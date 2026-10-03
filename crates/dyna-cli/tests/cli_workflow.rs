#![cfg(feature = "isolated-tests")]

use serde_json::{Value, json};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};

struct InstalledCli {
    home: tempfile::TempDir,
    cwd: PathBuf,
    binary: PathBuf,
}

impl InstalledCli {
    fn new() -> Self {
        let home = tempfile::tempdir().unwrap();
        let cwd = home.path().join("arbitrary directory 日本語");
        std::fs::create_dir(&cwd).unwrap();
        let binary = cwd.join("dyna executable 🦀");
        std::fs::copy(env!("CARGO_BIN_EXE_dyna"), &binary).unwrap();
        Self { home, cwd, binary }
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(&self.binary);
        command
            .args(args)
            .arg("--json")
            .env_clear()
            .env("PATH", "")
            .env("DYNA_ISOLATED_TEST_HOME", self.home.path())
            .current_dir(&self.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }

    fn run(&self, args: &[&str], input: Option<Value>) -> Value {
        let mut child = self.command(args).spawn().unwrap();
        let bytes = input
            .as_ref()
            .map(|value| serde_json::to_vec(value).unwrap());
        if let Some(bytes) = &bytes {
            child.stdin.take().unwrap().write_all(bytes).unwrap();
        } else {
            drop(child.stdin.take());
        }
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            output.stderr.is_empty(),
            "Successful commands have no diagnostic output"
        );
        assert!(output.stdout.len() <= 512 * 1024);
        let value: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert!(value["schema"].as_str().unwrap().starts_with("dyna/"));
        // A mutation result is control metadata, not a second copy of submitted
        // notes, outcomes, titles, evidence or secrets.
        if let Some(input) = input {
            let stdout = String::from_utf8(output.stdout).unwrap();
            for field in ["body", "summary", "outcome"] {
                if let Some(text) = input[field].as_str().filter(|text| text.len() > 20) {
                    assert!(!stdout.contains(text), "Mutation echoed {field}");
                }
            }
        }
        value
    }

    fn show(&self, item_id: &str) -> Value {
        self.run(
            &["item", "show", "--dashboard", "linus", "--item-id", item_id],
            None,
        )
    }

    fn mutation(&self, words: &[&str], item_id: &str, mut input: Value, flags: &[&str]) -> Value {
        let show = self.show(item_id);
        let fingerprint = show["item"]["fingerprint"].as_str().unwrap();
        let mut args = words.to_vec();
        args.extend([
            "--dashboard",
            "linus",
            "--item-id",
            item_id,
            "--expected-fingerprint",
            fingerprint,
        ]);
        let revision = show["revision"].to_string();
        let enrichment = show["enrichmentVersion"].to_string();
        if matches!(words[0], "organize" | "lifecycle" | "follow-up") {
            args.extend(["--expected-revision", &revision]);
        }
        if words == ["work", "enrich"] {
            args.extend(["--expected-enrichment-version", &enrichment]);
        }
        args.extend_from_slice(flags);
        input["requestId"] = json!(uuid::Uuid::new_v4().to_string());
        self.run(&args, Some(input))
    }
}

fn request(input: Value) -> Value {
    let mut input = input;
    input["requestId"] = json!(uuid::Uuid::new_v4().to_string());
    input
}

