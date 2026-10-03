use crate::application::Request;
use crate::contracts::{ActorKind, MAX_STDIN, MAX_STDOUT, uuid};
use crate::error::{DynaError, Result};
use serde::Deserialize;
use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Write};

pub const HELP: &str = r#"Dyna — standalone local work management

Usage: dyna <area> <operation> [flags]
       dyna setup | --help | --version

Dashboards: dashboard create|list|pick|show|snapshot|rename|update|archive|restore
Read work:  item search|show|history|activity|sources
Work:       work update|enrich|complete
Notes:      annotation add|edit|delete
Organize:   organize place|place-many
Lifecycle:  lifecycle stage|backlog|resume|archive|restore
Create:     todo create; follow-up create
Sources:    publisher setup|list|revoke; publication publish
Schedules:  schedule list|bind|unbind|reconcile (metadata, not a scheduler)
Maintain:   maintenance integrity|backup|recover|migration-plan
Native:     codex status (other native operations require verified integration)

Flags:
  --dashboard KEY-OR-UUID       Explicit dashboard; old keys remain aliases
  --dashboard-id UUID          Compatibility selector (not with --dashboard)
  --item-id UUID               Exact item UUID, never :number:
  --expected-fingerprint HEX   Current source fingerprint
  --expected-revision N        Current dashboard revision
  --expected-enrichment-version N
  --annotation-id UUID --expected-annotation-version N
  --query TEXT --scope active|archive
  --limit N --cursor CURSOR    Bounded pages: snapshot 200, search 20, history 50, activity 25
  --actor local-operator|linked-worker
  --json                      Bounded, versioned machine result

Mutations read exactly one strict JSON object (maximum 32 KiB) from stdin.
Each mutation includes a UUID requestId. Linked-worker mutations also include
task:{taskId,hostId} and a stable workAttemptId, and affect only a verified linked
item. Human operator writes do not require or invent Codex attribution.

Use dashboard list before selecting. Scripted commands never change a global
default. Legacy item update/enrich/place/archive/restore commands are rejected.
No SQL, database-path, shell, deletion or credential command is exposed.
Search requires each whitespace-separated term; quotes/backslashes are literal.

Exit codes: 0 success, 1 storage/internal failure, 2 invalid input, 3 not found,
4 stale/conflict, 5 forbidden, 6 busy (retry same request), 7 integration unavailable.
"#;

pub struct Parsed {
    pub request: Request,
    pub json: bool,
    pub mutation: bool,
}

pub enum Invocation {
    Help,
    Version,
    Command(Box<Parsed>),
}

