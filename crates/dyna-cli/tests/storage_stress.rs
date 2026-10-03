use dyna::application::Request;
use dyna::contracts::{TaskBinding, canonical_task_title, hash};
use dyna::repository::DynaRepository;
use dyna::{DynaApplication, SqliteDynaRepository};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::path::Path;

const NOW: &str = "2026-10-02T10:00:00.000Z";
const LATER: &str = "2026-10-02T11:00:00.000Z";

fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn request(operation: &str, dashboard: Option<&str>) -> Request {
    Request {
        operation: operation.into(),
        dashboard: dashboard.map(str::to_owned),
        ..Default::default()
    }
}

fn fixture() -> (tempfile::TempDir, DynaApplication<SqliteDynaRepository>) {
    let dir = tempfile::tempdir().unwrap();
    let app = DynaApplication::new(SqliteDynaRepository::open(dir.path()).unwrap());
    for key in ["linus", "personal"] {
        app.execute(
            &request("dashboard create", None),
            Some(json!({"requestId":id(),"key":key,"name":key})),
            NOW,
        )
        .unwrap();
    }
    (dir, app)
}

fn todo(app: &DynaApplication<SqliteDynaRepository>, dashboard: &str) -> Value {
    app.execute(
        &request("todo create", Some(dashboard)),
        Some(json!({"requestId":id(),"title":format!("Work for {dashboard}")})),
        NOW,
    )
    .unwrap()
}

fn seed_pending_rename(root: &Path, dashboard: &str, new_key: &str) -> (String, String, u64) {
    let catalog = Connection::open(root.join("catalog.sqlite3")).unwrap();
    let dashboard_id: String = catalog
        .query_row("SELECT id FROM dashboards WHERE key=?1", [dashboard], |r| {
            r.get(0)
        })
        .unwrap();
    let connection =
        Connection::open(root.join(format!("dashboards/{dashboard}.sqlite3"))).unwrap();
    let payload: String = connection
        .query_row("SELECT payload FROM dashboard_state", [], |r| r.get(0))
        .unwrap();
    let state: Value = serde_json::from_str(&payload).unwrap();
    let revision = state["dashboard"]["revision"].as_u64().unwrap();
    connection
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .unwrap();
    drop(connection);
    let request_id = id();
    let metadata = json!({"revision":revision,"name":"Renamed","updatedAt":LATER});
    let receipt_hash = hash(&json!({"dashboardId":dashboard_id,"key":new_key,"name":"Renamed"}));
    catalog.execute_batch("BEGIN IMMEDIATE").unwrap();
    catalog
        .execute(
            "INSERT INTO dashboard_keys(key,dashboard_id) VALUES(?1,?2)",
            params![new_key, dashboard_id],
        )
        .unwrap();
    catalog.execute("INSERT INTO recovery_intents(id,kind,dashboard_id,old_key,new_key,state,payload) VALUES(?1,'rename',?2,?3,?4,'pending',?5)",params![request_id,dashboard_id,dashboard,new_key,metadata.to_string()]).unwrap();
    catalog.execute("INSERT INTO catalog_receipts(request_id,dashboard_id,operation,request_hash,result) VALUES(?1,?2,'dashboard rename',?3,NULL)",params![request_id,dashboard_id,receipt_hash]).unwrap();
    catalog
        .execute(
            "UPDATE dashboards SET state='renaming' WHERE id=?1",
            [&dashboard_id],
        )
        .unwrap();
    catalog.execute_batch("COMMIT").unwrap();
    (dashboard_id, request_id, revision)
}

