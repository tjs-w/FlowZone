use dyna::application::{Request, project};
use dyna::contracts::*;
use dyna::repository::DynaRepository;
use dyna::{DynaApplication, SqliteDynaRepository};
use serde_json::{Value, json};
use std::process::{Command, Stdio};

const NOW: &str = "2026-10-01T10:00:00.000Z";
const LATER: &str = "2026-10-02T10:00:01.000Z";

fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn request(operation: &str, dashboard: Option<&str>) -> Request {
    Request {
        operation: operation.into(),
        dashboard: dashboard.map(str::to_string),
        ..Default::default()
    }
}
fn fixture() -> (tempfile::TempDir, DynaApplication<SqliteDynaRepository>) {
    let dir = tempfile::tempdir().unwrap();
    let app = DynaApplication::new(SqliteDynaRepository::open(dir.path()).unwrap());
    app.execute(
        &request("dashboard create", None),
        Some(json!({"requestId":id(),"key":"linus","name":"Linus Executive Action Queue"})),
        NOW,
    )
    .unwrap();
    (dir, app)
}
fn todo(app: &DynaApplication<SqliteDynaRepository>, dashboard: &str, title: &str) -> Value {
    app.execute(
        &request("todo create", Some(dashboard)),
        Some(json!({"requestId":id(),"title":title})),
        NOW,
    )
    .unwrap()
}
fn item_request(operation: &str, item: &Value, revision: u64) -> Request {
    Request {
        operation: operation.into(),
        dashboard: Some("linus".into()),
        item_id: item["itemId"].as_str().map(str::to_string),
        expected_fingerprint: item["fingerprint"].as_str().map(str::to_string),
        expected_revision: Some(revision),
        ..Default::default()
    }
}

#[test]
fn dashboards_are_independent_and_numbers_are_global_and_durable() {
    let (dir, app) = fixture();
    app.execute(
        &request("dashboard create", None),
        Some(json!({"requestId":id(),"key":"personal","name":"Personal"})),
        NOW,
    )
    .unwrap();
    let a = todo(&app, "linus", "Same external issue");
    let b = todo(&app, "personal", "Same external issue");
    assert_ne!(a["itemId"], b["itemId"]);
    assert_eq!(a["itemNumber"], 1);
    assert_eq!(b["itemNumber"], 2);
    drop(app);
    let app = DynaApplication::new(SqliteDynaRepository::open(dir.path()).unwrap());
    assert_eq!(todo(&app, "linus", "Next")["itemNumber"], 3);
    let list = app
        .execute(&request("dashboard list", None), None, NOW)
        .unwrap();
    assert!(
        list["dashboards"]
            .as_array()
            .unwrap()
            .iter()
            .any(|d| d["key"] == "linus" && d["database"] == "linus.sqlite3")
    );
    assert!(!list.to_string().contains(dir.path().to_str().unwrap()));
}

#[test]
fn exact_retry_returns_original_control_and_conflicting_reuse_is_atomic() {
    let (_dir, app) = fixture();
    let r = request("todo create", Some("linus"));
    let input = json!({"requestId":id(),"title":"Review release"});
    let first = app.execute(&r, Some(input.clone()), NOW).unwrap();
    let replay = app.execute(&r, Some(input.clone()), LATER).unwrap();
    assert_eq!(first["itemId"], replay["itemId"]);
    assert_eq!(first["itemNumber"], replay["itemNumber"]);
    assert_eq!(replay["deduplicated"], true);
    let mut conflict = input;
    conflict["title"] = json!("Different");
    assert_eq!(
        app.execute(&r, Some(conflict), NOW).unwrap_err().code,
        "request_conflict"
    );
    let show = app
        .execute(&request("dashboard show", Some("linus")), None, NOW)
        .unwrap();
    assert_eq!(show["counts"]["total"], 1);
    assert_eq!(show["revision"], 1);
}

#[test]
fn operator_can_work_without_task_attribution_and_mutation_output_is_redacted() {
    let (_dir, app) = fixture();
    let item = todo(&app, "linus", "Fix release");
    let update = app
        .execute(
            &item_request("work update", &item, 1),
            Some(json!({"requestId":id(),"kind":"progress","body":"PRIVATE durable milestone"})),
            NOW,
        )
        .unwrap();
    assert!(!update.to_string().contains("PRIVATE"));
    let complete = app
        .execute(
            &item_request("work complete", &item, 2),
            Some(json!({"requestId":id(),"outcome":"PRIVATE verified outcome"})),
            NOW,
        )
        .unwrap();
    assert_eq!(complete["control"]["lifecycle"], "completed");
    assert_eq!(complete["nativeSuccessCertified"], false);
    assert!(!complete.to_string().contains("PRIVATE"));
    let activity = app
        .execute(
            &Request {
                operation: "item activity".into(),
                ..item_request("item show", &item, 3)
            },
            None,
            NOW,
        )
        .unwrap();
    assert_eq!(activity["entries"].as_array().unwrap().len(), 2);
    assert!(activity.to_string().contains("PRIVATE durable milestone"));
}

#[test]
fn archive_retention_restore_followup_and_history_are_preserved() {
    let (_dir, app) = fixture();
    let item = todo(&app, "linus", "Ship");
    app.execute(
        &item_request("annotation add", &item, 1),
        Some(json!({"requestId":id(),"body":"Record decision"})),
        NOW,
    )
    .unwrap();
    app.execute(
        &item_request("work complete", &item, 2),
        Some(json!({"requestId":id(),"outcome":"Release verified"})),
        NOW,
    )
    .unwrap();
    let snapshot = app
        .execute(&request("dashboard snapshot", Some("linus")), None, LATER)
        .unwrap();
    assert_eq!(snapshot["counts"]["total"], 0);
    assert_eq!(snapshot["counts"]["archived"], 1);
    assert_eq!(snapshot["revision"], 4);
    let mut archive = request("item search", Some("linus"));
    archive.scope = Some("archive".into());
    archive.query = Some(":1:".into());
    assert_eq!(
        app.execute(&archive, None, LATER).unwrap()["items"][0]["itemNumber"],
        1
    );
    let follow = app
        .execute(
            &item_request("follow-up create", &item, 4),
            Some(json!({"requestId":id(),"title":"Deferred work"})),
            LATER,
        )
        .unwrap();
    assert_eq!(follow["itemNumber"], 2);
    let show = app
        .execute(&item_request("item show", &item, 5), None, LATER)
        .unwrap();
    assert_eq!(show["item"]["annotations"][0]["body"], "Record decision");
    assert_eq!(show["item"]["outcome"], "Release verified");
    assert_eq!(show["item"]["archive"]["reason"], "completed");
    assert_eq!(show["item"]["archive"]["mode"], "automatic");
    app.execute(
        &item_request("lifecycle restore", &item, 5),
        Some(json!({"requestId":id(),"confirmed":true})),
        LATER,
    )
    .unwrap();
    let snapshot = app
        .execute(&request("dashboard snapshot", Some("linus")), None, LATER)
        .unwrap();
    assert_eq!(snapshot["counts"]["total"], 2);
}

