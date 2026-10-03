use serde::Serialize;

pub type Result<T> = std::result::Result<T, DynaError>;

/// Only static, public messages reach the protocol boundary. Underlying IO and SQL
/// errors deliberately do not become Display output, logs, or serialized causes.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DynaError {
    pub code: &'static str,
    pub message: &'static str,
}

impl DynaError {
    pub const fn new(code: &'static str, message: &'static str) -> Self {
        Self { code, message }
    }

    pub const fn invalid() -> Self {
        Self::new("invalid_input", "Invalid or unsupported Dyna input.")
    }

    pub const fn storage() -> Self {
        Self::new(
            "storage_unavailable",
            "Dyna storage is unavailable; no success was recorded.",
        )
    }

    pub fn exit_code(&self) -> i32 {
        match self.code {
            "invalid_input"
            | "invalid_lifecycle"
            | "invalid_priority"
            | "confirmation_required"
            | "output_limit" => 2,
            "not_found" | "unknown_dashboard" => 3,
            "stale_item"
            | "stale_dashboard"
            | "stale_enrichment"
            | "stale_annotation"
            | "request_conflict"
            | "task_owned"
            | "reserved_key"
            | "stale_cursor"
            | "item_archived"
            | "dashboard_archived"
            | "record_identity_conflict"
            | "title_sync_needed" => 4,
            "forbidden" => 5,
            "busy" => 6,
            "integration_unavailable" => 7,
            _ => 1,
        }
    }
}

impl std::fmt::Display for DynaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for DynaError {}

impl From<std::io::Error> for DynaError {
    fn from(_: std::io::Error) -> Self {
        Self::storage()
    }
}

impl From<serde_json::Error> for DynaError {
    fn from(_: serde_json::Error) -> Self {
        Self::invalid()
    }
}
