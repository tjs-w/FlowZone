use crate::contracts::*;
use crate::error::{DynaError, Result};
use crate::evidence;
use crate::repository::DynaRepository;
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Default)]
pub struct Request {
    pub operation: String,
    pub dashboard: Option<String>,
    pub item_id: Option<String>,
    pub expected_fingerprint: Option<String>,
    pub expected_revision: Option<u64>,
    pub expected_enrichment_version: Option<u64>,
    pub expected_annotation_version: Option<u64>,
    pub annotation_id: Option<String>,
    pub query: Option<String>,
    pub scope: Option<String>,
    pub limit: Option<usize>,
    pub cursor: Option<String>,
    pub actor: Option<ActorKind>,
}

pub struct DynaApplication<R: DynaRepository> {
    repository: R,
}

impl<R: DynaRepository> DynaApplication<R> {
    pub fn new(repository: R) -> Self {
        Self { repository }
    }

    pub fn execute(&self, request: &Request, input: Option<Value>, now: &str) -> Result<Value> {
        let normalized_now = timestamp(now)?;
        let now = normalized_now.as_str();
        match request.operation.as_str() {
            "dashboard list" => Ok(envelope(
                "dyna/dashboard-list-result-v2",
                json!({"dashboards": self.repository.list()?}),
            )),
            "dashboard create" => {
                operator(request)?;
                let input = object(input)?;
                fields(
                    &input,
                    &[
                        "requestId",
                        "key",
                        "name",
                        "description",
                        "doneRetentionHours",
                    ],
                )?;
                let request_id = required_uuid(&input, "requestId")?;
                let id = uuid::Uuid::new_v5(
                    &uuid::Uuid::NAMESPACE_OID,
                    format!("dyna/dashboard/{request_id}").as_bytes(),
                )
                .to_string();
                let dashboard = Dashboard {
                    id,
                    key: dashboard_key(required_str(&input, "key")?)?,
                    name: bounded_text(required_str(&input, "name")?, 96)?,
                    description: optional_text(&input, "description", 500)?.unwrap_or_default(),
                    archived: false,
                    revision: 0,
                    done_retention_hours: retention(&input)?.unwrap_or(24),
                    created_at: now.to_string(),
                    updated_at: now.to_string(),
                };
                let receipt_hash = hash(
                    &json!({"key":dashboard.key,"name":dashboard.name,"description":dashboard.description,"doneRetentionHours":dashboard.done_retention_hours}),
                );
                self.repository
                    .create(dashboard, &request_id, &receipt_hash)
            }
            "dashboard rename" => {
                operator(request)?;
                let input = object(input)?;
                fields(&input, &["requestId", "key", "name"])?;
                let request_id = required_uuid(&input, "requestId")?;
                let key = dashboard_key(required_str(&input, "key")?)?;
                let name = optional_text(&input, "name", 96)?;
                let dashboard_id = self
                    .repository
                    .read(selector(request)?, |state| Ok(state.dashboard.id.clone()))?;
                let receipt_hash = hash(&json!({"dashboardId":dashboard_id,"key":key,"name":name}));
                self.repository.rename(
                    selector(request)?,
                    &key,
                    name.as_deref(),
                    &request_id,
                    &receipt_hash,
                    now,
                )
            }
            "dashboard show" | "dashboard snapshot" | "item search" => self.snapshot(request, now),
            "dashboard update" | "dashboard archive" | "dashboard restore" => {
                self.update_dashboard(request, input, now)
            }
            "item show" | "item history" | "item activity" | "item sources" => {
                self.read_item(request, now)
            }
            "todo create" | "follow-up create" => self.create_todo(request, input, now),
            "work update"
            | "work complete"
            | "work enrich"
            | "annotation add"
            | "annotation edit"
            | "annotation delete"
            | "organize place"
            | "organize place-many"
            | "lifecycle archive"
            | "lifecycle restore"
            | "lifecycle stage"
            | "lifecycle backlog"
            | "lifecycle resume" => self.mutate_item(request, input, now),
            "publication publish" => self.publish(request, input, now),
            "publisher setup" | "publisher revoke" | "schedule bind" | "schedule unbind"
            | "schedule reconcile" => self.manage_sources(request, input, now),
            "publisher list" | "schedule list" => {
                operator(request)?;
                self.repository.read(selector(request)?, |state| Ok(envelope("dyna/bindings-result-v1", if request.operation == "publisher list" {
                    json!({"publishers": state.publishers.values().take(50).collect::<Vec<_>>()})
                } else { json!({"schedules": state.schedules.iter().take(50).collect::<Vec<_>>()}) })))
            }
            "maintenance integrity" => {
                operator(request)?;
                self.repository.integrity()
            }
            "maintenance migration-plan" => {
                operator(request)?;
                crate::migration::preview(self.repository.legacy_inventory()?)
            }
            "maintenance recover" | "setup" => {
                operator(request)?;
                self.repository.recover()
            }
            "maintenance backup" => {
                operator(request)?;
                let input = object(input)?;
                fields(&input, &["requestId"])?;
                self.repository.backup(&required_uuid(&input, "requestId")?)
            }
            "codex status" => Ok(envelope(
                "dyna/integration-result-v1",
                json!({"available": false,"state": "unavailable","reason": "No verified desktop App Server connection."}),
            )),
            operation if operation.starts_with("codex ") => Err(DynaError::new(
                "integration_unavailable",
                "Native Codex integration is unavailable; no native operation was performed.",
            )),
            _ => Err(DynaError::invalid()),
        }
    }

    fn update_dashboard(
        &self,
        request: &Request,
        input: Option<Value>,
        now: &str,
    ) -> Result<Value> {
        operator(request)?;
        let input = object(input)?;
        fields(
            &input,
            &["requestId", "name", "description", "doneRetentionHours"],
        )?;
        let id = required_uuid(&input, "requestId")?;
        let hash = request_hash(request, &input, &Actor::default());
        self.repository.mutate(selector(request)?, &id, &request.operation, &hash, |state| {
            check_revision(request, state)?;
            match request.operation.as_str() {
                "dashboard archive" => state.dashboard.archived = true,
                "dashboard restore" => state.dashboard.archived = false,
                _ => {
                    if let Some(name) = optional_text(&input, "name", 96)? { state.dashboard.name = name; }
                    if let Some(description) = optional_text(&input, "description", 500)? { state.dashboard.description = description; }
                    if let Some(hours) = retention(&input)? { state.dashboard.done_retention_hours = hours; }
                }
            }
            touch(state, now);
            Ok(envelope("dyna/dashboard-mutation-result-v1", json!({"dashboardId": state.dashboard.id,"dashboardKey": state.dashboard.key,"revision": state.dashboard.revision,"deduplicated": false})))
        })
    }