#[test]
fn archive_disposition_does_not_complete_work() {
    let (_dir, app) = fixture();
    let item = todo(&app, "linus", "Duplicate");
    app.execute(
        &item_request("lifecycle archive", &item, 1),
        Some(json!({"requestId":id(),"reason":"duplicate","confirmed":true})),
        NOW,
    )
    .unwrap();
    let archived = app
        .execute(&item_request("item show", &item, 2), None, NOW)
        .unwrap();
    assert_eq!(archived["item"]["workflowState"], "todo");
    assert_eq!(archived["item"]["archive"]["reason"], "duplicate");
    app.execute(
        &item_request("lifecycle restore", &item, 2),
        Some(json!({"requestId":id(),"confirmed":true})),
        NOW,
    )
    .unwrap();
    assert_eq!(
        app.execute(&item_request("item show", &item, 3), None, NOW)
            .unwrap()["item"]["workflowState"],
        "todo"
    );
}

#[test]
fn bulk_placement_validates_every_member_before_writing() {
    let (_dir, app) = fixture();
    let a = todo(&app, "linus", "A");
    let b = todo(&app, "linus", "B");
    let r = Request {
        expected_revision: Some(2),
        ..request("organize place-many", Some("linus"))
    };
    let mut input = json!({"requestId":id(),"priority":"critical","items":[{"itemId":a["itemId"],"fingerprint":a["fingerprint"]},{"itemId":b["itemId"],"fingerprint":"stale"}]});
    assert_eq!(
        app.execute(&r, Some(input.clone()), NOW).unwrap_err().code,
        "stale_item"
    );
    assert_eq!(
        app.execute(&request("dashboard show", Some("linus")), None, NOW)
            .unwrap()["revision"],
        2
    );
    input["items"][1]["fingerprint"] = b["fingerprint"].clone();
    let moved = app.execute(&r, Some(input), NOW).unwrap();
    assert_eq!(moved["updated"], 2);
    let snapshot = app
        .execute(&request("dashboard snapshot", Some("linus")), None, NOW)
        .unwrap();
    assert_eq!(snapshot["cards"][0]["id"], a["itemId"]);
    assert_eq!(snapshot["cards"][1]["id"], b["itemId"]);
    assert_eq!(snapshot["counts"]["critical"], 2);
}

#[test]
fn rename_retains_uuid_number_and_old_key_alias_without_changing_other_database() {
    let (dir, app) = fixture();
    let item = todo(&app, "linus", "Stable");
    let renamed = app
        .execute(
            &request("dashboard rename", Some("linus")),
            Some(json!({"requestId":id(),"key":"work","name":"Work"})),
            NOW,
        )
        .unwrap();
    assert_eq!(renamed["dashboard"]["database"], "work.sqlite3");
    assert!(!dir.path().join("dashboards/linus.sqlite3").exists());
    assert!(dir.path().join("dashboards/work.sqlite3").exists());
    let show = app
        .execute(&item_request("item show", &item, 1), None, NOW)
        .unwrap();
    assert_eq!(show["item"]["itemNumber"], 1);
    assert_eq!(show["dashboardKey"], "work");
    let second = app
        .execute(
            &request("dashboard create", None),
            Some(json!({"requestId":id(),"key":"linus","name":"Other"})),
            NOW,
        )
        .unwrap_err();
    assert_eq!(second.code, "reserved_key");
}

#[test]
fn integrity_and_coordinated_backup_include_all_files() {
    let (dir, app) = fixture();
    todo(&app, "linus", "Evidence");
    assert_eq!(
        app.execute(&request("maintenance integrity", None), None, NOW)
            .unwrap()["valid"],
        true
    );
    let backup = id();
    let result = app
        .execute(
            &request("maintenance backup", None),
            Some(json!({"requestId":backup})),
            NOW,
        )
        .unwrap();
    assert_eq!(result["complete"], true);
    assert!(
        dir.path()
            .join(format!("backups/{backup}/catalog.sqlite3"))
            .is_file()
    );
    assert!(
        dir.path()
            .join(format!("backups/{backup}/linus.sqlite3"))
            .is_file()
    );
    let replay = app
        .execute(
            &request("maintenance backup", None),
            Some(json!({"requestId":backup})),
            NOW,
        )
        .unwrap();
    assert_eq!(replay["deduplicated"], true);
    let interrupted = id();
    std::fs::create_dir(dir.path().join(format!("backups/{interrupted}"))).unwrap();
    assert_eq!(
        app.execute(
            &request("maintenance backup", None),
            Some(json!({"requestId":interrupted})),
            NOW
        )
        .unwrap_err()
        .code,
        "backup_incomplete"
    );
    std::fs::write(
        dir.path().join(format!("backups/{backup}/manifest.json")),
        b"{}",
    )
    .unwrap();
    assert!(
        app.execute(
            &request("maintenance backup", None),
            Some(json!({"requestId":backup})),
            NOW
        )
        .is_err()
    );
}

#[test]
fn terminal_eot_only_terminates_terminal_json() {
    assert_eq!(
        dyna::cli::read_input_mode(b"{\"body\":\"Hello\"}\x04".as_slice(), true).unwrap()["body"],
        "Hello"
    );
    assert!(dyna::cli::read_input(b"{}\x04".as_slice()).is_err());
    assert!(dyna::cli::read_input_mode(b"{\"body\":\"unfinished\x04".as_slice(), true).is_err());
    let long = format!("{{\"body\":\"{}\"}}\x04", "x".repeat(10_000));
    assert_eq!(
        dyna::cli::read_input_mode(long.as_bytes(), true).unwrap()["body"]
            .as_str()
            .unwrap()
            .len(),
        10_000
    );
}

#[test]
fn absent_catalog_is_not_recreated_with_reset_numbering() {
    let (dir, app) = fixture();
    todo(&app, "linus", "Permanent number");
    drop(app);
    std::fs::rename(
        dir.path().join("catalog.sqlite3"),
        dir.path().join("catalog.backup"),
    )
    .unwrap();
    assert!(
        matches!(SqliteDynaRepository::open(dir.path()),Err(error)if error.code=="catalog_missing")
    );
}

#[test]
fn unrelated_worker_cannot_mutate_or_administer_items() {
    let (_dir, app) = fixture();
    let item = todo(&app, "linus", "Own work");
    let r = Request {
        actor: Some(ActorKind::LinkedWorker),
        ..item_request("work update", &item, 1)
    };
    let result=app.execute(&r,Some(json!({"requestId":id(),"workAttemptId":id(),"task":{"taskId":"unrelated","hostId":"local"},"kind":"progress","body":"No"})),NOW).unwrap_err();
    assert_eq!(result.code, "forbidden");
    let r = Request {
        actor: Some(ActorKind::LinkedWorker),
        ..request("todo create", Some("linus"))
    };
    assert_eq!(
        app.execute(
            &r,
            Some(json!({"requestId":id(),"title":"Out of scope"})),
            NOW
        )
        .unwrap_err()
        .code,
        "forbidden"
    );
}

