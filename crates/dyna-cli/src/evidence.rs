//! Exact, bounded provider identities and collector-supplied relationship proof.
//! No title similarity, publisher URL, or incidental issue mention establishes identity.
use crate::contracts::{Artifact, bounded_text, hash, uuid};
use crate::error::{DynaError, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Relationship {
    pub kind: String,
    pub target: Value,
    pub evidence: RelationshipProof,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelationshipProof {
    pub field: String,
    pub exact_value: String,
}

pub fn validate_ref(value: &Value, allow_manual: bool) -> Result<()> {
    let object = value.as_object().ok_or(DynaError::invalid())?;
    let source = text(value, "source", 32)?;
    let (allowed, required): (&[&str], &[&str]) = match source {
        "slack" => (
            &["source", "workspaceId", "channelId", "messageId"],
            &["workspaceId", "channelId", "messageId"],
        ),
        "outlook" => (
            &["source", "accountId", "messageId", "conversationId"],
            &["accountId", "messageId"],
        ),
        "email" => (
            &[
                "source",
                "provider",
                "accountId",
                "messageId",
                "conversationId",
            ],
            &["provider", "accountId", "messageId"],
        ),
        "messaging" => (
            &[
                "source",
                "provider",
                "workspaceId",
                "channelId",
                "messageId",
            ],
            &["provider", "workspaceId", "channelId", "messageId"],
        ),
        "gitlab" => (
            &["source", "instanceId", "projectPath", "iid", "entityType"],
            &["instanceId", "projectPath", "entityType"],
        ),
        "scm" => (
            &[
                "source",
                "provider",
                "instanceId",
                "repository",
                "entityType",
                "entityId",
            ],
            &[
                "provider",
                "instanceId",
                "repository",
                "entityType",
                "entityId",
            ],
        ),
        "twg" => (
            &["source", "contextId", "resultType", "recordId"],
            &["contextId", "resultType", "recordId"],
        ),
        "skill" => (
            &["source", "contextId", "skillName", "recordType", "recordId"],
            &["contextId", "skillName", "recordType", "recordId"],
        ),
        "codex" => (&["source", "taskId"], &["taskId"]),
        "manual" if allow_manual => (&["source", "todoId"], &["todoId"]),
        _ => return Err(DynaError::invalid()),
    };
    if object.keys().any(|k| !allowed.contains(&k.as_str())) {
        return Err(DynaError::invalid());
    }
    for key in required {
        text(
            value,
            key,
            match *key {
                "projectPath" | "repository" => 512,
                "provider" | "recordType" => 64,
                "skillName" => 128,
                _ => 256,
            },
        )?;
    }
    if value.get("conversationId").is_some() {
        text(value, "conversationId", 256)?;
    }
    match source {
        "gitlab" => {
            if value["iid"]
                .as_u64()
                .is_none_or(|v| v == 0 || v > 9_007_199_254_740_991)
                || !["merge_request", "issue", "pipeline"].contains(&text(value, "entityType", 32)?)
            {
                return Err(DynaError::invalid());
            }
        }
        "scm" => {
            if ![
                "pull_request",
                "merge_request",
                "issue",
                "pipeline",
                "commit",
            ]
            .contains(&text(value, "entityType", 32)?)
            {
                return Err(DynaError::invalid());
            }
        }
        "twg" => {
            if !["jira", "confluence", "bitbucket", "org", "work", "other"].contains(&text(
                value,
                "resultType",
                32,
            )?) {
                return Err(DynaError::invalid());
            }
        }
        "manual" => {
            uuid(text(value, "todoId", 256)?)?;
        }
        _ => {}
    }
    Ok(())
}

pub fn record_key(value: &Value) -> Result<String> {
    validate_ref(value, true)?;
    let get = |key: &str| value[key].as_str().unwrap_or("").trim().to_string();
    let source = get("source");
    let key = match source.as_str() {
        "gitlab" => json!([
            "gitlab",
            instance(&get("instanceId")),
            get("projectPath").to_lowercase(),
            get("entityType"),
            value["iid"].as_u64().unwrap().to_string()
        ]),
        "scm" => {
            let provider = get("provider").to_lowercase();
            let kind = if provider == "gitlab" && get("entityType") == "pull_request" {
                "merge_request".to_string()
            } else {
                get("entityType")
            };
            json!([
                provider,
                instance(&get("instanceId")),
                get("repository").to_lowercase(),
                kind,
                get("entityId")
            ])
        }
        "slack" | "messaging" => json!([
            if source == "slack" {
                source
            } else {
                get("provider").to_lowercase()
            },
            get("workspaceId"),
            get("channelId"),
            get("messageId")
        ]),
        "outlook" | "email" => {
            let provider = if source == "outlook" {
                source
            } else {
                get("provider").to_lowercase()
            };
            json!([
                if provider == "microsoft outlook" {
                    "outlook".to_string()
                } else {
                    provider
                },
                get("accountId"),
                get("messageId")
            ])
        }
        "twg" => json!([
            get("resultType"),
            instance(&get("contextId")),
            if get("resultType") == "jira" {
                get("recordId").to_uppercase()
            } else {
                get("recordId")
            }
        ]),
        "codex" => json!([source, get("taskId")]),
        "skill" => json!([
            source,
            get("contextId"),
            get("skillName"),
            get("recordType"),
            get("recordId")
        ]),
        "manual" => json!([source, get("todoId")]),
        _ => return Err(DynaError::invalid()),
    };
    Ok(key.to_string())
}

pub fn jira_key(value: &Value) -> Option<String> {
    (value["source"] == "twg" && value["resultType"] == "jira")
        .then(|| record_key(value).ok())
        .flatten()
}

pub fn valid_relationship(source: &Value, relationship: &Relationship) -> Result<bool> {
    validate_ref(&relationship.target, false)?;
    bounded_text(&relationship.evidence.exact_value, 512)?;
    if record_key(source)? == record_key(&relationship.target)? {
        return Ok(false);
    }
    let proof = &relationship.evidence;
    let target = &relationship.target;
    let same_url = source_url(target).is_some_and(|url| url == proof.exact_value);
    Ok(match relationship.kind.as_str() {
        "references_jira_issue" => {
            let mr = (source["source"] == "gitlab" && source["entityType"] == "merge_request")
                || (source["source"] == "scm"
                    && ["pull_request", "merge_request"]
                        .iter()
                        .any(|s| source["entityType"] == *s));
            mr && jira_key(target).is_some()
                && ((proof.field == "mr_reference"
                    && proof.exact_value.to_uppercase()
                        == target["recordId"].as_str().unwrap_or("").to_uppercase())
                    || (proof.field == "mr_description_link" && same_url))
        }
        "links_to_record" => {
            let message = ["email", "outlook", "slack", "messaging"]
                .iter()
                .any(|s| source["source"] == *s);
            let document = source["source"] == "twg" && source["resultType"] == "confluence";
            ((message && proof.field == "message_link")
                || (document && proof.field == "document_link"))
                && same_url
        }
        "same_thread" => {
            let slack = |v: &Value| {
                v["source"] == "slack"
                    || (v["source"] == "messaging"
                        && v["provider"]
                            .as_str()
                            .unwrap_or("")
                            .eq_ignore_ascii_case("slack"))
            };
            proof.field == "thread_root"
                && slack(source)
                && slack(target)
                && source["workspaceId"] == target["workspaceId"]
                && source["channelId"] == target["channelId"]
                && target["messageId"] == proof.exact_value
        }
        _ => false,
    })
}

pub fn source_url(value: &Value) -> Option<String> {
    validate_ref(value, true).ok()?;
    let get = |key: &str| value[key].as_str().unwrap_or("");
    match get("source") {
        "slack" => slack_url(get("workspaceId"), get("channelId"), get("messageId")),
        "outlook" => Some(format!(
            "https://outlook.office.com/mail/deeplink/read/{}",
            encode(get("messageId"))
        )),
        "email" => {
            let provider = get("provider").to_lowercase();
            if provider.contains("outlook") || provider.contains("microsoft") {
                Some(format!(
                    "https://outlook.office.com/mail/deeplink/read/{}",
                    encode(get("messageId"))
                ))
            } else if provider.contains("gmail") || provider.contains("google") {
                Some(format!(
                    "https://mail.google.com/mail/u/{}/#all/{}",
                    encode(get("accountId")),
                    encode(get("messageId"))
                ))
            } else {
                None
            }
        }
        "messaging" => {
            let provider = get("provider").to_lowercase();
            if provider.contains("slack") {
                slack_url(get("workspaceId"), get("channelId"), get("messageId"))
            } else if provider.contains("discord") {
                Some(format!(
                    "https://discord.com/channels/{}/{}/{}",
                    encode(get("workspaceId")),
                    encode(get("channelId")),
                    encode(get("messageId"))
                ))
            } else {
                None
            }
        }
        "gitlab" => Some(format!(
            "{}/{}/-/{}/{}",
            origin(get("instanceId"))?,
            encoded_path(get("projectPath")),
            gitlab_path(get("entityType"))?,
            value["iid"].as_u64()?
        )),
        "scm" => {
            let provider = get("provider").to_lowercase();
            let kind = get("entityType");
            let path = if provider.contains("gitlab") {
                match kind {
                    "pull_request" | "merge_request" => "-/merge_requests",
                    "issue" => "-/issues",
                    "pipeline" => "-/pipelines",
                    "commit" => "-/commit",
                    _ => return None,
                }
            } else if provider.contains("github") {
                match kind {
                    "pull_request" | "merge_request" => "pull",
                    "issue" => "issues",
                    "pipeline" => "actions/runs",
                    "commit" => "commit",
                    _ => return None,
                }
            } else if provider.contains("bitbucket") {
                match kind {
                    "pull_request" | "merge_request" => "pull-requests",
                    "issue" => "issues",
                    "pipeline" => "pipelines/results",
                    "commit" => "commits",
                    _ => return None,
                }
            } else {
                return None;
            };
            Some(format!(
                "{}/{}/{}/{}",
                origin(get("instanceId"))?,
                encoded_path(get("repository")),
                path,
                encode(get("entityId"))
            ))
        }
        "twg" => match get("resultType") {
            "jira" => Some(format!(
                "{}/browse/{}",
                origin(get("contextId"))?,
                encode(get("recordId"))
            )),
            "confluence" => Some(format!(
                "{}/wiki/pages/viewpage.action?pageId={}",
                origin(get("contextId"))?,
                encode(get("recordId"))
            )),
            _ => None,
        },
        _ => None,
    }
}

pub fn source_label(value: &Value) -> String {
    let get = |key: &str| value[key].as_str().unwrap_or("");
    match get("source") {
        "gitlab" => format!("GitLab {}!{}", get("projectPath"), value["iid"]),
        "scm" => format!(
            "{} {}#{}",
            get("provider"),
            get("repository"),
            get("entityId")
        ),
        "twg" => format!(
            "{} {}",
            match get("resultType") {
                "jira" => "Jira",
                "confluence" => "Confluence",
                _ => "TWG",
            },
            get("recordId")
        ),
        "slack" => format!("Slack {} · {}", get("channelId"), get("messageId")),
        "codex" => format!("Codex {}", get("taskId")),
        "outlook" => format!("Outlook {}", get("messageId")),
        "manual" => "Dyna to-do".into(),
        _ => format!("{} {}", get("provider"), get("messageId")),
    }
    .chars()
    .take(128)
    .collect()
}

pub fn validate_slices(value: &Value, statuses: bool) -> Result<Vec<Value>> {
    let array = value
        .as_array()
        .filter(|a| !a.is_empty() && a.len() <= 50)
        .ok_or(DynaError::invalid())?;
    let mut seen = std::collections::BTreeSet::new();
    for slice in array {
        let keys = if statuses {
            &["source", "sourceScope", "status"][..]
        } else {
            &["source", "sourceScope"][..]
        };
        if slice
            .as_object()
            .is_none_or(|o| o.keys().any(|k| !keys.contains(&k.as_str())))
        {
            return Err(DynaError::invalid());
        }
        if ![
            "slack",
            "outlook",
            "gitlab",
            "codex",
            "email",
            "messaging",
            "scm",
            "twg",
            "skill",
        ]
        .contains(&text(slice, "source", 32)?)
        {
            return Err(DynaError::invalid());
        }
        text(slice, "sourceScope", 128)?;
        if statuses && !["succeeded", "failed"].contains(&text(slice, "status", 32)?) {
            return Err(DynaError::invalid());
        }
        if !seen.insert(slice_key(slice)) {
            return Err(DynaError::invalid());
        }
    }
    Ok(array.clone())
}

pub fn slice_key(slice: &Value) -> String {
    json!([slice["source"], slice["sourceScope"]]).to_string()
}

fn text<'a>(value: &'a Value, key: &str, limit: usize) -> Result<&'a str> {
    let text = value[key].as_str().ok_or(DynaError::invalid())?;
    bounded_text(text, limit)?;
    if text != text.trim() {
        return Err(DynaError::invalid());
    }
    Ok(text)
}