    fn snapshot(&self, request: &Request, now: &str) -> Result<Value> {
        let query = request.query.clone().unwrap_or_default();
        if query.chars().count() > 500 {
            return Err(DynaError::invalid());
        }
        let scope = request.scope.as_deref().unwrap_or("active");
        if !["active", "archive"].contains(&scope) {
            return Err(DynaError::invalid());
        }
        let limit = request.limit.unwrap_or(200);
        if limit == 0 || limit > 200 {
            return Err(DynaError::invalid());
        }
        let terms = query
            .split_whitespace()
            .map(str::to_lowercase)
            .collect::<Vec<_>>();
        self.repository.write(selector(request)?, |state| {
            archive_expired(state, now)?;
            let mut items = state.items.values().filter(|item| !item.legacy.contains_key("mergedInto") && item.archive.is_some() == (scope == "archive"))
                .filter(|item| {
                    let text = search_text(item);
                    terms.iter().all(|term| text.contains(term))
                }).collect::<Vec<_>>();
            let exact = query.trim().trim_matches(':').parse::<i64>().ok();
            items.sort_by(|a, b| {
                (!matches_item_number(a, exact)).cmp(&(!matches_item_number(b, exact)))
                    .then_with(|| effective_priority(a).rank().cmp(&effective_priority(b).rank()))
                    .then_with(|| a.sequence.cmp(&b.sequence)).then_with(|| a.id.cmp(&b.id))
            });
            let active = state.items.values().filter(|i| !i.legacy.contains_key("mergedInto") && i.archive.is_none()).collect::<Vec<_>>();
            let counts = json!({"total": active.len(),"archived": state.items.values().filter(|i| !i.legacy.contains_key("mergedInto") && i.archive.is_some()).count(),
                "critical": active.iter().filter(|i| effective_priority(i) == Priority::Critical).count(),
                "high": active.iter().filter(|i| effective_priority(i) == Priority::High).count(),
                "leadership": active.iter().filter(|i| leadership_score(&projected_people(i)) >= 55).count(),"blocked": active.iter().filter(|i| project(i).blocked).count(),
                "backlog": active.iter().filter(|i| active_backlog(i, now).is_some()).count()});
            if request.operation == "dashboard show" {
                return Ok(envelope("dyna/dashboard-show-result-v2", json!({"dashboardId": state.dashboard.id,"dashboardKey": state.dashboard.key,
                    "dashboardName": state.dashboard.name,"revision": state.dashboard.revision,"freshness": source_freshness(state),"counts": counts,
                    "sourceHealth": state.publishers.values().map(|p| json!({"publisherId":p.id,"lastRunStatus":p.last_run_status,"lastRunAt":p.last_run_at,"sourceSlices":p.last_source_slices})).collect::<Vec<_>>()})));
            }
            if request.operation == "item search" {
                if request.limit.is_some_and(|limit| limit > 20) {
                    return Err(DynaError::invalid());
                }
                let signature = hash(&json!({"dashboard":state.dashboard.id,"revision":state.dashboard.revision,"query":query,"scope":scope,"operation":request.operation}));
                let entries = items.iter().map(|item| brief(item, now)).collect::<Vec<_>>();
                let result = envelope("dyna/item-search-result-v5", json!({"dashboardId":state.dashboard.id,"dashboardKey":state.dashboard.key,"revision":state.dashboard.revision,
                    "scope":scope,"query":query,"items":[]}));
                return bounded_page(result, "items", &entries, request.limit.unwrap_or(20), request.cursor.as_deref(), &signature);
            }
            let signature = hash(&json!({"dashboard":state.dashboard.id,"revision":state.dashboard.revision,"query":query,"scope":scope,"operation":request.operation}));
            let cards = items.into_iter().map(|item|card(item, now)).collect::<Vec<_>>();
            let result = envelope("dyna/snapshot-v13", json!({"dashboard":state.dashboard,"generatedAt":now,"query":query,"scope":scope,
                "revision":state.dashboard.revision,"freshness":source_freshness(state),"counts":counts,"schedules":state.schedules,
                "cards": []}));
            bounded_page(result, "cards", &cards, limit, request.cursor.as_deref(), &signature)
        })
    }

    fn read_item(&self, request: &Request, now: &str) -> Result<Value> {
        self.repository.read(selector(request)?, |state| {
            let item = find_item(state, item_id(request)?, false)?;
            let limit = request.limit.unwrap_or(if request.operation == "item activity" { 25 } else { 50 });
            let maximum = if request.operation == "item activity" { 25 } else { 50 };
            if limit == 0 || limit > maximum { return Err(DynaError::invalid()); }
            if request.operation == "item show" {
                return Ok(envelope("dyna/item-show-result-v6", json!({"dashboardId":state.dashboard.id,"dashboardKey":state.dashboard.key,
                    "revision":state.dashboard.revision,"enrichmentVersion":item.enrichment_version,"item":card(item, now)})));
            }
            let entries: Vec<Value> = match request.operation.as_str() {
                "item activity" => item.work_updates.iter().rev().map(|e| json!(e)).collect(),
                "item sources" => item.contributions.iter().map(|e| json!(e)).collect(),
                _ => state.events.iter().rev().filter(|e| e.item_id == item.id || item.aliases.iter().any(|a| a["itemId"] == e.item_id)).map(|e| json!(e)).collect(),
            };
            // Source upserts can reorder contributions. Require a fresh page
            // after publication instead of silently skipping moved evidence.
            // Activity/history remain append-stable across newer writes.
            let signature = hash(&json!({"dashboard":state.dashboard.id,"item":item.id,"operation":request.operation,
                "sourceRevision":if request.operation=="item sources" {Some(state.dashboard.revision)} else {None}}));
            let result = envelope(if request.operation == "item activity" { "dyna/activity-result-v3" } else if request.operation == "item sources" { "dyna/sources-result-v1" } else { "dyna/history-result-v4" },
                json!({"dashboardId":state.dashboard.id,"dashboardKey":state.dashboard.key,"itemId":item.id,"itemNumber":item.item_number,"entries":[]}));
            bounded_page(result, "entries", &entries, limit, request.cursor.as_deref(), &signature)
        })
    }

    fn create_todo(&self, request: &Request, input: Option<Value>, now: &str) -> Result<Value> {
        if request.operation == "todo create" {
            operator(request)?;
        }
        let input = object(input)?;
        fields(
            &input,
            &[
                "requestId",
                "title",
                "summary",
                "priority",
                "attention",
                "labels",
                "task",
                "workAttemptId",
            ],
        )?;
        let actor = actor(request, &input)?;
        let request_id = required_uuid(&input, "requestId")?;
        let title = bounded_text(required_str(&input, "title")?, 200)?;
        let summary = optional_text(&input, "summary", 1000)?.unwrap_or_default();
        let attention = optional_text(&input, "attention", 500)?;
        let priority = parse_priority(input.get("priority"))?.unwrap_or(Priority::Normal);
        let labels = text_array(input.get("labels"), 8, 64)?;
        let hash = request_hash(request, &input, &actor);
        if let Some(result) =
            self.repository
                .replay(selector(request)?, &request_id, &request.operation, &hash)?
        {
            return Ok(result);
        }
        let dashboard_id = self.repository.read(selector(request)?, |state| {
            active_dashboard(state)?;
            if request.operation == "follow-up create" {
                let original = check_item(request, state, &actor)?;
                if original.archive.is_none() && project(original).stage != "completed" {
                    return Err(DynaError::new(
                        "invalid_lifecycle",
                        "Follow-ups require completed or archived original work.",
                    ));
                }
            }
            Ok(state.dashboard.id.clone())
        })?;
        let new_id = uuid::Uuid::new_v5(
            &uuid::Uuid::NAMESPACE_OID,
            format!("dyna/todo/{dashboard_id}/{request_id}").as_bytes(),
        )
        .to_string();
        let number = self
            .repository
            .reserve_number(selector(request)?, &request_id, &new_id)?;
        self.repository.mutate(selector(request)?, &request_id, &request.operation, &hash, |state| {
            active_dashboard(state)?;
            let original = if request.operation == "follow-up create" {
                let source = check_item(request, state, &actor)?;
                if source.archive.is_none() && project(source).stage != "completed" { return Err(DynaError::new("invalid_lifecycle", "Follow-ups require completed or archived original work.")); }
                Some((source.id.clone(), source.item_number))
            } else { None };
            let sequence = state.items.values().map(|i| i.sequence).max().unwrap_or(-1) + 1;
            let mut item = Item { id:new_id.clone(), item_number:number, title:title.clone(), summary:summary.clone(), fingerprint:String::new(),
                source_updated_at:now.to_string(), source_priority:priority.clone(), priority_override:None, sequence, due_at:None, labels:labels.clone(), people:vec![],
                attention:attention.clone(), plan:vec![], next_steps:vec![], enrichment:None, enrichment_version:0, enrichment_fingerprint:None,
                contributions:vec![], relationships:vec![], aliases:vec![], linked_tasks:vec![], work_updates:vec![], annotations:vec![],archive:None,
                completed_at:None,outcome:None,completion_authority:None,manual_stage:None,manual_stage_at:None,backlog_until:None,
                follow_up_of_item_id:original.as_ref().map(|p|p.0.clone()),follow_up_of_item_number:original.map(|p|p.1),
                created_at:now.to_string(),updated_at:now.to_string(),legacy:BTreeMap::new() };
            item.fingerprint = hash_item(&item);
            let result_fingerprint = item.fingerprint.clone();
            state.items.insert(new_id.clone(), item);
            add_event(state, &new_id, "created", json!({"followUpOfItemId": request.item_id}), &actor, now);
            touch(state, now);
            let control = control(state, &new_id)?;
            Ok(envelope("dyna/todo-create-result-v3", json!({"requestId":request_id,"itemId":new_id,"itemNumber":number,"fingerprint":result_fingerprint,"deduplicated":false,"control":control})))
        })
    }