#[test]
fn rename_recovers_after_file_move_and_after_dashboard_commit_exactly_once() {
    for dashboard_committed in [false, true] {
        let (dir, app) = fixture();
        let item = todo(&app, "linus");
        let healthy = todo(&app, "personal");
        drop(app);
        let (dashboard_id, request_id, revision) = seed_pending_rename(dir.path(), "linus", "work");
        let old = dir.path().join("dashboards/linus.sqlite3");
        let new = dir.path().join("dashboards/work.sqlite3");
        std::fs::rename(&old, &new).unwrap();
        if dashboard_committed {
            let connection = Connection::open(&new).unwrap();
            let payload: String = connection
                .query_row("SELECT payload FROM dashboard_state", [], |r| r.get(0))
                .unwrap();
            let mut state: Value = serde_json::from_str(&payload).unwrap();
            state["dashboard"]["key"] = json!("work");
            state["dashboard"]["name"] = json!("Renamed");
            state["dashboard"]["revision"] = json!(revision + 1);
            state["dashboard"]["updatedAt"] = json!(LATER);
            connection
                .execute(
                    "UPDATE dashboard_state SET payload=?1 WHERE id=?2",
                    params![state.to_string(), dashboard_id],
                )
                .unwrap();
        }
        for _ in 0..2 {
            let repo = SqliteDynaRepository::open(dir.path()).unwrap();
            for selector in ["linus", "work", dashboard_id.as_str()] {
                repo.read(selector, |state| {
                    assert_eq!(state.dashboard.key, "work");
                    assert_eq!(state.dashboard.name, "Renamed");
                    assert_eq!(state.dashboard.revision, revision + 1);
                    assert_eq!(state.items.len(), 1);
                    assert_eq!(state.items.values().next().unwrap().id, item["itemId"]);
                    Ok(())
                })
                .unwrap();
            }
            repo.read("personal", |state| {
                assert_eq!(state.dashboard.revision, 1);
                assert_eq!(state.items.values().next().unwrap().id, healthy["itemId"]);
                Ok(())
            })
            .unwrap();
            let app = DynaApplication::new(repo);
            let replay = app
                .execute(
                    &request("dashboard rename", Some("linus")),
                    Some(json!({"requestId":request_id,"key":"work","name":"Renamed"})),
                    LATER,
                )
                .unwrap();
            assert_eq!(replay["deduplicated"], true);
        }
        assert!(!old.exists());
        assert!(new.exists());
    }
}

#[test]
fn unavailable_pending_rename_does_not_hide_healthy_dashboard_and_can_later_recover() {
    let (dir, app) = fixture();
    let item = todo(&app, "linus");
    todo(&app, "personal");
    drop(app);
    let (_, request_id, revision) = seed_pending_rename(dir.path(), "linus", "work");
    let old = dir.path().join("dashboards/linus.sqlite3");
    let withheld = dir.path().join("withheld.sqlite3");
    std::fs::rename(&old, &withheld).unwrap();
    let repo = SqliteDynaRepository::open(dir.path()).unwrap_or_else(|error| {
        panic!("A missing pending-rename database hid an unrelated healthy dashboard: {error:?}")
    });
    let list = repo.list().unwrap();
    assert!(list.iter().any(|d| d.key == "personal" && d.available));
    assert!(list.iter().any(|d| d.key == "linus" && !d.available));
    assert!(repo.read("linus", |_| Ok(())).is_err());
    let recovery = repo.recover().unwrap();
    assert_eq!(recovery["unavailableDashboards"], 1);
    assert!(repo.integrity().is_err());
    let backup_id = id();
    assert!(repo.backup(&backup_id).is_err());
    assert!(
        !dir.path()
            .join(format!("backups/{backup_id}/manifest.json"))
            .exists()
    );
    let app = DynaApplication::new(repo);
    assert_eq!(todo(&app, "personal")["itemNumber"], 3);
    drop(app);
    std::fs::rename(&withheld, &old).unwrap();
    let repo = SqliteDynaRepository::open(dir.path()).unwrap();
    repo.read("work", |state| {
        assert_eq!(state.dashboard.revision, revision + 1);
        assert_eq!(state.items.values().next().unwrap().id, item["itemId"]);
        Ok(())
    })
    .unwrap();
    let replay = DynaApplication::new(repo)
        .execute(
            &request("dashboard rename", Some("linus")),
            Some(json!({"requestId":request_id,"key":"work","name":"Renamed"})),
            LATER,
        )
        .unwrap();
    assert_eq!(replay["deduplicated"], true);
}

#[test]
fn unavailable_pending_creation_does_not_hide_healthy_dashboard() {
    let (dir, app) = fixture();
    todo(&app, "personal");
    drop(app);
    let catalog = Connection::open(dir.path().join("catalog.sqlite3")).unwrap();
    catalog
        .execute(
            "UPDATE dashboards SET state='creating' WHERE key='linus'",
            [],
        )
        .unwrap();
    catalog.execute("UPDATE catalog_receipts SET result=NULL WHERE dashboard_id=(SELECT id FROM dashboards WHERE key='linus')", []).unwrap();
    let broken = Connection::open(dir.path().join("dashboards/linus.sqlite3")).unwrap();
    broken.pragma_update(None, "user_version", 16).unwrap();
    drop(broken);
    drop(catalog);
    let repo = SqliteDynaRepository::open(dir.path()).unwrap_or_else(|error| {
        panic!("One pending creation with an unavailable schema hid the healthy store: {error:?}")
    });
    assert!(
        repo.list()
            .unwrap()
            .iter()
            .any(|d| d.key == "personal" && d.available)
    );
    assert!(repo.read("personal", |s| Ok(s.items.len())).unwrap() == 1);
    assert_eq!(repo.recover().unwrap()["unavailableDashboards"], 1);
}

