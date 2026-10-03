use dyna::application::Request;
use dyna::contracts::{Actor, ActorKind, TaskBinding, canonical_task_title};
use dyna::repository::DynaRepository;
use dyna::{DynaApplication, SqliteDynaRepository};
use serde_json::{Value, json};

const NOW: &str = "2026-10-01T10:00:00.000Z";
const NEXT: &str = "2026-10-01T11:00:00.000Z";
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn request(operation: &str) -> Request {
    Request {
        operation: operation.into(),
        dashboard: Some("linus".into()),
        ..Default::default()
    }
}
fn fixture() -> (
    tempfile::TempDir,
    DynaApplication<SqliteDynaRepository>,
    String,
) {
    let dir = tempfile::tempdir().unwrap();
    let app = DynaApplication::new(SqliteDynaRepository::open(dir.path()).unwrap());
    app.execute(
        &Request {
            operation: "dashboard create".into(),
            ..Default::default()
        },
        Some(json!({"requestId":id(),"key":"linus","name":"Linus"})),
        NOW,
    )
    .unwrap();
    let publisher=app.execute(&request("publisher setup"),Some(json!({"requestId":id(),"name":"Sources","requiredSourceSlices":slices("succeeded").iter().map(|s|json!({"source":s["source"],"sourceScope":s["sourceScope"]})).collect::<Vec<_>>()})),NOW).unwrap();
    (dir, app, publisher["publisherId"].as_str().unwrap().into())
}
fn jira(key: &str) -> Value {
    json!({"source":"twg","contextId":"https://jira.example.com","resultType":"jira","recordId":key})
}
fn mr(iid: u32) -> Value {
    json!({"source":"gitlab","instanceId":"https://gitlab.example.com","projectPath":"team/service","iid":iid,"entityType":"merge_request"})
}
fn slack() -> Value {
    json!({"source":"slack","workspaceId":"T12345678","channelId":"C12345678","messageId":"1790848800.000001"})
}
fn slices(status: &str) -> Vec<Value> {
    vec![
        json!({"source":"gitlab","sourceScope":"service","status":status}),
        json!({"source":"twg","sourceScope":"service","status":status}),
        json!({"source":"slack","sourceScope":"service","status":status}),
    ]
}
fn record(external: &str, reference: Value) -> Value {
    json!({"externalId":external,"sourceRef":reference,"sourceScope":"service","title":"Restore release path","summary":"Evidence for the release","priority":"high","priorityReason":"Direct request","sourceUpdatedAt":NOW})
}
fn related_mr(iid: u32, issue: &str) -> Value {
    let mut item = record(&format!("mr-{iid}"), mr(iid));
    item["relationships"] = json!([{"kind":"references_jira_issue","target":jira(issue),"evidence":{"field":"mr_reference","exactValue":issue}}]);
    item
}
fn payload(publisher: &str, records: Vec<Value>) -> Value {
    json!({"requestId":id(),"publisherId":publisher,"runId":id(),"sourceCompletedAt":NOW,"mode":"replace","status":"succeeded","sourceSlices":slices("succeeded"),"items":records})
}
fn snapshot(app: &DynaApplication<SqliteDynaRepository>) -> Value {
    app.execute(&request("dashboard snapshot"), None, NOW)
        .unwrap()
}

#[test]
fn exact_cross_source_work_keeps_one_card_and_four_distinct_links() {
    let (_dir, app, publisher) = fixture();
    let issue = record("jira-LIN-3087", jira("LIN-3087"));
    let mut message = record("slack-release", slack());
    message["relationships"] = json!([{"kind":"links_to_record","target":mr(1),"evidence":{"field":"message_link","exactValue":"https://gitlab.example.com/team/service/-/merge_requests/1"}}]);
    let mut input = payload(
        &publisher,
        vec![
            related_mr(1, "LIN-3087"),
            related_mr(2, "LIN-3087"),
            issue,
            message,
        ],
    );
    input["workSummaries"] = json!([{"workIdentity":jira("LIN-3087"),"summary":"Two MRs and the release decision concern the same issue.","evidenceRefs":[jira("LIN-3087"),mr(1),mr(2),slack()]}]);
    let result = app
        .execute(&request("publication publish"), Some(input), NOW)
        .unwrap();
    assert_eq!(result["accepted"], 4);
    let dashboard = snapshot(&app);
    assert_eq!(dashboard["counts"]["total"], 1);
    let card = &dashboard["cards"][0];
    assert_eq!(card["sources"].as_array().unwrap().len(), 4);
    assert!(
        card["sources"]
            .as_array()
            .unwrap()
            .iter()
            .all(|s| s["navigation"] == "link")
    );
    assert_eq!(card["summaryState"], "current");
    assert_eq!(card["groupingEvidence"][0]["collectorSupplied"], true);
    for source in card["sources"].as_array().unwrap() {
        assert!(dyna::evidence::source_url(&source["sourceRef"]).is_some());
    }
}