#[test]
fn native_status_and_task_reports_have_distinct_completion_authority() {
    let (dir, app) = fixture();
    let created = todo(&app, "linus", "Task");
    drop(app);
    let repository = SqliteDynaRepository::open(dir.path()).unwrap();
    let item_id = created["itemId"].as_str().unwrap();
    repository.reserve_task("linus", item_id, "task1").unwrap();
    repository
        .write("linus", |state| {
            let item = state.items.get_mut(item_id).unwrap();
            item.linked_tasks.push(TaskBinding {
                task_id: "task1".into(),
                host_id: "local".into(),
                title: ":1: Task".into(),
                state: "running".into(),
                status_updated_at: NOW.into(),
                observed_at: NOW.into(),
                outcome: None,
                title_sync_needed: false,
            });
            Ok(())
        })
        .unwrap();
    let app = DynaApplication::new(repository);
    let attempt = id();
    let r = Request {
        actor: Some(ActorKind::LinkedWorker),
        ..item_request("work update", &created, 1)
    };
    let report=app.execute(&r,Some(json!({"requestId":id(),"workAttemptId":attempt,"task":{"taskId":"task1","hostId":"local"},"kind":"completion_reported","body":"Ready","outcome":"Verified tests"})),"2026-10-01T10:01:00.000Z").unwrap();
    assert_eq!(report["control"]["lifecycle"], "executing");
    assert_eq!(report["control"]["condition"], "verification_pending");
    let show = app
        .execute(&item_request("item show", &created, 2), None, NOW)
        .unwrap();
    assert_eq!(show["item"]["linkedTasks"][0]["state"], "running");
}

#[test]
fn projector_rejects_archive_as_native_success() {
    let (dir, app) = fixture();
    let created = todo(&app, "linus", "Task");
    drop(app);
    let repository = SqliteDynaRepository::open(dir.path()).unwrap();
    let mut item = repository
        .read("linus", |state| {
            Ok(state.items[created["itemId"].as_str().unwrap()].clone())
        })
        .unwrap();
    item.linked_tasks.push(TaskBinding {
        task_id: "t".into(),
        host_id: "local".into(),
        title: ":1: Task".into(),
        state: "unknown".into(),
        status_updated_at: NOW.into(),
        observed_at: NOW.into(),
        outcome: None,
        title_sync_needed: false,
    });
    assert_eq!(project(&item).stage, "paused");
    item.linked_tasks[0].state = "succeeded".into();
    assert_eq!(project(&item).stage, "completed");
    item.manual_stage = Some("done".into());
    item.linked_tasks[0].state = "running".into();
    assert_eq!(project(&item).stage, "completed");
}

#[test]
#[cfg(feature = "isolated-tests")]
fn binary_is_standalone_with_empty_path_and_arbitrary_unicode_directory() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().join("other directory 日本語");
    std::fs::create_dir(&cwd).unwrap();
    let binary = env!("CARGO_BIN_EXE_dyna");
    let installed = cwd.join("dyna 🦀");
    std::fs::copy(binary, &installed).unwrap();
    let mut child = Command::new(&installed)
        .args(["dashboard", "create", "--json"])
        .env("DYNA_ISOLATED_TEST_HOME", dir.path())
        .env("PATH", "")
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    use std::io::Write;
    write!(
        child.stdin.take().unwrap(),
        "{}",
        json!({"requestId":id(),"key":"linus","name":"Linus"})
    )
    .unwrap();
    let result = child.wait_with_output().unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let list = Command::new(&installed)
        .args(["dashboard", "list", "--json"])
        .env("DYNA_ISOLATED_TEST_HOME", dir.path())
        .env("PATH", "")
        .current_dir(&cwd)
        .output()
        .unwrap();
    assert!(list.status.success());
    let parsed: Value = serde_json::from_slice(&list.stdout).unwrap();
    assert_eq!(parsed["dashboards"][0]["key"], "linus");
}

#[test]
fn strict_input_rejects_oversize_duplicates_and_multiple_objects() {
    for input in [
        b"{\"requestId\":\"a\",\"requestId\":\"b\"}".as_slice(),
        b"{\"x\":{\"y\":1,\"y\":2}}",
        b"{} {}",
        b"[]",
        b"{bad}",
    ] {
        assert!(dyna::cli::read_input(input).is_err());
    }
    assert!(dyna::cli::read_input(vec![b' '; MAX_STDIN + 1].as_slice()).is_err());
}

#[test]
fn cli_rejects_old_mutating_spellings_database_paths_and_duplicate_flags() {
    for args in [
        vec!["item", "update"],
        vec!["dashboard", "list", "--db", "/tmp/secret"],
        vec!["dashboard", "list", "--json", "--json"],
        vec![
            "item",
            "show",
            "--dashboard",
            "linus",
            "--dashboard-id",
            "bad",
            "--item-id",
            "bad",
        ],
    ] {
        assert!(dyna::cli::parse(&args.iter().map(|s| s.to_string()).collect::<Vec<_>>()).is_err());
    }
}

#[cfg(unix)]
#[test]
fn nonunicode_arguments_are_rejected_without_panic_or_echo() {
    use std::os::unix::ffi::OsStringExt;
    let output = Command::new(env!("CARGO_BIN_EXE_dyna"))
        .arg(std::ffi::OsString::from_vec(b"PRIVATE-ARG\xff".to_vec()))
        .arg("--json")
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(!error.contains("PRIVATE"));
    assert!(!error.contains("panicked"));
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stderr).unwrap()["error"]["code"],
        "invalid_input"
    );
}

#[test]
fn canonical_titles_are_exactly_once_and_unicode_bounded() {
    assert_eq!(
        canonical_task_title(184, ":20: :184:  Restore\n release"),
        ":184: Restore release"
    );
    assert_eq!(canonical_task_title(184, ""), ":184: Codex task");
    assert_eq!(
        canonical_task_title(184, &"🦀".repeat(300)).chars().count(),
        200
    );
}

#[test]
fn dashboard_admin_replay_hashes_all_fields_and_rename_does_not_repeat() {
    let (_dir, app) = fixture();
    let input = json!({"requestId":id(),"key":"personal","name":"Personal","description":"One","doneRetentionHours":12});
    app.execute(&request("dashboard create", None), Some(input.clone()), NOW)
        .unwrap();
    assert_eq!(
        app.execute(
            &request("dashboard create", None),
            Some(input.clone()),
            LATER
        )
        .unwrap()["deduplicated"],
        true
    );
    let mut conflict = input;
    conflict["description"] = json!("Changed");
    assert_eq!(
        app.execute(&request("dashboard create", None), Some(conflict), NOW)
            .unwrap_err()
            .code,
        "request_conflict"
    );
    let input = json!({"requestId":id(),"key":"work","name":"Work"});
    let rename = request("dashboard rename", Some("linus"));
    app.execute(&rename, Some(input.clone()), NOW).unwrap();
    app.execute(&rename, Some(input.clone()), LATER).unwrap();
    assert_eq!(
        app.execute(&request("dashboard show", Some("work")), None, NOW)
            .unwrap()["revision"],
        1
    );
    let mut conflict = input;
    conflict["key"] = json!("different");
    assert_eq!(
        app.execute(&rename, Some(conflict), NOW).unwrap_err().code,
        "request_conflict"
    );
}

#[test]
fn operator_blocker_input_and_progress_are_meaningful_without_codex() {
    let (_dir, app) = fixture();
    let item = todo(&app, "linus", "Decision");
    let r = item_request("work update", &item, 1);
    let blocked = app
        .execute(
            &r,
            Some(json!({"requestId":id(),"kind":"blocked","body":"Awaiting approval; ask owner"})),
            NOW,
        )
        .unwrap();
    assert_eq!(blocked["control"]["blocked"], true);
    assert_eq!(blocked["control"]["lifecycle"], "todo");
    let input = app
        .execute(
            &r,
            Some(json!({"requestId":id(),"kind":"needs_input","body":"Choose release branch"})),
            NOW,
        )
        .unwrap();
    assert_eq!(input["control"]["lifecycle"], "paused");
    let progress = app
        .execute(
            &r,
            Some(json!({"requestId":id(),"kind":"progress","body":"Decision received"})),
            NOW,
        )
        .unwrap();
    assert_eq!(progress["control"]["lifecycle"], "todo");
    assert_eq!(progress["control"]["blocked"], false);
}

