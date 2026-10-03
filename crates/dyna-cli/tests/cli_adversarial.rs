#![cfg(feature = "isolated-tests")]

use serde_json::{Value, json};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};

// Each executable owns a disposable home. No command can select the installed
// store, and the copied path proves that execution never needs PATH lookup.
struct Cli {
    home: tempfile::TempDir,
    cwd: PathBuf,
    binary: PathBuf,
}

impl Cli {
    fn new() -> Self {
        let home = tempfile::tempdir().unwrap();
        let cwd = home.path().join("CLI adversarial 日本語 🦀");
        std::fs::create_dir(&cwd).unwrap();
        let binary = cwd.join("dyna standalone 雪");
        std::fs::copy(env!("CARGO_BIN_EXE_dyna"), &binary).unwrap();
        Self { home, cwd, binary }
    }

    fn command(&self, args: &[&str], machine: bool) -> Command {
        let mut command = Command::new(&self.binary);
        command.args(args);
        if machine {
            command.arg("--json");
        }
        command
            .env_clear()
            .env("PATH", "")
            .env("DYNA_ISOLATED_TEST_HOME", self.home.path())
            .current_dir(&self.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }

    fn run_command(mut command: Command, bytes: Option<&[u8]>) -> Output {
        let mut child = command.spawn().unwrap();
        if let Some(bytes) = bytes {
            if let Err(error) = child.stdin.take().unwrap().write_all(bytes) {
                assert_eq!(error.kind(), std::io::ErrorKind::BrokenPipe);
            }
        } else {
            drop(child.stdin.take());
        }
        child.wait_with_output().unwrap()
    }

    fn raw(&self, args: &[&str], bytes: Option<&[u8]>, machine: bool) -> Output {
        Self::run_command(self.command(args, machine), bytes)
    }

    fn run(&self, args: &[&str], input: Option<Value>) -> Value {
        let bytes = input
            .as_ref()
            .map(|value| serde_json::to_vec(value).unwrap());
        let output = self.raw(args, bytes.as_deref(), true);
        if let Some(input) = input {
            let text = String::from_utf8_lossy(&output.stdout);
            for field in ["title", "summary", "body", "outcome"] {
                if let Some(submitted) = input[field].as_str().filter(|s| s.len() > 24) {
                    assert!(!text.contains(submitted), "Mutation echoed {field}");
                }
            }
        }
        success(output)
    }

    fn create_dashboard(&self, key: &str) -> Value {
        self.run(
            &["dashboard", "create"],
            Some(request(
                json!({"key":key,"name":format!("Fixture {key} 雪")}),
            )),
        )
    }

    fn create_item(&self, key: &str, title: &str) -> Value {
        self.run(
            &["todo", "create", "--dashboard", key],
            Some(request(json!({"title":title}))),
        )
    }

    fn show(&self, key: &str, id: &str) -> Value {
        self.run(&["item", "show", "--dashboard", key, "--item-id", id], None)
    }

    fn mutation_args(&self, area: &str, operation: &str, key: &str, id: &str) -> Vec<String> {
        let shown = self.show(key, id);
        let mut args = vec![
            area.into(),
            operation.into(),
            "--dashboard".into(),
            key.into(),
            "--item-id".into(),
            id.into(),
            "--expected-fingerprint".into(),
            shown["item"]["fingerprint"].as_str().unwrap().into(),
        ];
        if matches!(area, "lifecycle" | "organize" | "follow-up") {
            args.extend(["--expected-revision".into(), shown["revision"].to_string()]);
        }
        if area == "work" && operation == "enrich" {
            args.extend([
                "--expected-enrichment-version".into(),
                shown["enrichmentVersion"].to_string(),
            ]);
        }
        args
    }
}

fn request(mut input: Value) -> Value {
    input["requestId"] = json!(uuid::Uuid::new_v4().to_string());
    input
}

fn refs(args: &[String]) -> Vec<&str> {
    args.iter().map(String::as_str).collect()
}

fn same_read_content(left: &Value, right: &Value) -> bool {
    let mut left = left.clone();
    let mut right = right.clone();
    // Two executable reads use different wall-clock instants. Only this
    // presentation timestamp is volatile; every durable field still compares.
    left.as_object_mut().unwrap().remove("generatedAt");
    right.as_object_mut().unwrap().remove("generatedAt");
    left == right
}

fn success(output: Output) -> Value {
    assert!(
        output.status.success(),
        "status {:?}, stderr {}",
        output.status.code(),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());
    assert!(output.stdout.len() <= dyna::contracts::MAX_STDOUT);
    assert_eq!(output.stdout.last(), Some(&b'\n'));
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(value["schema"].as_str().unwrap().starts_with("dyna/"));
    value
}

fn failure(output: Output, exit: i32, code: &str) -> Value {
    let error: Value = serde_json::from_slice(&output.stderr).unwrap_or_else(|_| {
        panic!(
            "non-JSON diagnostic: {}",
            String::from_utf8_lossy(&output.stderr)
        )
    });
    assert_eq!(error["schema"], "dyna/error-v1");
    assert_eq!(error["error"]["code"], code);
    assert_eq!(
        output.status.code(),
        Some(exit),
        "{code} must use its documented exit class; diagnostic {error}"
    );
    assert!(
        output.stdout.is_empty(),
        "failure must not emit success bytes"
    );
    assert!(output.stderr.len() < 2048);
    error
}

#[test]
fn executable_argument_rejections_are_static_and_leave_fixture_uninitialized() {
    let cli = Cli::new();
    let long = "private-fixture-argv".repeat(300);
    let many = vec!["private-fixture-argv"; 41];
    let malformed: Vec<Vec<&str>> = vec![
        vec!["dashboard", "list", "--json", "--json"],
        vec!["dashboard", "list", "--actor", "controller"],
        vec!["dashboard", "list", "--database", "private-fixture.sqlite3"],
        vec!["dashboard", "list", "--dashboard-id", "not-a-uuid"],
        vec!["item", "update", "--dashboard", "private-fixture-argv"],
        vec!["dashboard", "show", "--dashboard"],
        vec!["dashboard", "show", "--dashboard=private-fixture-argv"],
        vec![
            "dashboard",
            "show",
            "--dashboard",
            "one",
            "--dashboard",
            "two",
        ],
        vec![
            "dashboard",
            "show",
            "--dashboard",
            "one",
            "--dashboard-id",
            "two",
        ],
        vec![
            "dashboard",
            "snapshot",
            "--dashboard",
            "one",
            "--limit",
            "+1",
        ],
        vec![
            "dashboard",
            "snapshot",
            "--dashboard",
            "one",
            "--limit",
            "9007199254740992",
        ],
        vec!["dashboard", "show", "--dashboard", &long],
        many,
    ];
    for args in malformed {
        let error = failure(cli.raw(&args, None, true), 2, "invalid_input");
        assert!(!error.to_string().contains("private-fixture"));
        assert!(!cli.home.path().join("flowzone-fixture").exists());
    }
}

#[test]
fn pipe_json_rejects_equivalent_duplicate_keys_and_malformed_unicode_without_writes() {
    let cli = Cli::new();
    cli.create_dashboard("linus");
    let before = cli.run(&["dashboard", "show", "--dashboard", "linus"], None);
    let id = uuid::Uuid::new_v4().to_string();
    let valid = format!(r#"{{"requestId":"{id}","title":"private-fixture-body"}}"#);
    let mut oversized = valid.as_bytes().to_vec();
    oversized.resize(dyna::contracts::MAX_STDIN + 1, b' ');
    let malformed = vec![
        Vec::new(),
        b"[]".to_vec(),
        b"null".to_vec(),
        format!("{valid}{valid}").into_bytes(),
        format!("{valid}\x04").into_bytes(),
        format!("{valid}\0").into_bytes(),
        format!("\u{feff}{valid}").into_bytes(),
        format!(r#"{{"requestId":"{id}","title":"private-fixture-body","ti\u0074le":"other"}}"#).into_bytes(),
        format!(r#"{{"requestId":"{id}","title":"private-fixture-body","labels":[{{"x":1,"\u0078":2}}]}}"#).into_bytes(),
        format!(r#"{{"requestId":"{id}","title":"\ud800"}}"#).into_bytes(),
        format!(r#"{{"requestId":"{id}","title":"\udfff"}}"#).into_bytes(),
        format!(r#"{{"requestId":"{id}","title":"private-fixture-body"}},"#).into_bytes(),
        vec![b'{', b'"', 0xff, b'"', b':', b'1', b'}'],
        oversized,
    ];
    for bytes in malformed {
        let error = failure(
            cli.raw(
                &["todo", "create", "--dashboard", "linus"],
                Some(&bytes),
                true,
            ),
            2,
            "invalid_input",
        );
        assert!(!error.to_string().contains("private-fixture-body"));
        assert_eq!(
            cli.run(&["dashboard", "show", "--dashboard", "linus"], None),
            before
        );
    }
    let created = cli.run(
        &["todo", "create", "--dashboard", "linus"],
        Some(json!({"requestId":id,"title":"Valid retry after rejection"})),
    );
    assert_eq!(created["control"]["itemNumber"], 1);
}

#[test]
fn exact_stdin_byte_limit_accepts_unicode_then_rejects_one_extra_byte() {
    let cli = Cli::new();
    cli.create_dashboard("linus");
    let title = "🦀".repeat(200);
    let payload = request(json!({"title":title,"summary":"雪".repeat(1000)}));
    let mut exact = serde_json::to_vec(&payload).unwrap();
    exact.resize(dyna::contracts::MAX_STDIN, b' ');
    let created = success(cli.raw(
        &["todo", "create", "--dashboard", "linus"],
        Some(&exact),
        true,
    ));
    assert_eq!(
        cli.show("linus", created["itemId"].as_str().unwrap())["item"]["title"],
        title
    );
    exact.push(b' ');
    failure(
        cli.raw(
            &["todo", "create", "--dashboard", "linus"],
            Some(&exact),
            true,
        ),
        2,
        "invalid_input",
    );
    let second = cli.create_item("linus", "Next valid allocation");
    assert_eq!(second["control"]["itemNumber"], 2);
}

#[test]
fn invalid_semantic_create_does_not_consume_the_request_or_item_number() {
    let cli = Cli::new();
    cli.create_dashboard("linus");
    let mut payload = request(json!({"title":"Correctable fixture","labels":["雪".repeat(65)]}));
    let bytes = serde_json::to_vec(&payload).unwrap();
    failure(
        cli.raw(
            &["todo", "create", "--dashboard", "linus"],
            Some(&bytes),
            true,
        ),
        2,
        "invalid_input",
    );
    payload["labels"] = json!(["雪".repeat(64)]);
    let created = cli.run(
        &["todo", "create", "--dashboard", "linus"],
        Some(payload.clone()),
    );
    assert_eq!(created["control"]["itemNumber"], 1);
    let replay = cli.run(&["todo", "create", "--dashboard", "linus"], Some(payload));
    assert_eq!(replay["itemId"], created["itemId"]);
    assert_eq!(replay["deduplicated"], true);
}

#[test]
fn executable_errors_preserve_exit_classes_and_native_status_reports_unavailable() {
    let cli = Cli::new();
    cli.create_dashboard("linus");
    let created = cli.create_item("linus", "Error class fixture");
    let id = created["itemId"].as_str().unwrap();
    failure(
        cli.raw(&["dashboard", "show", "--dashboard", "absent"], None, true),
        3,
        "unknown_dashboard",
    );
    failure(
        cli.raw(
            &[
                "item",
                "show",
                "--dashboard",
                "linus",
                "--item-id",
                &uuid::Uuid::new_v4().to_string(),
            ],
            None,
            true,
        ),
        3,
        "not_found",
    );
    let bytes =
        serde_json::to_vec(&request(json!({"kind":"note","body":"Fixture message"}))).unwrap();
    failure(
        cli.raw(
            &[
                "work",
                "update",
                "--dashboard",
                "linus",
                "--item-id",
                id,
                "--expected-fingerprint",
                &"0".repeat(64),
            ],
            Some(&bytes),
            true,
        ),
        4,
        "stale_item",
    );
    let bytes = serde_json::to_vec(&request(json!({"title":"Forbidden fixture"}))).unwrap();
    failure(
        cli.raw(
            &[
                "todo",
                "create",
                "--dashboard",
                "linus",
                "--actor",
                "linked-worker",
            ],
            Some(&bytes),
            true,
        ),
        5,
        "forbidden",
    );
    let native = cli.run(&["codex", "status"], None);
    assert_eq!(native["available"], false);
    assert_eq!(native["state"], "unavailable");
}

#[test]
fn public_state_and_cursor_conflicts_use_conflict_exit_without_changing_work() {
    let cli = Cli::new();
    cli.create_dashboard("linus");
    let created = cli.create_item("linus", "State conflict fixture");
    let id = created["itemId"].as_str().unwrap();
    cli.create_item("linus", "Second fixture for paging");
    let mut observed = Vec::new();
    let first = cli.run(
        &[
            "dashboard",
            "snapshot",
            "--dashboard",
            "linus",
            "--limit",
            "1",
        ],
        None,
    );
    let cursor = first["nextCursor"].as_str().unwrap();
    cli.create_item("linus", "Revision-changing fixture");
    let output = cli.raw(
        &[
            "dashboard",
            "snapshot",
            "--dashboard",
            "linus",
            "--limit",
            "1",
            "--cursor",
            cursor,
        ],
        None,
        true,
    );
    let error: Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(error["error"]["code"], "stale_cursor");
    assert!(output.stdout.is_empty());
    observed.push(("stale_cursor", output.status.code()));

    let args = cli.mutation_args("lifecycle", "archive", "linus", id);
    cli.run(
        &refs(&args),
        Some(request(
            json!({"reason":"no_action_needed","confirmed":true}),
        )),
    );
    let before = cli.show("linus", id);
    let args = cli.mutation_args("work", "update", "linus", id);
    let bytes = serde_json::to_vec(&request(
        json!({"kind":"note","body":"Rejected archived fixture write"}),
    ))
    .unwrap();
    let output = cli.raw(&refs(&args), Some(&bytes), true);
    let error: Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(error["error"]["code"], "item_archived");
    assert!(output.stdout.is_empty());
    observed.push(("item_archived", output.status.code()));
    assert_eq!(cli.show("linus", id), before);

    let revision =
        cli.run(&["dashboard", "show", "--dashboard", "linus"], None)["revision"].to_string();
    cli.run(
        &[
            "dashboard",
            "archive",
            "--dashboard",
            "linus",
            "--expected-revision",
            &revision,
        ],
        Some(request(json!({}))),
    );
    let output = cli.raw(
        &["todo", "create", "--dashboard", "linus"],
        Some(
            &serde_json::to_vec(&request(
                json!({"title":"Rejected archived dashboard write"}),
            ))
            .unwrap(),
        ),
        true,
    );
    let error: Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(error["error"]["code"], "dashboard_archived");
    assert!(output.stdout.is_empty());
    observed.push(("dashboard_archived", output.status.code()));

    cli.create_dashboard("sources");
    let publisher = cli.run(
        &["publisher", "setup", "--dashboard", "sources"],
        Some(request(json!({"name":"Identity fixture"}))),
    );
    let record = |iid: u32| json!({"externalId":"same-external-id","sourceRef":{"source":"gitlab","instanceId":"https://gitlab.example.com","projectPath":"fixture/service","iid":iid,"entityType":"merge_request"},"sourceScope":"fixture","title":"Source identity fixture","summary":"Fixture-only independent work record","priority":"normal","priorityReason":"Fixture evidence","sourceUpdatedAt":"2026-09-01T00:00:00.000Z"});
    let publication = |run: &str, iid: u32| {
        request(
            json!({"publisherId":publisher["publisherId"],"runId":run,"mode":"upsert","sourceCompletedAt":"2026-09-02T00:00:00.000Z","items":[record(iid)]}),
        )
    };
    cli.run(
        &["publication", "publish", "--dashboard", "sources"],
        Some(publication("first", 1)),
    );
    let before = cli.run(&["dashboard", "snapshot", "--dashboard", "sources"], None);
    let output = cli.raw(
        &["publication", "publish", "--dashboard", "sources"],
        Some(&serde_json::to_vec(&publication("conflict", 2)).unwrap()),
        true,
    );
    let error: Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(error["error"]["code"], "record_identity_conflict");
    assert!(output.stdout.is_empty());
    observed.push(("record_identity_conflict", output.status.code()));
    assert!(
        same_read_content(
            &cli.run(&["dashboard", "snapshot", "--dashboard", "sources"], None),
            &before
        ),
        "Rejected publication changed durable snapshot content"
    );

    assert!(
        observed.iter().all(|(_, exit)| *exit == Some(4)),
        "public state/cursor conflicts must use conflict exit 4: {observed:?}"
    );
}

#[test]
fn semantic_user_errors_do_not_report_storage_or_internal_failure() {
    let cli = Cli::new();
    cli.create_dashboard("linus");
    let created = cli.create_item("linus", "Active fixture");
    let id = created["itemId"].as_str().unwrap();
    let before = cli.show("linus", id);
    let cases = [
        (
            "follow-up",
            "create",
            json!({"title":"Premature follow-up"}),
            "invalid_lifecycle",
        ),
        (
            "lifecycle",
            "archive",
            json!({"reason":"no_action_needed"}),
            "confirmation_required",
        ),
        (
            "work",
            "enrich",
            json!({"set":{"priority":"critical","priorityReason":"Fixture-only assertion"}}),
            "invalid_priority",
        ),
    ];
    let mut observed = Vec::new();
    for (area, operation, payload, code) in cases {
        let args = cli.mutation_args(area, operation, "linus", id);
        let bytes = serde_json::to_vec(&request(payload)).unwrap();
        let output = cli.raw(&refs(&args), Some(&bytes), true);
        let error: Value = serde_json::from_slice(&output.stderr).unwrap();
        assert_eq!(error["error"]["code"], code);
        assert!(output.stdout.is_empty());
        observed.push((code, output.status.code()));
        assert_eq!(
            cli.show("linus", id),
            before,
            "{code} mutated rejected work"
        );
    }
    assert!(
        observed.iter().all(|(_, exit)| *exit == Some(2)),
        "semantic request errors must use invalid-input exit 2, not storage/internal exit 1: {observed:?}"
    );
}

#[test]
fn unlinked_worker_and_local_operator_attribution_spoofing_are_rejected_atomically() {
    let cli = Cli::new();
    cli.create_dashboard("linus");
    let created = cli.create_item("linus", "Unlinked fixture");
    let id = created["itemId"].as_str().unwrap();
    let before = cli.show("linus", id);
    for actor in ["local-operator", "linked-worker"] {
        let mut args = cli.mutation_args("work", "update", "linus", id);
        args.extend(["--actor".into(), actor.into()]);
        let body = format!("Fixture-only private body {}", uuid::Uuid::new_v4());
        let bytes = serde_json::to_vec(&request(json!({"kind":"progress","body":body,"task":{"taskId":"unrelated","hostId":"local"},"workAttemptId":uuid::Uuid::new_v4().to_string()}))).unwrap();
        let (exit, code) = if actor == "local-operator" {
            (2, "invalid_input")
        } else {
            (5, "forbidden")
        };
        let error = failure(cli.raw(&refs(&args), Some(&bytes), true), exit, code);
        assert!(!error.to_string().contains(&body));
        assert_eq!(cli.show("linus", id), before);
    }
    let args = cli.mutation_args("work", "update", "linus", id);
    let body = request(
        json!({"kind":"progress","body":"Fixture-only body","actor":{"kind":"controller"}}),
    );
    failure(
        cli.raw(
            &refs(&args),
            Some(&serde_json::to_vec(&body).unwrap()),
            true,
        ),
        2,
        "invalid_input",
    );
    assert_eq!(cli.show("linus", id), before);
    let activity = cli.run(
        &["item", "activity", "--dashboard", "linus", "--item-id", id],
        None,
    );
    assert_eq!(activity["total"], 0);
}

#[test]
fn exact_replay_retains_original_control_after_later_work_and_conflicting_reuse_is_atomic() {
    let cli = Cli::new();
    let dashboard = cli.create_dashboard("linus");
    let created = cli.create_item("linus", "Replay fixture");
    let id = created["itemId"].as_str().unwrap();
    let args = cli.mutation_args("work", "update", "linus", id);
    let payload = request(json!({"kind":"progress","body":"Fixture-only original progress body"}));
    let first = cli.run(&refs(&args), Some(payload.clone()));
    let later = cli.mutation_args("work", "update", "linus", id);
    cli.run(
        &refs(&later),
        Some(request(
            json!({"kind":"blocked","body":"Fixture-only later blocker"}),
        )),
    );
    let before_replay = cli.show("linus", id);
    let replay = cli.run(&refs(&args), Some(payload.clone()));
    assert_eq!(replay["control"], first["control"]);
    assert_eq!(replay["deduplicated"], true);
    assert_eq!(cli.show("linus", id), before_replay);
    let mut conflicting = payload.clone();
    conflicting["body"] = json!("Fixture-only conflicting body");
    failure(
        cli.raw(
            &refs(&args),
            Some(&serde_json::to_vec(&conflicting).unwrap()),
            true,
        ),
        4,
        "request_conflict",
    );
    assert_eq!(cli.show("linus", id), before_replay);
    cli.run(
        &["dashboard", "rename", "--dashboard", "linus"],
        Some(request(json!({"key":"renamed"}))),
    );
    let mut alternate = args;
    alternate[3] = dashboard["dashboard"]["id"].as_str().unwrap().into();
    let replay = cli.run(&refs(&alternate), Some(payload));
    assert_eq!(replay["control"], first["control"]);
    let activity = cli.run(
        &[
            "item",
            "activity",
            "--dashboard",
            "renamed",
            "--item-id",
            id,
        ],
        None,
    );
    assert_eq!(activity["total"], 2);
    assert!(
        activity["entries"]
            .as_array()
            .unwrap()
            .iter()
            .all(|e| e["actor"]["kind"] == "local_operator" && e["actor"]["taskId"].is_null())
    );
}

#[cfg(unix)]
#[test]
fn retry_after_stdout_pipe_failure_returns_one_committed_item_without_private_echo() {
    use std::os::fd::FromRawFd;
    let cli = Cli::new();
    cli.create_dashboard("linus");
    let payload = request(
        json!({"title":"Broken pipe fixture","summary":"Fixture-only private summary that must never be diagnostic output"}),
    );
    let bytes = serde_json::to_vec(&payload).unwrap();
    let mut pipe = [0; 2];
    assert_eq!(unsafe { libc::pipe(pipe.as_mut_ptr()) }, 0);
    // Closing the sole reader makes the child's stdout fail with EPIPE.
    unsafe { libc::close(pipe[0]) };
    let writer = unsafe { std::fs::File::from_raw_fd(pipe[1]) };
    let mut command = cli.command(&["todo", "create", "--dashboard", "linus"], true);
    command.stdout(Stdio::from(writer));
    let error = failure(
        Cli::run_command(command, Some(&bytes)),
        1,
        "output_unavailable",
    );
    assert!(!error.to_string().contains("private summary"));
    let replay = cli.run(&["todo", "create", "--dashboard", "linus"], Some(payload));
    assert_eq!(replay["deduplicated"], true);
    assert_eq!(replay["control"]["itemNumber"], 1);
    let snapshot = cli.run(&["dashboard", "snapshot", "--dashboard", "linus"], None);
    assert_eq!(snapshot["total"], 1);
    let second = cli.create_item("linus", "Independent second allocation");
    assert_eq!(second["control"]["itemNumber"], 2);
}

#[test]
fn human_item_snapshot_and_history_escape_nested_terminal_controls() {
    let cli = Cli::new();
    cli.create_dashboard("linus");
    let title = "Visible 雪\u{009b}31m\u{202e}spoof\u{202c}\u{2066}isolated\u{2069}";
    let created = cli.create_item("linus", title);
    let id = created["itemId"].as_str().unwrap();
    let args = cli.mutation_args("annotation", "add", "linus", id);
    cli.run(
        &refs(&args),
        Some(request(
            json!({"body":"Note 雪\u{009d}52;c;fixture\u{009c}\u{200f}spoof"}),
        )),
    );
    assert_eq!(
        cli.show("linus", id)["item"]["title"],
        title,
        "JSON must retain source text"
    );
    let operations = [
        vec!["item", "show", "--dashboard", "linus", "--item-id", id],
        vec!["dashboard", "snapshot", "--dashboard", "linus"],
        vec!["item", "history", "--dashboard", "linus", "--item-id", id],
    ];
    let mut unsafe_outputs = Vec::new();
    for args in operations {
        let output = cli.raw(&args, None, false);
        assert!(output.status.success());
        assert!(output.stderr.is_empty());
        assert!(output.stdout.len() <= dyna::contracts::MAX_STDOUT);
        let text = String::from_utf8(output.stdout).unwrap();
        assert!(text.contains('雪'));
        let raw_controls: Vec<u32> = text.chars().filter(|c| {
            (c.is_control() && !matches!(c, '\n' | '\t')) || matches!(c, '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        }).map(u32::from).collect();
        if !raw_controls.is_empty() {
            unsafe_outputs.push((args[0..2].join(" "), raw_controls));
        }
    }
    assert!(
        unsafe_outputs.is_empty(),
        "untrusted nested text reached human terminal output as raw controls: {unsafe_outputs:?}"
    );
}

#[test]
fn rich_unicode_snapshots_are_byte_paged_completely_through_the_executable() {
    let cli = Cli::new();
    cli.create_dashboard("linus");
    let mut expected = std::collections::BTreeSet::new();
    for index in 0..8 {
        let created = cli.create_item("linus", &format!("Rich fixture {index} 雪"));
        let id = created["itemId"].as_str().unwrap();
        expected.insert(id.to_string());
        let args = cli.mutation_args("annotation", "add", "linus", id);
        for note in 0..20 {
            cli.run(
                &refs(&args),
                Some(request(
                    json!({"body":format!("{note:02}{}", "🦀".repeat(998))}),
                )),
            );
        }
    }
    let mut cursor = None::<String>;
    let mut observed = std::collections::BTreeSet::new();
    let mut pages = 0;
    loop {
        let mut args = vec![
            "dashboard",
            "snapshot",
            "--dashboard",
            "linus",
            "--limit",
            "200",
        ];
        if let Some(cursor) = cursor.as_deref() {
            args.extend(["--cursor", cursor]);
        }
        let page = cli.run(&args, None);
        let human = cli.raw(&args, None, false);
        assert!(
            human.status.success(),
            "{}",
            String::from_utf8_lossy(&human.stderr)
        );
        assert!(human.stdout.len() <= dyna::contracts::MAX_STDOUT);
        assert_eq!(page["total"], 8);
        for card in page["cards"].as_array().unwrap() {
            assert!(observed.insert(card["id"].as_str().unwrap().to_string()));
        }
        cursor = page["nextCursor"].as_str().map(str::to_string);
        assert_eq!(page["truncated"], cursor.is_some());
        pages += 1;
        assert!(pages <= 8);
        if cursor.is_none() {
            break;
        }
    }
    assert!(
        pages > 1,
        "rich multibyte evidence must exercise the byte boundary"
    );
    assert_eq!(observed, expected);
}

#[test]
fn escaped_control_rich_snapshots_fit_human_budget_and_round_trip_source_text() {
    let cli = Cli::new();
    cli.create_dashboard("linus");
    let mut expected = std::collections::BTreeSet::new();
    for index in 0..8 {
        let created = cli.create_item("linus", &format!("Control-rich fixture {index} 雪"));
        let id = created["itemId"].as_str().unwrap();
        expected.insert(id.to_string());
        let args = cli.mutation_args("annotation", "add", "linus", id);
        for note in 0..20 {
            cli.run(
                &refs(&args),
                Some(request(
                    json!({"body":format!("{note:02}{}", "\u{202e}".repeat(998))}),
                )),
            );
        }
    }
    let mut cursor = None::<String>;
    let mut observed = std::collections::BTreeSet::new();
    let mut pages = 0;
    loop {
        let mut args = vec![
            "dashboard",
            "snapshot",
            "--dashboard",
            "linus",
            "--limit",
            "200",
        ];
        if let Some(cursor) = cursor.as_deref() {
            args.extend(["--cursor", cursor]);
        }
        let page = cli.run(&args, None);
        let human = cli.raw(&args, None, false);
        assert!(
            human.status.success(),
            "escaped human page failed: {}",
            String::from_utf8_lossy(&human.stderr)
        );
        assert!(human.stdout.len() <= dyna::contracts::MAX_STDOUT);
        let human_text = std::str::from_utf8(&human.stdout).unwrap();
        assert!(
            !human_text.contains('\u{202e}'),
            "human evidence text must escape directional controls"
        );
        let round_trip: Value = serde_json::from_slice(&human.stdout).unwrap();
        assert!(
            same_read_content(&round_trip, &page),
            "Escaping changed original JSON source text or page contents"
        );
        for card in page["cards"].as_array().unwrap() {
            assert!(observed.insert(card["id"].as_str().unwrap().to_string()));
        }
        cursor = page["nextCursor"].as_str().map(str::to_string);
        assert_eq!(page["truncated"], cursor.is_some());
        pages += 1;
        assert!(pages <= 8);
        if cursor.is_none() {
            break;
        }
    }
    assert!(
        pages > 1,
        "human escaping expansion must exercise byte paging"
    );
    assert_eq!(observed, expected);
}

#[cfg(unix)]
#[test]
fn malformed_terminal_submission_restores_echo_and_never_echoes_private_body() {
    use std::io::Read;
    use std::os::fd::{AsRawFd, FromRawFd};
    let cli = Cli::new();
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
    let mut command = cli.command(&["todo", "create", "--dashboard", "linus"], true);
    command.stdin(Stdio::from(slave));
    let mut child = command.spawn().unwrap();
    let mut state = unsafe { std::mem::zeroed::<libc::termios>() };
    let mut quiet = false;
    for _ in 0..200 {
        assert_eq!(
            unsafe { libc::tcgetattr(master.as_raw_fd(), &mut state) },
            0
        );
        if state.c_lflag & (libc::ECHO | libc::ICANON) == 0 {
            quiet = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    if !quiet {
        child.kill().unwrap();
        child.wait().unwrap();
    }
    assert!(
        quiet,
        "CLI must enter non-echo mode before reading terminal JSON"
    );
    master
        .write_all(br#"{"title":"Fixture-only private terminal body","title":"duplicate"}"#)
        .unwrap();
    master.write_all(&[4]).unwrap();
    let mut finished = false;
    for _ in 0..1000 {
        if child.try_wait().unwrap().is_some() {
            finished = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    if !finished {
        child.kill().unwrap();
    }
    let output = child.wait_with_output().unwrap();
    assert!(finished, "malformed terminal JSON must terminate with EOT");
    let error = failure(output, 2, "invalid_input");
    assert!(!error.to_string().contains("private terminal body"));
    assert_eq!(
        unsafe { libc::tcgetattr(master.as_raw_fd(), &mut state) },
        0
    );
    assert_ne!(state.c_lflag & libc::ECHO, 0);
    assert_ne!(state.c_lflag & libc::ICANON, 0);
    unsafe { libc::fcntl(master.as_raw_fd(), libc::F_SETFL, libc::O_NONBLOCK) };
    let mut echoed = [0; 256];
    let count = master.read(&mut echoed).unwrap_or(0);
    assert_eq!(
        count, 0,
        "terminal must not have echoed malformed submitted body"
    );
    assert!(!cli.home.path().join("flowzone-fixture").exists());
}