#[test]
fn multi_target_message_correlation_is_independent_of_input_order() {
    let permutations = [
        [0, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0],
    ];
    for common_issue in [false, true] {
        for order in permutations {
            let (_dir, app, publisher) = fixture();
            let mut message = record("slack-two-targets", slack());
            message["relationships"] = json!([
                {"kind":"links_to_record","target":mr(1),"evidence":{"field":"message_link","exactValue":"https://gitlab.example.com/team/service/-/merge_requests/1"}},
                {"kind":"links_to_record","target":mr(2),"evidence":{"field":"message_link","exactValue":"https://gitlab.example.com/team/service/-/merge_requests/2"}}
            ]);
            let records = if common_issue {
                [
                    related_mr(1, "LIN-3087"),
                    related_mr(2, "LIN-3087"),
                    message,
                ]
            } else {
                [record("mr-1", mr(1)), record("mr-2", mr(2)), message]
            };
            let input = payload(&publisher, order.map(|i| records[i].clone()).to_vec());
            app.execute(&request("publication publish"), Some(input), NOW)
                .unwrap();
            let dashboard = snapshot(&app);
            assert_eq!(
                dashboard["counts"]["total"],
                if common_issue { 1 } else { 3 },
                "order {order:?}, common anchor {common_issue}"
            );
            if common_issue {
                assert!(
                    dashboard["cards"][0]["sources"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .all(|source| source["correlationWarning"] == false)
                );
            } else {
                let message = dashboard["cards"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|card| card["source"] == "slack")
                    .unwrap();
                assert_eq!(message["sources"][0]["correlationWarning"], true);
            }
        }
    }
}

#[test]
fn newer_retired_or_failed_evidence_cannot_override_a_current_summary_citation() {
    for status in ["succeeded", "failed"] {
        let (_dir, app, publisher_a) = fixture();
        let publisher_b = app.execute(&request("publisher setup"), Some(json!({"requestId":id(),"name":"Other collector","requiredSourceSlices":slices("succeeded").iter().map(|s|json!({"source":s["source"],"sourceScope":s["sourceScope"]})).collect::<Vec<_>>()})), NOW).unwrap()["publisherId"].as_str().unwrap().to_string();
        app.execute(
            &request("publication publish"),
            Some(payload(&publisher_a, vec![record("a-mr", mr(1))])),
            NOW,
        )
        .unwrap();
        let mut newer = record("b-mr", mr(1));
        newer["sourceUpdatedAt"] = json!(NEXT);
        newer["summary"] = json!("Newer evidence from the second collector");
        let mut input = payload(&publisher_b, vec![newer]);
        input["sourceCompletedAt"] = json!(NEXT);
        app.execute(&request("publication publish"), Some(input), NEXT)
            .unwrap();
        let mut retire_or_fail = payload(&publisher_b, vec![]);
        retire_or_fail["status"] = json!(status);
        retire_or_fail["sourceSlices"] = json!(slices(status));
        retire_or_fail["sourceCompletedAt"] = json!("2026-10-01T12:00:00.000Z");
        app.execute(
            &request("publication publish"),
            Some(retire_or_fail),
            "2026-10-01T12:00:00.000Z",
        )
        .unwrap();
        let mut cited = payload(&publisher_a, vec![record("a-mr", mr(1))]);
        cited["sourceCompletedAt"] = json!("2026-10-01T13:00:00.000Z");
        cited["workSummaries"] = json!([{"workIdentity":mr(1),"summary":"Current first-collector evidence","evidenceRefs":[mr(1)]}]);
        app.execute(
            &request("publication publish"),
            Some(cited),
            "2026-10-01T13:00:00.000Z",
        )
        .unwrap();
        let dashboard = snapshot(&app);
        assert_eq!(
            dashboard["cards"][0]["summaryState"], "current",
            "second publisher {status}"
        );
        assert_eq!(
            dashboard["cards"][0]["summary"],
            "Current first-collector evidence"
        );
        assert_eq!(dashboard["cards"][0]["sources"][0]["freshness"], "current");
        let mut changed = record("a-mr", mr(1));
        changed["sourceUpdatedAt"] = json!("2026-10-01T14:00:00.000Z");
        changed["summary"] = json!("The actually cited fact changed");
        let mut input = payload(&publisher_a, vec![changed]);
        input["sourceCompletedAt"] = json!("2026-10-01T14:00:00.000Z");
        app.execute(
            &request("publication publish"),
            Some(input),
            "2026-10-01T14:00:00.000Z",
        )
        .unwrap();
        assert_eq!(snapshot(&app)["cards"][0]["summaryState"], "last_known");
    }
}

#[test]
fn previously_ambiguous_message_can_join_a_later_proven_common_anchor() {
    let (_dir, app, publisher) = fixture();
    let mut message = record("slack-two-targets", slack());
    message["relationships"] = json!([
        {"kind":"links_to_record","target":mr(1),"evidence":{"field":"message_link","exactValue":"https://gitlab.example.com/team/service/-/merge_requests/1"}},
        {"kind":"links_to_record","target":mr(2),"evidence":{"field":"message_link","exactValue":"https://gitlab.example.com/team/service/-/merge_requests/2"}}
    ]);
    app.execute(
        &request("publication publish"),
        Some(payload(
            &publisher,
            vec![
                message.clone(),
                record("mr-1", mr(1)),
                record("mr-2", mr(2)),
            ],
        )),
        NOW,
    )
    .unwrap();
    assert_eq!(snapshot(&app)["counts"]["total"], 3);
    let mut input = payload(
        &publisher,
        vec![
            message,
            related_mr(1, "LIN-3087"),
            related_mr(2, "LIN-3087"),
        ],
    );
    input["sourceCompletedAt"] = json!(NEXT);
    app.execute(&request("publication publish"), Some(input), NEXT)
        .unwrap();
    let dashboard = snapshot(&app);
    assert_eq!(dashboard["counts"]["total"], 1);
    assert_eq!(
        dashboard["cards"][0]["sources"].as_array().unwrap().len(),
        3
    );
}

#[test]
fn source_cursor_rejects_refresh_reordering_instead_of_silently_skipping_evidence() {
    let (_dir, app, publisher) = fixture();
    let input = payload(
        &publisher,
        vec![
            related_mr(1, "LIN-3087"),
            related_mr(2, "LIN-3087"),
            record("issue", jira("LIN-3087")),
        ],
    );
    app.execute(&request("publication publish"), Some(input), NOW)
        .unwrap();
    let item = &snapshot(&app)["cards"][0];
    let mut read = Request {
        item_id: item["id"].as_str().map(str::to_string),
        limit: Some(1),
        ..request("item sources")
    };
    let first = app.execute(&read, None, NOW).unwrap();
    assert_eq!(first["entries"][0]["externalId"], "mr-1");
    read.cursor = first["nextCursor"].as_str().map(str::to_string);
    let mut update = payload(&publisher, vec![related_mr(1, "LIN-3087")]);
    update["mode"] = json!("upsert");
    update["sourceCompletedAt"] = json!(NEXT);
    app.execute(&request("publication publish"), Some(update), NEXT)
        .unwrap();
    assert_eq!(
        app.execute(&read, None, NEXT).unwrap_err().code,
        "stale_cursor"
    );
    read.cursor = None;
    let mut evidence = std::collections::BTreeSet::new();
    loop {
        let page = app.execute(&read, None, NEXT).unwrap();
        for entry in page["entries"].as_array().unwrap() {
            assert!(evidence.insert(entry["externalId"].as_str().unwrap().to_string()));
        }
        read.cursor = page["nextCursor"].as_str().map(str::to_string);
        if read.cursor.is_none() {
            break;
        }
    }
    assert_eq!(
        evidence,
        ["mr-1", "mr-2", "issue"]
            .into_iter()
            .map(str::to_string)
            .collect()
    );
}

#[test]
fn outage_retains_stale_evidence_without_identity_or_fingerprint_churn() {
    let (_dir, app, publisher) = fixture();
    app.execute(
        &request("publication publish"),
        Some(payload(
            &publisher,
            vec![
                related_mr(1, "LIN-3087"),
                record("jira-LIN-3087", jira("LIN-3087")),
            ],
        )),
        NOW,
    )
    .unwrap();
    let before = snapshot(&app)["cards"][0].clone();
    let mut input = payload(&publisher, vec![related_mr(1, "LIN-3087")]);
    input["sourceCompletedAt"] = json!(NEXT);
    input["status"] = json!("partial");
    input["sourceSlices"][1]["status"] = json!("failed");
    app.execute(&request("publication publish"), Some(input), NEXT)
        .unwrap();
    let dashboard = app
        .execute(&request("dashboard snapshot"), None, NEXT)
        .unwrap();
    assert_eq!(dashboard["counts"]["total"], 1);
    let after = &dashboard["cards"][0];
    assert_eq!(after["id"], before["id"]);
    assert_eq!(after["itemNumber"], before["itemNumber"]);
    assert_eq!(after["fingerprint"], before["fingerprint"]);
    assert!(
        after["sources"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["sourceRef"]["source"] == "twg" && s["freshness"] == "last_known")
    );
    let mut recovered = payload(
        &publisher,
        vec![
            related_mr(1, "LIN-3087"),
            record("jira-LIN-3087", jira("LIN-3087")),
        ],
    );
    recovered["sourceCompletedAt"] = json!(NEXT);
    app.execute(&request("publication publish"), Some(recovered), NEXT)
        .unwrap();
    assert_eq!(
        snapshot(&app)["cards"][0]["itemNumber"],
        before["itemNumber"]
    );
}

#[test]
fn similar_titles_and_conflicting_jira_keys_never_merge() {
    let (_dir, app, publisher) = fixture();
    app.execute(
        &request("publication publish"),
        Some(payload(
            &publisher,
            vec![record("mr-1", mr(1)), record("mr-2", mr(2))],
        )),
        NOW,
    )
    .unwrap();
    assert_eq!(snapshot(&app)["counts"]["total"], 2);
    let mut conflicting = related_mr(3, "LIN-1");
    conflicting["relationships"].as_array_mut().unwrap().push(json!({"kind":"references_jira_issue","target":jira("LIN-2"),"evidence":{"field":"mr_reference","exactValue":"LIN-2"}}));
    let mut input = payload(&publisher, vec![conflicting]);
    input["mode"] = json!("upsert");
    app.execute(&request("publication publish"), Some(input), NOW)
        .unwrap();
    let cards = snapshot(&app)["cards"].as_array().unwrap().clone();
    assert_eq!(cards.len(), 3);
    assert!(
        cards
            .iter()
            .any(|c| c["sources"][0]["correlationWarning"] == true)
    );
}

#[test]
fn omission_retires_evidence_but_keeps_unfinished_card_and_links() {
    let (_dir, app, publisher) = fixture();
    app.execute(
        &request("publication publish"),
        Some(payload(&publisher, vec![record("mr-1", mr(1))])),
        NOW,
    )
    .unwrap();
    let before = snapshot(&app)["cards"][0].clone();
    let mut input = payload(&publisher, vec![]);
    input["sourceCompletedAt"] = json!(NEXT);
    app.execute(&request("publication publish"), Some(input), NEXT)
        .unwrap();
    let dashboard = snapshot(&app);
    let after = &dashboard["cards"][0];
    assert_eq!(dashboard["counts"]["total"], 1);
    assert_eq!(after["id"], before["id"]);
    assert_eq!(after["sourceState"], "none");
    assert_eq!(after["sources"][0]["freshness"], "retired");
}

#[test]
fn replay_is_run_scoped_and_conflicting_or_invalid_publication_is_atomic() {
    let (_dir, app, publisher) = fixture();
    let input = payload(&publisher, vec![record("mr-1", mr(1))]);
    app.execute(&request("publication publish"), Some(input.clone()), NOW)
        .unwrap();
    let mut retry = input.clone();
    retry["requestId"] = json!(id());
    assert_eq!(
        app.execute(&request("publication publish"), Some(retry), NOW)
            .unwrap()["deduplicated"],
        true
    );
    let mut conflict = input.clone();
    conflict["items"][0]["title"] = json!("Different content");
    assert_eq!(
        app.execute(&request("publication publish"), Some(conflict), NOW)
            .unwrap_err()
            .code,
        "request_conflict"
    );
    let revision = snapshot(&app)["revision"].clone();
    for mut invalid in [
        payload(&publisher, vec![record("mr-2", mr(2))]),
        payload(&publisher, vec![related_mr(2, "LIN-1")]),
    ] {
        if invalid["items"][0].get("relationships").is_some() {
            invalid["items"][0]["relationships"][0]["evidence"]["exactValue"] =
                json!("Mentioned LIN-1 in passing");
        } else {
            invalid["sourceSlices"][0]["status"] = json!("failed");
            invalid["status"] = json!("partial");
        }
        assert!(
            app.execute(&request("publication publish"), Some(invalid), NOW)
                .is_err()
        );
        assert_eq!(snapshot(&app)["revision"], revision);
    }
}

#[test]
fn completed_and_archived_work_never_reopens_on_source_changes() {
    let (_dir, app, publisher) = fixture();
    app.execute(
        &request("publication publish"),
        Some(payload(&publisher, vec![record("mr-1", mr(1))])),
        NOW,
    )
    .unwrap();
    let dashboard = snapshot(&app);
    let item = &dashboard["cards"][0];
    let mut r = request("work complete");
    r.item_id = item["id"].as_str().map(str::to_string);
    r.expected_fingerprint = item["fingerprint"].as_str().map(str::to_string);
    app.execute(
        &r,
        Some(json!({"requestId":id(),"outcome":"Release verified"})),
        NOW,
    )
    .unwrap();
    r.operation = "lifecycle archive".into();
    r.expected_revision = Some(3);
    app.execute(
        &r,
        Some(json!({"requestId":id(),"reason":"completed","confirmed":true})),
        NOW,
    )
    .unwrap();
    let mut changed = record("mr-1", mr(1));
    changed["summary"] = json!("New source evidence");
    changed["sourceUpdatedAt"] = json!(NEXT);
    let mut input = payload(&publisher, vec![changed]);
    input["sourceCompletedAt"] = json!(NEXT);
    app.execute(&request("publication publish"), Some(input), NEXT)
        .unwrap();
    assert_eq!(snapshot(&app)["counts"]["total"], 0);
    let mut show = request("item show");
    show.item_id = r.item_id;
    let item = app.execute(&show, None, NEXT).unwrap()["item"].clone();
    assert_eq!(item["workflowState"], "completed");
    assert_eq!(item["archive"]["changedSinceArchive"], true);
    assert_eq!(item["outcome"], "Release verified");
}

#[test]
fn equivalent_gitlab_identities_deduplicate_and_manifests_are_strict() {
    assert_eq!(dyna::evidence::record_key(&mr(1)).unwrap(),dyna::evidence::record_key(&json!({"source":"scm","provider":"GitLab","instanceId":"gitlab.example.com","repository":"TEAM/service","entityType":"pull_request","entityId":"1"})).unwrap());
    for bad in [
        json!([{"source":"slack","sourceScope":"service","url":"https://example.com"}]),
        json!([{"source":"unknown","sourceScope":"service"}]),
        json!([{"source":"slack","sourceScope":"service"},{"source":"slack","sourceScope":"service"}]),
    ] {
        assert!(dyna::evidence::validate_slices(&bad, false).is_err());
    }
}

#[test]
fn failed_run_cannot_retire_evidence_using_succeeded_slice() {
    let (_dir, app, publisher) = fixture();
    app.execute(
        &request("publication publish"),
        Some(payload(&publisher, vec![record("mr-1", mr(1))])),
        NOW,
    )
    .unwrap();
    let before = snapshot(&app);
    let mut failed = payload(&publisher, vec![]);
    failed["status"] = json!("failed");
    assert_eq!(
        app.execute(&request("publication publish"), Some(failed), NOW)
            .unwrap_err()
            .code,
        "invalid_input"
    );
    let after = snapshot(&app);
    assert_eq!(after["revision"], before["revision"]);
    assert_eq!(after["cards"][0]["sources"], before["cards"][0]["sources"]);
}

#[test]
fn chained_merge_preserves_task_attempt_and_searchable_alias_numbers() {
    let (dir, app, publisher) = fixture();
    for (external, reference) in [("jira", jira("LIN-1")), ("mr-1", mr(1)), ("slack", slack())] {
        let mut input = payload(&publisher, vec![record(external, reference)]);
        input["mode"] = json!("upsert");
        app.execute(&request("publication publish"), Some(input), NOW)
            .unwrap();
    }
    let initial = snapshot(&app);
    let original = initial["cards"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["itemNumber"] == 3)
        .unwrap()
        .clone();
    let original_id = original["id"].as_str().unwrap();
    let actor = Actor {
        kind: ActorKind::LinkedWorker,
        task_id: Some("task1".into()),
        host_id: Some("local".into()),
        work_attempt_id: Some(id()),
    };
    drop(app);
    let repository = SqliteDynaRepository::open(dir.path()).unwrap();
    repository
        .reserve_task("linus", original_id, "task1")
        .unwrap();
    repository
        .reserve_attempt("linus", original_id, &actor)
        .unwrap();
    repository
        .write("linus", |state| {
            let item = state.items.get_mut(original_id).unwrap();
            item.linked_tasks.push(TaskBinding {
                task_id: "task1".into(),
                host_id: "local".into(),
                title: canonical_task_title(3, "Original"),
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
    // The newer Slack record first joins the MR, then both join the oldest Jira card.
    let mut linked = record("slack", slack());
    linked["relationships"] = json!([{"kind":"links_to_record","target":mr(1),"evidence":{"field":"message_link","exactValue":"https://gitlab.example.com/team/service/-/merge_requests/1"}}]);
    let mut first_merge = payload(&publisher, vec![linked]);
    first_merge["mode"] = json!("upsert");
    app.execute(&request("publication publish"), Some(first_merge), NOW)
        .unwrap();
    let mut final_merge = payload(&publisher, vec![related_mr(1, "LIN-1")]);
    final_merge["mode"] = json!("upsert");
    app.execute(&request("publication publish"), Some(final_merge), NEXT)
        .unwrap();
    let final_snapshot = snapshot(&app);
    assert_eq!(final_snapshot["counts"]["total"], 1);
    let canonical = &final_snapshot["cards"][0];
    assert_eq!(canonical["itemNumber"], 1);
    let mut read = request("item show");
    read.item_id = Some(original_id.into());
    assert_eq!(
        app.execute(&read, None, NOW).unwrap()["item"]["itemNumber"],
        1
    );
    for query in ["3", ":3:"] {
        let mut search = request("item search");
        search.query = Some(query.into());
        assert_eq!(
            app.execute(&search, None, NOW).unwrap()["items"][0]["itemNumber"],
            1
        );
    }
    drop(app);
    let repository = SqliteDynaRepository::open(dir.path()).unwrap();
    repository
        .write("linus", |state| {
            let item = state
                .items
                .get_mut(canonical["id"].as_str().unwrap())
                .unwrap();
            item.linked_tasks[0].title = canonical_task_title(1, "Original");
            item.linked_tasks[0].title_sync_needed = false;
            Ok(())
        })
        .unwrap();
    let app = DynaApplication::new(repository);
    let mut update = request("work update");
    update.actor = Some(ActorKind::LinkedWorker);
    update.item_id = Some(canonical["id"].as_str().unwrap().into());
    update.expected_fingerprint = Some(canonical["fingerprint"].as_str().unwrap().into());
    app.execute(&update,Some(json!({"requestId":id(),"workAttemptId":actor.work_attempt_id,"task":{"taskId":"task1","hostId":"local"},"kind":"progress","body":"Continued after consolidation"})),NEXT).unwrap();
    let reopened = SqliteDynaRepository::open(dir.path()).unwrap();
    reopened
        .reserve_task("linus", canonical["id"].as_str().unwrap(), "task1")
        .unwrap();
    reopened.integrity().unwrap();
}