#[test]
fn note_edit_delete_use_versions_and_retain_historical_bodies() {
    let (_dir, app) = fixture();
    let item = todo(&app, "linus", "Notes");
    let added = app
        .execute(
            &item_request("annotation add", &item, 1),
            Some(json!({"requestId":id(),"body":"Original decision"})),
            NOW,
        )
        .unwrap();
    let note = added["annotationId"].as_str().unwrap().to_string();
    let edit = Request {
        annotation_id: Some(note.clone()),
        expected_annotation_version: Some(1),
        ..item_request("annotation edit", &item, 2)
    };
    app.execute(
        &edit,
        Some(json!({"requestId":id(),"body":"Corrected decision"})),
        NOW,
    )
    .unwrap();
    assert_eq!(
        app.execute(
            &edit,
            Some(json!({"requestId":id(),"body":"Stale edit"})),
            NOW
        )
        .unwrap_err()
        .code,
        "stale_annotation"
    );
    let delete = Request {
        expected_annotation_version: Some(2),
        operation: "annotation delete".into(),
        ..edit
    };
    app.execute(&delete, Some(json!({"requestId":id()})), NOW)
        .unwrap();
    let show = app
        .execute(&item_request("item show", &item, 4), None, NOW)
        .unwrap();
    assert_eq!(show["item"]["annotations"].as_array().unwrap().len(), 0);
    let history = app
        .execute(&item_request("item history", &item, 4), None, NOW)
        .unwrap()
        .to_string();
    assert!(history.contains("Original decision"));
    assert!(history.contains("Corrected decision"));
}

#[test]
fn enrichment_is_patch_safe_strict_and_deadline_clear_is_explicit() {
    let (dir, app) = fixture();
    let item = todo(&app, "linus", "Plan");
    drop(app);
    let repo = SqliteDynaRepository::open(dir.path()).unwrap();
    repo.write("linus", |s| {
        s.items
            .get_mut(item["itemId"].as_str().unwrap())
            .unwrap()
            .due_at = Some(LATER.into());
        Ok(())
    })
    .unwrap();
    let app = DynaApplication::new(repo);
    let enrich = Request {
        expected_enrichment_version: Some(0),
        ..item_request("work enrich", &item, 1)
    };
    for invalid in [
        json!({"set":null}),
        json!({"set":[]}),
        json!({"set":{"people":[{"name":"CEO"}]}}),
        json!({"set":{"priority":"critical"}}),
    ] {
        let mut invalid = invalid;
        invalid["requestId"] = json!(id());
        assert!(app.execute(&enrich, Some(invalid), NOW).is_err());
    }
    app.execute(&enrich,Some(json!({"requestId":id(),"set":{"attention":"Decide deployment","plan":["Review evidence"]}})),NOW).unwrap();
    let enrich = Request {
        expected_enrichment_version: Some(1),
        ..enrich
    };
    app.execute(&enrich,Some(json!({"requestId":id(),"set":{"nextSteps":[{"label":"Verify staging"}]},"clear":["dueAt"]})),NOW).unwrap();
    let show = app
        .execute(&item_request("item show", &item, 3), None, NOW)
        .unwrap();
    assert_eq!(show["item"]["attention"], "Decide deployment");
    assert_eq!(show["item"]["plan"][0], "Review evidence");
    assert!(show["item"].get("dueAt").is_none());
}

#[test]
fn enrichment_patch_does_not_revalidate_stale_fields() {
    let (dir, app) = fixture();
    let item = todo(&app, "linus", "Plan");
    app.execute(
        &Request {
            expected_enrichment_version: Some(0),
            ..item_request("work enrich", &item, 1)
        },
        Some(json!({"requestId":id(),"set":{"attention":"Old evidence","plan":["Old plan"]}})),
        NOW,
    )
    .unwrap();
    drop(app);
    let repo = SqliteDynaRepository::open(dir.path()).unwrap();
    repo.write("linus", |s| {
        s.items
            .get_mut(item["itemId"].as_str().unwrap())
            .unwrap()
            .fingerprint = "a".repeat(64);
        Ok(())
    })
    .unwrap();
    let app = DynaApplication::new(repo);
    let r = Request {
        expected_fingerprint: Some("a".repeat(64)),
        expected_enrichment_version: Some(1),
        ..item_request("work enrich", &item, 2)
    };
    app.execute(
        &r,
        Some(json!({"requestId":id(),"set":{"summary":"New summary"}})),
        NOW,
    )
    .unwrap();
    let show = app
        .execute(&item_request("item show", &item, 3), None, NOW)
        .unwrap();
    assert_ne!(show["item"]["attention"], "Old evidence");
    assert!(show["item"]["plan"].as_array().unwrap().is_empty());
}

#[test]
fn activity_cursor_survives_new_entries_without_duplicates() {
    let (_dir, app) = fixture();
    let item = todo(&app, "linus", "History");
    let r = item_request("work update", &item, 1);
    for index in 0..3 {
        app.execute(
            &r,
            Some(json!({"requestId":id(),"kind":"note","body":format!("Milestone {index}")})),
            NOW,
        )
        .unwrap();
    }
    let read = Request {
        limit: Some(1),
        ..item_request("item activity", &item, 4)
    };
    let first = app.execute(&read, None, NOW).unwrap();
    app.execute(
        &r,
        Some(json!({"requestId":id(),"kind":"note","body":"New milestone"})),
        LATER,
    )
    .unwrap();
    let next = Request {
        cursor: first["nextCursor"].as_str().map(str::to_string),
        ..read
    };
    let second = app.execute(&next, None, NOW).unwrap();
    assert_eq!(first["entries"][0]["body"], "Milestone 2");
    assert_eq!(second["entries"][0]["body"], "Milestone 1");
}

#[test]
fn replay_survives_later_source_fingerprint_replacement() {
    let (dir, app) = fixture();
    let item = todo(&app, "linus", "History");
    let r = item_request("work update", &item, 1);
    let input = json!({"requestId":id(),"kind":"note","body":"Durable update"});
    app.execute(&r, Some(input.clone()), NOW).unwrap();
    drop(app);
    let repo = SqliteDynaRepository::open(dir.path()).unwrap();
    repo.write("linus", |s| {
        s.items
            .get_mut(item["itemId"].as_str().unwrap())
            .unwrap()
            .fingerprint = "f".repeat(64);
        Ok(())
    })
    .unwrap();
    let app = DynaApplication::new(repo);
    assert_eq!(
        app.execute(&r, Some(input), LATER).unwrap()["deduplicated"],
        true
    );
}