    fn mutate_item(&self, request: &Request, input: Option<Value>, now: &str) -> Result<Value> {
        let input = object(input)?;
        let actor = actor(request, &input)?;
        if request.operation == "organize place-many" {
            operator(request)?;
        }
        let extra: &[&str] = match request.operation.as_str() {
            "work update" => &[
                "kind",
                "body",
                "outcome",
                "artifacts",
                "supersedesWorkUpdateId",
            ],
            "work complete" => &["outcome", "body", "artifacts"],
            "work enrich" => &["set", "clear"],
            "annotation add" | "annotation edit" => &["body"],
            "annotation delete" => &[],
            "organize place" => &["priority", "move"],
            "organize place-many" => &["priority", "items"],
            "lifecycle archive" => &["reason", "reasonDetail", "confirmed"],
            "lifecycle restore" => &["confirmed"],
            "lifecycle stage" => &["stage", "outcome"],
            "lifecycle backlog" => &["until"],
            "lifecycle resume" => &[],
            _ => return Err(DynaError::invalid()),
        };
        let mut allowed = vec!["requestId", "task", "workAttemptId"];
        allowed.extend_from_slice(extra);
        fields(&input, &allowed)?;
        let request_id = required_uuid(&input, "requestId")?;
        let hash = request_hash(request, &input, &actor);
        if let Some(result) =
            self.repository
                .replay(selector(request)?, &request_id, &request.operation, &hash)?
        {
            return Ok(result);
        }
        if actor.kind == ActorKind::LinkedWorker {
            self.repository.read(selector(request)?, |state| {
                check_item(request, state, &actor)?;
                Ok(())
            })?;
            self.repository
                .reserve_attempt(selector(request)?, item_id(request)?, &actor)?;
        }
        self.repository.mutate(selector(request)?, &request_id, &request.operation, &hash, |state| {
            active_dashboard(state)?;
            if request.operation == "organize place-many" {
                check_revision(request, state)?;
                let priority = parse_priority(input.get("priority"))?.ok_or(DynaError::invalid())?;
                let selected = input.get("items").and_then(Value::as_array).ok_or(DynaError::invalid())?;
                if selected.is_empty() || selected.len() > 200 { return Err(DynaError::invalid()); }
                let mut ids = BTreeSet::new();
                for pair in selected {
                    let pair = pair.as_object().ok_or(DynaError::invalid())?;
                    fields(pair, &["itemId", "fingerprint"])?;
                    let id = required_uuid(pair, "itemId")?;
                    if !ids.insert(id.clone()) { return Err(DynaError::invalid()); }
                    let item = find_item(state, &id, true)?;
                    if item.fingerprint != required_str(pair, "fingerprint")? { return Err(stale_item()); }
                    if item.archive.is_some() { return Err(archived()); }
                }
                let mut selected = ids.iter().map(|id| state.items[id].clone()).collect::<Vec<_>>();
                selected.sort_by_key(|item| (effective_priority(item).rank(),item.sequence,item.id.clone()));
                let last = state.items.values().filter(|i| !ids.contains(&i.id) && effective_priority(i)==priority).map(|i|i.sequence).max().unwrap_or(-1);
                for (offset, item) in selected.iter().enumerate() {
                    let target = state.items.get_mut(&item.id).unwrap();
                    target.priority_override=Some(priority.clone()); target.sequence=last+1+offset as i64;
                    add_event(state,&item.id,"placement",json!({"priority":priority,"sequence":last+1+offset as i64}),&actor,now);
                }
                touch(state,now);
                return Ok(envelope("dyna/bulk-placement-result-v2",json!({"requestId":request_id,"revision":state.dashboard.revision,"updated":ids.len(),"deduplicated":false})));
            }
            let old = check_item(request, state, &actor)?.clone();
            let id = old.id.clone();
            let is_archive_operation = request.operation.starts_with("lifecycle ") || request.operation.starts_with("annotation ");
            if old.archive.is_some() && !is_archive_operation { return Err(archived()); }
            let completed = project(&old).stage == "completed";
            let mut item = old.clone();
            let mut annotation_id = None;
            match request.operation.as_str() {
                "work update" | "work complete" => {
                    if completed || item.archive.is_some() { return Err(DynaError::new("invalid_lifecycle", "Continued execution requires a linked follow-up.")); }
                    let kind = if request.operation == "work complete" { "completion_reported" } else { required_str(&input,"kind")? };
                    if !["note","progress","decision","needs_input","blocked","completion_reported","handoff"].contains(&kind) { return Err(DynaError::invalid()); }
                    let outcome = optional_text(&input,"outcome",200)?;
                    if kind=="completion_reported" && outcome.is_none() { return Err(DynaError::invalid()); }
                    if kind!="completion_reported" && outcome.is_some(){return Err(DynaError::invalid());}
                    if outcome.as_ref().is_some_and(|s|s.contains(['\n','\r'])) { return Err(DynaError::invalid()); }
                    let body=optional_text(&input,"body",1000)?.or_else(||outcome.clone()).ok_or(DynaError::invalid())?;
                    let artifacts = parse_artifacts(input.get("artifacts"))?;
                    let supersedes = input.get("supersedesWorkUpdateId").map(|v|uuid(v.as_str().ok_or(DynaError::invalid())?)).transpose()?;
                    if let Some(prior_id)=&supersedes {
                        let prior=item.work_updates.iter().find(|u| &u.id==prior_id).ok_or(DynaError::new("not_found","Dyna activity was not found."))?;
                        if actor.kind==ActorKind::LinkedWorker && prior.actor.task_id!=actor.task_id { return Err(forbidden()); }
                    }
                    item.work_updates.push(WorkUpdate{id:uuid::Uuid::new_v4().to_string(),kind:kind.to_string(),body,outcome:outcome.clone(),artifacts,created_at:now.to_string(),actor:actor.clone(),supersedes_work_update_id:supersedes});
                    if request.operation=="work complete" {
                        item.completed_at=Some(now.to_string());item.outcome=outcome;item.completion_authority=Some(if actor.kind==ActorKind::LinkedWorker {"dyna_task"} else {"dyna_user"}.to_string());item.manual_stage=Some("done".to_string());item.manual_stage_at=Some(now.to_string());
                    }
                }
                "work enrich" => {
                    if completed { return Err(DynaError::new("invalid_lifecycle","Continued analysis requires a linked follow-up.")); }
                    if request.expected_enrichment_version!=Some(item.enrichment_version) { return Err(DynaError::new("stale_enrichment","Dyna enrichment changed; read current context.")); }
                    let set=input.get("set").map(|v|v.as_object().cloned().ok_or(DynaError::invalid())).transpose()?.unwrap_or_default();
                    let keys=["summary","attention","plan","nextSteps","dueAt","labels","people","priority","priorityReason"];
                    fields(&set,&keys)?;
                    let clear=text_array(input.get("clear"),9,32)?;
                    if clear.iter().any(|key| !keys.contains(&key.as_str()) || set.contains_key(key)) { return Err(DynaError::invalid()); }
                    validate_enrichment(&set)?;
                    if set.get("priority")==Some(&json!("critical")) && item.source_priority!=Priority::Critical { return Err(DynaError::new("invalid_priority","Critical priority requires critical source evidence.")); }
                    let mut enrichment=active_enrichment(&item).and_then(|v|v.as_object().cloned()).unwrap_or_default();
                    for key in clear { if key=="dueAt" {enrichment.insert(key,Value::Null);} else {enrichment.remove(&key);} }
                    enrichment.extend(set);
                    item.enrichment=Some(Value::Object(enrichment));item.enrichment_version+=1;item.enrichment_fingerprint=Some(item.fingerprint.clone());
                }
                "annotation add" => {
                    let note_id=uuid::Uuid::new_v4().to_string();
                    item.annotations.push(Annotation{id:note_id.clone(),body:bounded_text(required_str(&input,"body")?,1000)?,version:1,created_at:now.to_string(),updated_at:now.to_string(),deleted_at:None,actor:actor.clone()});
                    annotation_id=Some(note_id);
                }
                "annotation edit" | "annotation delete" => {
                    let target_id=request.annotation_id.as_deref().ok_or(DynaError::invalid())?;
                    let annotation=item.annotations.iter_mut().find(|a|a.id==target_id && a.deleted_at.is_none()).ok_or(DynaError::new("not_found","Dyna annotation was not found."))?;
                    if request.expected_annotation_version!=Some(annotation.version) { return Err(DynaError::new("stale_annotation","Dyna annotation changed; read current context.")); }
                    if request.operation=="annotation edit" { annotation.body=bounded_text(required_str(&input,"body")?,1000)?; } else {annotation.deleted_at=Some(now.to_string());}
                    annotation.version+=1;annotation.updated_at=now.to_string();annotation.actor=actor.clone();annotation_id=Some(target_id.to_string());
                }
                "organize place" => {
                    let priority=parse_priority(input.get("priority"))?.unwrap_or_else(||effective_priority(&item));
                    let movement=input.get("move").map(|v|v.as_str().ok_or(DynaError::invalid())).transpose()?;
                    if movement.is_some_and(|m|! ["earlier","later","first","last"].contains(&m)) { return Err(DynaError::invalid()); }
                    let mut group=state.items.values().filter(|i|i.id!=id && i.archive.is_none() && effective_priority(i)==priority).cloned().collect::<Vec<_>>();
                    group.sort_by_key(|i|(i.sequence,i.id.clone()));
                    let current=group.iter().position(|i|i.sequence>=item.sequence).unwrap_or(group.len());
                    let position=match movement {Some("first")=>0,Some("earlier")=>current.saturating_sub(1),Some("later")=>(current+1).min(group.len()),_=>group.len()};
                    group.insert(position,item.clone());
                    for (sequence,member) in group.iter().enumerate() { if member.id!=id { state.items.get_mut(&member.id).unwrap().sequence=sequence as i64; } }
                    item.sequence=position as i64;item.priority_override=Some(priority);
                }
                "lifecycle archive" => {
                    if item.archive.is_some() { return Err(archived()); }
                    let reason=required_str(&input,"reason")?;
                    if !["completed","invalid","duplicate","no_action_needed","superseded","other"].contains(&reason) { return Err(DynaError::invalid()); }
                    if reason=="completed" && !completed { return Err(DynaError::new("invalid_lifecycle","Archiving does not certify completion.")); }
                    if input.get("confirmed")!=Some(&json!(true)) {return Err(DynaError::new("confirmation_required","Confirm the archive disposition explicitly."));}
                    let detail=optional_text(&input,"reasonDetail",500)?;
                    if reason=="other" && detail.is_none(){return Err(DynaError::invalid());}
                    item.archive=Some(Archive{id:uuid::Uuid::new_v4().to_string(),reason:reason.to_string(),reason_detail:detail,mode:"manual".to_string(),archived_at:now.to_string(),fingerprint_at_archive:item.fingerprint.clone(),changed_since_archive:false});
                }
                "lifecycle restore" => {
                    if input.get("confirmed")!=Some(&json!(true)) {return Err(DynaError::new("confirmation_required","Confirm restoration explicitly."));}
                    if item.archive.is_none(){return Err(DynaError::new("invalid_lifecycle","The Dyna item is not archived."));}
                    item.archive=None;
                    // Restored completed evidence gets a new confirmation window,
                    // not an immediate re-archive at the next dashboard read.
                    if completed { item.completed_at=Some(now.to_string()); }
                }
                "lifecycle stage" => {
                    if item.archive.is_some(){return Err(archived());}
                    if completed{return Err(DynaError::new("invalid_lifecycle","Completed work requires a follow-up."));}
                    let stage=required_str(&input,"stage")?;
                    if !["todo","needs_you","done"].contains(&stage){return Err(DynaError::invalid());}
                    item.manual_stage=Some(stage.to_string());
                    item.manual_stage_at=Some(now.to_string());
                    if stage=="done" {
                        let outcome=bounded_text(required_str(&input,"outcome")?,200)?;
                        if outcome.contains(['\n','\r']){return Err(DynaError::invalid());}
                        item.outcome=Some(outcome);item.completed_at=Some(now.to_string());
                        item.completion_authority=Some(if actor.kind==ActorKind::LinkedWorker {"dyna_task"} else {"dyna_user"}.to_string());
                    } else {item.completed_at=None;item.outcome=None;item.completion_authority=None;}
                }
                "lifecycle backlog" => {
                    if completed || item.archive.is_some(){return Err(DynaError::new("invalid_lifecycle","Only active work can enter Backlog."));}
                    let until=input.get("until").map(|v|timestamp(v.as_str().ok_or(DynaError::invalid())?)).transpose()?.unwrap_or_else(|| (chrono::DateTime::parse_from_rfc3339(now).unwrap()+chrono::Duration::hours(24)).to_rfc3339());
                    if until.as_str()<=now{return Err(DynaError::invalid());} item.backlog_until=Some(until);
                }
                "lifecycle resume" => item.backlog_until=None,
                _=>return Err(DynaError::invalid()),
            }
            item.updated_at=now.to_string();
            let event_data=if request.operation.starts_with("annotation "){json!({"annotation":item.annotations.iter().find(|a|Some(&a.id)==annotation_id.as_ref())})}
                else if request.operation.starts_with("work ") && request.operation!="work enrich" {json!({"update":item.work_updates.last()})}
                else {json!({"before":{"enrichment":old.enrichment,"priority":effective_priority(&old),"sequence":old.sequence,"archive":old.archive,"completedAt":old.completed_at,"outcome":old.outcome,"stage":old.manual_stage,"backlogUntil":old.backlog_until},
                    "after":{"enrichment":item.enrichment,"priority":effective_priority(&item),"sequence":item.sequence,"archive":item.archive,"completedAt":item.completed_at,"outcome":item.outcome,"completionAuthority":item.completion_authority,"stage":item.manual_stage,"backlogUntil":item.backlog_until}})};
            state.items.insert(id.clone(),item);
            add_event(state,&id,&request.operation,event_data,&actor,now);
            touch(state,now);
            Ok(envelope("dyna/mutation-result-v2",json!({"requestId":request_id,"itemId":id,"annotationId":annotation_id,"nativeSuccessCertified":false,"deduplicated":false,"control":control(state,&id)?})))
        })
    }