pub fn parse(args: &[String]) -> Result<Invocation> {
    if args == ["--help"] || args == ["help"] || args.is_empty() {
        return Ok(Invocation::Help);
    }
    if args == ["--version"] {
        return Ok(Invocation::Version);
    }
    if args.len() > 40 || args.iter().any(|a| a.len() > 4096 || a.contains('\0')) {
        return Err(DynaError::invalid());
    }
    let mut words = vec![];
    let mut flags = BTreeMap::new();
    let mut json_output = false;
    let mut index = 0;
    while index < args.len() {
        let token = &args[index];
        if token == "--json" {
            if json_output {
                return Err(DynaError::invalid());
            }
            json_output = true;
            index += 1;
            continue;
        }
        if token.starts_with("--") {
            if flags.contains_key(token) {
                return Err(DynaError::invalid());
            }
            let value = args
                .get(index + 1)
                .filter(|v| !v.starts_with("--"))
                .ok_or(DynaError::invalid())?;
            flags.insert(token.clone(), value.clone());
            index += 2;
        } else {
            words.push(token.as_str());
            index += 1;
        }
    }
    let operation = words.join(" ");
    let (mutation, required, optional) = command_flags(&operation)?;
    let allowed = required
        .iter()
        .chain(optional)
        .copied()
        .chain(["--actor", "--dashboard-id"])
        .collect::<BTreeSet<_>>();
    if flags.keys().any(|flag| !allowed.contains(flag.as_str())) {
        return Err(DynaError::invalid());
    }
    if flags.contains_key("--dashboard") && flags.contains_key("--dashboard-id") {
        return Err(DynaError::invalid());
    }
    if let Some(id) = flags.remove("--dashboard-id") {
        flags.insert("--dashboard".into(), uuid(&id)?);
    }
    if required.iter().any(|flag| !flags.contains_key(*flag)) {
        return Err(DynaError::invalid());
    }
    let actor = match flags.get("--actor").map(String::as_str) {
        None | Some("local-operator") => None,
        Some("linked-worker") => Some(ActorKind::LinkedWorker),
        _ => return Err(DynaError::invalid()),
    };
    let request = Request {
        operation,
        dashboard: flags.get("--dashboard").cloned(),
        item_id: flags.get("--item-id").map(|id| uuid(id)).transpose()?,
        expected_fingerprint: flags
            .get("--expected-fingerprint")
            .map(|v| {
                if v.len() != 64
                    || !v
                        .bytes()
                        .all(|c| c.is_ascii_digit() || matches!(c, b'a'..=b'f'))
                {
                    Err(DynaError::invalid())
                } else {
                    Ok(v.clone())
                }
            })
            .transpose()?,
        expected_revision: number(&flags, "--expected-revision")?,
        expected_enrichment_version: number(&flags, "--expected-enrichment-version")?,
        expected_annotation_version: number(&flags, "--expected-annotation-version")?,
        annotation_id: flags
            .get("--annotation-id")
            .map(|id| uuid(id))
            .transpose()?,
        query: flags.get("--query").cloned(),
        scope: flags.get("--scope").cloned(),
        limit: number(&flags, "--limit")?.map(|n| n as usize),
        cursor: flags.get("--cursor").cloned(),
        actor,
    };
    if request
        .query
        .as_ref()
        .is_some_and(|q| q.chars().count() > 500)
        || request.cursor.as_ref().is_some_and(|c| c.len() > 256)
        || request
            .scope
            .as_ref()
            .is_some_and(|s| !["active", "archive"].contains(&s.as_str()))
    {
        return Err(DynaError::invalid());
    }
    Ok(Invocation::Command(Box::new(Parsed {
        request,
        json: json_output,
        mutation,
    })))
}

fn number(flags: &BTreeMap<String, String>, key: &str) -> Result<Option<u64>> {
    flags
        .get(key)
        .map(|v| {
            if v.is_empty() || !v.bytes().all(|c| c.is_ascii_digit()) {
                Err(DynaError::invalid())
            } else {
                v.parse::<u64>()
                    .ok()
                    .filter(|n| *n <= 9_007_199_254_740_991)
                    .ok_or(DynaError::invalid())
            }
        })
        .transpose()
}

type FlagSet = (bool, &'static [&'static str], &'static [&'static str]);
fn command_flags(operation: &str) -> Result<FlagSet> {
    const D: &[&str] = &["--dashboard"];
    const I: &[&str] = &["--dashboard", "--item-id"];
    const F: &[&str] = &["--dashboard", "--item-id", "--expected-fingerprint"];
    const V: &[&str] = &[
        "--dashboard",
        "--item-id",
        "--expected-fingerprint",
        "--expected-revision",
    ];
    const E: &[&str] = &[
        "--dashboard",
        "--item-id",
        "--expected-fingerprint",
        "--expected-enrichment-version",
    ];
    const A: &[&str] = &[
        "--dashboard",
        "--item-id",
        "--expected-fingerprint",
        "--annotation-id",
        "--expected-annotation-version",
    ];
    match operation {
        "dashboard list" | "dashboard pick" | "codex status" => Ok((false, &[], &[])),
        "dashboard create"
        | "setup"
        | "maintenance integrity"
        | "maintenance recover"
        | "maintenance migration-plan" => Ok((operation == "dashboard create", &[], &[])),
        "maintenance backup" => Ok((true, &[], &[])),
        "dashboard show" => Ok((false, D, &[])),
        "dashboard snapshot" => Ok((false, D, &["--query", "--scope", "--limit", "--cursor"])),
        "item search" => Ok((false, D, &["--query", "--scope", "--limit", "--cursor"])),
        "dashboard rename" => Ok((true, D, &[])),
        "dashboard update" | "dashboard archive" | "dashboard restore" | "organize place-many" => {
            Ok((true, &["--dashboard", "--expected-revision"], &[]))
        }
        "item show" => Ok((false, I, &[])),
        "item history" | "item activity" | "item sources" => {
            Ok((false, I, &["--limit", "--cursor"]))
        }
        "work update" | "work complete" | "annotation add" => Ok((true, F, &[])),
        "work enrich" => Ok((true, E, &[])),
        "annotation edit" | "annotation delete" => Ok((true, A, &[])),
        "organize place" | "lifecycle archive" | "lifecycle restore" | "lifecycle stage"
        | "lifecycle backlog" | "lifecycle resume" | "follow-up create" => Ok((true, V, &[])),
        "todo create"
        | "publisher setup"
        | "publisher revoke"
        | "publication publish"
        | "schedule bind"
        | "schedule unbind"
        | "schedule reconcile" => Ok((true, D, &[])),
        "publisher list" | "schedule list" => Ok((false, D, &[])),
        _ => Err(DynaError::invalid()),
    }
}