#[test]
fn artifact_validation_rejects_malformed_and_active_urls() {
    for url in [
        "javascript:alert(1)",
        "https://",
        "https://?path",
        "https://user:secret@host/path",
        "https://host\\evil/path",
        "https://host:bad/path",
        "https://[invalid]/path",
    ] {
        assert!(
            Artifact {
                kind: "report".into(),
                label: "Evidence".into(),
                url: url.into()
            }
            .validate()
            .is_err(),
            "{url}"
        );
    }
    for url in [
        "https://example.com/report?x=1#summary",
        "http://127.0.0.1:123/path",
        "https://[::1]/path",
    ] {
        Artifact {
            kind: "report".into(),
            label: "Evidence".into(),
            url: url.into(),
        }
        .validate()
        .unwrap();
    }
}

#[test]
fn unknown_dashboard_does_not_create_a_database() {
    let (dir, app) = fixture();
    assert!(
        app.execute(&request("dashboard show", Some("typo")), None, NOW)
            .is_err()
    );
    assert!(!dir.path().join("dashboards/typo.sqlite3").exists());
}

#[test]
fn legacy_store_requires_explicit_migration_before_catalog_creation() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::File::create(dir.path().join("dyna.sqlite3")).unwrap();
    assert!(matches!(SqliteDynaRepository::open(dir.path()),Err(e)if e.code=="migration_required"));
    assert!(!dir.path().join("catalog.sqlite3").exists());
}

#[test]
fn independent_databases_cannot_reserve_one_native_task() {
    let (dir, app) = fixture();
    let a = todo(&app, "linus", "A");
    app.execute(
        &request("dashboard create", None),
        Some(json!({"requestId":id(),"key":"personal","name":"Personal"})),
        NOW,
    )
    .unwrap();
    let b = todo(&app, "personal", "B");
    drop(app);
    let repo = SqliteDynaRepository::open(dir.path()).unwrap();
    repo.reserve_task("linus", a["itemId"].as_str().unwrap(), "native-task")
        .unwrap();
    assert_eq!(
        repo.reserve_task("personal", b["itemId"].as_str().unwrap(), "native-task")
            .unwrap_err()
            .code,
        "task_owned"
    );
}

#[test]
fn global_work_attempt_cannot_change_task_or_dashboard() {
    let (dir, app) = fixture();
    let a = todo(&app, "linus", "A");
    app.execute(
        &request("dashboard create", None),
        Some(json!({"requestId":id(),"key":"personal","name":"Personal"})),
        NOW,
    )
    .unwrap();
    let b = todo(&app, "personal", "B");
    drop(app);
    let repo = SqliteDynaRepository::open(dir.path()).unwrap();
    let actor = Actor {
        kind: ActorKind::LinkedWorker,
        task_id: Some("first".into()),
        host_id: Some("local".into()),
        work_attempt_id: Some(id()),
    };
    repo.reserve_attempt("linus", a["itemId"].as_str().unwrap(), &actor)
        .unwrap();
    assert_eq!(
        repo.reserve_attempt("personal", b["itemId"].as_str().unwrap(), &actor)
            .unwrap_err()
            .code,
        "forbidden"
    );
}

#[test]
fn manual_todo_and_native_waiting_precedence_are_explicit() {
    let (dir, app) = fixture();
    let item = todo(&app, "linus", "Task");
    drop(app);
    let repo = SqliteDynaRepository::open(dir.path()).unwrap();
    repo.reserve_task("linus", item["itemId"].as_str().unwrap(), "task")
        .unwrap();
    repo.write("linus", |s| {
        s.items
            .get_mut(item["itemId"].as_str().unwrap())
            .unwrap()
            .linked_tasks
            .push(TaskBinding {
                task_id: "task".into(),
                host_id: "local".into(),
                title: ":1: Task".into(),
                state: "waiting".into(),
                status_updated_at: NOW.into(),
                observed_at: NOW.into(),
                outcome: None,
                title_sync_needed: false,
            });
        Ok(())
    })
    .unwrap();
    let app = DynaApplication::new(repo);
    let update=app.execute(&item_request("work update",&item,1),Some(json!({"requestId":id(),"kind":"progress","body":"Progress does not clear native waiting"})),LATER).unwrap();
    assert_eq!(update["control"]["lifecycle"], "paused");
    let change = app
        .execute(
            &item_request("lifecycle stage", &item, 2),
            Some(json!({"requestId":id(),"stage":"todo"})),
            LATER,
        )
        .unwrap();
    assert_eq!(change["control"]["lifecycle"], "todo");
    assert!(
        app.execute(
            &item_request("lifecycle stage", &item, 3),
            Some(json!({"requestId":id(),"stage":"done","outcome":"not\none line"})),
            LATER
        )
        .is_err()
    );
}

#[test]
fn no_integration_operation_claims_native_success() {
    let (_dir, app) = fixture();
    let status = app
        .execute(&request("codex status", None), None, NOW)
        .unwrap();
    assert_eq!(status["available"], false);
    assert_eq!(
        app.execute(&request("codex rename", None), None, NOW)
            .unwrap_err()
            .code,
        "integration_unavailable"
    );
}