    fn manage_sources(&self, request: &Request, input: Option<Value>, now: &str) -> Result<Value> {
        operator(request)?;
        let input = object(input)?;
        let allowed: &[&str] = match request.operation.as_str() {
            "publisher setup" => &["requestId", "name", "requiredSourceSlices"],
            "publisher revoke" => &["requestId", "publisherId"],
            "schedule bind" | "schedule reconcile" => {
                &["requestId", "publisherId", "scheduleId", "title", "state"]
            }
            "schedule unbind" => &["requestId", "scheduleId"],
            _ => return Err(DynaError::invalid()),
        };
        fields(&input, allowed)?;
        let id = required_uuid(&input, "requestId")?;
        let receipt_hash = request_hash(request, &input, &Actor::default());
        self.repository.mutate(selector(request)?,&id,&request.operation,&receipt_hash,|state|{
            active_dashboard(state)?;
            let mut publisher_id=None;
            match request.operation.as_str(){
                "publisher setup"=>{
                    let name=bounded_text(required_str(&input,"name")?,96)?;
                    let slices=input.get("requiredSourceSlices").map(|v|evidence::validate_slices(v,false)).transpose()?.unwrap_or_default();
                    let new_id=uuid::Uuid::new_v4().to_string();
                    state.publishers.insert(new_id.clone(),Publisher{id:new_id.clone(),name,revoked:false,required_source_slices:slices,last_run_at:None,last_run_status:"never".to_string(),last_source_slices:vec![]});publisher_id=Some(new_id);
                }
                "publisher revoke"=>{let id=required_uuid(&input,"publisherId")?;state.publishers.get_mut(&id).ok_or(DynaError::new("not_found","Dyna publisher was not found."))?.revoked=true;publisher_id=Some(id);}
                "schedule bind"|"schedule reconcile"=>{
                    let id=required_uuid(&input,"publisherId")?;
                    let publisher=state.publishers.get(&id).ok_or(DynaError::new("not_found","Dyna publisher was not found."))?;
                    if publisher.revoked{return Err(forbidden());}
                    let schedule_id=bounded_text(required_str(&input,"scheduleId")?,128)?;
                    let title=bounded_text(required_str(&input,"title")?,200)?;
                    let status=required_str(&input,"state")?;
                    if !["active","paused","unknown"].contains(&status){return Err(DynaError::invalid());}
                    state.schedules.retain(|s|s.schedule_id!=schedule_id);
                    state.schedules.push(ScheduleBinding{schedule_id,publisher_id:id.clone(),title,state:status.to_string()});publisher_id=Some(id);
                }
                "schedule unbind"=>{let id=bounded_text(required_str(&input,"scheduleId")?,128)?;state.schedules.retain(|s|s.schedule_id!=id);}
                _=>return Err(DynaError::invalid()),
            }
            touch(state,now);
            Ok(envelope("dyna/binding-mutation-result-v1",json!({"requestId":id,"publisherId":publisher_id,"revision":state.dashboard.revision,"deduplicated":false})))
        })
    }

