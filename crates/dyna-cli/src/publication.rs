//! Source-sliced publication and exact, dashboard-local correlation rules.
//! This module is transport/storage independent; all input is untrusted evidence.
use crate::contracts::*;
use crate::error::{DynaError, Result};
use crate::evidence::{self, Relationship};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Publication {
    pub request_id: String,
    pub publisher_id: String,
    pub run_id: String,
    pub source_completed_at: String,
    #[serde(default = "replace")]
    pub mode: String,
    #[serde(default = "succeeded")]
    pub status: String,
    pub failure_message: Option<String>,
    pub source_slices: Option<Vec<Value>>,
    pub items: Vec<PublishedRecord>,
    #[serde(default)]
    pub work_summaries: Vec<WorkSummary>,
}
fn replace() -> String {
    "replace".into()
}
fn succeeded() -> String {
    "succeeded".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublishedRecord {
    pub external_id: String,
    pub source_ref: Value,
    pub source_scope: String,
    pub title: String,
    pub summary: String,
    pub priority: Priority,
    pub priority_reason: String,
    pub source_updated_at: String,
    pub due_at: Option<String>,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub people: Vec<PersonSignal>,
    pub attention: Option<String>,
    #[serde(default)]
    pub plan: Vec<String>,
    #[serde(default)]
    pub next_steps: Vec<NextStep>,
    #[serde(default)]
    pub relationships: Vec<Relationship>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NextStep {
    pub label: String,
    pub owner: Option<String>,
    pub due_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkSummary {
    pub work_identity: Value,
    pub summary: String,
    pub evidence_refs: Vec<Value>,
}

impl Publication {
    pub fn validate(&mut self, now: &str) -> Result<()> {
        self.request_id = uuid(&self.request_id)?;
        self.publisher_id = uuid(&self.publisher_id)?;
        bounded_text(&self.run_id, 256)?;
        self.source_completed_at = timestamp(&self.source_completed_at)?;
        if self.source_completed_at.as_str() > now
            || !["replace", "upsert"].contains(&self.mode.as_str())
            || !["succeeded", "partial", "failed"].contains(&self.status.as_str())
            || self.items.len() > 200
            || self.work_summaries.len() > 200
        {
            return Err(DynaError::invalid());
        }
        if let Some(message) = &self.failure_message {
            bounded_text(message, 500)?;
        }
        if let Some(slices) = &self.source_slices {
            evidence::validate_slices(&json!(slices), true)?;
        }
        if self.status == "failed"
            && (!self.items.is_empty()
                || !self.work_summaries.is_empty()
                || self.source_slices.as_ref().is_some_and(|slices| {
                    slices.iter().any(|slice| slice["status"] == "succeeded")
                }))
        {
            return Err(DynaError::invalid());
        }
        if self.status == "partial" && self.source_slices.is_none() {
            return Err(DynaError::invalid());
        }
        if self.status == "succeeded"
            && self
                .source_slices
                .as_ref()
                .is_some_and(|slices| slices.iter().any(|s| s["status"] != "succeeded"))
        {
            return Err(DynaError::invalid());
        }
        let mut ids = BTreeSet::new();
        for record in &mut self.items {
            bounded_text(&record.external_id, 256)?;
            if !ids.insert(record.external_id.clone()) {
                return Err(DynaError::invalid());
            }
            evidence::validate_ref(&record.source_ref, false)?;
            bounded_text(&record.source_scope, 128)?;
            bounded_text(&record.title, 200)?;
            bounded_text(&record.summary, 1000)?;
            bounded_text(&record.priority_reason, 500)?;
            record.source_updated_at = timestamp(&record.source_updated_at)?;
            if record.source_updated_at > self.source_completed_at {
                return Err(DynaError::invalid());
            }
            if let Some(due) = &mut record.due_at {
                *due = timestamp(due)?;
            }
            if let Some(attention) = &record.attention {
                bounded_text(attention, 500)?;
            }
            if record.labels.len() > 20
                || record.people.len() > 8
                || record.plan.len() > 4
                || record.next_steps.len() > 4
                || record.relationships.len() > 8
            {
                return Err(DynaError::invalid());
            }
            for label in &record.labels {
                bounded_text(label, 64)?;
            }
            for person in &record.people {
                person.validate()?;
                if !["declared_source", "source_metadata"].contains(&person.provenance.as_str()) {
                    return Err(DynaError::invalid());
                }
            }
            for step in &record.plan {
                bounded_text(step, 200)?;
            }
            for step in &mut record.next_steps {
                bounded_text(&step.label, 200)?;
                if let Some(owner) = &step.owner {
                    bounded_text(owner, 120)?;
                }
                if let Some(due) = &mut step.due_at {
                    *due = timestamp(due)?;
                }
            }
            for relationship in &record.relationships {
                if !evidence::valid_relationship(&record.source_ref, relationship)? {
                    return Err(DynaError::invalid());
                }
            }
            if self.source_slices.as_ref().is_some_and(|slices| {
                !slices.iter().any(|slice| {
                    slice["source"] == record.source_ref["source"]
                        && slice["sourceScope"] == record.source_scope
                        && slice["status"] == "succeeded"
                })
            }) {
                return Err(DynaError::invalid());
            }
        }
        for summary in &self.work_summaries {
            evidence::validate_ref(&summary.work_identity, false)?;
            bounded_text(&summary.summary, 1000)?;
            if summary.evidence_refs.is_empty() || summary.evidence_refs.len() > 16 {
                return Err(DynaError::invalid());
            }
            for reference in &summary.evidence_refs {
                evidence::validate_ref(reference, false)?;
            }
        }
        Ok(())
    }

    pub fn receipt_id(&self, dashboard: &str) -> String {
        scoped_id(&format!(
            "dyna/publication/{dashboard}/{}/{}",
            self.publisher_id, self.run_id
        ))
    }
    pub fn receipt_hash(&self) -> String {
        let mut value = json!(self);
        value.as_object_mut().unwrap().remove("requestId");
        hash(&value)
    }
}

pub fn candidate_id(dashboard: &str, record_key: &str) -> String {
    scoped_id(&format!("dyna/record/{dashboard}/{record_key}"))
}
fn scoped_id(value: &str) -> String {
    uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_OID, value.as_bytes()).to_string()
}

pub fn apply(
    state: &mut DashboardState,
    publication: &Publication,
    allocations: &BTreeMap<String, i64>,
    now: &str,
) -> Result<Value> {
    let publisher = state
        .publishers
        .get(&publication.publisher_id)
        .ok_or(DynaError::new("not_found", "Dyna publisher was not found."))?;
    if state.dashboard.archived || publisher.revoked {
        return Err(DynaError::new(
            "forbidden",
            "The dashboard or publisher is inactive.",
        ));
    }
    if !publisher.required_source_slices.is_empty() {
        let provided = publication
            .source_slices
            .as_ref()
            .ok_or(DynaError::invalid())?;
        let required = publisher
            .required_source_slices
            .iter()
            .map(evidence::slice_key)
            .collect::<BTreeSet<_>>();
        if required != provided.iter().map(evidence::slice_key).collect() {
            return Err(DynaError::invalid());
        }
    }
    if publisher
        .last_run_at
        .as_ref()
        .is_some_and(|time| time > &publication.source_completed_at)
    {
        return Ok(envelope(
            "dyna/publication-result-v1",
            json!({"requestId":publication.request_id,"accepted":0,"deduplicated":false,"superseded":true,"status":publication.status,"revision":state.dashboard.revision}),
        ));
    }
    let mut touched = BTreeSet::new();
    let successful_slice = |source: &Value, scope: &str| {
        publication
            .source_slices
            .as_ref()
            .map_or(publication.status == "succeeded", |slices| {
                slices.iter().any(|s| {
                    s["source"] == source["source"]
                        && s["sourceScope"] == scope
                        && s["status"] == "succeeded"
                })
            })
    };
    let failed_slice = |source: &Value, scope: &str| {
        publication
            .source_slices
            .as_ref()
            .map_or(publication.status == "failed", |slices| {
                slices.iter().any(|s| {
                    s["source"] == source["source"]
                        && s["sourceScope"] == scope
                        && s["status"] == "failed"
                })
            })
    };
    let incoming = publication
        .items
        .iter()
        .map(|i| i.external_id.as_str())
        .collect::<BTreeSet<_>>();
    for item in state
        .items
        .values_mut()
        .filter(|item| !item.legacy.contains_key("mergedInto"))
    {
        for contribution in &mut item.contributions {
            if contribution.publisher_id != publication.publisher_id
                || contribution.retired_at.is_some()
            {
                continue;
            }
            if failed_slice(&contribution.source_ref, &contribution.source_scope) {
                contribution.freshness = "last_known".into();
            }
            if publication.mode == "replace"
                && successful_slice(&contribution.source_ref, &contribution.source_scope)
                && !incoming.contains(contribution.external_id.as_str())
            {
                contribution.retired_at = Some(now.into());
                contribution.freshness = "retired".into();
                touched.insert(item.id.clone());
            }
        }
    }
    // Establish work anchors before context records so a message cannot claim
    // an unseen MR simply because it happens to precede it in this payload.
    let mut records = publication.items.iter().collect::<Vec<_>>();
    records.sort_by_key(|record| context_record(&record.source_ref));
    for record in records {
        let key = evidence::record_key(&record.source_ref)?;
        let prior = state.items.values().find(|item| {
            !item.legacy.contains_key("mergedInto")
                && item.contributions.iter().any(|c| {
                    c.publisher_id == publication.publisher_id
                        && c.external_id == record.external_id
                })
        });
        if let Some(prior) = prior {
            let old = prior
                .contributions
                .iter()
                .find(|c| {
                    c.publisher_id == publication.publisher_id
                        && c.external_id == record.external_id
                })
                .unwrap();
            if old.record_key != key {
                return Err(DynaError::new(
                    "record_identity_conflict",
                    "A published record cannot change its provider identity.",
                ));
            }
            if old.source_updated_at > record.source_updated_at {
                continue;
            }
        }
        let mut targets = record
            .relationships
            .iter()
            .map(|r| evidence::record_key(&r.target))
            .collect::<Result<BTreeSet<_>>>()?;
        targets.retain(|target| {
            !state
                .source_separations
                .contains(&(key.clone(), target.clone()))
        });
        let mut jira_keys = record
            .relationships
            .iter()
            .filter_map(|r| evidence::jira_key(&r.target))
            .collect::<BTreeSet<_>>();
        if let Some(jira) = evidence::jira_key(&record.source_ref) {
            jira_keys.insert(jira);
        }
        let mut candidates = targets
            .iter()
            .chain([&key])
            .filter_map(|k| state.work_identities.get(k).cloned())
            .collect::<BTreeSet<_>>();
        for candidate in &candidates {
            if let Some(item) = state.items.get(candidate) {
                for contribution in &item.contributions {
                    if let Some(jira) = evidence::jira_key(&contribution.source_ref) {
                        jira_keys.insert(jira);
                    }
                }
                for relationship in &item.relationships {
                    if let Some(jira) = evidence::jira_key(&relationship["target"]) {
                        jira_keys.insert(jira);
                    }
                }
            }
        }
        // A message pointing at several independent anchors never joins them.
        let target_anchors = targets
            .iter()
            .map(|target| state.work_identities.get(target).cloned())
            .collect::<Option<BTreeSet<_>>>();
        let targets_established = target_anchors.is_some_and(|anchors| anchors.len() == 1);
        let conflict = jira_keys.len() > 1
            || (context_record(&record.source_ref) && targets.len() > 1 && !targets_established);
        if conflict {
            candidates = state
                .work_identities
                .get(&key)
                .cloned()
                .into_iter()
                .collect();
            targets.clear();
        }
        let item_id = if candidates.is_empty() {
            let new_id = candidate_id(&state.dashboard.id, &key);
            let number = *allocations.get(&new_id).ok_or(DynaError::new(
                "stale_item",
                "Publication context changed; retry the same request.",
            ))?;
            if !state.items.contains_key(&new_id) {
                let sequence = state.items.values().map(|i| i.sequence).max().unwrap_or(-1) + 1;
                state.items.insert(
                    new_id.clone(),
                    new_record_item(&new_id, number, record, sequence, now),
                );
            }
            new_id
        } else {
            let survivor = candidates
                .iter()
                .min_by_key(|id| {
                    state
                        .items
                        .get(*id)
                        .map(|i| (i.created_at.clone(), i.item_number))
                })
                .unwrap()
                .clone();
            for candidate in candidates.iter().filter(|id| **id != survivor) {
                merge(state, &survivor, candidate, now)?;
            }
            survivor
        };
        state.work_identities.insert(key.clone(), item_id.clone());
        for target in &targets {
            state
                .work_identities
                .insert(target.clone(), item_id.clone());
        }
        let prior = state
            .items
            .get(&item_id)
            .and_then(|item| {
                item.contributions.iter().find(|c| {
                    c.publisher_id == publication.publisher_id
                        && c.external_id == record.external_id
                })
            })
            .cloned();
        if prior
            .as_ref()
            .is_none_or(|old| old.payload != json!(record) || old.retired_at.is_some())
        {
            state.events.push(Event {
                id: uuid::Uuid::new_v4().to_string(),
                item_id: item_id.clone(),
                kind: "source_updated".into(),
                occurred_at: now.into(),
                actor: Actor {
                    kind: ActorKind::Publisher,
                    ..Default::default()
                },
                data: json!({"before":prior,"after":record,"publisherId":publication.publisher_id}),
            });
        }
        let item = state.items.get_mut(&item_id).ok_or(DynaError::storage())?;
        item.contributions.retain(|c| {
            !(c.publisher_id == publication.publisher_id && c.external_id == record.external_id)
        });
        item.contributions.push(SourceContribution {
            publisher_id: publication.publisher_id.clone(),
            external_id: record.external_id.clone(),
            record_key: key.clone(),
            source_scope: record.source_scope.clone(),
            source_ref: record.source_ref.clone(),
            payload: json!(record),
            observed_at: now.into(),
            source_updated_at: record.source_updated_at.clone(),
            freshness: "current".into(),
            retired_at: None,
        });
        for relationship in &record.relationships {
            if !targets.contains(&evidence::record_key(&relationship.target)?) {
                continue;
            }
            let proof = json!({"kind":relationship.kind,"source":record.source_ref,"target":relationship.target,"field":relationship.evidence.field,"exactValue":relationship.evidence.exact_value,"publisherId":publication.publisher_id,"externalId":record.external_id,"observedAt":now,"collectorSupplied":true});
            let proof_key = hash(&json!([
                proof["kind"],
                proof["source"],
                proof["target"],
                proof["field"],
                proof["exactValue"]
            ]));
            item.relationships.retain(|old| {
                hash(&json!([
                    old["kind"],
                    old["source"],
                    old["target"],
                    old["field"],
                    old["exactValue"]
                ])) != proof_key
            });
            item.relationships.push(proof);
        }
        if conflict {
            item.legacy.insert("correlationWarning".into(), json!(true));
        }
        touched.insert(item_id);
    }
    for summary in &publication.work_summaries {
        let anchor = evidence::record_key(&summary.work_identity)?;
        let item_id = state
            .work_identities
            .get(&anchor)
            .ok_or(DynaError::invalid())?;
        let item = state.items.get_mut(item_id).ok_or(DynaError::storage())?;
        let mut cited = vec![];
        for reference in &summary.evidence_refs {
            let key = evidence::record_key(reference)?;
            let contribution = current_citation(item, &key).ok_or(DynaError::invalid())?;
            cited.push((key, contribution.payload.clone()));
        }
        cited.sort_by(|a, b| a.0.cmp(&b.0));
        item.legacy.insert("citedSummary".into(), json!({"summary":summary.summary,"keys":cited.iter().map(|e|&e.0).collect::<Vec<_>>(),"fingerprint":evidence::summary_evidence_fingerprint(&cited),"updatedAt":now}));
        touched.insert(item_id.clone());
    }
    for id in &touched {
        let item = state.items.get_mut(id).ok_or(DynaError::storage())?;
        refresh_item(item, now);
    }
    let publisher = state.publishers.get_mut(&publication.publisher_id).unwrap();
    publisher.last_run_at = Some(publication.source_completed_at.clone());
    publisher.last_run_status = publication.status.clone();
    publisher.last_source_slices = publication.source_slices.clone().unwrap_or_default();
    state.dashboard.revision += 1;
    state.dashboard.updated_at = now.into();
    Ok(envelope(
        "dyna/publication-result-v1",
        json!({"requestId":publication.request_id,"accepted":publication.items.len(),"deduplicated":false,"superseded":false,"status":publication.status,"revision":state.dashboard.revision,"updatedItems":touched.len()}),
    ))
}

fn new_record_item(
    id: &str,
    number: i64,
    record: &PublishedRecord,
    sequence: i64,
    now: &str,
) -> Item {
    Item {
        id: id.into(),
        item_number: number,
        title: record.title.clone(),
        summary: record.summary.clone(),
        fingerprint: String::new(),
        source_updated_at: record.source_updated_at.clone(),
        source_priority: record.priority.clone(),
        priority_override: None,
        sequence,
        due_at: record.due_at.clone(),
        labels: record.labels.clone(),
        people: record.people.iter().map(|p| json!(p)).collect(),
        attention: record.attention.clone(),
        plan: record.plan.clone(),
        next_steps: record.next_steps.iter().map(|p| json!(p)).collect(),
        enrichment: None,
        enrichment_version: 0,
        enrichment_fingerprint: None,
        contributions: vec![],
        relationships: vec![],
        aliases: vec![],
        linked_tasks: vec![],
        work_updates: vec![],
        annotations: vec![],
        archive: None,
        completed_at: None,
        outcome: None,
        completion_authority: None,
        manual_stage: None,
        manual_stage_at: None,
        backlog_until: None,
        follow_up_of_item_id: None,
        follow_up_of_item_number: None,
        created_at: now.into(),
        updated_at: now.into(),
        legacy: BTreeMap::new(),
    }
}

fn merge(state: &mut DashboardState, survivor: &str, merged: &str, now: &str) -> Result<()> {
    let original = state
        .items
        .get(merged)
        .cloned()
        .ok_or(DynaError::storage())?;
    let before = state
        .items
        .get(survivor)
        .cloned()
        .ok_or(DynaError::storage())?;
    let item = state.items.get_mut(survivor).unwrap();
    // Never reopen historical work through correlation.
    if item.completed_at.is_none() && crate::application::project(&original).stage == "completed" {
        item.completed_at = original.completed_at.clone().or_else(|| {
            original
                .linked_tasks
                .iter()
                .map(|task| task.status_updated_at.clone())
                .max()
        });
        item.outcome = original.outcome.clone();
        item.completion_authority = original
            .completion_authority
            .clone()
            .or_else(|| Some("native_controller".into()));
    }
    if item.archive.is_none() {
        item.archive = original.archive.clone();
    }
    // Correlation changes evidence/identity, not explicit work disposition.
    // Keep the later deferral and most recent manual stage; a tie retains the
    // survivor's choice. The merge event retains both originals for correction.
    if original.backlog_until > item.backlog_until {
        item.backlog_until = original.backlog_until.clone();
    }
    if original.manual_stage.is_some()
        && (item.manual_stage.is_none() || original.manual_stage_at > item.manual_stage_at)
    {
        item.manual_stage = original.manual_stage.clone();
        item.manual_stage_at = original.manual_stage_at.clone();
    }
    if item.priority_override.is_none() {
        item.priority_override = original.priority_override.clone();
    }
    item.contributions.extend(original.contributions.clone());
    item.relationships.extend(original.relationships.clone());
    item.annotations.extend(original.annotations.clone());
    item.work_updates.extend(original.work_updates.clone());
    item.work_updates
        .sort_by_key(|u| (u.created_at.clone(), u.id.clone()));
    item.work_updates.dedup_by(|a, b| a.id == b.id);
    item.linked_tasks.extend(original.linked_tasks.clone());
    for task in &mut item.linked_tasks {
        task.title_sync_needed = task.title != canonical_task_title(item.item_number, &task.title);
    }
    item.aliases.extend(original.aliases.clone());
    item.aliases.push(json!({"itemId":original.id,"itemNumber":original.item_number,"title":original.title,"mergedAt":now}));
    let alias = state.items.get_mut(merged).unwrap();
    alias.legacy.insert("mergedInto".into(), json!(survivor));
    alias.linked_tasks.clear();
    for alias in state.items.values_mut() {
        if alias.legacy.get("mergedInto").and_then(Value::as_str) == Some(merged) {
            alias.legacy.insert("mergedInto".into(), json!(survivor));
        }
    }
    for canonical in state.work_identities.values_mut() {
        if canonical == merged {
            *canonical = survivor.into();
        }
    }
    state.events.push(Event {
        id: uuid::Uuid::new_v4().to_string(),
        item_id: survivor.into(),
        kind: "sources_merged".into(),
        occurred_at: now.into(),
        actor: Actor {
            kind: ActorKind::Publisher,
            ..Default::default()
        },
        data: json!({"survivorBefore":before,"mergedBefore":original,"collectorSupplied":true}),
    });
    Ok(())
}

pub fn preferred_contribution(contributions: &[SourceContribution]) -> Option<&SourceContribution> {
    contributions.iter().max_by_key(|c| {
        (
            c.retired_at.is_none(),
            evidence::jira_key(&c.source_ref).is_some(),
            c.freshness == "current",
            c.source_updated_at.clone(),
            c.record_key.clone(),
            c.publisher_id.clone(),
            c.external_id.clone(),
        )
    })
}

pub fn refresh_item(item: &mut Item, now: &str) {
    let preferred = preferred_contribution(&item.contributions).filter(|c| c.retired_at.is_none());
    if let Some(contribution) = preferred {
        let record = &contribution.payload;
        item.title = record["title"].as_str().unwrap_or(&item.title).into();
        item.summary = record["summary"].as_str().unwrap_or(&item.summary).into();
        item.source_updated_at = contribution.source_updated_at.clone();
        item.due_at = record["dueAt"].as_str().map(str::to_string);
        item.attention = record["attention"].as_str().map(str::to_string);
        item.plan = record["plan"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect();
        item.next_steps = record["nextSteps"].as_array().cloned().unwrap_or_default();
        item.legacy
            .insert("priorityReason".into(), record["priorityReason"].clone());
    }
    let mut current = item
        .contributions
        .iter()
        .filter(|c| c.retired_at.is_none())
        .collect::<Vec<_>>();
    current.sort_by_key(|c| (&c.record_key, &c.publisher_id, &c.external_id));
    if let Some(priority) = current
        .iter()
        .filter_map(|c| serde_json::from_value::<Priority>(c.payload["priority"].clone()).ok())
        .min_by_key(Priority::rank)
    {
        item.source_priority = priority;
    }
    item.labels = current
        .iter()
        .flat_map(|c| c.payload["labels"].as_array().into_iter().flatten())
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .take(20)
        .collect();
    item.people = current
        .iter()
        .flat_map(|c| c.payload["people"].as_array().into_iter().flatten())
        .take(8)
        .cloned()
        .collect();
    let mut records=item.contributions.iter().map(|c|json!({"key":c.record_key,"publisher":c.publisher_id,"external":c.external_id,"payload":c.payload,"retired":c.retired_at.is_some()})).collect::<Vec<_>>();
    records.sort_by_key(Value::to_string);
    let mut relationships = item
        .relationships
        .iter()
        .map(|r| {
            json!([
                r["kind"],
                r["source"],
                r["target"],
                r["field"],
                r["exactValue"]
            ])
        })
        .collect::<Vec<_>>();
    relationships.sort_by_key(Value::to_string);
    item.fingerprint = hash(&json!({"records":records,"relationships":relationships}));
    item.updated_at = now.into();
    if let Some(archive) = &mut item.archive {
        archive.changed_since_archive |= archive.fingerprint_at_archive != item.fingerprint;
    }
}

fn context_record(source: &Value) -> bool {
    ["slack", "messaging", "outlook", "email"]
        .iter()
        .any(|name| source["source"] == *name)
        || (source["source"] == "twg" && source["resultType"] == "confluence")
}

fn current_citation<'a>(item: &'a Item, key: &str) -> Option<&'a SourceContribution> {
    item.contributions
        .iter()
        .filter(|c| c.record_key == key && c.retired_at.is_none() && c.freshness == "current")
        .max_by_key(|c| {
            (
                &c.source_updated_at,
                &c.observed_at,
                &c.publisher_id,
                &c.external_id,
            )
        })
}

pub fn cited_summary(item: &Item) -> Option<(String, bool)> {
    let summary = item.legacy.get("citedSummary")?;
    let mut records = vec![];
    let mut current = true;
    for key in summary["keys"].as_array()? {
        let key = key.as_str()?;
        let contribution = current_citation(item, key).or_else(|| {
            current = false;
            item.contributions
                .iter()
                .filter(|c| c.record_key == key)
                .max_by_key(|c| {
                    (
                        &c.source_updated_at,
                        &c.observed_at,
                        &c.publisher_id,
                        &c.external_id,
                    )
                })
        })?;
        records.push((
            contribution.record_key.clone(),
            contribution.payload.clone(),
        ));
    }
    records.sort_by(|a, b| a.0.cmp(&b.0));
    current &= summary["fingerprint"] == evidence::summary_evidence_fingerprint(&records);
    Some((summary["summary"].as_str()?.into(), current))
}