#[test]
fn executable_manages_complete_ordinary_work_without_a_host_or_runtime() {
    let cli = InstalledCli::new();
    cli.run(&["setup"], None);
    let created = cli.run(
        &["dashboard", "create"],
        Some(request(
            json!({"key":"linus","name":"Linus Executive Action Queue"}),
        )),
    );
    let dashboard_id = created["dashboard"]["id"].as_str().unwrap();
    cli.run(
        &["dashboard", "create"],
        Some(request(json!({"key":"personal","name":"Personal"}))),
    );
    assert_eq!(
        cli.run(&["dashboard", "list"], None)["dashboards"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let first = cli.run(&["todo", "create", "--dashboard", "linus"], Some(request(json!({"title":"Decide release exception","summary":"A bounded standalone operator request for the next release."}))));
    let second = cli.run(
        &["todo", "create", "--dashboard", "linus"],
        Some(request(json!({"title":"Review migration MR"}))),
    );
    let item_id = first["itemId"].as_str().unwrap();
    let other_id = second["itemId"].as_str().unwrap();
    assert!(second["itemNumber"].as_i64().unwrap() > first["itemNumber"].as_i64().unwrap());
    let update = cli.mutation(&["work", "update"], item_id, json!({"kind":"blocked","body":"Waiting for release owner to approve the recovery path.","artifacts":[{"kind":"merge_request","label":"MR !123","url":"https://gitlab.example.com/team/project/-/merge_requests/123"}]}), &[]);
    assert_eq!(update["control"]["blocked"], true);
    let progress = cli.mutation(&["work", "update"], item_id, json!({"kind":"progress","body":"The release owner approved the recovery path; validation is running."}), &[]);
    assert_eq!(progress["control"]["blocked"], false);
    let note = cli.mutation(
        &["annotation", "add"],
        item_id,
        json!({"body":"Keep the rollback evidence with this decision."}),
        &[],
    );
    let annotation_id = note["annotationId"].as_str().unwrap();
    cli.mutation(
        &["annotation", "edit"],
        item_id,
        json!({"body":"Keep the verified rollback evidence with this decision."}),
        &[
            "--annotation-id",
            annotation_id,
            "--expected-annotation-version",
            "1",
        ],
    );
    cli.mutation(
        &["annotation", "delete"],
        item_id,
        json!({}),
        &[
            "--annotation-id",
            annotation_id,
            "--expected-annotation-version",
            "2",
        ],
    );
    cli.mutation(&["work", "enrich"], item_id, json!({"set":{"attention":"Choose the rollback-safe option.","plan":["Validate recovery","Record outcome"]}}), &[]);
    cli.mutation(
        &["work", "enrich"],
        item_id,
        json!({"set":{"labels":["release"]}}),
        &[],
    );
    assert_eq!(
        cli.show(item_id)["item"]["attention"],
        "Choose the rollback-safe option."
    );
    cli.mutation(
        &["organize", "place"],
        item_id,
        json!({"priority":"high","move":"first"}),
        &[],
    );
    let revision = cli.show(item_id)["revision"].to_string();
    cli.run(&["organize", "place-many", "--dashboard", "linus", "--expected-revision", &revision], Some(request(json!({"priority":"normal","items":[{"itemId":item_id,"fingerprint":first["fingerprint"]},{"itemId":other_id,"fingerprint":second["fingerprint"]}]}))));
    cli.mutation(&["lifecycle", "backlog"], other_id, json!({}), &[]);
    assert_eq!(
        cli.run(&["dashboard", "show", "--dashboard", "linus"], None)["counts"]["backlog"],
        1
    );
    cli.mutation(&["lifecycle", "resume"], other_id, json!({}), &[]);
    cli.mutation(
        &["lifecycle", "stage"],
        other_id,
        json!({"stage":"needs_you"}),
        &[],
    );
    cli.mutation(&["lifecycle", "stage"], other_id, json!({"stage":"done","outcome":"Migration review accepted with verified rollback evidence."}), &[]);
    let completion = cli.mutation(
        &["work", "complete"],
        item_id,
        json!({"outcome":"Release exception approved and recovery verified."}),
        &[],
    );
    assert_eq!(completion["control"]["lifecycle"], "completed");
    assert_eq!(completion["nativeSuccessCertified"], false);
    cli.mutation(
        &["lifecycle", "archive"],
        item_id,
        json!({"reason":"completed","confirmed":true}),
        &[],
    );
    assert_eq!(
        cli.run(
            &[
                "item",
                "search",
                "--dashboard",
                "linus",
                "--scope",
                "archive",
                "--query",
                "rollback"
            ],
            None
        )["total"],
        1
    );
    assert_eq!(
        cli.run(&["dashboard", "show", "--dashboard", "linus"], None)["counts"]["total"],
        1
    );
    let follow_up = cli.mutation(
        &["follow-up", "create"],
        item_id,
        json!({"title":"Validate the next release"}),
        &[],
    );
    assert!(follow_up["itemNumber"].as_i64().unwrap() > second["itemNumber"].as_i64().unwrap());
    assert_eq!(
        cli.show(follow_up["itemId"].as_str().unwrap())["item"]["followUpOfItemNumber"],
        first["itemNumber"]
    );
    cli.mutation(
        &["lifecycle", "restore"],
        item_id,
        json!({"confirmed":true}),
        &[],
    );
    assert_eq!(cli.show(item_id)["item"]["itemNumber"], first["itemNumber"]);
    let history = cli.run(
        &[
            "item",
            "history",
            "--dashboard",
            "linus",
            "--item-id",
            item_id,
            "--limit",
            "2",
        ],
        None,
    );
    let cursor = history["nextCursor"].as_str().unwrap();
    let next = cli.run(
        &[
            "item",
            "history",
            "--dashboard",
            "linus",
            "--item-id",
            item_id,
            "--limit",
            "2",
            "--cursor",
            cursor,
        ],
        None,
    );
    assert_ne!(history["entries"][0]["id"], next["entries"][0]["id"]);
    assert_eq!(
        cli.run(
            &[
                "item",
                "activity",
                "--dashboard",
                "linus",
                "--item-id",
                item_id
            ],
            None
        )["entries"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    assert_eq!(
        cli.run(
            &[
                "item",
                "sources",
                "--dashboard",
                "linus",
                "--item-id",
                item_id
            ],
            None
        )["entries"],
        json!([])
    );
    cli.run(
        &["dashboard", "rename", "--dashboard", "linus"],
        Some(request(json!({"key":"engineering","name":"Engineering"}))),
    );
    assert_eq!(
        cli.run(&["dashboard", "show", "--dashboard", "linus"], None)["dashboardKey"],
        "engineering"
    );
    assert_eq!(
        cli.run(&["dashboard", "show", "--dashboard", dashboard_id], None)["dashboardKey"],
        "engineering"
    );
    let revision =
        cli.run(&["dashboard", "show", "--dashboard", "engineering"], None)["revision"].to_string();
    let archive = cli.run(
        &[
            "dashboard",
            "archive",
            "--dashboard",
            "engineering",
            "--expected-revision",
            &revision,
        ],
        Some(request(json!({}))),
    );
    cli.run(
        &[
            "dashboard",
            "restore",
            "--dashboard",
            "engineering",
            "--expected-revision",
            &archive["revision"].to_string(),
        ],
        Some(request(json!({}))),
    );
    assert_eq!(cli.run(&["codex", "status"], None)["available"], false);
    cli.run(&["maintenance", "integrity"], None);
    assert_eq!(
        cli.run(&["maintenance", "backup"], Some(request(json!({}))))["complete"],
        true
    );
    cli.run(&["maintenance", "recover"], None);
}

#[test]
fn concurrent_process_creation_keeps_global_numbers_and_independent_dashboard_content() {
    let cli = InstalledCli::new();
    for dashboard in ["linus", "personal"] {
        cli.run(
            &["dashboard", "create"],
            Some(request(json!({"key":dashboard,"name":dashboard}))),
        );
    }
    let children = (0..16)
        .map(|index| {
            let dashboard = if index % 2 == 0 { "linus" } else { "personal" };
            let input = request(json!({"title":format!("Concurrent work {index}")}));
            let mut child = cli
                .command(&["todo", "create", "--dashboard", dashboard])
                .spawn()
                .unwrap();
            serde_json::to_writer(child.stdin.take().unwrap(), &input).unwrap();
            (child, dashboard, input)
        })
        .collect::<Vec<_>>();
    let mut numbers = std::collections::BTreeSet::new();
    let mut retries = Vec::new();
    for (child, dashboard, input) in children {
        let Output {
            status,
            stdout,
            stderr,
        } = child.wait_with_output().unwrap();
        if !status.success() {
            let error: Value = serde_json::from_slice(&stderr).unwrap();
            assert_eq!(error["error"]["code"], "busy");
            assert!(stdout.is_empty());
            retries.push((dashboard, input));
            continue;
        }
        let value: Value = serde_json::from_slice(&stdout).unwrap();
        assert!(numbers.insert(value["itemNumber"].as_i64().unwrap()));
    }
    // Contention is explicitly retryable. Reuse the exact request rather than
    // allocating a replacement request or silently bypassing the catalog lock.
    for (dashboard, input) in retries {
        let args = ["todo", "create", "--dashboard", dashboard];
        let result = cli.run(&args, Some(input.clone()));
        assert!(numbers.insert(result["itemNumber"].as_i64().unwrap()));
        let replay = cli.run(&args, Some(input));
        assert_eq!(replay["itemNumber"], result["itemNumber"]);
        assert_eq!(replay["deduplicated"], true);
    }
    assert_eq!(numbers.len(), 16);
    for dashboard in ["linus", "personal"] {
        assert_eq!(
            cli.run(&["dashboard", "show", "--dashboard", dashboard], None)["counts"]["total"],
            8
        );
    }
    cli.run(&["maintenance", "integrity"], None);
}

#[test]
fn executable_publishes_sources_and_reconciles_schedule_metadata_offline() {
    let cli = InstalledCli::new();
    cli.run(
        &["dashboard", "create"],
        Some(request(json!({"key":"linus","name":"Linus"}))),
    );
    let slices = json!([{"source":"gitlab","sourceScope":"service"}]);
    let publisher = cli.run(
        &["publisher", "setup", "--dashboard", "linus"],
        Some(request(
            json!({"name":"Release evidence","requiredSourceSlices":slices}),
        )),
    );
    let publisher_id = publisher["publisherId"].as_str().unwrap();
    let publisher_list = cli.run(&["publisher", "list", "--dashboard", "linus"], None);
    assert_eq!(publisher_list["publishers"][0]["id"], publisher_id);
    for (verb, state) in [("bind", "active"), ("reconcile", "paused")] {
        cli.run(&["schedule", verb, "--dashboard", "linus"], Some(request(json!({"publisherId":publisher_id,"scheduleId":"release-refresh","title":"Release refresh","state":state}))));
        assert_eq!(
            cli.run(&["schedule", "list", "--dashboard", "linus"], None)["schedules"][0]["state"],
            state
        );
    }
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let record = json!({"externalId":"mr-123","sourceRef":{"source":"gitlab","instanceId":"https://gitlab.example.com","projectPath":"team/service","iid":123,"entityType":"merge_request"},"sourceScope":"service","title":"Review the release migration","summary":"MR !123 requires a concrete release decision.","priority":"high","priorityReason":"Direct review request","sourceUpdatedAt":now});
    let publication = request(
        json!({"publisherId":publisher_id,"runId":"run-one","sourceCompletedAt":now,"sourceSlices":[{"source":"gitlab","sourceScope":"service","status":"succeeded"}],"items":[record]}),
    );
    let published = cli.run(
        &["publication", "publish", "--dashboard", "linus"],
        Some(publication.clone()),
    );
    assert_eq!(published["accepted"], 1);
    let replay = cli.run(
        &["publication", "publish", "--dashboard", "linus"],
        Some(publication),
    );
    assert_eq!(replay["deduplicated"], true);
    let initial = cli.run(&["dashboard", "snapshot", "--dashboard", "linus"], None);
    let card = &initial["cards"][0];
    let item_id = card["id"].as_str().unwrap();
    let sources = cli.run(
        &[
            "item",
            "sources",
            "--dashboard",
            "linus",
            "--item-id",
            item_id,
        ],
        None,
    );
    assert_eq!(sources["entries"].as_array().unwrap().len(), 1);
    let source_key = sources["entries"][0]["recordKey"].as_str().unwrap();
    assert_eq!(card["sources"][0]["navigation"], "link");
    let failure = request(
        json!({"publisherId":publisher_id,"runId":"run-two","sourceCompletedAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"status":"failed","sourceSlices":[{"source":"gitlab","sourceScope":"service","status":"failed"}],"items":[]}),
    );
    cli.run(
        &["publication", "publish", "--dashboard", "linus"],
        Some(failure),
    );
    let stale = cli.show(item_id);
    assert_eq!(stale["item"]["fingerprint"], card["fingerprint"]);
    assert_eq!(stale["item"]["sources"][0]["freshness"], "last_known");
    let omission = request(
        json!({"publisherId":publisher_id,"runId":"run-three","sourceCompletedAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"sourceSlices":[{"source":"gitlab","sourceScope":"service","status":"succeeded"}],"items":[]}),
    );
    cli.run(
        &["publication", "publish", "--dashboard", "linus"],
        Some(omission),
    );
    let retired = cli.show(item_id);
    assert_eq!(retired["item"]["itemNumber"], card["itemNumber"]);
    assert_eq!(retired["item"]["sourceState"], "none");
    assert_eq!(
        cli.run(
            &[
                "item",
                "sources",
                "--dashboard",
                "linus",
                "--item-id",
                item_id
            ],
            None
        )["entries"][0]["recordKey"],
        source_key
    );
    assert_eq!(
        cli.run(&["dashboard", "show", "--dashboard", "linus"], None)["counts"]["total"],
        1
    );
    cli.run(
        &["schedule", "unbind", "--dashboard", "linus"],
        Some(request(json!({"scheduleId":"release-refresh"}))),
    );
    assert_eq!(
        cli.run(&["schedule", "list", "--dashboard", "linus"], None)["schedules"],
        json!([])
    );
    cli.run(
        &["publisher", "revoke", "--dashboard", "linus"],
        Some(request(json!({"publisherId":publisher_id}))),
    );
    assert_eq!(
        cli.run(&["publisher", "list", "--dashboard", "linus"], None)["publishers"][0]["revoked"],
        true
    );
    cli.run(&["maintenance", "integrity"], None);
}
