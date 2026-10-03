//! Read-only migration decisions. No SQLite, paths, native task access or writes.
use crate::contracts::*;
use crate::error::{DynaError, Result};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub fn preview(mut inventory: LegacyInventory) -> Result<Value> {
    if inventory.schema_version != 14
        || inventory.dashboards.len() > 100
        || inventory.memberships.len() > 20_000
        || inventory.tasks.len() > 20_000
        || !(0..=MAX_ITEM_NUMBER).contains(&inventory.number_high_water)
    {
        return Err(DynaError::new(
            "migration_unavailable",
            "Only a bounded, intact Dyna v14 store can be planned.",
        ));
    }
    inventory
        .dashboards
        .sort_by_key(|d| (d.created_at.clone(), d.id.clone()));
    inventory
        .memberships
        .sort_by_key(|m| (m.item_number, m.item_id.clone(), m.dashboard_id.clone()));
    inventory
        .tasks
        .sort_by_key(|t| (t.task_id.clone(), t.item_id.clone()));
    let fingerprint = hash(&json!(inventory));
    let mut dashboard_ids = BTreeSet::new();
    let mut keys = BTreeSet::new();
    let mut dashboards = vec![];
    for dashboard in &inventory.dashboards {
        uuid(&dashboard.id)?;
        timestamp(&dashboard.created_at)?;
        bounded_text(&dashboard.name, 96)?;
        if !dashboard_ids.insert(dashboard.id.clone()) {
            return Err(DynaError::storage());
        }
        let mut base = dashboard
            .name
            .to_ascii_lowercase()
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .collect::<String>();
        if !base.starts_with(|c: char| c.is_ascii_lowercase()) {
            base.insert_str(0, "dashboard");
        }
        base.truncate(32);
        let mut key = base.clone();
        let mut suffix = 2;
        while !keys.insert(key.clone()) {
            let tail = suffix.to_string();
            key = format!("{}{}", &base[..base.len().min(32 - tail.len())], tail);
            suffix += 1;
        }
        dashboards.push(json!({"dashboardId":dashboard.id,"dashboardKey":dashboard_key(&key)?,"dashboardName":dashboard.name,"archived":dashboard.archived,"database":format!("{key}.sqlite3")}));
    }
    let mut by_item: BTreeMap<String, Vec<&LegacyMembership>> = BTreeMap::new();
    let mut numbers = BTreeMap::new();
    let mut pairs = BTreeSet::new();
    for member in &inventory.memberships {
        uuid(&member.item_id)?;
        if !dashboard_ids.contains(&member.dashboard_id)
            || member.item_number <= 0
            || member.item_number > inventory.number_high_water
            || !pairs.insert((member.dashboard_id.clone(), member.item_id.clone()))
        {
            return Err(DynaError::storage());
        }
        if numbers
            .insert(member.item_number, member.item_id.clone())
            .is_some_and(|previous| previous != member.item_id)
        {
            return Err(DynaError::storage());
        }
        by_item
            .entry(member.item_id.clone())
            .or_default()
            .push(member);
    }
    let order: BTreeMap<_, _> = inventory
        .dashboards
        .iter()
        .enumerate()
        .map(|(n, d)| (d.id.as_str(), n))
        .collect();
    let mut next = inventory.number_high_water;
    let mut items = vec![];
    let mut owners = BTreeMap::new();
    let mut task_items = BTreeMap::new();
    for task in &inventory.tasks {
        bounded_text(&task.task_id, 256)?;
        if !by_item.contains_key(&task.item_id)
            || task_items
                .insert(task.task_id.clone(), task.item_id.clone())
                .is_some_and(|previous| previous != task.item_id)
        {
            return Err(DynaError::new(
                "migration_conflict",
                "Legacy task ownership is inconsistent; no migration was performed.",
            ));
        }
    }
    // Iterate by existing number, then UUID. Dashboard age/UUID determines ownership.
    let mut groups = by_item.into_iter().collect::<Vec<_>>();
    groups.sort_by_key(|(id, members)| (members[0].item_number, id.clone()));
    let mut shared_items = 0;
    for (item_id, mut members) in groups {
        members.sort_by_key(|m| order[m.dashboard_id.as_str()]);
        if members
            .iter()
            .any(|m| m.item_number != members[0].item_number)
        {
            return Err(DynaError::storage());
        }
        if members.len() > 1 {
            shared_items += 1;
        }
        let owner = &members[0].dashboard_id;
        owners.insert(item_id.clone(), owner.clone());
        for member in members {
            let retains = member.dashboard_id == *owner;
            let number = if retains {
                member.item_number
            } else {
                next = next
                    .checked_add(1)
                    .filter(|n| *n <= MAX_ITEM_NUMBER)
                    .ok_or_else(|| {
                        DynaError::new("number_exhausted", "Dyna item numbers are exhausted.")
                    })?;
                next
            };
            let target_id = if retains {
                item_id.clone()
            } else {
                uuid::Uuid::new_v5(
                    &uuid::Uuid::NAMESPACE_OID,
                    format!("dyna/migration/v15/{}/{item_id}", member.dashboard_id).as_bytes(),
                )
                .to_string()
            };
            items.push(json!({"legacyItemId":item_id,"legacyItemNumber":member.item_number,"dashboardId":member.dashboard_id,"itemId":target_id,"proposedItemNumber":number,"retainsOriginal":retains,"retainsTaskAssociations":retains,"originItemId":if retains{None}else{Some(&item_id)}}));
        }
    }
    // Only aggregate task counts are public. No native task IDs or content are returned.
    let mut task_counts: BTreeMap<String, usize> = BTreeMap::new();
    for item_id in task_items.values() {
        *task_counts.entry(owners[item_id].clone()).or_default() += 1;
    }
    let result = envelope(
        "dyna/migration-plan-result-v1",
        json!({"previewOnly":true,"readyForCutover":false,"sourceSchemaVersion":14,"targetSchemaVersion":15,"catalogSchemaVersion":1,"fingerprint":fingerprint,"dashboards":dashboards,"items":items,"sharedItemCount":shared_items,"proposedNumberHighWater":next,"taskAssociationCounts":task_counts,"requiresStoppedLegacyWriters":true,"requiresCoordinatedBackup":true}),
    );
    if serde_json::to_vec(&result)?.len() > MAX_STDOUT {
        return Err(DynaError::new(
            "capacity_exceeded",
            "Migration preview exceeds the bounded result limit.",
        ));
    }
    Ok(result)
}
