use crate::error::{DynaError, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub const DASHBOARD_SCHEMA_VERSION: i64 = 15;
pub const CATALOG_SCHEMA_VERSION: i64 = 1;
pub const MAX_ITEM_NUMBER: i64 = 9_007_199_254_740_991;
pub const MAX_STDIN: usize = 32 * 1024;
pub const MAX_STDOUT: usize = 512 * 1024;

pub fn unsafe_display_character(ch: char) -> bool {
    ch.is_control()
        || matches!(ch, '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{2028}' | '\u{2029}')
}

/// Preserve readable JSON and its exact data while escaping terminal commands
/// and directional controls. Formatting newlines are not source text.
pub fn safe_pretty_json(value: &Value) -> Result<String> {
    let pretty = serde_json::to_string_pretty(value)?;
    let mut text = String::with_capacity(pretty.len());
    for ch in pretty.chars() {
        if ch != '\n' && unsafe_display_character(ch) {
            text.push_str(&format!("\\u{:04x}", ch as u32));
        } else {
            text.push(ch);
        }
    }
    Ok(text)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyDashboard {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub archived: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyMembership {
    pub dashboard_id: String,
    pub item_id: String,
    pub item_number: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyTaskOwner {
    pub item_id: String,
    pub task_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyInventory {
    pub schema_version: i64,
    pub number_high_water: i64,
    pub dashboards: Vec<LegacyDashboard>,
    pub memberships: Vec<LegacyMembership>,
    pub tasks: Vec<LegacyTaskOwner>,
}

pub fn dashboard_key(value: &str) -> Result<String> {
    let key = value.to_ascii_lowercase();
    if key.is_empty()
        || key.len() > 32
        || !key.as_bytes()[0].is_ascii_lowercase()
        || !key
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
    {
        return Err(DynaError::invalid());
    }
    Ok(key)
}

pub fn uuid(value: &str) -> Result<String> {
    let id = uuid::Uuid::parse_str(value).map_err(|_| DynaError::invalid())?;
    Ok(id.hyphenated().to_string())
}

pub fn hash(value: &Value) -> String {
    // serde_json's default map uses sorted keys, giving one canonical receipt hash.
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(value).expect("JSON serializable"))
    )
}

pub fn bounded_text(value: &str, max: usize) -> Result<String> {
    let text = value.trim();
    if text.is_empty() || text.chars().count() > max || text.contains('\0') {
        return Err(DynaError::invalid());
    }
    Ok(text.to_string())
}

pub fn timestamp(value: &str) -> Result<String> {
    let parsed = chrono::DateTime::parse_from_rfc3339(value).map_err(|_| DynaError::invalid())?;
    Ok(parsed
        .with_timezone(&chrono::Utc)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ActorKind {
    LocalOperator,
    LinkedWorker,
    ComponentView,
    Controller,
    Publisher,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Actor {
    pub kind: ActorKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub work_attempt_id: Option<String>,
}

impl Default for Actor {
    fn default() -> Self {
        Self {
            kind: ActorKind::LocalOperator,
            task_id: None,
            host_id: None,
            work_attempt_id: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Priority {
    Critical,
    High,
    Normal,
    Low,
}

impl Priority {
    pub fn rank(&self) -> usize {
        match self {
            Self::Critical => 0,
            Self::High => 1,
            Self::Normal => 2,
            Self::Low => 3,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Dashboard {
    pub id: String,
    pub key: String,
    pub name: String,
    pub description: String,
    pub archived: bool,
    pub revision: u64,
    pub done_retention_hours: u32,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskBinding {
    pub task_id: String,
    pub host_id: String,
    pub title: String,
    pub state: String,
    pub status_updated_at: String,
    pub observed_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
    pub title_sync_needed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Artifact {
    pub kind: String,
    pub label: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PersonSignal {
    pub display_name: String,
    pub title: Option<String>,
    pub leadership_level: String,
    pub relationship: String,
    pub involvement: String,
    pub provenance: String,
    pub confidence: String,
}

impl PersonSignal {
    pub fn validate(&self) -> Result<()> {
        bounded_text(&self.display_name, 120)?;
        if let Some(title) = &self.title {
            bounded_text(title, 160)?;
        }
        if ![
            "ceo",
            "cto",
            "gm",
            "vp",
            "senior_director",
            "director",
            "vip",
            "architect",
            "other",
        ]
        .contains(&self.leadership_level.as_str())
            || ![
                "management_chain",
                "my_org",
                "neighboring_org",
                "external",
                "unknown",
            ]
            .contains(&self.relationship.as_str())
            || ![
                "sender",
                "author",
                "declared_owner",
                "operational_owner",
                "approver",
                "reviewer",
                "expert",
                "informed",
                "mentioned",
            ]
            .contains(&self.involvement.as_str())
            || ![
                "user_configured",
                "twg_org_tree",
                "declared_source",
                "source_metadata",
            ]
            .contains(&self.provenance.as_str())
            || !["high", "medium", "low"].contains(&self.confidence.as_str())
        {
            return Err(DynaError::invalid());
        }
        Ok(())
    }
}

impl Artifact {
    pub fn validate(&self) -> Result<()> {
        if ![
            "merge_request",
            "pull_request",
            "issue",
            "pipeline",
            "commit",
            "document",
            "report",
            "other",
        ]
        .contains(&self.kind.as_str())
        {
            return Err(DynaError::invalid());
        }
        bounded_text(&self.label, 200)?;
        // Deliberately bounded protocol check; provider-derived source URLs have
        // their own exact-identity validation rather than accepting this input.
        if self.url.len() > 2048
            || !["http://", "https://"]
                .iter()
                .any(|p| self.url.starts_with(p))
            || self.url.bytes().any(|c| c <= 32 || c == 127)
        {
            return Err(DynaError::invalid());
        }
        let authority = self
            .url
            .split_once("://")
            .unwrap()
            .1
            .split(['/', '?', '#'])
            .next()
            .unwrap_or("");
        if authority.is_empty() || authority.contains('@') || self.url.contains('\\') {
            return Err(DynaError::invalid());
        }
        let (host, port) = if authority.starts_with('[') {
            let end = authority.find(']').ok_or(DynaError::invalid())?;
            authority[1..end]
                .parse::<std::net::Ipv6Addr>()
                .map_err(|_| DynaError::invalid())?;
            let port = authority[end + 1..].strip_prefix(':');
            if end + 1 < authority.len() && port.is_none() {
                return Err(DynaError::invalid());
            }
            (&authority[..=end], port)
        } else {
            authority
                .split_once(':')
                .map(|(h, p)| (h, Some(p)))
                .unwrap_or((authority, None))
        };
        if !host.starts_with('[')
            && (host.len() > 253
                || host.split('.').any(|label| {
                    label.is_empty()
                        || label.len() > 63
                        || label.starts_with('-')
                        || label.ends_with('-')
                        || !label
                            .bytes()
                            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
                }))
        {
            return Err(DynaError::invalid());
        }
        if let Some(port) = port {
            if port.is_empty()
                || !port.bytes().all(|c| c.is_ascii_digit())
                || port.parse::<u16>().is_err()
            {
                return Err(DynaError::invalid());
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkUpdate {
    pub id: String,
    pub kind: String,
    pub body: String,
    pub outcome: Option<String>,
    pub artifacts: Vec<Artifact>,
    pub created_at: String,
    pub actor: Actor,
    pub supersedes_work_update_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Annotation {
    pub id: String,
    pub body: String,
    pub version: u64,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub actor: Actor,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Archive {
    pub id: String,
    pub reason: String,
    pub reason_detail: Option<String>,
    pub mode: String,
    pub archived_at: String,
    pub fingerprint_at_archive: String,
    pub changed_since_archive: bool,
}

/// Source material stays in an untrusted payload. It is never interpreted as a
/// command, path, permission, or native-task identity.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceContribution {
    pub publisher_id: String,
    pub external_id: String,
    pub record_key: String,
    #[serde(default)]
    pub source_scope: String,
    pub source_ref: Value,
    pub payload: Value,
    pub observed_at: String,
    pub source_updated_at: String,
    pub freshness: String,
    pub retired_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Item {
    pub id: String,
    pub item_number: i64,
    pub title: String,
    pub summary: String,
    pub fingerprint: String,
    pub source_updated_at: String,
    pub source_priority: Priority,
    pub priority_override: Option<Priority>,
    pub sequence: i64,
    pub due_at: Option<String>,
    pub labels: Vec<String>,
    pub people: Vec<Value>,
    pub attention: Option<String>,
    pub plan: Vec<String>,
    pub next_steps: Vec<Value>,
    pub enrichment: Option<Value>,
    pub enrichment_version: u64,
    pub enrichment_fingerprint: Option<String>,
    pub contributions: Vec<SourceContribution>,
    pub relationships: Vec<Value>,
    pub aliases: Vec<Value>,
    pub linked_tasks: Vec<TaskBinding>,
    pub work_updates: Vec<WorkUpdate>,
    pub annotations: Vec<Annotation>,
    pub archive: Option<Archive>,
    pub completed_at: Option<String>,
    pub outcome: Option<String>,
    pub completion_authority: Option<String>,
    pub manual_stage: Option<String>,
    #[serde(default)]
    pub manual_stage_at: Option<String>,
    pub backlog_until: Option<String>,
    pub follow_up_of_item_id: Option<String>,
    pub follow_up_of_item_number: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
    /// Migration retains nonprojected source/evidence/history fields verbatim.
    #[serde(default)]
    pub legacy: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Event {
    pub id: String,
    pub item_id: String,
    pub kind: String,
    pub occurred_at: String,
    pub actor: Actor,
    pub data: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Publisher {
    pub id: String,
    pub name: String,
    pub revoked: bool,
    pub required_source_slices: Vec<Value>,
    pub last_run_at: Option<String>,
    pub last_run_status: String,
    pub last_source_slices: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleBinding {
    pub schedule_id: String,
    pub publisher_id: String,
    pub title: String,
    pub state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DashboardState {
    pub dashboard: Dashboard,
    pub items: BTreeMap<String, Item>,
    pub publishers: BTreeMap<String, Publisher>,
    pub schedules: Vec<ScheduleBinding>,
    pub events: Vec<Event>,
    #[serde(default)]
    pub work_identities: BTreeMap<String, String>,
    #[serde(default)]
    pub source_separations: Vec<(String, String)>,
}

pub fn format_item_number(number: i64) -> String {
    format!(":{number}:")
}

pub fn canonical_task_title(number: i64, title: &str) -> String {
    let mut suffix = title.split_whitespace().collect::<Vec<_>>().join(" ");
    while let Some(after_colon) = suffix.strip_prefix(':') {
        let Some((digits, rest)) = after_colon.split_once(':') else {
            break;
        };
        if digits.is_empty() || !digits.bytes().all(|c| c.is_ascii_digit()) {
            break;
        }
        suffix = rest.trim_start().to_string();
    }
    if suffix.is_empty() {
        suffix = "Codex task".to_string();
    }
    let prefix = format!(":{number}: ");
    format!(
        "{}{}",
        prefix,
        suffix
            .chars()
            .take(200 - prefix.chars().count())
            .collect::<String>()
    )
}

pub fn envelope(schema: &str, value: Value) -> Value {
    let mut result = value.as_object().cloned().unwrap_or_default();
    result.insert("schema".to_string(), json!(schema));
    Value::Object(result)
}
