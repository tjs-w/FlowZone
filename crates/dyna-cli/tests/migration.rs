use dyna::application::Request;
use dyna::contracts::*;
use dyna::{DynaApplication, SqliteDynaRepository};
use rusqlite::{Connection, params};

const NOW: &str = "2026-10-01T10:00:00.000Z";
fn uid(n: u128) -> String {
    uuid::Uuid::from_u128(n).to_string()
}
fn inventory() -> LegacyInventory {
    LegacyInventory {
        schema_version: 14,
        number_high_water: 100,
        dashboards: vec![
            LegacyDashboard {
                id: uid(2),
                name: "Executive Queue".into(),
                created_at: NOW.into(),
                archived: true,
            },
            LegacyDashboard {
                id: uid(1),
                name: "Executive Queue".into(),
                created_at: NOW.into(),
                archived: false,
            },
        ],
        memberships: vec![
            LegacyMembership {
                dashboard_id: uid(2),
                item_id: uid(10),
                item_number: 1,
            },
            LegacyMembership {
                dashboard_id: uid(1),
                item_id: uid(10),
                item_number: 1,
            },
        ],
        tasks: vec![LegacyTaskOwner {
            item_id: uid(10),
            task_id: "PRIVATE-NATIVE-TASK".into(),
        }],
    }
}

#[test]
fn deterministic_read_only_plan_preserves_oldest_ownership_and_tombstones() {
    let result = dyna::migration::preview(inventory()).unwrap();
    assert_eq!(result["previewOnly"], true);
    assert_eq!(result["readyForCutover"], false);
    assert_eq!(result["dashboards"][0]["dashboardKey"], "executivequeue");
    assert_eq!(result["dashboards"][1]["dashboardKey"], "executivequeue2");
    assert_eq!(result["dashboards"][1]["archived"], true);
    assert_eq!(result["items"][0]["itemId"], uid(10));
    assert_eq!(result["items"][0]["proposedItemNumber"], 1);
    assert_eq!(result["items"][1]["proposedItemNumber"], 101);
    assert_ne!(result["items"][1]["itemId"], uid(10));
    assert_eq!(result["taskAssociationCounts"][uid(1)], 1);
    assert!(!result.to_string().contains("PRIVATE-NATIVE-TASK"));
    let mut reversed = inventory();
    reversed.dashboards.reverse();
    reversed.memberships.reverse();
    assert_eq!(result, dyna::migration::preview(reversed).unwrap());
}

#[test]
fn migration_preview_rejects_conflicts_capacity_and_number_exhaustion() {
    let mut conflict = inventory();
    conflict.memberships.push(LegacyMembership {
        dashboard_id: uid(1),
        item_id: uid(11),
        item_number: 2,
    });
    conflict.tasks.push(LegacyTaskOwner {
        item_id: uid(11),
        task_id: "PRIVATE-NATIVE-TASK".into(),
    });
    assert_eq!(
        dyna::migration::preview(conflict).unwrap_err().code,
        "migration_conflict"
    );
    let mut exhausted = inventory();
    exhausted.number_high_water = MAX_ITEM_NUMBER;
    assert_eq!(
        dyna::migration::preview(exhausted).unwrap_err().code,
        "number_exhausted"
    );
    let mut too_many = inventory();
    too_many.dashboards = vec![too_many.dashboards[0].clone(); 101];
    assert_eq!(
        dyna::migration::preview(too_many).unwrap_err().code,
        "migration_unavailable"
    );
    let mut bad_version = inventory();
    bad_version.schema_version = 15;
    assert_eq!(
        dyna::migration::preview(bad_version).unwrap_err().code,
        "migration_unavailable"
    );
    let mut bad_number = inventory();
    bad_number.memberships[1].item_number = 2;
    assert!(dyna::migration::preview(bad_number).is_err());
}

#[test]
fn metadata_preview_leaves_legacy_file_and_routing_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("dyna.sqlite3");
    let db = Connection::open(&path).unwrap();
    db.execute_batch("PRAGMA user_version=14; CREATE TABLE dashboards(id TEXT PRIMARY KEY,name TEXT,created_at TEXT,archived INTEGER); CREATE TABLE items(id TEXT PRIMARY KEY,body TEXT); CREATE TABLE item_numbers(number INTEGER PRIMARY KEY AUTOINCREMENT,item_id TEXT UNIQUE); CREATE TABLE dashboard_items(dashboard_id TEXT,item_id TEXT); CREATE TABLE task_bindings(item_id TEXT,task_id TEXT);").unwrap();
    for d in inventory().dashboards {
        db.execute(
            "INSERT INTO dashboards VALUES(?1,?2,?3,?4)",
            params![d.id, d.name, d.created_at, d.archived],
        )
        .unwrap();
    }
    db.execute(
        "INSERT INTO items VALUES(?1,'PRIVATE SOURCE CONTENT')",
        [uid(10)],
    )
    .unwrap();
    db.execute("INSERT INTO item_numbers VALUES(1,?1)", [uid(10)])
        .unwrap();
    db.execute(
        "INSERT INTO item_numbers VALUES(100,'deleted-item-tombstone')",
        [],
    )
    .unwrap();
    for m in inventory().memberships {
        db.execute(
            "INSERT INTO dashboard_items VALUES(?1,?2)",
            params![m.dashboard_id, m.item_id],
        )
        .unwrap();
    }
    db.execute(
        "INSERT INTO task_bindings VALUES(?1,'PRIVATE-NATIVE-TASK')",
        [uid(10)],
    )
    .unwrap();
    drop(db);
    let before = std::fs::read(&path).unwrap();
    let app =
        DynaApplication::new(SqliteDynaRepository::open_migration_preview(dir.path()).unwrap());
    let result = app
        .execute(
            &Request {
                operation: "maintenance migration-plan".into(),
                ..Default::default()
            },
            None,
            NOW,
        )
        .unwrap();
    assert_eq!(result["proposedNumberHighWater"], 101);
    assert!(!result.to_string().contains("PRIVATE"));
    assert!(!result.to_string().contains(dir.path().to_str().unwrap()));
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert!(!dir.path().join("catalog.sqlite3").exists());
    assert!(!dir.path().join("dashboards").exists());
    assert!(!dir.path().join("locks").exists());
    let request = dyna::cli::parse(&[
        "maintenance".into(),
        "migration-plan".into(),
        "--json".into(),
    ])
    .unwrap();
    let dyna::cli::Invocation::Command(command) = request else {
        panic!("expected command")
    };
    assert!(!command.mutation);
    let worker = app
        .execute(
            &Request {
                operation: "maintenance migration-plan".into(),
                actor: Some(ActorKind::LinkedWorker),
                ..Default::default()
            },
            None,
            NOW,
        )
        .unwrap_err();
    assert_eq!(worker.code, "forbidden");
}