    fn publish(&self, request: &Request, input: Option<Value>, now: &str) -> Result<Value> {
        operator(request)?;
        let mut publication: crate::publication::Publication =
            serde_json::from_value(input.ok_or(DynaError::invalid())?)?;
        publication.validate(now)?;
        let dashboard_id = self
            .repository
            .read(selector(request)?, |state| Ok(state.dashboard.id.clone()))?;
        let receipt_id = publication.receipt_id(&dashboard_id);
        let receipt_hash = publication.receipt_hash();
        if let Some(result) = self.repository.replay(
            selector(request)?,
            &receipt_id,
            "publication publish",
            &receipt_hash,
        )? {
            return Ok(result);
        }
        self.repository.read(selector(request)?, |state| {
            active_dashboard(state)?;
            let publisher = state
                .publishers
                .get(&publication.publisher_id)
                .ok_or(DynaError::new("not_found", "Dyna publisher was not found."))?;
            if publisher.revoked {
                return Err(forbidden());
            }
            Ok(())
        })?;
        let mut allocations = BTreeMap::new();
        for record in &publication.items {
            let key = evidence::record_key(&record.source_ref)?;
            let item_id = crate::publication::candidate_id(&dashboard_id, &key);
            let number = self
                .repository
                .reserve_number(selector(request)?, &item_id, &item_id)?;
            allocations.insert(item_id, number);
        }
        self.repository.mutate(
            selector(request)?,
            &receipt_id,
            "publication publish",
            &receipt_hash,
            |state| crate::publication::apply(state, &publication, &allocations, now),
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Projection {
    pub stage: &'static str,
    pub condition: Option<&'static str>,
    pub blocked: bool,
}

pub fn project(item: &Item) -> Projection {
    if item.completed_at.is_some() || item.manual_stage.as_deref() == Some("done") {
        return Projection {
            stage: "completed",
            condition: None,
            blocked: false,
        };
    }
    let native_observed_at = item
        .linked_tasks
        .iter()
        .map(|t| t.observed_at.as_str())
        .max();
    let manual_current = item
        .manual_stage_at
        .as_deref()
        .is_some_and(|at| native_observed_at.is_none_or(|observed| at >= observed));
    if manual_current && item.manual_stage.as_deref() == Some("todo") {
        return Projection {
            stage: "todo",
            condition: None,
            blocked: false,
        };
    }
    if manual_current && item.manual_stage.as_deref() == Some("needs_you") {
        return Projection {
            stage: "paused",
            condition: Some("input_needed"),
            blocked: false,
        };
    }
    if !item.linked_tasks.is_empty() && item.linked_tasks.iter().all(|t| t.state == "succeeded") {
        return Projection {
            stage: "completed",
            condition: None,
            blocked: false,
        };
    }
    let mut condition = None;
    let mut blocked = false;
    let updates = effective_work_conditions(item);
    if let Some(update) = updates
        .iter()
        .find(|u| u.actor.kind == ActorKind::LocalOperator)
    {
        match update.kind.as_str() {
            "needs_input" => condition = Some("input_needed"),
            "blocked" => blocked = true,
            "completion_reported" => condition = Some("verification_pending"),
            _ => {}
        }
    }
    for task in &item.linked_tasks {
        match task.state.as_str() {
            "waiting" => condition = Some("input_needed"),
            "failed" => {
                if condition != Some("input_needed") {
                    condition = Some("task_failed");
                }
            }
            "unknown" if condition.is_none() || condition == Some("verification_pending") => {
                condition = Some("status_unknown")
            }
            _ => {}
        }
        if let Some(update) = updates
            .iter()
            .find(|u| u.actor.task_id.as_deref() == Some(&task.task_id))
        {
            match update.kind.as_str() {
                "needs_input" => condition = Some("input_needed"),
                "blocked" => blocked = true,
                "completion_reported" if condition.is_none() => {
                    condition = Some("verification_pending")
                }
                _ => {}
            }
        }
    }
    Projection {
        stage: if condition.is_some_and(|c| c != "verification_pending") {
            "paused"
        } else if item.linked_tasks.is_empty() {
            "todo"
        } else {
            "executing"
        },
        condition,
        blocked,
    }
}

/// The same selector drives both lifecycle conditions and their card summary.
/// Corrected and controller-obsolete reports remain in history, never in the
/// current-condition projection.
fn effective_work_conditions(item: &Item) -> Vec<&WorkUpdate> {
    let superseded = item
        .work_updates
        .iter()
        .filter_map(|u| u.supersedes_work_update_id.as_deref())
        .collect::<BTreeSet<_>>();
    let latest_observation = item
        .linked_tasks
        .iter()
        .map(|t| t.observed_at.as_str())
        .max();
    let mut seen = BTreeSet::new();
    item.work_updates
        .iter()
        .rev()
        .filter(|update| {
            if superseded.contains(update.id.as_str())
                || ![
                    "progress",
                    "needs_input",
                    "blocked",
                    "completion_reported",
                    "handoff",
                ]
                .contains(&update.kind.as_str())
            {
                return false;
            }
            let key = update.actor.task_id.as_deref().unwrap_or("local-operator");
            if !seen.insert(key) {
                return false;
            }
            if update.actor.kind == ActorKind::LocalOperator {
                return latest_observation.is_none_or(|at| update.created_at.as_str() > at);
            }
            item.linked_tasks
                .iter()
                .find(|task| update.actor.task_id.as_deref() == Some(&task.task_id))
                .is_some_and(|task| {
                    task.state != "succeeded" && update.created_at > task.observed_at
                })
        })
        .collect()
}

fn projected_people(item: &Item) -> Value {
    active_enrichment(item)
        .and_then(|e| e.get("people"))
        .cloned()
        .unwrap_or_else(|| json!(item.people))
}

pub fn leadership_score(people: &Value) -> u32 {
    people
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|person| {
            if person["confidence"] == "low"
                || !["user_configured", "twg_org_tree"]
                    .iter()
                    .any(|v| person["provenance"] == *v)
                || ![
                    "sender",
                    "author",
                    "declared_owner",
                    "operational_owner",
                    "approver",
                ]
                .iter()
                .any(|v| person["involvement"] == *v)
            {
                return None;
            }
            let weight = match person["leadershipLevel"].as_str()? {
                "ceo" => 100,
                "cto" => 95,
                "gm" => 85,
                "vp" => 80,
                "senior_director" => 70,
                "director" => 60,
                "vip" => 65,
                "architect" => 55,
                _ => 0,
            };
            Some(
                weight
                    + match person["relationship"].as_str() {
                        Some("management_chain") => 10,
                        Some("my_org" | "neighboring_org") => 5,
                        _ => 0,
                    },
            )
        })
        .max()
        .unwrap_or(0)
}

pub fn effective_priority(item: &Item) -> Priority {
    if let Some(priority) = &item.priority_override {
        return priority.clone();
    }
    let priority = active_enrichment(item)
        .and_then(|v| v.get("priority"))
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_else(|| item.source_priority.clone());
    match (priority, leadership_score(&projected_people(item))) {
        (Priority::Normal, score) if score >= 75 => Priority::High,
        (Priority::Low, score) if score >= 55 => Priority::Normal,
        (priority, _) => priority,
    }
}

fn active_backlog<'a>(item: &'a Item, now: &str) -> Option<&'a str> {
    item.backlog_until.as_deref().filter(|until| {
        *until > now && item.archive.is_none() && project(item).stage != "completed"
    })
}

