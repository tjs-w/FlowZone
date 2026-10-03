//! Differentiated workflow/data tests. Every repository is an explicit tempfile
//! fixture; these tests never resolve the installed Dyna store or native tasks.

use dyna::application::{Request, card, project};
use dyna::contracts::{Actor, ActorKind, Item, SourceContribution, TaskBinding, WorkUpdate};
use dyna::repository::DynaRepository;
use dyna::{DynaApplication, SqliteDynaRepository};
use serde_json::{Value, json};
use std::collections::BTreeSet;

type App = DynaApplication<SqliteDynaRepository>;
const NOW: &str = "2026-10-01T10:00:00.000Z";
const NEXT: &str = "2026-10-01T11:00:00.000Z";
const UNTIL: &str = "2026-10-02T10:00:00.000Z";
const ORDERS: [[usize; 3]; 6] = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
];

fn id(label: &str) -> String {
    uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_OID, label.as_bytes()).to_string()
}

fn request(operation: &str) -> Request {
    Request {
        operation: operation.into(),
        dashboard: Some("fixture".into()),
        ..Default::default()
    }
}

fn fixture() -> (tempfile::TempDir, App) {
    let directory = tempfile::tempdir().unwrap();
    let app = DynaApplication::new(SqliteDynaRepository::open(directory.path()).unwrap());
    app.execute(
        &Request {
            operation: "dashboard create".into(),
            ..Default::default()
        },
        Some(json!({"requestId":id("workflow-dashboard"),"key":"fixture","name":"Workflow fixtures"})),
        NOW,
    )
    .unwrap();
    (directory, app)
}

fn todo(app: &App, title: &str) -> Value {
    app.execute(
        &request("todo create"),
        Some(json!({"requestId":id(&format!("todo/{title}")),"title":title})),
        NOW,
    )
    .unwrap()
}

fn snapshot(app: &App, now: &str) -> Value {
    app.execute(&request("dashboard snapshot"), None, now)
        .unwrap()
}

fn item_request(operation: &str, item: &Value, revision: u64) -> Request {
    Request {
        item_id: item["id"].as_str().map(str::to_string),
        expected_fingerprint: item["fingerprint"].as_str().map(str::to_string),
        expected_revision: Some(revision),
        ..request(operation)
    }
}

fn publisher(app: &App, label: &str) -> String {
    let result = app
        .execute(
            &request("publisher setup"),
            Some(json!({"requestId":id(label),"name":label})),
            NOW,
        )
        .unwrap();
    result["publisherId"].as_str().unwrap().into()
}

fn jira(key: &str) -> Value {
    json!({"source":"twg","contextId":"https://jira.example.test","resultType":"jira","recordId":key})
}

fn mr(number: u32) -> Value {
    json!({"source":"gitlab","instanceId":"https://gitlab.example.test","projectPath":"fixture/service","iid":number,"entityType":"merge_request"})
}

fn record(label: &str, reference: Value) -> Value {
    json!({"externalId":label,"sourceRef":reference,"sourceScope":"fixture","title":label,"summary":format!("Facts from {label}"),"priority":"normal","priorityReason":"Fixture proof","sourceUpdatedAt":NOW})
}

fn related_mr(number: u32) -> Value {
    let mut value = record(&format!("mr-{number}"), mr(number));
    value["relationships"] = json!([{"kind":"references_jira_issue","target":jira("LIN-501"),"evidence":{"field":"mr_reference","exactValue":"LIN-501"}}]);
    value
}

fn publication(publisher: &str, run: &str, items: Vec<Value>) -> Value {
    json!({"requestId":id(&format!("request/{run}")),"publisherId":publisher,"runId":run,"sourceCompletedAt":NOW,"mode":"upsert","status":"succeeded","items":items})
}

fn publish(app: &App, publisher: &str, run: &str, items: Vec<Value>) -> Value {
    app.execute(
        &request("publication publish"),
        Some(publication(publisher, run, items)),
        NEXT,
    )
    .unwrap()
}