/// JSON's usual last-key-wins parsing is unsuitable for mutation protocols.
/// Reject duplicates recursively, not just at the root.
struct StrictValue(Value);
impl<'de> Deserialize<'de> for StrictValue {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        struct StrictVisitor;
        impl<'de> Visitor<'de> for StrictVisitor {
            type Value = StrictValue;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("one strict JSON value")
            }
            fn visit_bool<E: de::Error>(self, v: bool) -> std::result::Result<StrictValue, E> {
                Ok(StrictValue(json!(v)))
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> std::result::Result<StrictValue, E> {
                Ok(StrictValue(json!(v)))
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> std::result::Result<StrictValue, E> {
                Ok(StrictValue(json!(v)))
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> std::result::Result<StrictValue, E> {
                serde_json::Number::from_f64(v)
                    .map(|n| StrictValue(Value::Number(n)))
                    .ok_or_else(|| E::custom("invalid number"))
            }
            fn visit_str<E: de::Error>(self, v: &str) -> std::result::Result<StrictValue, E> {
                Ok(StrictValue(json!(v)))
            }
            fn visit_string<E: de::Error>(self, v: String) -> std::result::Result<StrictValue, E> {
                Ok(StrictValue(Value::String(v)))
            }
            fn visit_unit<E: de::Error>(self) -> std::result::Result<StrictValue, E> {
                Ok(StrictValue(Value::Null))
            }
            fn visit_seq<A: SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> std::result::Result<StrictValue, A::Error> {
                let mut values = vec![];
                while let Some(value) = seq.next_element::<StrictValue>()? {
                    values.push(value.0);
                }
                Ok(StrictValue(Value::Array(values)))
            }
            fn visit_map<A: MapAccess<'de>>(
                self,
                mut map: A,
            ) -> std::result::Result<StrictValue, A::Error> {
                let mut values = Map::new();
                while let Some(key) = map.next_key::<String>()? {
                    if values.contains_key(&key) {
                        return Err(de::Error::custom("duplicate field"));
                    }
                    let value = map.next_value::<StrictValue>()?;
                    values.insert(key, value.0);
                }
                Ok(StrictValue(Value::Object(values)))
            }
        }
        d.deserialize_any(StrictVisitor)
    }
}

pub fn read_input(mut input: impl Read) -> Result<Value> {
    read_input_mode(&mut input, false)
}