fn origin(input: &str) -> Option<String> {
    let url = if input.contains("://") {
        input.to_string()
    } else {
        format!("https://{input}")
    };
    Artifact {
        kind: "other".into(),
        label: "Origin".into(),
        url: url.clone(),
    }
    .validate()
    .ok()?;
    let (scheme, rest) = url.split_once("://")?;
    Some(format!(
        "{}://{}",
        scheme.to_lowercase(),
        rest.split(['/', '?', '#']).next()?.to_lowercase()
    ))
}
fn instance(input: &str) -> String {
    origin(input).unwrap_or_else(|| input.trim().to_lowercase())
}
fn encode(input: &str) -> String {
    input
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || b"-_.~".contains(&byte) {
                (byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}
fn encoded_path(input: &str) -> String {
    input
        .split('/')
        .filter(|p| !p.is_empty())
        .map(encode)
        .collect::<Vec<_>>()
        .join("/")
}
fn gitlab_path(kind: &str) -> Option<&'static str> {
    match kind {
        "merge_request" => Some("merge_requests"),
        "issue" => Some("issues"),
        "pipeline" => Some("pipelines"),
        _ => None,
    }
}
fn slack_url(workspace: &str, channel: &str, message: &str) -> Option<String> {
    let valid_id = |s: &str, initials: &str| {
        (9..=32).contains(&s.len())
            && s.bytes()
                .next()
                .is_some_and(|b| initials.as_bytes().contains(&b))
            && s.bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
    };
    let (seconds, micros) = message.split_once('.')?;
    if !valid_id(channel, "CDG")
        || !(9..=12).contains(&seconds.len())
        || micros.len() != 6
        || !seconds
            .bytes()
            .chain(micros.bytes())
            .all(|b| b.is_ascii_digit())
    {
        return None;
    }
    if valid_id(workspace, "T") {
        Some(format!(
            "https://app.slack.com/client/{workspace}/{channel}/thread/{channel}-{message}"
        ))
    } else {
        let slug = workspace.to_lowercase();
        if slug.is_empty()
            || slug.len() > 63
            || slug.starts_with('-')
            || slug.ends_with('-')
            || !slug
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        {
            return None;
        }
        Some(format!(
            "https://{slug}.slack.com/archives/{channel}/p{seconds}{micros}"
        ))
    }
}

pub fn summary_evidence_fingerprint(records: &[(String, Value)]) -> String {
    hash(&json!(records))
}