fn base_item(directory: &tempfile::TempDir, item_id: &str) -> Item {
    SqliteDynaRepository::open(directory.path())
        .unwrap()
        .read("fixture", |state| Ok(state.items[item_id].clone()))
        .unwrap()
}

fn binding(number: usize, state: &str, at: &str) -> TaskBinding {
    TaskBinding {
        task_id: format!("task-{number}"),
        host_id: "fixture-host".into(),
        title: ":1: Fixture".into(),
        state: state.into(),
        status_updated_at: at.into(),
        observed_at: at.into(),
        outcome: None,
        title_sync_needed: false,
    }
}

fn worker_update(number: usize, kind: &str, at: &str) -> WorkUpdate {
    WorkUpdate {
        id: id(&format!("update/{number}/{kind}/{at}")),
        kind: kind.into(),
        body: format!("{kind} task-{number}"),
        outcome: (kind == "completion_reported").then(|| "Reported success".into()),
        artifacts: vec![],
        created_at: at.into(),
        actor: Actor {
            kind: ActorKind::LinkedWorker,
            task_id: Some(format!("task-{number}")),
            host_id: Some("fixture-host".into()),
            work_attempt_id: Some(id(&format!("attempt/{number}"))),
        },
        supersedes_work_update_id: None,
    }
}

#[test]
fn all_three_task_state_permutations_project_the_same_lifecycle() {
    let (directory, app) = fixture();
    let created = todo(&app, "Fixture");
    let base = base_item(&directory, created["itemId"].as_str().unwrap());
    let states = ["running", "waiting", "failed", "unknown", "succeeded"];
    for a in states {
        for b in states {
            for c in states {
                let tasks = [binding(0, a, NOW), binding(1, b, NOW), binding(2, c, NOW)];
                let mut observed = BTreeSet::new();
                for order in ORDERS {
                    let mut item = base.clone();
                    item.linked_tasks = order.map(|i| tasks[i].clone()).to_vec();
                    let result = project(&item);
                    observed.insert((result.stage, result.condition, result.blocked));
                    if [a, b, c].contains(&"waiting") {
                        assert_eq!(result.condition, Some("input_needed"));
                    } else if [a, b, c].contains(&"failed") {
                        assert_eq!(result.condition, Some("task_failed"));
                    } else if [a, b, c].contains(&"unknown") {
                        assert_eq!(result.condition, Some("status_unknown"));
                    } else if [a, b, c].iter().all(|s| *s == "succeeded") {
                        assert_eq!(result.stage, "completed");
                    } else {
                        assert_eq!(result.stage, "executing");
                    }
                }
                assert_eq!(observed.len(), 1, "states {a}/{b}/{c}");
            }
        }
    }
}

#[test]
fn mixed_worker_conditions_and_manual_timestamps_follow_authority_boundaries() {
    let (directory, app) = fixture();
    let created = todo(&app, "Fixture");
    let base = base_item(&directory, created["itemId"].as_str().unwrap());
    let states = ["running", "waiting", "failed", "unknown", "succeeded"];
    for native in states {
        for kind in ["needs_input", "blocked", "completion_reported"] {
            let mut item = base.clone();
            item.linked_tasks = vec![binding(0, native, NOW), binding(1, "running", NOW)];
            item.work_updates = vec![worker_update(0, kind, NEXT)];
            let result = project(&item);
            if native == "succeeded" {
                assert!(!result.blocked);
                assert_eq!(result.condition, None);
            } else if kind == "needs_input" || native == "waiting" {
                assert_eq!(result.condition, Some("input_needed"));
            } else if native == "failed" {
                assert_eq!(result.condition, Some("task_failed"));
            } else if native == "unknown" {
                assert_eq!(result.condition, Some("status_unknown"));
            } else if kind == "completion_reported" {
                assert_eq!(result.condition, Some("verification_pending"));
            }
            if native != "succeeded" && kind == "blocked" {
                assert!(result.blocked);
            }
            item.linked_tasks[0].observed_at = NEXT.into();
            let rendered = card(&item, NEXT);
            assert!(
                rendered.get("workState").is_none(),
                "equal timestamp expires worker condition"
            );
            for stage in ["todo", "needs_you"] {
                item.manual_stage = Some(stage.into());
                item.manual_stage_at = Some(NEXT.into());
                let result = project(&item);
                assert_eq!(
                    result.stage,
                    if stage == "todo" { "todo" } else { "paused" }
                );
                assert!(!result.blocked);
                item.manual_stage_at = Some(NOW.into());
                assert_eq!(
                    project(&item).stage,
                    if ["waiting", "failed", "unknown"].contains(&native) {
                        "paused"
                    } else {
                        "executing"
                    }
                );
            }
        }
    }
}