#[test]
#[cfg(unix)]
fn terminal_echo_is_restored_after_interrupt() {
    use std::os::fd::FromRawFd;
    let mut master = 0;
    let mut slave = 0;
    assert_eq!(
        unsafe {
            libc::openpty(
                &mut master,
                &mut slave,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        },
        0
    );
    unsafe {
        libc::fcntl(master, libc::F_SETFD, libc::FD_CLOEXEC);
        libc::fcntl(slave, libc::F_SETFD, libc::FD_CLOEXEC);
    }
    let master = unsafe { std::fs::File::from_raw_fd(master) };
    let slave = unsafe { std::fs::File::from_raw_fd(slave) };
    use std::os::fd::AsRawFd;
    let child = Command::new(env!("CARGO_BIN_EXE_dyna"))
        .args(["todo", "create", "--dashboard", "linus", "--json"])
        .stdin(Stdio::from(slave))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut state = unsafe { std::mem::zeroed::<libc::termios>() };
    let mut quiet = false;
    for _ in 0..200 {
        unsafe { libc::tcgetattr(master.as_raw_fd(), &mut state) };
        if state.c_lflag & libc::ECHO == 0 {
            quiet = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    assert!(quiet, "child must disable echo before input");
    use std::io::Write;
    write!(&master, "PRIVATE-NOTE-NOT-FOR-LOGS").unwrap();
    unsafe { libc::kill(child.id() as i32, libc::SIGINT) };
    let output = child.wait_with_output().unwrap();
    unsafe { libc::tcgetattr(master.as_raw_fd(), &mut state) };
    assert_ne!(state.c_lflag & libc::ECHO, 0);
    assert!(!String::from_utf8_lossy(&output.stderr).contains("PRIVATE"));
    assert!(output.stdout.is_empty());
}

#[cfg(all(unix, feature = "isolated-tests"))]
#[test]
fn terminal_accepts_long_json_without_echo_and_restores_canonical_mode() {
    use std::io::{Read, Write};
    use std::os::fd::{AsRawFd, FromRawFd};
    let dir = tempfile::tempdir().unwrap();
    let app = DynaApplication::new(
        SqliteDynaRepository::open(dir.path().join("flowzone-fixture")).unwrap(),
    );
    app.execute(
        &request("dashboard create", None),
        Some(json!({"requestId":id(),"key":"linus","name":"Linus"})),
        NOW,
    )
    .unwrap();
    let (mut master, mut slave) = (0, 0);
    assert_eq!(
        unsafe {
            libc::openpty(
                &mut master,
                &mut slave,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        },
        0
    );
    unsafe {
        libc::fcntl(master, libc::F_SETFD, libc::FD_CLOEXEC);
        libc::fcntl(slave, libc::F_SETFD, libc::FD_CLOEXEC);
    }
    let mut master = unsafe { std::fs::File::from_raw_fd(master) };
    let slave = unsafe { std::fs::File::from_raw_fd(slave) };
    let mut child = Command::new(env!("CARGO_BIN_EXE_dyna"))
        .args(["todo", "create", "--dashboard", "linus", "--json"])
        .env("DYNA_ISOLATED_TEST_HOME", dir.path())
        .env("PATH", "")
        .stdin(Stdio::from(slave))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut state = unsafe { std::mem::zeroed::<libc::termios>() };
    let mut quiet = false;
    for _ in 0..200 {
        unsafe { libc::tcgetattr(master.as_raw_fd(), &mut state) };
        if state.c_lflag & (libc::ECHO | libc::ICANON) == 0 {
            quiet = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    assert!(quiet);
    let input = format!(
        "{}{}\x04",
        " ".repeat(12_000),
        json!({"requestId":id(),"title":"Long terminal submission","summary":"PRIVATE-BODY-NOT-FOR-LOGS"})
    );
    master.write_all(input.as_bytes()).unwrap();
    let mut exited = false;
    for _ in 0..1000 {
        if child.try_wait().unwrap().is_some() {
            exited = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    if !exited {
        child.kill().unwrap();
    }
    let output = child.wait_with_output().unwrap();
    assert!(exited, "long JSON followed by EOT must finish");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!String::from_utf8_lossy(&output.stdout).contains("PRIVATE"));
    assert!(!String::from_utf8_lossy(&output.stderr).contains("PRIVATE"));
    unsafe {
        libc::tcgetattr(master.as_raw_fd(), &mut state);
        libc::fcntl(master.as_raw_fd(), libc::F_SETFL, libc::O_NONBLOCK);
    }
    assert_eq!(
        state.c_lflag & (libc::ECHO | libc::ICANON),
        libc::ECHO | libc::ICANON
    );
    let mut echoed = Vec::new();
    let _ = master.read_to_end(&mut echoed);
    assert!(echoed.is_empty(), "submitted terminal JSON must never echo");
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap()["itemNumber"],
        1
    );
}

#[test]
fn empty_or_missing_catalog_never_resets_an_initialized_store() {
    for keep_dashboards in [true, false] {
        let (dir, app) = fixture();
        todo(&app, "linus", "Allocated once");
        drop(app);
        if !keep_dashboards {
            for entry in std::fs::read_dir(dir.path().join("dashboards")).unwrap() {
                std::fs::remove_file(entry.unwrap().path()).unwrap();
            }
        }
        for filename in [
            "catalog.sqlite3",
            "catalog.sqlite3-wal",
            "catalog.sqlite3-shm",
        ] {
            let path = dir.path().join(filename);
            if path.exists() {
                std::fs::remove_file(path).unwrap();
            }
        }
        assert!(
            matches!(SqliteDynaRepository::open(dir.path()), Err(e) if e.code == "catalog_missing")
        );
        std::fs::File::create(dir.path().join("catalog.sqlite3")).unwrap();
        assert!(
            matches!(SqliteDynaRepository::open(dir.path()), Err(e) if e.code == "catalog_missing")
        );
    }
}

#[test]
fn damaged_dashboard_does_not_hide_healthy_dashboards() {
    let (dir, app) = fixture();
    app.execute(
        &request("dashboard create", None),
        Some(json!({"requestId":id(),"key":"personal","name":"Personal"})),
        NOW,
    )
    .unwrap();
    drop(app);
    std::fs::write(
        dir.path().join("dashboards/personal.sqlite3"),
        b"invalid database",
    )
    .unwrap();
    let app = DynaApplication::new(SqliteDynaRepository::open(dir.path()).unwrap());
    let list = app
        .execute(&request("dashboard list", None), None, NOW)
        .unwrap();
    let records = list["dashboards"].as_array().unwrap();
    assert_eq!(
        records.iter().find(|r| r["key"] == "linus").unwrap()["available"],
        true
    );
    assert_eq!(
        records.iter().find(|r| r["key"] == "personal").unwrap()["available"],
        false
    );
    todo(&app, "linus", "Still usable");
    assert!(
        app.execute(&request("dashboard show", Some("personal")), None, NOW)
            .is_err()
    );
    assert!(app.execute(&request("integrity", None), None, NOW).is_err());
}

#[test]
fn active_enrichment_projects_people_labels_reason_and_priority() {
    let (_dir, app) = fixture();
    let item = todo(&app, "linus", "VIP decision");
    let r = Request {
        expected_enrichment_version: Some(0),
        ..item_request("work enrich", &item, 1)
    };
    let people = json!([{"displayName":"CTO","leadershipLevel":"cto","relationship":"management_chain","involvement":"sender","provenance":"user_configured","confidence":"high"}]);
    app.execute(&r, Some(json!({"requestId":id(),"set":{"labels":["release"],"people":people,"priorityReason":"Direct CTO request"}})), NOW).unwrap();
    let show = app
        .execute(&item_request("item show", &item, 2), None, NOW)
        .unwrap();
    assert_eq!(show["item"]["labels"], json!(["release"]));
    assert_eq!(show["item"]["people"], people);
    assert_eq!(show["item"]["priorityReason"], "Direct CTO request");
    assert_eq!(show["item"]["leadershipScore"], 105);
    assert_eq!(show["item"]["priority"], "high");
    app.execute(
        &Request {
            expected_enrichment_version: Some(1),
            ..r.clone()
        },
        Some(json!({"requestId":id(),"set":{"attention":"Confirm release"}})),
        NOW,
    )
    .unwrap();
    let snapshot = app
        .execute(&request("dashboard snapshot", Some("linus")), None, NOW)
        .unwrap();
    assert_eq!(snapshot["cards"][0]["labels"], json!(["release"]));
    app.execute(
        &Request {
            expected_enrichment_version: Some(2),
            ..r
        },
        Some(json!({"requestId":id(),"clear":["people","labels","priorityReason"]})),
        NOW,
    )
    .unwrap();
    let show = app
        .execute(&item_request("item show", &item, 4), None, NOW)
        .unwrap();
    assert_eq!(show["item"]["labels"], json!([]));
    assert_eq!(show["item"]["people"], json!([]));
    assert_eq!(show["item"]["leadershipScore"], 0);
    assert_eq!(show["item"]["priority"], "normal");
}

#[test]
fn native_unknown_outranks_completion_report_and_obsolete_conditions_are_hidden() {
    let (dir, app) = fixture();
    let item = todo(&app, "linus", "Task");
    app.execute(&item_request("work update", &item, 1), Some(json!({"requestId":id(),"kind":"completion_reported","body":"Work reported","outcome":"Tests passed"})), "2026-10-01T10:01:00.000Z").unwrap();
    drop(app);
    let repo = SqliteDynaRepository::open(dir.path()).unwrap();
    repo.reserve_task("linus", item["itemId"].as_str().unwrap(), "unknown-task")
        .unwrap();
    repo.write("linus", |state| {
        state
            .items
            .get_mut(item["itemId"].as_str().unwrap())
            .unwrap()
            .linked_tasks
            .push(TaskBinding {
                task_id: "unknown-task".into(),
                host_id: "local".into(),
                title: ":1: Task".into(),
                state: "unknown".into(),
                status_updated_at: NOW.into(),
                observed_at: NOW.into(),
                outcome: None,
                title_sync_needed: false,
            });
        Ok(())
    })
    .unwrap();
    let app = DynaApplication::new(repo);
    let show = app
        .execute(&item_request("item show", &item, 2), None, NOW)
        .unwrap();
    assert_eq!(show["item"]["workflowState"], "paused");
    let blocked = app
        .execute(
            &item_request("work update", &item, 2),
            Some(json!({"requestId":id(),"kind":"blocked","body":"Old blocker"})),
            "2026-10-01T10:02:00.000Z",
        )
        .unwrap();
    let activity = app
        .execute(&item_request("item activity", &item, 3), None, NOW)
        .unwrap();
    let update_id = activity["entries"][0]["id"].as_str().unwrap();
    app.execute(&item_request("work update", &item, 3), Some(json!({"requestId":id(),"kind":"note","body":"Correction: no blocker","supersedesWorkUpdateId":update_id})), "2026-10-01T10:03:00.000Z").unwrap();
    let show = app
        .execute(&item_request("item show", &item, 4), None, NOW)
        .unwrap();
    assert_eq!(show["item"]["blocked"], false);
    assert_ne!(show["item"]["workConditionSummary"], "Old blocker");
    assert_eq!(blocked["control"]["blocked"], true);
    drop(app);
    let repo = SqliteDynaRepository::open(dir.path()).unwrap();
    repo.write("linus", |state| {
        state
            .items
            .get_mut(item["itemId"].as_str().unwrap())
            .unwrap()
            .linked_tasks[0]
            .observed_at = "2026-10-01T10:04:00.000Z".into();
        Ok(())
    })
    .unwrap();
    let app = DynaApplication::new(repo);
    let show = app
        .execute(&item_request("item show", &item, 4), None, NOW)
        .unwrap();
    assert!(show["item"].get("workState").is_none());
}

#[test]
fn completed_original_rejects_stage_changes_for_operators_and_linked_workers() {
    for actor in [ActorKind::LocalOperator, ActorKind::LinkedWorker] {
        for native_completion in [false, true] {
            let (dir, app) = fixture();
            let created = todo(&app, "linus", "Completed task");
            drop(app);
            let repo = SqliteDynaRepository::open(dir.path()).unwrap();
            let item_id = created["itemId"].as_str().unwrap();
            repo.reserve_task("linus", item_id, "verified-task")
                .unwrap();
            repo.write("linus", |state| {
                state
                    .items
                    .get_mut(item_id)
                    .unwrap()
                    .linked_tasks
                    .push(TaskBinding {
                        task_id: "verified-task".into(),
                        host_id: "local".into(),
                        title: canonical_task_title(
                            created["itemNumber"].as_i64().unwrap(),
                            "Completed task",
                        ),
                        state: if native_completion {
                            "succeeded"
                        } else {
                            "running"
                        }
                        .into(),
                        status_updated_at: NOW.into(),
                        observed_at: NOW.into(),
                        outcome: Some("Native result retained".into()),
                        title_sync_needed: false,
                    });
                Ok(())
            })
            .unwrap();
            let app = DynaApplication::new(repo);
            let attempt = id();
            let attributed = |mut body: Value| {
                if actor == ActorKind::LinkedWorker {
                    body["workAttemptId"] = json!(attempt);
                    body["task"] = json!({"taskId":"verified-task","hostId":"local"});
                }
                body
            };
            let mut completion_request = item_request("work complete", &created, 1);
            completion_request.actor = Some(actor.clone());
            if !native_completion {
                let body = attributed(
                    json!({"requestId":id(),"body":"Verified delivery","outcome":"Dyna result retained"}),
                );
                let result = app
                    .execute(&completion_request, Some(body.clone()), NOW)
                    .unwrap();
                assert_eq!(result["control"]["lifecycle"], "completed");
                assert_eq!(
                    app.execute(&completion_request, Some(body), NOW).unwrap()["deduplicated"],
                    true
                );
            }
            let show_request = item_request("item show", &created, 1);
            let before = app.execute(&show_request, None, NOW).unwrap();
            let history_before = app
                .execute(&item_request("item history", &created, 1), None, NOW)
                .unwrap();
            for stage in ["todo", "needs_you", "done"] {
                let mut mutation = item_request(
                    "lifecycle stage",
                    &created,
                    before["revision"].as_u64().unwrap(),
                );
                mutation.actor = Some(actor.clone());
                let body = attributed(
                    json!({"requestId":id(),"stage":stage,"outcome":"Must not overwrite outcome"}),
                );
                // Only Done accepts an outcome field.
                let mut body = body;
                if stage != "done" {
                    body.as_object_mut().unwrap().remove("outcome");
                }
                assert_eq!(
                    app.execute(&mutation, Some(body), "2026-10-01T10:01:00.000Z")
                        .unwrap_err()
                        .code,
                    "invalid_lifecycle"
                );
                assert_eq!(app.execute(&show_request, None, NOW).unwrap(), before);
                assert_eq!(
                    app.execute(&item_request("item history", &created, 1), None, NOW)
                        .unwrap(),
                    history_before
                );
            }
            let mut progress = item_request(
                "work update",
                &created,
                before["revision"].as_u64().unwrap(),
            );
            progress.actor = Some(actor.clone());
            assert_eq!(
                app.execute(
                    &progress,
                    Some(attributed(
                        json!({"requestId":id(),"kind":"progress","body":"Continued execution"})
                    )),
                    NOW
                )
                .unwrap_err()
                .code,
                "invalid_lifecycle"
            );
            let mut follow_up = item_request(
                "follow-up create",
                &created,
                before["revision"].as_u64().unwrap(),
            );
            follow_up.actor = Some(actor.clone());
            let next = app
                .execute(
                    &follow_up,
                    Some(attributed(
                        json!({"requestId":id(),"title":"Concrete deferred work"}),
                    )),
                    NOW,
                )
                .unwrap();
            assert_ne!(next["itemNumber"], created["itemNumber"]);
            assert_eq!(
                app.execute(&show_request, None, NOW).unwrap()["item"],
                before["item"]
            );
        }
    }
}

#[test]
fn backlog_projection_expires_at_the_same_instant_in_snapshot_and_item_show() {
    let (_dir, app) = fixture();
    let created = todo(&app, "linus", "Deferred work");
    let until = "2026-10-01T11:00:00.000Z";
    app.execute(
        &item_request("lifecycle backlog", &created, 1),
        Some(json!({"requestId":id(),"until":until})),
        NOW,
    )
    .unwrap();
    for (time, expected) in [
        (NOW, true),
        (until, false),
        ("2026-10-01T11:00:00.001Z", false),
    ] {
        let snapshot = app
            .execute(&request("dashboard snapshot", Some("linus")), None, time)
            .unwrap();
        let show = app
            .execute(&item_request("item show", &created, 2), None, time)
            .unwrap();
        assert_eq!(snapshot["counts"]["backlog"], usize::from(expected));
        assert_eq!(snapshot["cards"][0].get("backlog").is_some(), expected);
        assert_eq!(show["item"].get("backlog").is_some(), expected);
        assert_eq!(
            snapshot["revision"], 2,
            "expiry is a projection, not a write"
        );
    }
    app.execute(
        &item_request("lifecycle resume", &created, 2),
        Some(json!({"requestId":id()})),
        NOW,
    )
    .unwrap();
    assert!(
        app.execute(&item_request("item show", &created, 3), None, NOW)
            .unwrap()["item"]
            .get("backlog")
            .is_none()
    );
    app.execute(
        &item_request("lifecycle backlog", &created, 3),
        Some(json!({"requestId":id(),"until":until})),
        NOW,
    )
    .unwrap();
    app.execute(
        &item_request("work complete", &created, 4),
        Some(json!({"requestId":id(),"body":"Delivered","outcome":"Verified outcome"})),
        NOW,
    )
    .unwrap();
    assert!(
        app.execute(&item_request("item show", &created, 5), None, NOW)
            .unwrap()["item"]
            .get("backlog")
            .is_none()
    );
    app.execute(
        &item_request("lifecycle archive", &created, 5),
        Some(json!({"requestId":id(),"reason":"completed","confirmed":true})),
        NOW,
    )
    .unwrap();
    app.execute(
        &item_request("lifecycle restore", &created, 6),
        Some(json!({"requestId":id(),"confirmed":true})),
        NOW,
    )
    .unwrap();
    assert!(
        app.execute(&item_request("item show", &created, 7), None, NOW)
            .unwrap()["item"]
            .get("backlog")
            .is_none()
    );
}

#[test]
fn human_dashboard_labels_never_emit_terminal_controls() {
    let name = "Linus 雪\u{1b}]52;c;Y29weQ==\u{7}\r\u{7f}\u{202e}spoof";
    let value = json!({"dashboards":[{"key":"linus","name":name,"database":"linus.sqlite3","available":true}]});
    let mut output = Vec::new();
    dyna::cli::print_result(&value, false, &mut output).unwrap();
    let printed = String::from_utf8(output).unwrap();
    assert!(printed.contains("Linus 雪"));
    assert!(printed.contains(r"\u{1b}]52"));
    assert!(
        printed
            .trim_end_matches('\n')
            .chars()
            .all(|c| !c.is_control())
    );
    let picker_label = dyna::cli::terminal_label(name);
    assert!(picker_label.chars().all(|c| !c.is_control()));
    assert!(!picker_label.contains('\u{202e}'));
    let mut json_output = Vec::new();
    dyna::cli::print_result(&value, true, &mut json_output).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&json_output).unwrap(),
        value
    );
}

#[test]
#[cfg(not(feature = "isolated-tests"))]
fn production_binary_fails_closed_when_fixture_storage_is_requested() {
    let dir = tempfile::tempdir().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_dyna"))
        .args(["setup", "--json"])
        .env("DYNA_ISOLATED_TEST_HOME", dir.path())
        .output()
        .unwrap();
    assert!(!output.status.success());
    let error: Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(error["error"]["code"], "fixture_mode_unavailable");
    assert!(!dir.path().join("flowzone-fixture").exists());
}

#[test]
fn rich_dashboard_and_history_are_byte_paged_without_losing_entries() {
    let (dir, app) = fixture();
    let items = (0..12)
        .map(|i| todo(&app, "linus", &format!("Rich work {i}")))
        .collect::<Vec<_>>();
    drop(app);
    let repo = SqliteDynaRepository::open(dir.path()).unwrap();
    repo.write("linus", |state| {
        for item in state.items.values_mut() {
            for _ in 0..20 {
                item.annotations.push(Annotation {
                    id: id(),
                    body: "雪".repeat(1000),
                    version: 1,
                    created_at: NOW.into(),
                    updated_at: NOW.into(),
                    deleted_at: None,
                    actor: Actor::default(),
                });
            }
        }
        for _ in 0..40 {
            state.events.push(Event {
                id: id(),
                item_id: items[0]["itemId"].as_str().unwrap().into(),
                kind: "retained_evidence".into(),
                occurred_at: NOW.into(),
                actor: Actor::default(),
                data: json!({"evidence":"雪".repeat(8000)}),
            });
        }
        state.dashboard.revision += 1;
        Ok(())
    })
    .unwrap();
    let app = DynaApplication::new(repo);
    for (operation, field, expected_total) in [
        ("dashboard snapshot", "cards", 12),
        ("item history", "entries", 41),
    ] {
        let mut request = if operation == "dashboard snapshot" {
            request(operation, Some("linus"))
        } else {
            item_request(operation, &items[0], 13)
        };
        let mut ids = std::collections::BTreeSet::new();
        let mut pages = 0;
        loop {
            let result = app.execute(&request, None, NOW).unwrap();
            assert_eq!(result["total"], expected_total);
            for json_output in [false, true] {
                let mut bytes = Vec::new();
                dyna::cli::print_result(&result, json_output, &mut bytes).unwrap();
                assert!(bytes.len() <= MAX_STDOUT);
            }
            for entry in result[field].as_array().unwrap() {
                assert!(
                    ids.insert(entry["id"].as_str().unwrap().to_string()),
                    "no duplicate on next page"
                );
            }
            pages += 1;
            request.cursor = result["nextCursor"].as_str().map(str::to_string);
            assert_eq!(result["truncated"], request.cursor.is_some());
            if request.cursor.is_none() {
                break;
            }
            assert!(pages < 20);
        }
        assert_eq!(ids.len(), expected_total);
        assert!(
            pages > 1,
            "the byte budget, not only record count, must paginate"
        );
    }
}

#[test]
fn snapshot_pagination_is_bound_to_scope_query_and_dashboard_revision() {
    let (_dir, app) = fixture();
    todo(&app, "linus", "First");
    todo(&app, "linus", "Second");
    let mut read = request("dashboard snapshot", Some("linus"));
    read.limit = Some(1);
    let first = app.execute(&read, None, NOW).unwrap();
    assert_eq!(first["cards"].as_array().unwrap().len(), 1);
    read.cursor = first["nextCursor"].as_str().map(str::to_string);
    let second = app.execute(&read, None, NOW).unwrap();
    assert_ne!(first["cards"][0]["id"], second["cards"][0]["id"]);
    assert!(second["nextCursor"].is_null());
    for limit in [0, 201] {
        let mut invalid = request("dashboard snapshot", Some("linus"));
        invalid.limit = Some(limit);
        assert_eq!(
            app.execute(&invalid, None, NOW).unwrap_err().code,
            "invalid_input"
        );
    }
    let mut changed_scope = read.clone();
    changed_scope.scope = Some("archive".into());
    assert!(app.execute(&changed_scope, None, NOW).is_err());
    let mut changed_query = read.clone();
    changed_query.query = Some("First".into());
    assert!(app.execute(&changed_query, None, NOW).is_err());
    todo(&app, "linus", "Third");
    assert!(
        app.execute(&read, None, NOW).is_err(),
        "changing ordering/revision requires a fresh page"
    );
    let args = [
        "dashboard",
        "snapshot",
        "--dashboard",
        "linus",
        "--limit",
        "1",
        "--cursor",
        "bounded",
    ]
    .map(str::to_string);
    assert!(dyna::cli::parse(&args).is_ok());
}