pub fn card(item: &Item, now: &str) -> Value {
    let projection = project(item);
    let enrichment = active_enrichment(item);
    let source = crate::publication::preferred_contribution(&item.contributions);
    let mut by_record = BTreeMap::new();
    for contribution in &item.contributions {
        let rank = |c: &SourceContribution| {
            (
                c.retired_at.is_none(),
                c.freshness == "current",
                c.source_updated_at.clone(),
                c.observed_at.clone(),
                c.publisher_id.clone(),
                c.external_id.clone(),
            )
        };
        let newer = by_record
            .get(&contribution.record_key)
            .is_none_or(|old: &&SourceContribution| rank(old) < rank(contribution));
        if newer {
            by_record.insert(contribution.record_key.clone(), contribution);
        }
    }
    let sources=by_record.values().take(32).map(|c|json!({"sourceRef":c.source_ref,"label":evidence::source_label(&c.source_ref),"sourceUpdatedAt":c.source_updated_at,"observedAt":c.observed_at,"freshness":c.freshness,"navigation":if evidence::source_url(&c.source_ref).is_some(){"link"}else{"exact_record"},"correlationWarning":item.legacy.get("correlationWarning").and_then(Value::as_bool).unwrap_or(false)})).collect::<Vec<_>>();
    let summary = crate::publication::cited_summary(item);
    let mut value = json!({"id":item.id,"itemNumber":item.item_number,"fingerprint":item.fingerprint,"title":item.title,
        "summary":enrichment.and_then(|v|v.get("summary")).cloned().unwrap_or_else(||json!(summary.as_ref().map(|s|s.0.as_str()).unwrap_or(&item.summary))),"source":source.and_then(|s|s.source_ref.get("source")).and_then(Value::as_str).unwrap_or("manual"),
        "sourceRef":source.map(|s|s.source_ref.clone()).unwrap_or_else(||json!({"source":"manual","todoId":item.id})),"sourceLabel":source.map(|s|s.external_id.as_str()).unwrap_or("To-do"),
        "sources":sources,"sourceState":if !item.contributions.iter().any(|c|c.retired_at.is_none()){"none"}else if item.contributions.iter().any(|c|c.freshness=="current" && c.retired_at.is_none()){"current"}else{"last_known"},
        "sourcePriority":item.source_priority,"priority":effective_priority(item),"priorityReason":enrichment.and_then(|e|e.get("priorityReason")).cloned().or_else(||item.legacy.get("priorityReason").cloned()).unwrap_or(json!("")),"sourceUpdatedAt":item.source_updated_at,
        "labels":enrichment.and_then(|e|e.get("labels")).cloned().unwrap_or(json!(item.labels)),"people":projected_people(item),"leadershipScore":leadership_score(&projected_people(item)),"priorityMode":if item.priority_override.is_some(){"manual"}else if enrichment.is_some(){"enrichment"}else{"source"},
        "sequence":item.sequence,"canMoveEarlier":item.sequence>0,"canMoveLater":true,"workflowState":projection.stage,
        "annotations":item.annotations.iter().filter(|a|a.deleted_at.is_none()).rev().take(20).collect::<Vec<_>>(),"linkedTasks":item.linked_tasks,
        "workUpdates":item.work_updates.iter().rev().take(1).collect::<Vec<_>>(),"workUpdateCount":item.work_updates.len(),"blocked":projection.blocked,
        "titleSyncNeeded":item.linked_tasks.iter().any(|t|t.title_sync_needed),"groupingEvidence":item.relationships,"mergedAliases":item.aliases});
    for (key, val) in [
        ("dueAt", item.due_at.as_ref()),
        ("attention", item.attention.as_ref()),
        ("completedAt", item.completed_at.as_ref()),
        ("outcome", item.outcome.as_ref()),
        ("completionAuthority", item.completion_authority.as_ref()),
        ("followUpOfItemId", item.follow_up_of_item_id.as_ref()),
    ] {
        if let Some(v) = enrichment
            .and_then(|e| e.get(key))
            .cloned()
            .or_else(|| val.map(|v| json!(v)))
        {
            if !v.is_null() {
                value[key] = v;
            }
        }
    }
    value["plan"] = enrichment
        .and_then(|e| e.get("plan"))
        .cloned()
        .unwrap_or_else(|| json!(item.plan));
    value["nextSteps"] = enrichment
        .and_then(|e| e.get("nextSteps"))
        .cloned()
        .unwrap_or_else(|| json!(item.next_steps));
    if let Some(archive) = &item.archive {
        value["archive"] = json!(archive);
    }
    if let Some((_, current)) = summary {
        value["summaryState"] = json!(if current { "current" } else { "last_known" });
    }
    if let Some(number) = item.follow_up_of_item_number {
        value["followUpOfItemNumber"] = json!(number);
    }
    if let Some(update) = effective_work_conditions(item).first() {
        value["workState"] = json!(update.kind);
        value["workConditionSummary"] = json!(update.body.chars().take(500).collect::<String>());
    }
    if item.enrichment.is_some() {
        value["enrichmentState"] = json!(if enrichment.is_some() {
            "active"
        } else {
            "stale"
        });
    }
    if let Some(until) = active_backlog(item, now) {
        value["backlog"] = json!({"until":until});
    }
    value
}

fn brief(item: &Item, now: &str) -> Value {
    let c = card(item, now);
    json!({"id":item.id,"itemNumber":item.item_number,"title":item.title,"fingerprint":item.fingerprint,"priority":c["priority"],"workflowState":c["workflowState"],"sources":c["sources"],"archived":item.archive.is_some()})
}
fn active_enrichment(item: &Item) -> Option<&Value> {
    item.enrichment
        .as_ref()
        .filter(|_| item.enrichment_fingerprint.as_deref() == Some(&item.fingerprint))
}
fn hash_item(item: &Item) -> String {
    hash(
        &json!({"title":item.title,"summary":item.summary,"sources":item.contributions.iter().map(|c|json!({"record":c.record_key,"payload":c.payload})).collect::<Vec<_>>(),"relationships":item.relationships}),
    )
}
fn search_text(item: &Item) -> String {
    fn collect(value: &Value, text: &mut String) {
        match value {
            Value::String(value) => {
                text.push(' ');
                text.push_str(value);
            }
            Value::Array(values) => {
                for value in values {
                    collect(value, text);
                }
            }
            Value::Object(values) => {
                for value in values.values() {
                    collect(value, text);
                }
            }
            _ => {}
        }
    }
    let mut content = String::new();
    collect(
        &serde_json::to_value(item).unwrap_or_default(),
        &mut content,
    );
    format!(
        "{} {} {} {}",
        item.item_number,
        format_item_number(item.item_number),
        item.aliases
            .iter()
            .filter_map(|alias| alias["itemNumber"].as_i64())
            .map(|number| format!("{} {}", number, format_item_number(number)))
            .collect::<Vec<_>>()
            .join(" "),
        content
    )
    .to_lowercase()
}