#[test]
fn equal_timestamp_correlated_record_permutations_keep_displayed_facts_stable() {
    let (_directory, app) = fixture();
    let publisher = publisher(&app, "Permutation sources");
    let records = [related_mr(1), related_mr(2), related_mr(3)].map(|mut value| {
        let label = value["externalId"].as_str().unwrap().to_string();
        value["attention"] = json!(format!("Act on {label}"));
        value["plan"] = json!([format!("Review {label}")]);
        value["nextSteps"] = json!([{"label":format!("Ship {label}")}]);
        value
    });
    let mut fingerprints = BTreeSet::new();
    let mut projections = BTreeSet::new();
    for (round, order) in ORDERS.into_iter().enumerate() {
        publish(
            &app,
            &publisher,
            &format!("permutation-{round}"),
            order.map(|i| records[i].clone()).to_vec(),
        );
        let current = snapshot(&app, NEXT);
        assert_eq!(current["counts"]["total"], 1);
        let current = &current["cards"][0];
        fingerprints.insert(current["fingerprint"].as_str().unwrap().to_string());
        projections.insert(json!({"title":current["title"],"summary":current["summary"],"attention":current["attention"],"plan":current["plan"],"nextSteps":current["nextSteps"]}).to_string());
    }
    assert_eq!(
        fingerprints.len(),
        1,
        "equivalent record facts have one fingerprint"
    );
    assert_eq!(
        projections.len(),
        1,
        "reordering equal-time evidence must not change displayed actions: {projections:?}"
    );
}

#[test]
fn equal_timestamp_permutations_keep_people_and_primary_source_stable() {
    let (_directory, app) = fixture();
    let publisher = publisher(&app, "People permutation sources");
    let records = [related_mr(1), related_mr(2), related_mr(3)].map(|mut value| {
        let label = value["externalId"].as_str().unwrap().to_string();
        value["people"] = json!((0..8).map(|number| {
            json!({"displayName":format!("{label} person {number}"),"leadershipLevel":if label=="mr-2" && number==0 {"vp"} else {"other"},"relationship":if label=="mr-2" && number==0 {"management_chain"} else {"unknown"},"involvement":"author","provenance":"declared_source","confidence":"high"})
        }).collect::<Vec<_>>());
        value
    });
    let mut primary_sources = BTreeSet::new();
    let mut people = BTreeSet::new();
    let mut leadership_counts = BTreeSet::new();
    let mut leadership_scores = BTreeSet::new();
    for (round, order) in ORDERS.into_iter().enumerate() {
        publish(
            &app,
            &publisher,
            &format!("people-order-{round}"),
            order.map(|i| records[i].clone()).to_vec(),
        );
        let current = snapshot(&app, NEXT);
        let item = &current["cards"][0];
        leadership_counts.insert(current["counts"]["leadership"].as_u64().unwrap());
        leadership_scores.insert(item["leadershipScore"].as_u64().unwrap());
        assert!(item["people"].as_array().unwrap().len() <= 8);
        primary_sources.insert(json!({"source":item["source"],"sourceRef":item["sourceRef"],"sourceLabel":item["sourceLabel"]}).to_string());
        people.insert(json!({"people":item["people"],"leadershipScore":item["leadershipScore"],"leadershipCount":current["counts"]["leadership"]}).to_string());
    }
    assert_eq!(
        primary_sources.len(),
        1,
        "same evidence must keep the primary source stable: {primary_sources:?}; people projections: {}; leadership counts: {leadership_counts:?}; scores: {leadership_scores:?}",
        people.len()
    );
    assert_eq!(
        people.len(),
        1,
        "same people evidence must keep the capped projection and leadership count stable: {people:?}"
    );
}