pub fn read_input_mode(mut input: impl Read, terminal: bool) -> Result<Value> {
    let mut bytes = vec![];
    if terminal {
        // Noncanonical PTYs deliver pasted JSON without the canonical line limit.
        // EOT terminates a terminal submission only; it remains invalid in pipe JSON.
        let mut chunk = [0_u8; 1024];
        loop {
            let count = input.read(&mut chunk).map_err(|_| DynaError::invalid())?;
            if count == 0 {
                break;
            }
            let end = chunk[..count].iter().position(|b| *b == 4);
            bytes.extend_from_slice(&chunk[..end.unwrap_or(count)]);
            if bytes.len() > MAX_STDIN {
                return Err(DynaError::invalid());
            }
            if end.is_some() {
                break;
            }
        }
    } else {
        input
            .by_ref()
            .take((MAX_STDIN + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| DynaError::invalid())?;
    }
    if bytes.is_empty() || bytes.len() > MAX_STDIN {
        return Err(DynaError::invalid());
    }
    let mut deserializer = serde_json::Deserializer::from_slice(&bytes);
    let value = StrictValue::deserialize(&mut deserializer)
        .map_err(|_| DynaError::invalid())?
        .0;
    deserializer.end().map_err(|_| DynaError::invalid())?;
    if !value.is_object() {
        return Err(DynaError::invalid());
    }
    Ok(value)
}

pub fn print_result(value: &Value, json_output: bool, mut output: impl Write) -> Result<()> {
    let text = if json_output {
        serde_json::to_string(value)?
    } else {
        human_output(value)?
    };
    if text.len() >= MAX_STDOUT {
        return Err(DynaError::new(
            "output_limit",
            "Dyna result is too large; use pagination or a narrower query.",
        ));
    }
    writeln!(output, "{text}")
        .map_err(|_| DynaError::new("output_unavailable", "Dyna output is unavailable."))
}

/// Display stored text without allowing it to issue terminal commands or hide
/// surrounding labels. JSON retains the original data with JSON escaping.
pub fn terminal_label(value: &str) -> String {
    value
        .chars()
        .flat_map(|ch| {
            if crate::contracts::unsafe_display_character(ch) {
                ch.escape_unicode().collect::<Vec<_>>()
            } else {
                vec![ch]
            }
        })
        .collect()
}

fn human_output(value: &Value) -> Result<String> {
    if let Some(dashboards) = value.get("dashboards").and_then(Value::as_array) {
        return Ok(dashboards
            .iter()
            .map(|d| {
                format!(
                    "{}  {}  {}{}",
                    terminal_label(d["key"].as_str().unwrap_or("")),
                    terminal_label(d["name"].as_str().unwrap_or("")),
                    terminal_label(d["database"].as_str().unwrap_or("")),
                    if d["available"] == false {
                        " (unavailable)"
                    } else if d["archived"] == true {
                        " (archived)"
                    } else {
                        ""
                    }
                )
            })
            .collect::<Vec<_>>()
            .join("\n"));
    }
    if let Some(control) = value.get("control") {
        return Ok(format!(
            ":{}: {} · {} · revision {}{}",
            control["itemNumber"],
            terminal_label(control["dashboardKey"].as_str().unwrap_or("")),
            terminal_label(control["lifecycle"].as_str().unwrap_or("")),
            control["dashboardRevision"],
            if value["deduplicated"] == true {
                " (replayed)"
            } else {
                ""
            }
        ));
    }
    crate::contracts::safe_pretty_json(value)
}

#[cfg(unix)]
pub struct NonEchoInput {
    saved: Option<libc::termios>,
    handlers: Vec<(i32, libc::sigaction)>,
}

#[cfg(unix)]
struct SignalTerminal(std::cell::UnsafeCell<std::mem::MaybeUninit<libc::termios>>);
// Written once while the handled signals are blocked, then read-only until all
// handlers are removed. The guard is process-adapter-only, never an app thread.
#[cfg(unix)]
unsafe impl Sync for SignalTerminal {}
#[cfg(unix)]
static SIGNAL_TERMINAL: SignalTerminal =
    SignalTerminal(std::cell::UnsafeCell::new(std::mem::MaybeUninit::uninit()));
#[cfg(unix)]
static TERMINAL_ACTIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg(unix)]
extern "C" fn restore_terminal_signal(signal: i32) {
    if TERMINAL_ACTIVE.load(std::sync::atomic::Ordering::Acquire) {
        let saved = unsafe { (*SIGNAL_TERMINAL.0.get()).assume_init() };
        let mut target = saved;
        if signal == libc::SIGCONT {
            target.c_lflag &= !(libc::ECHO | libc::ECHONL | libc::ICANON);
            target.c_cc[libc::VMIN] = 1;
            target.c_cc[libc::VTIME] = 0;
        }
        unsafe { libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &target) };
    }
    if signal == libc::SIGTSTP {
        unsafe { libc::kill(libc::getpid(), libc::SIGSTOP) };
    } else if signal != libc::SIGCONT {
        unsafe { libc::_exit(128 + signal) };
    }
}