fn matches_item_number(item: &Item, number: Option<i64>) -> bool {
    number.is_some_and(|number| {
        item.item_number == number
            || item
                .aliases
                .iter()
                .any(|alias| alias["itemNumber"].as_i64() == Some(number))
    })
}

fn archive_expired(state: &mut DashboardState, now: &str) -> Result<()> {
    let current = chrono::DateTime::parse_from_rfc3339(now).map_err(|_| DynaError::invalid())?;
    let mut events = vec![];
    for item in state.items.values_mut() {
        if item.archive.is_some() || item.legacy.contains_key("mergedInto") {
            continue;
        }
        if project(item).stage == "completed" && item.completed_at.is_none() {
            item.completed_at = item
                .linked_tasks
                .iter()
                .map(|t| t.status_updated_at.clone())
                .max();
            item.completion_authority = Some("native_controller".to_string());
        }
        if let Some(completed) = &item.completed_at {
            let completed = chrono::DateTime::parse_from_rfc3339(completed)
                .map_err(|_| DynaError::storage())?;
            if current - completed
                >= chrono::Duration::hours(state.dashboard.done_retention_hours as i64)
            {
                item.archive = Some(Archive {
                    id: uuid::Uuid::new_v4().to_string(),
                    reason: "completed".to_string(),
                    reason_detail: None,
                    mode: "automatic".to_string(),
                    archived_at: now.to_string(),
                    fingerprint_at_archive: item.fingerprint.clone(),
                    changed_since_archive: false,
                });
                events.push((item.id.clone(), json!(item.archive)));
            }
        }
    }
    if !events.is_empty() {
        for (id, data) in events {
            add_event(
                state,
                &id,
                "automatic_archive",
                data,
                &Actor::default(),
                now,
            );
        }
        touch(state, now);
    }
    Ok(())
}

fn control(state: &DashboardState, id: &str) -> Result<Value> {
    let item = find_item(state, id, false)?;
    let projection = project(item);
    Ok(
        json!({"dashboardId":state.dashboard.id,"dashboardKey":state.dashboard.key,"itemId":id,"itemNumber":item.item_number,
    "fingerprint":item.fingerprint,"dashboardRevision":state.dashboard.revision,"enrichmentVersion":item.enrichment_version,"lifecycle":projection.stage,"condition":projection.condition,"blocked":projection.blocked,"archived":item.archive.is_some()}),
    )
}
fn touch(state: &mut DashboardState, now: &str) {
    state.dashboard.revision += 1;
    state.dashboard.updated_at = now.to_string();
}
fn add_event(
    state: &mut DashboardState,
    id: &str,
    kind: &str,
    data: Value,
    actor: &Actor,
    now: &str,
) {
    state.events.push(Event {
        id: uuid::Uuid::new_v4().to_string(),
        item_id: id.to_string(),
        kind: kind.to_string(),
        occurred_at: now.to_string(),
        actor: actor.clone(),
        data,
    });
}
fn source_freshness(state: &DashboardState) -> &'static str {
    if state.publishers.is_empty() {
        "fresh"
    } else if state
        .publishers
        .values()
        .any(|p| p.last_run_status == "failed" || p.last_run_status == "partial")
    {
        "stale"
    } else {
        "fresh"
    }
}
fn selector(request: &Request) -> Result<&str> {
    request.dashboard.as_deref().ok_or(DynaError::invalid())
}
fn item_id(request: &Request) -> Result<&str> {
    request.item_id.as_deref().ok_or(DynaError::invalid())
}
fn object(input: Option<Value>) -> Result<Map<String, Value>> {
    input
        .and_then(|v| v.as_object().cloned())
        .ok_or(DynaError::invalid())
}
fn fields(input: &Map<String, Value>, allowed: &[&str]) -> Result<()> {
    if input.keys().any(|k| !allowed.contains(&k.as_str())) {
        Err(DynaError::invalid())
    } else {
        Ok(())
    }
}
fn required_str<'a>(input: &'a Map<String, Value>, key: &str) -> Result<&'a str> {
    input
        .get(key)
        .and_then(Value::as_str)
        .ok_or(DynaError::invalid())
}
fn required_uuid(input: &Map<String, Value>, key: &str) -> Result<String> {
    uuid(required_str(input, key)?)
}
fn optional_text(input: &Map<String, Value>, key: &str, max: usize) -> Result<Option<String>> {
    input
        .get(key)
        .map(|v| bounded_text(v.as_str().ok_or(DynaError::invalid())?, max))
        .transpose()
}
fn retention(input: &Map<String, Value>) -> Result<Option<u32>> {
    input
        .get("doneRetentionHours")
        .map(|v| {
            let n = v
                .as_u64()
                .filter(|n| *n >= 1 && *n <= 8760)
                .ok_or(DynaError::invalid())?;
            Ok(n as u32)
        })
        .transpose()
}
fn parse_priority(value: Option<&Value>) -> Result<Option<Priority>> {
    value
        .map(|v| serde_json::from_value(v.clone()).map_err(|_| DynaError::invalid()))
        .transpose()
}
fn text_array(value: Option<&Value>, count: usize, length: usize) -> Result<Vec<String>> {
    let Some(value) = value else {
        return Ok(vec![]);
    };
    let values = value
        .as_array()
        .filter(|a| a.len() <= count)
        .ok_or(DynaError::invalid())?;
    values
        .iter()
        .map(|v| bounded_text(v.as_str().ok_or(DynaError::invalid())?, length))
        .collect()
}
fn parse_artifacts(value: Option<&Value>) -> Result<Vec<Artifact>> {
    let artifacts: Vec<Artifact> = value
        .map(|v| serde_json::from_value(v.clone()))
        .transpose()?
        .unwrap_or_default();
    if artifacts.len() > 4 {
        return Err(DynaError::invalid());
    }
    for artifact in &artifacts {
        artifact.validate()?;
    }
    Ok(artifacts)
}
fn request_hash(request: &Request, input: &Map<String, Value>, actor: &Actor) -> String {
    hash(
        &json!({"operation":request.operation,"input":input,"item":request.item_id,"fingerprint":request.expected_fingerprint,"revision":request.expected_revision,"enrichmentVersion":request.expected_enrichment_version,"annotation":request.annotation_id,"annotationVersion":request.expected_annotation_version,"actor":actor}),
    )
}
fn entry_key(entry: &Value) -> String {
    entry.get("id").and_then(Value::as_str).map(str::to_string).unwrap_or_else(||hash(&json!({"publisher":entry["publisherId"],"external":entry["externalId"],"record":entry["recordKey"]})))
}

/// Bound both machine and human output by bytes, not merely record count.
/// Stored evidence is untouched; callers can request the remaining records.
fn bounded_page(
    mut result: Value,
    field: &str,
    entries: &[Value],
    limit: usize,
    cursor: Option<&str>,
    signature: &str,
) -> Result<Value> {
    let offset = cursor_offset(cursor, signature, entries)?;
    result["total"] = json!(entries.len());
    result["nextCursor"] = Value::Null;
    result["truncated"] = json!(offset < entries.len());
    for entry in entries.iter().skip(offset).take(limit) {
        result[field].as_array_mut().unwrap().push(entry.clone());
        let count = result[field].as_array().unwrap().len();
        let more = offset + count < entries.len();
        result["truncated"] = json!(more);
        result["nextCursor"] = if more {
            json!(format!("{signature}|{}", entry_key(entry)))
        } else {
            Value::Null
        };
        if !within_output_budget(&result)? {
            result[field].as_array_mut().unwrap().pop();
            let previous = result[field]
                .as_array()
                .unwrap()
                .last()
                .ok_or(DynaError::new(
                    "output_limit",
                    "One evidence record exceeds the bounded read limit.",
                ))?;
            result["nextCursor"] = json!(format!("{signature}|{}", entry_key(previous)));
            result["truncated"] = json!(true);
            break;
        }
    }
    if !within_output_budget(&result)? {
        return Err(DynaError::new(
            "output_limit",
            "Dyna result exceeds the bounded read limit.",
        ));
    }
    Ok(result)
}