#[test]
fn item_search_cursors_page_every_match_and_reject_changed_query_scope_or_revision() {
    let (_directory, app) = fixture();
    for number in 0..23 {
        todo(&app, &format!("Search page fixture {number}"));
    }
    let mut read = request("item search");
    read.query = Some("Search fixture".into());
    read.limit = Some(3);
    let first = app.execute(&read, None, NOW).unwrap();
    assert_eq!(first["items"].as_array().unwrap().len(), 3);
    assert_eq!(first["total"], 23);
    assert_eq!(first["truncated"], true);
    let cursor = first["nextCursor"].as_str().unwrap().to_string();
    let mut ids = BTreeSet::new();
    let mut pages = 0;
    loop {
        let page = app.execute(&read, None, NOW).unwrap();
        assert_eq!(page["total"], 23);
        assert!(page["items"].as_array().unwrap().len() <= 3);
        for item in page["items"].as_array().unwrap() {
            assert!(
                ids.insert(item["id"].as_str().unwrap().to_string()),
                "no search duplicates"
            );
        }
        read.cursor = page["nextCursor"].as_str().map(str::to_string);
        assert_eq!(page["truncated"], read.cursor.is_some());
        pages += 1;
        if read.cursor.is_none() {
            break;
        }
        assert!(pages < 20);
    }
    assert_eq!(ids.len(), 23);
    assert_eq!(pages, 8);
    read.cursor = Some(cursor.clone());
    for change in ["query", "scope", "operation"] {
        let mut changed = read.clone();
        match change {
            "query" => changed.query = Some("Search changed".into()),
            "scope" => changed.scope = Some("archive".into()),
            _ => changed.operation = "dashboard snapshot".into(),
        }
        assert_eq!(
            app.execute(&changed, None, NOW).unwrap_err().code,
            "stale_cursor",
            "cursor binds {change}"
        );
    }
    todo(&app, "Search fixture new revision");
    assert_eq!(
        app.execute(&read, None, NOW).unwrap_err().code,
        "stale_cursor"
    );
    for limit in [0, 21] {
        let mut invalid = request("item search");
        invalid.limit = Some(limit);
        assert_eq!(
            app.execute(&invalid, None, NOW).unwrap_err().code,
            "invalid_input"
        );
    }
    let parsed = [
        "item",
        "search",
        "--dashboard",
        "fixture",
        "--query",
        "Search fixture",
        "--limit",
        "3",
        "--cursor",
        &cursor,
    ]
    .map(str::to_string);
    assert!(dyna::cli::parse(&parsed).is_ok());
}

fn two_independent_sources(app: &App, publisher: &str) -> Value {
    publish(
        app,
        publisher,
        "independent",
        vec![record("jira", jira("LIN-501")), record("mr-2", mr(2))],
    );
    snapshot(app, NEXT)
}

#[test]
fn source_correlation_preserves_explicit_backlog_from_a_merged_item() {
    let (_directory, app) = fixture();
    let publisher = publisher(&app, "Backlog sources");
    let before = two_independent_sources(&app, &publisher);
    let original = before["cards"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["title"] == "mr-2")
        .unwrap();
    app.execute(
        &item_request(
            "lifecycle backlog",
            original,
            before["revision"].as_u64().unwrap(),
        ),
        Some(json!({"requestId":id("backlog-before-merge"),"until":UNTIL})),
        NEXT,
    )
    .unwrap();
    publish(&app, &publisher, "correlate-backlog", vec![related_mr(2)]);
    let after = snapshot(&app, NEXT);
    assert_eq!(after["counts"]["total"], 1);
    assert_eq!(
        after["cards"][0]["backlog"]["until"], UNTIL,
        "correlation must preserve a current deferral"
    );
    assert_eq!(after["counts"]["backlog"], 1);
}