#[cfg(unix)]
impl NonEchoInput {
    pub fn is_terminal(&self) -> bool {
        self.saved.is_some()
    }

    pub fn begin() -> Result<Self> {
        // Called before input parsing. Never print or echo submitted work text.
        if unsafe { libc::isatty(libc::STDIN_FILENO) } == 0 {
            return Ok(Self {
                saved: None,
                handlers: vec![],
            });
        }
        let mut saved = std::mem::MaybeUninit::<libc::termios>::uninit();
        if unsafe { libc::tcgetattr(libc::STDIN_FILENO, saved.as_mut_ptr()) } != 0 {
            return Err(DynaError::new(
                "tty_unavailable",
                "Cannot safely disable terminal input echo.",
            ));
        }
        let saved = unsafe { saved.assume_init() };
        let mut quiet = saved;
        quiet.c_lflag &= !(libc::ECHO | libc::ECHONL | libc::ICANON);
        quiet.c_cc[libc::VMIN] = 1;
        quiet.c_cc[libc::VTIME] = 0;
        let signals = [
            libc::SIGHUP,
            libc::SIGINT,
            libc::SIGQUIT,
            libc::SIGTERM,
            libc::SIGTSTP,
            libc::SIGCONT,
        ];
        let mut blocked = unsafe { std::mem::zeroed::<libc::sigset_t>() };
        let mut original_mask = unsafe { std::mem::zeroed::<libc::sigset_t>() };
        unsafe { libc::sigemptyset(&mut blocked) };
        for signal in signals {
            unsafe { libc::sigaddset(&mut blocked, signal) };
        }
        if unsafe { libc::sigprocmask(libc::SIG_BLOCK, &blocked, &mut original_mask) } != 0 {
            return Err(DynaError::new(
                "tty_unavailable",
                "Cannot safely protect terminal input.",
            ));
        }
        let mut guard = Self {
            saved: Some(saved),
            handlers: vec![],
        };
        unsafe { (*SIGNAL_TERMINAL.0.get()).write(saved) };
        for signal in signals {
            let mut action = unsafe { std::mem::zeroed::<libc::sigaction>() };
            action.sa_sigaction = restore_terminal_signal as *const () as usize;
            action.sa_flags = libc::SA_RESTART;
            action.sa_mask = blocked;
            let mut original = unsafe { std::mem::zeroed::<libc::sigaction>() };
            if unsafe { libc::sigaction(signal, &action, &mut original) } != 0 {
                drop(guard);
                unsafe {
                    libc::sigprocmask(libc::SIG_SETMASK, &original_mask, std::ptr::null_mut())
                };
                return Err(DynaError::new(
                    "tty_unavailable",
                    "Cannot safely protect terminal input.",
                ));
            }
            guard.handlers.push((signal, original));
        }
        TERMINAL_ACTIVE.store(true, std::sync::atomic::Ordering::Release);
        let quiet_result = unsafe { libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &quiet) };
        unsafe { libc::sigprocmask(libc::SIG_SETMASK, &original_mask, std::ptr::null_mut()) };
        if quiet_result != 0 {
            return Err(DynaError::new(
                "tty_unavailable",
                "Cannot safely disable terminal input echo.",
            ));
        }
        Ok(guard)
    }
}

#[cfg(unix)]
impl Drop for NonEchoInput {
    fn drop(&mut self) {
        TERMINAL_ACTIVE.store(false, std::sync::atomic::Ordering::Release);
        if let Some(saved) = self.saved {
            unsafe { libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &saved) };
        }
        for (signal, handler) in &self.handlers {
            unsafe { libc::sigaction(*signal, handler, std::ptr::null_mut()) };
        }
    }
}
