use dyna::application::Request;
use dyna::contracts::{Actor, Annotation, MAX_STDOUT};
use dyna::repository::DynaRepository;
use dyna::{DynaApplication, SqliteDynaRepository};
use serde_json::json;
use std::collections::BTreeSet;
use std::time::Instant;

const NOW: &str = "2026-10-01T10:00:00.000Z";

#[test]
fn large_rich_dashboard_snapshot_is_bounded_and_fully_pageable() {
    let home = tempfile::tempdir().unwrap();
    let repository = SqliteDynaRepository::open(home.path()).unwrap();
    let app = DynaApplication::new(SqliteDynaRepository::open(home.path()).unwrap());
    app.execute(
        &Request {
            operation: "dashboard create".into(),
            ..Default::default()
        },
        Some(json!({"requestId":uuid::Uuid::new_v4(),"key":"scale","name":"Scale fixture"})),
        NOW,
    )
    .unwrap();
    let seed = app
        .execute(
            &Request {
                operation: "todo create".into(),
                dashboard: Some("scale".into()),
                ..Default::default()
            },
            Some(json!({"requestId":uuid::Uuid::new_v4(),"title":"Scale seed"})),
            NOW,
        )
        .unwrap();
    let template = repository
        .read("scale", |state| {
            Ok(state.items[seed["itemId"].as_str().unwrap()].clone())
        })
        .unwrap();
    let mut items = vec![template.clone()];
    for index in 1..241 {
        let mut item = template.clone();
        item.id = uuid::Uuid::new_v4().to_string();
        item.item_number = repository
            .reserve_number("scale", &uuid::Uuid::new_v4().to_string(), &item.id)
            .unwrap();
        item.title = format!("Scale item {index:03}");
        item.sequence = index;
        items.push(item);
    }
    repository
        .write("scale", |state| {
            for mut item in items {
                item.annotations = (0..6)
                    .map(|_| Annotation {
                        id: uuid::Uuid::new_v4().to_string(),
                        body: "Disposable rich-note fixture. ".repeat(60),
                        version: 1,
                        created_at: NOW.into(),
                        updated_at: NOW.into(),
                        deleted_at: None,
                        actor: Actor::default(),
                    })
                    .collect();
                state.items.insert(item.id.clone(), item);
            }
            state.dashboard.revision += 1;
            Ok(())
        })
        .unwrap();

    let start = Instant::now();
    let mut request = Request {
        operation: "dashboard snapshot".into(),
        dashboard: Some("scale".into()),
        ..Default::default()
    };
    let mut ids = BTreeSet::new();
    let mut pages = 0;
    loop {
        let page = app.execute(&request, None, NOW).unwrap();
        pages += 1;
        assert_eq!(page["total"], 241);
        assert_eq!(page["counts"]["total"], 241);
        assert_eq!(page["revision"], 2);
        assert!(serde_json::to_vec(&page).unwrap().len() < MAX_STDOUT);
        assert!(serde_json::to_string_pretty(&page).unwrap().len() < MAX_STDOUT);
        let cards = page["cards"].as_array().unwrap();
        assert!(!cards.is_empty());
        assert!(cards.len() <= 200);
        for card in cards {
            assert!(ids.insert(card["id"].as_str().unwrap().to_string()));
            assert_eq!(card["annotations"].as_array().unwrap().len(), 6);
        }
        if page["nextCursor"].is_null() {
            assert_eq!(page["truncated"], false);
            break;
        }
        assert_eq!(page["truncated"], true);
        request.cursor = page["nextCursor"].as_str().map(str::to_string);
        assert!(pages < 20, "page cursor must make progress");
    }
    assert_eq!(ids.len(), 241);
    assert!(pages > 2, "fixture must exercise byte-boundary pagination");
    eprintln!(
        "241 rich cards: {pages} bounded pages, {:.2}s total (debug build; no launch-time claim)",
        start.elapsed().as_secs_f64()
    );
}