#[test]
fn source_correlation_preserves_explicit_manual_stage_from_a_merged_item() {
    let (_directory, app) = fixture();
    let publisher = publisher(&app, "Stage sources");
    let before = two_independent_sources(&app, &publisher);
    let original = before["cards"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["title"] == "mr-2")
        .unwrap();
    app.execute(
        &item_request(
            "lifecycle stage",
            original,
            before["revision"].as_u64().unwrap(),
        ),
        Some(json!({"requestId":id("stage-before-merge"),"stage":"needs_you"})),
        NEXT,
    )
    .unwrap();
    publish(&app, &publisher, "correlate-stage", vec![related_mr(2)]);
    let after = snapshot(&app, NEXT);
    assert_eq!(after["counts"]["total"], 1);
    assert_eq!(
        after["cards"][0]["workflowState"], "paused",
        "correlation must retain an explicit request for input"
    );
}

#[test]
fn publication_receipts_replay_after_publisher_revocation_or_dashboard_archive() {
    let mut failures = vec![];
    for inactive in ["publisher revoke", "dashboard archive"] {
        let (_directory, app) = fixture();
        let publisher = publisher(&app, "Receipt sources");
        let input = publication(
            &publisher,
            "receipt-proof",
            vec![record("jira", jira("LIN-501"))],
        );
        let first = app
            .execute(&request("publication publish"), Some(input.clone()), NEXT)
            .unwrap();
        let disable = if inactive == "publisher revoke" {
            json!({"requestId":id(inactive),"publisherId":publisher})
        } else {
            json!({"requestId":id(inactive)})
        };
        let mut disable_request = request(inactive);
        disable_request.expected_revision =
            Some(snapshot(&app, NEXT)["revision"].as_u64().unwrap());
        app.execute(&disable_request, Some(disable), NEXT).unwrap();
        let before = snapshot(&app, NEXT);
        match app.execute(&request("publication publish"), Some(input), NEXT) {
            Ok(replay) => {
                assert_eq!(replay["deduplicated"], true);
                assert_eq!(replay["accepted"], first["accepted"]);
                assert_eq!(replay["revision"], first["revision"]);
                assert_eq!(snapshot(&app, NEXT), before);
            }
            Err(error) => failures.push(format!("{inactive}: {}", error.code)),
        }
    }
    assert!(
        failures.is_empty(),
        "committed receipt replay performs no write and must survive later state changes: {failures:?}"
    );
}

#[test]
fn full_text_search_matches_user_quotes_and_backslashes() {
    let (_directory, app) = fixture();
    let created = todo(&app, "Review \"quoted\" paths C:\\work\\repo");
    let mut failures = vec![];
    for operation in ["item search", "dashboard snapshot"] {
        for query in ["\"quoted\"", "C:\\work\\repo"] {
            let mut read = request(operation);
            read.query = Some(query.into());
            let result = app.execute(&read, None, NOW).unwrap();
            let field = if operation == "item search" {
                "items"
            } else {
                "cards"
            };
            if result[field].as_array().unwrap().len() != 1 {
                failures.push(format!(
                    "{operation} / {query:?}: {} matches",
                    result[field].as_array().unwrap().len()
                ));
            } else {
                assert_eq!(result[field][0]["id"], created["itemId"]);
            }
        }
    }
    assert!(
        failures.is_empty(),
        "search actual user text, before JSON escaping: {failures:?}"
    );
}