fn within_output_budget(value: &Value) -> Result<bool> {
    Ok(
        serde_json::to_vec(value)?.len() < MAX_STDOUT
            && safe_pretty_json(value)?.len() < MAX_STDOUT,
    )
}

fn cursor_offset(cursor: Option<&str>, signature: &str, entries: &[Value]) -> Result<usize> {
    match cursor {
        None => Ok(0),
        Some(c) => {
            let (s, anchor) = c.split_once('|').ok_or(DynaError::invalid())?;
            if c.len() > 130 {
                return Err(DynaError::invalid());
            }
            if s != signature {
                return Err(DynaError::new(
                    "stale_cursor",
                    "The evidence cursor changed; restart the bounded read.",
                ));
            }
            entries
                .iter()
                .position(|entry| entry_key(entry) == anchor)
                .map(|position| position + 1)
                .ok_or(DynaError::new(
                    "stale_cursor",
                    "The evidence cursor changed; restart the bounded read.",
                ))
        }
    }
}
fn operator(request: &Request) -> Result<()> {
    if request
        .actor
        .as_ref()
        .is_none_or(|a| *a == ActorKind::LocalOperator)
    {
        Ok(())
    } else {
        Err(forbidden())
    }
}
fn actor(request: &Request, input: &Map<String, Value>) -> Result<Actor> {
    let kind = request.actor.clone().unwrap_or(ActorKind::LocalOperator);
    if ![ActorKind::LocalOperator, ActorKind::LinkedWorker].contains(&kind) {
        return Err(forbidden());
    }
    if kind == ActorKind::LocalOperator {
        if input.contains_key("task") || input.contains_key("workAttemptId") {
            return Err(DynaError::invalid());
        }
        return Ok(Actor::default());
    }
    let task = input
        .get("task")
        .and_then(Value::as_object)
        .ok_or(DynaError::invalid())?;
    fields(task, &["taskId", "hostId"])?;
    let task_id = bounded_text(required_str(task, "taskId")?, 128)?;
    let host_id = bounded_text(required_str(task, "hostId")?, 128)?;
    let attempt = required_uuid(input, "workAttemptId")?;
    Ok(Actor {
        kind,
        task_id: Some(task_id),
        host_id: Some(host_id),
        work_attempt_id: Some(attempt),
    })
}
fn find_item<'a>(state: &'a DashboardState, id: &str, mutation: bool) -> Result<&'a Item> {
    let mut canonical_id = id;
    let mut visited = BTreeSet::new();
    while let Some(canonical) = state
        .items
        .get(canonical_id)
        .and_then(|i| i.legacy.get("mergedInto"))
        .and_then(Value::as_str)
    {
        if mutation {
            return Err(stale_item());
        }
        if !visited.insert(canonical_id) || visited.len() > 200 {
            return Err(DynaError::storage());
        }
        canonical_id = canonical;
    }
    if canonical_id != id {
        return state.items.get(canonical_id).ok_or(DynaError::storage());
    }
    uuid(id)?;
    let direct = state.items.get(id);
    let canonical = state.items.values().find(|i| {
        i.aliases
            .iter()
            .any(|a| a.get("itemId").and_then(Value::as_str) == Some(id))
    });
    if mutation && canonical.is_some() {
        return Err(stale_item());
    }
    direct.or(canonical).ok_or(DynaError::new(
        "not_found",
        "Dyna item was not found on this dashboard.",
    ))
}
fn check_revision(request: &Request, state: &DashboardState) -> Result<()> {
    if request.expected_revision != Some(state.dashboard.revision) {
        Err(DynaError::new(
            "stale_dashboard",
            "Dyna dashboard changed; read current context.",
        ))
    } else {
        Ok(())
    }
}
fn check_item<'a>(request: &Request, state: &'a DashboardState, actor: &Actor) -> Result<&'a Item> {
    let item = find_item(state, item_id(request)?, true)?;
    if request.expected_fingerprint.as_deref() != Some(&item.fingerprint) {
        return Err(stale_item());
    }
    if ![
        "work update",
        "work complete",
        "work enrich",
        "annotation add",
        "annotation edit",
        "annotation delete",
    ]
    .contains(&request.operation.as_str())
    {
        check_revision(request, state)?;
    }
    if actor.kind == ActorKind::LinkedWorker {
        let task = item
            .linked_tasks
            .iter()
            .find(|t| {
                Some(&t.task_id) == actor.task_id.as_ref()
                    && Some(&t.host_id) == actor.host_id.as_ref()
            })
            .ok_or(forbidden())?;
        if task.title_sync_needed
            || task.title != canonical_task_title(item.item_number, &task.title)
        {
            return Err(DynaError::new(
                "title_sync_needed",
                "Verify the linked Codex task title before writing.",
            ));
        }
        for event in &state.events {
            if event.actor.work_attempt_id == actor.work_attempt_id
                && event.actor.task_id != actor.task_id
            {
                return Err(forbidden());
            }
        }
    }
    Ok(item)
}
fn active_dashboard(state: &DashboardState) -> Result<()> {
    if state.dashboard.archived {
        Err(DynaError::new(
            "dashboard_archived",
            "Restore the dashboard before modifying its work.",
        ))
    } else {
        Ok(())
    }
}
fn validate_enrichment(set: &Map<String, Value>) -> Result<()> {
    for (key, value) in set {
        match key.as_str() {
            "summary" => {
                bounded_text(value.as_str().ok_or(DynaError::invalid())?, 1000)?;
            }
            "attention" | "priorityReason" => {
                bounded_text(value.as_str().ok_or(DynaError::invalid())?, 500)?;
            }
            "plan" => {
                text_array(Some(value), 4, 200)?;
            }
            "nextSteps" => {
                let steps = value
                    .as_array()
                    .filter(|s| s.len() <= 4)
                    .ok_or(DynaError::invalid())?;
                for step in steps {
                    let step = step.as_object().ok_or(DynaError::invalid())?;
                    fields(step, &["label", "owner", "dueAt"])?;
                    bounded_text(required_str(step, "label")?, 200)?;
                    optional_text(step, "owner", 120)?;
                    if let Some(due) = step.get("dueAt") {
                        timestamp(due.as_str().ok_or(DynaError::invalid())?)?;
                    }
                }
            }
            "labels" => {
                text_array(Some(value), 20, 64)?;
            }
            "dueAt" => {
                timestamp(value.as_str().ok_or(DynaError::invalid())?)?;
            }
            "priority" => {
                parse_priority(Some(value))?;
            }
            "people" => {
                let people: Vec<PersonSignal> = serde_json::from_value(value.clone())?;
                if people.len() > 8 {
                    return Err(DynaError::invalid());
                }
                for person in people {
                    person.validate()?;
                }
            }
            _ => return Err(DynaError::invalid()),
        }
    }
    Ok(())
}
fn forbidden() -> DynaError {
    DynaError::new(
        "forbidden",
        "This actor cannot perform the requested Dyna operation.",
    )
}
fn stale_item() -> DynaError {
    DynaError::new(
        "stale_item",
        "Dyna item changed; read current canonical context.",
    )
}
fn archived() -> DynaError {
    DynaError::new(
        "item_archived",
        "Restore the Dyna item or create a linked follow-up.",
    )
}