fn fixture_with_committed_task() -> (tempfile::TempDir, String) {
    let (dir, app) = fixture();
    let item = todo(&app, "linus");
    let item_id = item["itemId"].as_str().unwrap().to_owned();
    drop(app);
    let repo = SqliteDynaRepository::open(dir.path()).unwrap();
    repo.reserve_task("linus", &item_id, "native-task").unwrap();
    repo.write("linus", |state| {
        let item = state.items.get_mut(&item_id).unwrap();
        item.linked_tasks.push(TaskBinding {
            task_id: "native-task".into(),
            host_id: "local".into(),
            title: canonical_task_title(item.item_number, "Test task"),
            state: "running".into(),
            status_updated_at: NOW.into(),
            observed_at: NOW.into(),
            outcome: None,
            title_sync_needed: false,
        });
        Ok(())
    })
    .unwrap();
    let catalog = Connection::open(dir.path().join("catalog.sqlite3")).unwrap();
    let status: String = catalog
        .query_row(
            "SELECT state FROM task_owners WHERE task_id='native-task'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(status, "committed");
    (dir, item_id)
}

fn remove_task_binding(path: &Path, item_id: &str) {
    let connection = Connection::open(path).unwrap();
    let payload: String = connection
        .query_row(
            "SELECT payload FROM item_records WHERE id=?1",
            [item_id],
            |r| r.get(0),
        )
        .unwrap();
    let mut item: Value = serde_json::from_str(&payload).unwrap();
    item["linkedTasks"] = json!([]);
    connection
        .execute(
            "UPDATE item_records SET payload=?1 WHERE id=?2",
            params![item.to_string(), item_id],
        )
        .unwrap();
    let integrity: String = connection
        .pragma_query_value(None, "integrity_check", |r| r.get(0))
        .unwrap();
    assert_eq!(integrity, "ok");
}

#[test]
fn committed_task_without_durable_binding_fails_integrity_and_new_backup() {
    let (dir, item_id) = fixture_with_committed_task();
    remove_task_binding(&dir.path().join("dashboards/linus.sqlite3"), &item_id);
    let repo = SqliteDynaRepository::open(dir.path()).unwrap();
    assert!(
        repo.integrity().is_err(),
        "Integrity reported success after a committed native task lost its durable binding"
    );
    let backup_id = id();
    assert!(repo.backup(&backup_id).is_err());
    assert!(
        !dir.path()
            .join(format!("backups/{backup_id}/manifest.json"))
            .exists()
    );
    let list = repo.list().unwrap();
    assert!(list.iter().any(|d| d.key == "linus" && !d.available));
    assert!(list.iter().any(|d| d.key == "personal" && d.available));
}

#[test]
fn backup_replay_rejects_a_lost_committed_native_task_binding() {
    let (dir, item_id) = fixture_with_committed_task();
    let repo = SqliteDynaRepository::open(dir.path()).unwrap();
    let backup_id = id();
    assert_eq!(repo.backup(&backup_id).unwrap()["complete"], true);
    remove_task_binding(
        &dir.path()
            .join(format!("backups/{backup_id}/linus.sqlite3")),
        &item_id,
    );
    assert!(
        repo.backup(&backup_id).is_err(),
        "A damaged backup replay still reported complete after a committed native task disappeared"
    );
}

#[test]
fn uncommitted_native_task_reservations_remain_valid_recovery_gaps() {
    let (dir, app) = fixture();
    let item = todo(&app, "linus");
    drop(app);
    let repo = SqliteDynaRepository::open(dir.path()).unwrap();
    repo.reserve_task(
        "linus",
        item["itemId"].as_str().unwrap(),
        "not-yet-attached",
    )
    .unwrap();
    drop(repo);
    let repo = SqliteDynaRepository::open(dir.path()).unwrap();
    assert_eq!(repo.integrity().unwrap()["valid"], true);
    assert_eq!(repo.backup(&id()).unwrap()["complete"], true);
    repo.reserve_task(
        "linus",
        item["itemId"].as_str().unwrap(),
        "not-yet-attached",
    )
    .unwrap();
}

#[cfg(feature = "isolated-tests")]
mod processes {
    use super::*;
    use std::io::Write;
    use std::process::{Child, Command, Output, Stdio};

    struct Cli {
        home: tempfile::TempDir,
    }

    impl Cli {
        fn new() -> Self {
            let cli = Self {
                home: tempfile::tempdir().unwrap(),
            };
            for key in ["linus", "personal"] {
                cli.run(
                    &["dashboard", "create"],
                    Some(json!({"requestId":id(),"key":key,"name":key})),
                )
                .unwrap();
            }
            cli
        }

        fn spawn(&self, args: &[&str], input: Option<&Value>) -> Child {
            let mut child = Command::new(env!("CARGO_BIN_EXE_dyna"))
                .args(args)
                .arg("--json")
                .env_clear()
                .env("PATH", "")
                .env("DYNA_ISOLATED_TEST_HOME", self.home.path())
                .current_dir(self.home.path())
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            if let Some(input) = input {
                child
                    .stdin
                    .take()
                    .unwrap()
                    .write_all(&serde_json::to_vec(input).unwrap())
                    .unwrap();
            } else {
                drop(child.stdin.take());
            }
            child
        }

        fn decode(output: Output) -> std::result::Result<Value, Value> {
            if output.status.success() {
                assert!(output.stderr.is_empty());
                Ok(serde_json::from_slice(&output.stdout).unwrap())
            } else {
                assert!(output.stdout.is_empty());
                Err(serde_json::from_slice(&output.stderr).unwrap())
            }
        }

        fn run(&self, args: &[&str], input: Option<Value>) -> std::result::Result<Value, Value> {
            Self::decode(self.spawn(args, input.as_ref()).wait_with_output().unwrap())
        }

        fn finish(
            &self,
            child: Child,
            args: &[&str],
            input: Value,
        ) -> std::result::Result<Value, Value> {
            let mut result = Self::decode(child.wait_with_output().unwrap());
            for _ in 0..100 {
                if !matches!(&result, Err(error) if error["error"]["code"] == "busy") {
                    return result;
                }
                // Other already-spawned processes may still hold the lock.
                // Retry only the exact command/input; every failed attempt must
                // have the explicit retryable busy envelope and empty stdout.
                std::thread::sleep(std::time::Duration::from_millis(5));
                result = self.run(args, Some(input.clone()));
            }
            result
        }

        fn root(&self) -> std::path::PathBuf {
            self.home.path().join("flowzone-fixture")
        }
    }

    #[test]
    fn concurrent_identical_retries_commit_one_item_receipt_allocation_and_history() {
        let cli = Cli::new();
        let args = ["todo", "create", "--dashboard", "linus"];
        let input = json!({"requestId":id(),"title":"Exactly once"});
        let children: Vec<_> = (0..24).map(|_| cli.spawn(&args, Some(&input))).collect();
        let mut originals = 0;
        let mut first = None;
        for child in children {
            let result = cli.finish(child, &args, input.clone()).unwrap();
            originals += usize::from(result["deduplicated"] == false);
            if let Some(first) = &first {
                let first: &Value = first;
                assert_eq!(result["itemId"], first["itemId"]);
                assert_eq!(result["itemNumber"], first["itemNumber"]);
                assert_eq!(result["control"], first["control"]);
            } else {
                first = Some(result);
            }
        }
        assert_eq!(originals, 1);
        let show = cli
            .run(&["dashboard", "show", "--dashboard", "linus"], None)
            .unwrap();
        assert_eq!(show["counts"]["total"], 1);
        assert_eq!(show["revision"], 1);
        let catalog = Connection::open(cli.root().join("catalog.sqlite3")).unwrap();
        assert_eq!(
            catalog
                .query_row("SELECT COUNT(*) FROM item_numbers", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        let dashboard = Connection::open(cli.root().join("dashboards/linus.sqlite3")).unwrap();
        for table in ["item_records", "history_events", "request_receipts"] {
            assert_eq!(
                dashboard
                    .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r
                        .get::<_, i64>(0))
                    .unwrap(),
                1
            );
        }
        assert_eq!(cli.run(&args, Some(input)).unwrap()["deduplicated"], true);
        assert_eq!(
            cli.run(&["maintenance", "integrity"], None).unwrap()["valid"],
            true
        );
    }

    #[test]
    fn concurrent_conflicting_receipts_never_replace_the_winner_or_consume_extra_numbers() {
        let cli = Cli::new();
        let request_id = id();
        let args = ["todo", "create", "--dashboard", "linus"];
        let children: Vec<_> = (0..24)
            .map(|n| {
                let input = json!({"requestId":request_id,"title":if n%2==0 {"A"} else {"B"}});
                (cli.spawn(&args, Some(&input)), input)
            })
            .collect();
        let mut winner = None;
        let mut originals = 0;
        let mut conflicts = 0;
        for (child, input) in children {
            match cli.finish(child, &args, input.clone()) {
                Ok(result) => {
                    originals += usize::from(result["deduplicated"] == false);
                    if let Some(winner) = &winner {
                        assert_eq!(&input, winner);
                    } else {
                        winner = Some(input);
                    }
                }
                Err(error) => {
                    assert_eq!(error["error"]["code"], "request_conflict");
                    conflicts += 1;
                }
            }
        }
        assert_eq!(originals, 1);
        assert_eq!(conflicts, 12);
        let winner = winner.unwrap();
        assert_eq!(
            cli.run(&args, Some(winner.clone())).unwrap()["deduplicated"],
            true
        );
        let show = cli
            .run(&["dashboard", "snapshot", "--dashboard", "linus"], None)
            .unwrap();
        assert_eq!(show["cards"][0]["title"], winner["title"]);
        assert_eq!(show["revision"], 1);
        let catalog = Connection::open(cli.root().join("catalog.sqlite3")).unwrap();
        assert_eq!(
            catalog
                .query_row("SELECT COUNT(*) FROM item_numbers", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn optimistic_dashboard_race_has_one_winner_and_preserves_exact_replay() {
        let cli = Cli::new();
        let args = [
            "dashboard",
            "update",
            "--dashboard",
            "linus",
            "--expected-revision",
            "0",
        ];
        let inputs = [
            json!({"requestId":id(),"name":"First"}),
            json!({"requestId":id(),"name":"Second"}),
        ];
        let children: Vec<_> = inputs
            .iter()
            .map(|input| cli.spawn(&args, Some(input)))
            .collect();
        let mut winners = 0;
        let mut stale = 0;
        for (child, input) in children.into_iter().zip(inputs) {
            match cli.finish(child, &args, input.clone()) {
                Ok(result) => {
                    winners += 1;
                    assert_eq!(result["revision"], 1);
                    assert_eq!(cli.run(&args, Some(input)).unwrap()["deduplicated"], true);
                }
                Err(error) => {
                    assert_eq!(error["error"]["code"], "stale_dashboard");
                    stale += 1;
                }
            }
        }
        assert_eq!((winners, stale), (1, 1));
        let show = cli
            .run(&["dashboard", "show", "--dashboard", "linus"], None)
            .unwrap();
        assert_eq!(show["revision"], 1);
        let dashboard = Connection::open(cli.root().join("dashboards/linus.sqlite3")).unwrap();
        assert_eq!(
            dashboard
                .query_row("SELECT COUNT(*) FROM request_receipts", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn identical_request_ids_are_scoped_to_independent_dashboards() {
        let cli = Cli::new();
        let input = json!({"requestId":id(),"title":"Independent"});
        let inputs = ["linus", "personal"].map(|dashboard| {
            let args = ["todo", "create", "--dashboard", dashboard];
            (cli.spawn(&args, Some(&input)), dashboard)
        });
        let mut numbers = std::collections::BTreeSet::new();
        let mut items = std::collections::BTreeSet::new();
        for (child, dashboard) in inputs {
            let args = ["todo", "create", "--dashboard", dashboard];
            let result = cli.finish(child, &args, input.clone()).unwrap();
            assert!(numbers.insert(result["itemNumber"].as_i64().unwrap()));
            assert!(items.insert(result["itemId"].as_str().unwrap().to_owned()));
            assert_eq!(
                cli.run(&args, Some(input.clone())).unwrap()["deduplicated"],
                true
            );
        }
        assert_eq!(numbers, std::collections::BTreeSet::from([1, 2]));
        assert_eq!(
            cli.run(&["maintenance", "integrity"], None).unwrap()["dashboards"],
            2
        );
    }
}