#[test]
fn multiword_search_matches_terms_across_work_fields() {
    let (_directory, app) = fixture();
    app.execute(&request("todo create"), Some(json!({"requestId":id("cross-field-search"),"title":"Alpha migration","summary":"Omega evidence"})), NOW).unwrap();
    for operation in ["item search", "dashboard snapshot"] {
        let mut read = request(operation);
        read.query = Some("alpha omega".into());
        let result = app.execute(&read, None, NOW).unwrap();
        let field = if operation == "item search" {
            "items"
        } else {
            "cards"
        };
        assert_eq!(
            result[field].as_array().unwrap().len(),
            1,
            "all user search terms occur in this work item"
        );
    }
}

#[test]
fn rich_search_pages_fit_output_budget_and_return_every_match() {
    let (directory, app) = fixture();
    let source_publisher = publisher(&app, "Rich search sources");
    for number in 0..20 {
        todo(&app, &format!("Rich searchable item {number}"));
    }
    drop(app);
    let repository = SqliteDynaRepository::open(directory.path()).unwrap();
    repository.write("fixture", |state| {
        for (item_index, item) in state.items.values_mut().enumerate() {
            for number in 0..32 {
                let reference = json!({"source":"gitlab","instanceId":"https://gitlab.example.test","projectPath":format!("team/{}/service", "雪".repeat(480)),"iid":1+item_index*32+number,"entityType":"merge_request"});
                dyna::evidence::validate_ref(&reference, false)?;
                item.contributions.push(SourceContribution {
                    publisher_id: source_publisher.clone(),
                    external_id: format!("record-{item_index}-{number}"),
                    record_key: dyna::evidence::record_key(&reference)?,
                    source_scope: "fixture".into(),
                    source_ref: reference.clone(),
                    payload: record(&format!("record-{item_index}-{number}"), reference),
                    observed_at: NOW.into(),
                    source_updated_at: NOW.into(),
                    freshness: "current".into(),
                    retired_at: None,
                });
            }
        }
        state.dashboard.revision += 1;
        Ok(())
    }).unwrap();
    let app = DynaApplication::new(repository);
    let mut read = request("item search");
    read.query = Some("Rich searchable".into());
    read.limit = Some(20);
    let mut found = BTreeSet::new();
    let mut pages = 0;
    loop {
        let result = app.execute(&read, None, NOW).unwrap();
        assert_eq!(result["total"], 20);
        for machine in [false, true] {
            let mut bytes = vec![];
            let printed = dyna::cli::print_result(&result, machine, &mut bytes);
            assert!(
                printed.is_ok(),
                "valid rich search needs a bounded page: {printed:?}"
            );
            assert!(bytes.len() <= dyna::contracts::MAX_STDOUT);
        }
        for item in result["items"].as_array().unwrap() {
            assert!(found.insert(item["id"].as_str().unwrap().to_string()));
        }
        pages += 1;
        read.cursor = result["nextCursor"].as_str().map(str::to_string);
        if read.cursor.is_none() {
            break;
        }
        assert!(pages < 50);
    }
    assert_eq!(found.len(), 20);
    assert!(pages > 1, "rich matching evidence must be byte-paged");
}

#[test]
fn stale_note_versions_are_atomic_and_exact_receipts_survive_later_edits() {
    let (_directory, app) = fixture();
    todo(&app, "Receipt edit fixture");
    let initial = snapshot(&app, NOW);
    let item = &initial["cards"][0];
    let added = app
        .execute(
            &item_request("annotation add", item, 1),
            Some(json!({"requestId":id("note-add"),"body":"Original"})),
            NOW,
        )
        .unwrap();
    let mut edit = item_request("annotation edit", item, 2);
    edit.annotation_id = added["annotationId"].as_str().map(str::to_string);
    edit.expected_annotation_version = Some(1);
    let edit_input = json!({"requestId":id("note-edit"),"body":"First edit"});
    let first = app.execute(&edit, Some(edit_input.clone()), NEXT).unwrap();
    let before = snapshot(&app, NEXT);
    assert_eq!(
        app.execute(
            &edit,
            Some(json!({"requestId":id("note-stale-edit"),"body":"Lost update"})),
            NEXT
        )
        .unwrap_err()
        .code,
        "stale_annotation"
    );
    assert_eq!(snapshot(&app, NEXT), before);
    let mut later = edit.clone();
    later.expected_annotation_version = Some(2);
    app.execute(
        &later,
        Some(json!({"requestId":id("note-later-edit"),"body":"Current edit"})),
        NEXT,
    )
    .unwrap();
    let latest = snapshot(&app, NEXT);
    let mut archive = item_request(
        "lifecycle archive",
        &latest["cards"][0],
        latest["revision"].as_u64().unwrap(),
    );
    app.execute(&archive, Some(json!({"requestId":id("archive-edited-note"),"reason":"no_action_needed","confirmed":true})), NEXT).unwrap();
    app.execute(
        &request("dashboard rename"),
        Some(json!({"requestId":id("rename-notes"),"key":"renamed"})),
        NEXT,
    )
    .unwrap();
    edit.dashboard = Some("renamed".into());
    archive.operation = "item show".into();
    archive.dashboard = Some("renamed".into());
    let before_replay = app.execute(&archive, None, NEXT).unwrap();
    let replay = app.execute(&edit, Some(edit_input), UNTIL).unwrap();
    assert_eq!(replay["deduplicated"], true);
    assert_eq!(replay["control"], first["control"]);
    assert_eq!(app.execute(&archive, None, NEXT).unwrap(), before_replay);
    assert_eq!(
        before_replay["item"]["annotations"][0]["body"],
        "Current edit"
    );
}

#[test]
fn completed_source_alias_followup_keeps_origin_and_numbered_history() {
    let (_directory, app) = fixture();
    let publisher = publisher(&app, "Alias follow-up sources");
    let before = two_independent_sources(&app, &publisher);
    let original = before["cards"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["title"] == "mr-2")
        .unwrap()
        .clone();
    app.execute(
        &item_request(
            "work complete",
            &original,
            before["revision"].as_u64().unwrap(),
        ),
        Some(json!({"requestId":id("complete-alias-original"),"outcome":"Released safely"})),
        NEXT,
    )
    .unwrap();
    publish(&app, &publisher, "correlate-completed", vec![related_mr(2)]);
    let merged = snapshot(&app, NEXT);
    let canonical = &merged["cards"][0];
    assert_eq!(canonical["workflowState"], "completed");
    assert_eq!(canonical["outcome"], "Released safely");
    let mut alias_read = request("item show");
    alias_read.item_id = original["id"].as_str().map(str::to_string);
    assert_eq!(
        app.execute(&alias_read, None, NEXT).unwrap()["item"]["id"],
        canonical["id"]
    );
    let stale = item_request(
        "follow-up create",
        &original,
        merged["revision"].as_u64().unwrap(),
    );
    assert_eq!(
        app.execute(
            &stale,
            Some(json!({"requestId":id("stale-alias-followup"),"title":"Follow-up"})),
            NEXT
        )
        .unwrap_err()
        .code,
        "stale_item"
    );
    let created = app
        .execute(
            &item_request(
                "follow-up create",
                canonical,
                merged["revision"].as_u64().unwrap(),
            ),
            Some(json!({"requestId":id("canonical-followup"),"title":"Follow-up"})),
            NEXT,
        )
        .unwrap();
    let after = snapshot(&app, NEXT);
    let followup = after["cards"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == created["itemId"])
        .unwrap();
    assert_eq!(followup["followUpOfItemId"], canonical["id"]);
    assert_eq!(followup["followUpOfItemNumber"], canonical["itemNumber"]);
    assert_ne!(followup["itemNumber"], canonical["itemNumber"]);
    alias_read.operation = "item history".into();
    let history = app.execute(&alias_read, None, NEXT).unwrap();
    assert!(
        history["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|event| event["kind"] == "work complete")
    );
    assert!(
        history["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|event| event["kind"] == "sources_merged")
    );
}
