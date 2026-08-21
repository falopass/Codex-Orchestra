#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager,
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const ROUTER_VERSION: &str = "0.4.0-beta.3";
const ROUTER_REPOSITORY: &str = "https://github.com/duolahypercho/codex-router";
// Deliberately explicit: an update must move this pin in a reviewed change.
const ROUTER_PINNED_COMMIT: &str = "a1be46aa02426d87a9e24e114ce8c22619c63c7a";
const ROUTER_PINNED_TAG: &str = "v0.4.0-beta.3";
const CREATE_NEW_CONSOLE: u32 = 0x00000010;
const CREATE_NO_WINDOW: u32 = 0x08000000;
const APP_SERVER_EVENT: &str = "app-server-event";
const STATE_SCHEMA_VERSION: i64 = 3;
static APP_SERVER_REQUEST_ID: AtomicU64 = AtomicU64::new(100);
static DELEGATION_EVIDENCE_ID: AtomicU64 = AtomicU64::new(1);
static USAGE_EVENT_ID: AtomicU64 = AtomicU64::new(1);

/// One in-memory App Server transport. Deliberately not persisted: Codex owns
/// its own thread history and Orchestra must not retain prompts or responses.
#[derive(Clone, Default)]
struct AppServerState {
    session: Arc<Mutex<Option<AppServerSession>>>,
}

struct AppServerSession {
    child: Child,
    stdin: std::process::ChildStdin,
    thread_id: String,
    turn_id: Option<String>,
}

#[derive(Clone)]
struct DelegationEvidenceContext {
    run_id: String,
    root_model: String,
    requested_role: String,
    requested_worker_model: Option<String>,
    root_thread_id: String,
}

impl Drop for AppServerSession {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn now() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("unix:{seconds}")
}

fn current_user_home() -> PathBuf {
    env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn data_root() -> PathBuf {
    env::var_os("CODEX_ORCHESTRA_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .unwrap_or_else(|| current_user_home().join("AppData").join("Local"))
                .join("CodexOrchestra")
        })
}

fn codex_home() -> PathBuf {
    env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| current_user_home().join(".codex"))
}

fn router_root() -> PathBuf {
    env::var_os("CODEX_ORCHESTRA_ROUTER_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| data_root().join("engine").join("codex-router"))
}

fn router_launcher() -> Option<(PathBuf, bool)> {
    let root = router_root();
    let target_wrapper = root.join("model-router.ps1");
    if target_wrapper.is_file() {
        return Some((target_wrapper, true));
    }
    let direct_wrapper = root.join("codex-router.ps1");
    direct_wrapper.is_file().then_some((direct_wrapper, false))
}

fn git_revision(root: &Path) -> Option<String> {
    git_ref(root, "HEAD")
}

fn git_ref(root: &Path, reference: &str) -> Option<String> {
    let mut command = Command::new("git");
    command
        .args(["-C"])
        .arg(root)
        .args(["rev-parse", reference]);
    command_output_with_timeout(command, Duration::from_secs(2))
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|value| !value.is_empty() && value.len() <= 80)
}

fn router_state_root() -> PathBuf {
    [
        "MODEL_ROUTER_STATE_DIR",
        "CODEX_ROUTER_STATE_DIR",
        "KIMI_CODEX_STATE_DIR",
    ]
    .into_iter()
    .find_map(env::var_os)
    .map(PathBuf::from)
    .unwrap_or_else(|| codex_home().join("codex-router"))
}

fn state_db_path() -> PathBuf {
    data_root().join("orchestra.db")
}

fn table_has_column(connection: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| format!("State schema inspection failed: {error}"))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| format!("State schema columns failed: {error}"))?;
    let found = columns.filter_map(Result::ok).any(|name| name == column);
    Ok(found)
}

fn migrate_state_db(connection: &mut Connection) -> Result<(), String> {
    connection
        .execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")
        .map_err(|error| format!("State database pragmas failed: {error}"))?;
    let current_version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| format!("State schema version failed: {error}"))?;
    if current_version > STATE_SCHEMA_VERSION {
        return Err(format!(
            "State database schema {current_version} is newer than supported schema {STATE_SCHEMA_VERSION}"
        ));
    }

    let transaction = connection
        .transaction()
        .map_err(|error| format!("State migration could not start: {error}"))?;
    transaction
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                path TEXT NOT NULL UNIQUE,
                payload TEXT NOT NULL,
                updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS health_runs (
                id TEXT PRIMARY KEY,
                completed_at TEXT NOT NULL,
                payload TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS usage_events (
                id TEXT PRIMARY KEY,
                timestamp TEXT NOT NULL,
                payload TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS backups (
                id TEXT PRIMARY KEY,
                target TEXT NOT NULL,
                backup_path TEXT,
                created_at TEXT NOT NULL,
                reason TEXT NOT NULL,
                restorable INTEGER NOT NULL,
                redacted INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS pricing_rules (
                model TEXT NOT NULL,
                version TEXT NOT NULL,
                effective_from TEXT NOT NULL,
                payload TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (model, version)
             );
             CREATE TABLE IF NOT EXISTS logs (
                id TEXT PRIMARY KEY,
                timestamp TEXT NOT NULL,
                level TEXT NOT NULL,
                operation TEXT NOT NULL,
                payload TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS worktrees (
                id TEXT PRIMARY KEY,
                project_path TEXT NOT NULL,
                role TEXT NOT NULL,
                slug TEXT NOT NULL,
                target TEXT NOT NULL UNIQUE,
                base_ref TEXT NOT NULL,
                created_at TEXT NOT NULL,
                state TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS delegation_evidence (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                occurred_at TEXT NOT NULL,
                payload TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS worktrees_project_idx ON worktrees(project_path);
             CREATE INDEX IF NOT EXISTS delegation_evidence_run_idx ON delegation_evidence(run_id);
             CREATE INDEX IF NOT EXISTS delegation_evidence_time_idx ON delegation_evidence(occurred_at);",
        )
        .map_err(|error| format!("State schema failed: {error}"))?;
    if !table_has_column(&transaction, "backups", "backup_path")? {
        transaction
            .execute("ALTER TABLE backups ADD COLUMN backup_path TEXT", [])
            .map_err(|error| format!("State backup migration failed: {error}"))?;
    }
    transaction
        .pragma_update(None, "user_version", STATE_SCHEMA_VERSION)
        .map_err(|error| format!("State schema version update failed: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("State migration commit failed: {error}"))
}

fn open_state_db() -> Result<Connection, String> {
    let root = data_root();
    fs::create_dir_all(&root).map_err(|error| format!("State directory failed: {error}"))?;
    let mut connection = Connection::open(state_db_path())
        .map_err(|error| format!("State database failed: {error}"))?;
    migrate_state_db(&mut connection)?;
    Ok(connection)
}

fn load_json_rows(connection: &Connection, query: &str) -> Result<Vec<Value>, String> {
    let mut statement = connection
        .prepare(query)
        .map_err(|error| format!("State query failed: {error}"))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("State rows failed: {error}"))?;
    rows.map(|row| {
        let payload = row.map_err(|error| format!("State row failed: {error}"))?;
        serde_json::from_str(&payload).map_err(|error| format!("State JSON failed: {error}"))
    })
    .collect()
}

fn load_backups(connection: &Connection) -> Result<Vec<Value>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, target, backup_path, created_at, reason, restorable, redacted FROM backups ORDER BY created_at DESC",
        )
        .map_err(|error| format!("Backup query failed: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "target": row.get::<_, String>(1)?,
                "backupPath": row.get::<_, Option<String>>(2)?,
                "createdAt": row.get::<_, String>(3)?,
                "reason": row.get::<_, String>(4)?,
                "restorable": row.get::<_, i64>(5)? == 1,
                "redacted": row.get::<_, i64>(6)? == 1
            }))
        })
        .map_err(|error| format!("Backup rows failed: {error}"))?;
    rows.map(|row| row.map_err(|error| format!("Backup row failed: {error}")))
        .collect()
}

fn default_pricing_rules() -> Vec<Value> {
    vec![
        json!({
            "provider": "qwen-plan",
            "model": "qwen-plan/qwen3.8-max",
            "currency": "USD",
            "inputPerMillion": 0.0,
            "cachedInputPerMillion": 0.0,
            "outputPerMillion": 0.0,
            "effectiveFrom": "2026-08-13T00:00:00Z",
            "version": "qwen-plan-subscription-2026-08",
            "billingType": "subscription",
            "sourceLabel": "Alibaba Model Studio Token Plan; allowance is provider-owned and not invented here",
            "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/developer-reference/compatibility-of-openai-with-dashscope"
        }),
        json!({
            "provider": "opencode-go",
            "model": "opencode-go/kimi-k3",
            "currency": "USD",
            "inputPerMillion": 0.0,
            "cachedInputPerMillion": 0.0,
            "outputPerMillion": 0.0,
            "effectiveFrom": "2026-08-13T00:00:00Z",
            "version": "opencode-go-subscription-2026-08",
            "billingType": "subscription",
            "sourceLabel": "OpenCode Go subscription; allowance observed by Router when available",
            "sourceUrl": "https://opencode.ai/docs/es/go/"
        }),
        json!({
            "provider": "kimi-api",
            "model": "kimi-api/kimi-k3",
            "currency": "USD",
            "inputPerMillion": 3.0,
            "cachedInputPerMillion": 0.3,
            "outputPerMillion": 15.0,
            "effectiveFrom": "2026-08-01T00:00:00Z",
            "version": "kimi-k3-2026-08",
            "billingType": "payg",
            "sourceLabel": "Moonshot AI official pricing documentation",
            "sourceUrl": "https://platform.moonshot.ai/docs/pricing"
        }),
        json!({
            "provider": "grok-api",
            "model": "grok-api/grok-4.6",
            "currency": "USD",
            "inputPerMillion": 2.0,
            "cachedInputPerMillion": 0.5,
            "outputPerMillion": 6.0,
            "effectiveFrom": "2026-08-01T00:00:00Z",
            "version": "grok-4.6-2026-08",
            "billingType": "payg",
            "sourceLabel": "xAI official model documentation",
            "sourceUrl": "https://docs.x.ai/docs/models"
        }),
    ]
}

fn load_pricing_rules(connection: &Connection) -> Result<Vec<Value>, String> {
    let mut statement = connection
        .prepare("SELECT payload FROM pricing_rules ORDER BY model ASC, effective_from DESC")
        .map_err(|error| format!("Pricing rules query failed: {error}"))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Pricing rules rows failed: {error}"))?;
    let parsed: Vec<Value> = rows
        .filter_map(|row| row.ok())
        .filter_map(|payload| serde_json::from_str(&payload).ok())
        .filter(|rule: &Value| {
            rule["model"]
                .as_str()
                .map(|model| !model.contains("grok-4.") || model.ends_with("grok-4.6"))
                .unwrap_or(true)
        })
        .collect();
    // Stored rows win. Defaults apply only on an empty table; existing
    // installs keep older rates until the operator re-imports pricing.
    Ok(if parsed.is_empty() {
        default_pricing_rules()
    } else {
        parsed
    })
}

fn load_recent_logs(connection: &Connection) -> Result<Vec<Value>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, timestamp, level, operation, payload FROM logs ORDER BY timestamp DESC LIMIT 50",
        )
        .map_err(|error| format!("Log query failed: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            let payload: String = row.get(4)?;
            let mut value: Value = serde_json::from_str(&payload).unwrap_or_else(|_| json!({}));
            value["id"] = Value::String(row.get::<_, String>(0)?);
            value["timestamp"] = Value::String(row.get::<_, String>(1)?);
            value["level"] = Value::String(row.get::<_, String>(2)?);
            value["operation"] = Value::String(row.get::<_, String>(3)?);
            value["redacted"] = Value::Bool(true);
            Ok(value)
        })
        .map_err(|error| format!("Log rows failed: {error}"))?;
    rows.map(|row| row.map_err(|error| format!("Log row failed: {error}")))
        .collect()
}

fn load_setting_value(connection: &Connection, key: &str) -> Option<Value> {
    connection
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .and_then(|value| serde_json::from_str(&value).ok())
}

fn persist_setting_value(connection: &Connection, key: &str, value: &Value) -> Result<(), String> {
    connection
        .execute(
            "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
            params![key, value.to_string(), now()],
        )
        .map_err(|error| format!("Setting write failed: {error}"))?;
    Ok(())
}

fn persist_log(level: &str, operation: &str, message: &str) {
    let Ok(connection) = open_state_db() else {
        return;
    };
    let timestamp = now();
    let id = format!("log-{}-{}", timestamp, operation);
    let payload = json!({
        "message": redact_bounded(message),
        "redacted": true
    });
    let _ = connection.execute(
        "INSERT OR REPLACE INTO logs (id, timestamp, level, operation, payload) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, timestamp, level, operation, payload.to_string()],
    );
}

fn delegation_run_id() -> String {
    let sequence = DELEGATION_EVIDENCE_ID.fetch_add(1, Ordering::Relaxed);
    format!("run-{}-{sequence}", now())
}

fn normalized_collab_action(tool: &str) -> Option<&'static str> {
    let compact: String = tool
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect();
    match compact.as_str() {
        "spawnagent" => Some("spawn-agent"),
        "sendinput" | "sendmessage" => Some("send-message"),
        "resumeagent" | "followuptask" => Some("follow-up"),
        "wait" | "waitagent" => Some("wait"),
        "interruptagent" | "closeagent" => Some("interrupt-agent"),
        _ => None,
    }
}

fn normalized_collab_status(status: Option<&str>) -> &'static str {
    match status.unwrap_or_default() {
        "completed" => "completed",
        "failed" => "failed",
        "interrupted" | "cancelled" | "canceled" => "interrupted",
        "declined" => "declined",
        _ => "unknown",
    }
}

fn delegation_evidence_from_event(
    event: &Value,
    context: &DelegationEvidenceContext,
) -> Option<Value> {
    if event["method"].as_str()? != "item/completed" {
        return None;
    }
    let item = event["params"]["item"].as_object()?;
    if item.get("type")?.as_str()? != "collabToolCall" {
        return None;
    }
    if item.get("senderThreadId")?.as_str()? != context.root_thread_id {
        return None;
    }
    let action = normalized_collab_action(item.get("tool")?.as_str()?)?;
    let sequence = DELEGATION_EVIDENCE_ID.fetch_add(1, Ordering::Relaxed);
    let occurred_at = now();
    let id = format!("delegation-{occurred_at}-{sequence}");
    let child_created = item
        .get("newThreadId")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty());
    Some(json!({
        "id": id,
        "runId": context.run_id,
        "occurredAt": occurred_at,
        "rootModel": context.root_model,
        "requestedRole": context.requested_role,
        "requestedWorkerModel": context.requested_worker_model,
        "action": action,
        "status": normalized_collab_status(item.get("status").and_then(Value::as_str)),
        "childCreated": child_created,
        "rootMediated": true,
        "source": "codex-app-server",
        "redacted": true
    }))
}

fn persist_delegation_evidence(record: &Value) -> Result<(), String> {
    let id = record["id"]
        .as_str()
        .ok_or_else(|| "Delegation evidence id is invalid".to_string())?;
    let run_id = record["runId"]
        .as_str()
        .ok_or_else(|| "Delegation evidence run id is invalid".to_string())?;
    let occurred_at = record["occurredAt"]
        .as_str()
        .ok_or_else(|| "Delegation evidence timestamp is invalid".to_string())?;
    if record["redacted"].as_bool() != Some(true)
        || record["rootMediated"].as_bool() != Some(true)
        || !matches!(
            record["requestedRole"].as_str(),
            Some("frontend" | "engineer" | "visual" | "unspecified")
        )
    {
        return Err("Delegation evidence failed the redaction policy".to_string());
    }
    let connection = open_state_db()?;
    connection
        .execute(
            "INSERT OR REPLACE INTO delegation_evidence (id, run_id, occurred_at, payload) VALUES (?1, ?2, ?3, ?4)",
            params![id, run_id, occurred_at, record.to_string()],
        )
        .map_err(|error| format!("Delegation evidence write failed: {error}"))?;
    Ok(())
}

fn agent_role_for_provider(provider: &str) -> Option<&'static str> {
    match provider {
        "kimi-api" | "opencode-go" | "qwen-plan" => Some("frontend"),
        "grok-api" | "grok-oauth" => Some("engineer"),
        _ => None,
    }
}

fn sanitized_live_check_record(
    provider: &str,
    model: &str,
    test: &str,
    executed_test: &str,
    result: &Value,
) -> Value {
    json!({
        "role": agent_role_for_provider(provider).unwrap_or("unknown"),
        "provider": provider,
        "model": model,
        "test": test,
        "executedTest": executed_test,
        "status": if result["ok"].as_bool().unwrap_or(false) { "passed" } else { "failed" },
        "checkedAt": now()
    })
}

fn persist_live_check_record(record: &Value) -> Result<(), String> {
    let role = record["role"]
        .as_str()
        .filter(|role| matches!(*role, "frontend" | "engineer"))
        .ok_or_else(|| "Live check role is invalid".to_string())?;
    let connection = open_state_db()?;
    let mut records = load_setting_value(&connection, "agentTestResults")
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    records[role] = record.clone();
    persist_setting_value(&connection, "agentTestResults", &records)?;
    drop(connection);
    persist_log(
        if record["status"].as_str() == Some("passed") {
            "info"
        } else {
            "warn"
        },
        "live-check",
        &format!(
            "Recorded {} result for {} without output content",
            record["test"].as_str().unwrap_or("live check"),
            role
        ),
    );
    Ok(())
}

fn valid_pricing_effective_time(value: &str) -> bool {
    if value.len() != 20 || !value.ends_with('Z') {
        return false;
    }
    let bytes = value.as_bytes();
    if bytes.get(4) != Some(&b'-')
        || bytes.get(7) != Some(&b'-')
        || bytes.get(10) != Some(&b'T')
        || bytes.get(13) != Some(&b':')
        || bytes.get(16) != Some(&b':')
    {
        return false;
    }
    for index in [0usize, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18] {
        if !bytes[index].is_ascii_digit() {
            return false;
        }
    }
    let number = |start: usize, end: usize| value[start..end].parse::<u32>().ok();
    matches!(number(0, 4), Some(2000..=2200))
        && matches!(number(5, 7), Some(1..=12))
        && matches!(number(8, 10), Some(1..=31))
        && matches!(number(11, 13), Some(0..=23))
        && matches!(number(14, 16), Some(0..=59))
        && matches!(number(17, 19), Some(0..=59))
}

fn pricing_source_host(value: &str) -> Option<&str> {
    let remainder = value.strip_prefix("https://")?;
    if remainder.is_empty() || remainder.contains(char::is_whitespace) {
        return None;
    }
    let host = remainder.split(['/', '?', '#']).next()?.split(':').next()?;
    if host.is_empty() || host.contains('@') {
        return None;
    }
    Some(host)
}

fn pricing_source_allowed(provider: &str, value: &str) -> bool {
    let Some(host) = pricing_source_host(value) else {
        return false;
    };
    let allowed = match provider {
        "qwen-plan" => &["alibabacloud.com", "aliyun.com"][..],
        "opencode-go" => &["opencode.ai"][..],
        "kimi-api" => &["moonshot.ai"][..],
        "grok-api" | "grok-oauth" => &["x.ai"][..],
        "openai" => &["openai.com"][..],
        _ => &[][..],
    };
    allowed
        .iter()
        .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")))
}

fn validate_pricing_rule(rule: &Value) -> Result<(), String> {
    let string_field = |key: &str, max: usize| {
        rule[key]
            .as_str()
            .filter(|value| !value.is_empty() && value.len() <= max)
            .ok_or_else(|| format!("Pricing rule field {key} is invalid"))
    };
    let provider = string_field("provider", 80)?;
    let model = string_field("model", 160)?;
    if !allowed_provider(provider) && provider != "openai" {
        return Err("Pricing rule provider is not allow-listed".to_string());
    }
    if !valid_model_argument(model) {
        return Err("Pricing rule model contains unsupported characters".to_string());
    }
    if !model.starts_with(&format!("{provider}/")) {
        return Err("Pricing rule provider and model do not match".to_string());
    }
    if !matches!(rule["currency"].as_str(), Some("USD" | "CLP")) {
        return Err("Pricing rule currency must be USD or CLP".to_string());
    }
    for key in [
        "inputPerMillion",
        "cachedInputPerMillion",
        "outputPerMillion",
    ] {
        let value = rule[key]
            .as_f64()
            .ok_or_else(|| format!("Pricing rule field {key} is invalid"))?;
        if !value.is_finite() || !(0.0..=1_000_000.0).contains(&value) {
            return Err(format!(
                "Pricing rule field {key} is outside the safe range"
            ));
        }
    }
    let effective_from = string_field("effectiveFrom", 80)?;
    if !valid_pricing_effective_time(effective_from) {
        return Err("Pricing rule effectiveFrom must be UTC RFC3339 seconds".to_string());
    }
    string_field("version", 80)?;
    let billing_type = rule["billingType"].as_str().unwrap_or("payg");
    if !matches!(billing_type, "payg" | "subscription") {
        return Err("Pricing rule billingType must be payg or subscription".to_string());
    }
    if billing_type == "subscription"
        && [
            "inputPerMillion",
            "cachedInputPerMillion",
            "outputPerMillion",
        ]
        .iter()
        .any(|key| rule[*key].as_f64().unwrap_or_default() != 0.0)
    {
        return Err("Subscription pricing rules cannot invent per-token charges".to_string());
    }
    string_field("sourceLabel", 240)?;
    let source_url = string_field("sourceUrl", 500)?;
    if !pricing_source_allowed(provider, source_url) {
        return Err(
            "Pricing rule sourceUrl is not an approved official provider domain".to_string(),
        );
    }
    Ok(())
}

fn pricing_import_preview(rules: &[Value]) -> Result<Value, String> {
    if rules.is_empty() || rules.len() > 100 {
        return Err("Provide between 1 and 100 pricing rules".to_string());
    }
    let mut identities = HashSet::new();
    let mut providers = HashSet::new();
    let mut versions = HashSet::new();
    let mut effective = Vec::new();
    let mut subscription_rules = 0;
    for rule in rules {
        validate_pricing_rule(rule)?;
        let identity = format!(
            "{}\u{0}{}\u{0}{}",
            rule["model"].as_str().unwrap_or_default(),
            rule["version"].as_str().unwrap_or_default(),
            rule["effectiveFrom"].as_str().unwrap_or_default()
        );
        if !identities.insert(identity) {
            return Err(
                "Pricing import contains a duplicate model/version/effectiveFrom".to_string(),
            );
        }
        providers.insert(rule["provider"].as_str().unwrap_or_default().to_string());
        versions.insert(rule["version"].as_str().unwrap_or_default().to_string());
        effective.push(
            rule["effectiveFrom"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
        );
        if rule["billingType"].as_str() == Some("subscription") {
            subscription_rules += 1;
        }
    }
    let mut providers: Vec<String> = providers.into_iter().collect();
    let mut versions: Vec<String> = versions.into_iter().collect();
    providers.sort();
    versions.sort();
    effective.sort();
    let payload = serde_json::to_string(rules)
        .map_err(|error| format!("Pricing preview JSON failed: {error}"))?;
    Ok(json!({
        "token": managed_preview_hash(&payload),
        "count": rules.len(),
        "providers": providers,
        "versions": versions,
        "effectiveFrom": effective.first().cloned().unwrap_or_default(),
        "effectiveTo": effective.last().cloned().unwrap_or_default(),
        "subscriptionRules": subscription_rules,
        "paygRules": rules.len() - subscription_rules,
        "writesCredentialValues": false
    }))
}

fn persist_pricing_rules(rules: &[Value]) -> Result<(), String> {
    pricing_import_preview(rules)?;
    let mut connection = open_state_db()?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Pricing transaction failed: {error}"))?;
    for rule in rules {
        transaction
            .execute(
                "INSERT OR REPLACE INTO pricing_rules (model, version, effective_from, payload, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    rule["model"].as_str().unwrap_or_default(),
                    rule["version"].as_str().unwrap_or_default(),
                    rule["effectiveFrom"].as_str().unwrap_or_default(),
                    rule.to_string(),
                    now()
                ],
            )
            .map_err(|error| format!("Pricing rule write failed: {error}"))?;
    }
    transaction
        .commit()
        .map_err(|error| format!("Pricing transaction commit failed: {error}"))?;
    persist_log(
        "info",
        "pricing-rules",
        "Pricing rules version saved locally",
    );
    Ok(())
}

fn load_snapshot_state(mut snapshot: Value, refresh_router: bool) -> Result<Value, String> {
    let connection = open_state_db()?;
    snapshot["projects"] = Value::Array(load_json_rows(
        &connection,
        "SELECT payload FROM projects ORDER BY updated_at DESC",
    )?);
    snapshot["usage"] = Value::Array(load_json_rows(
        &connection,
        "SELECT payload FROM usage_events ORDER BY timestamp DESC",
    )?);
    snapshot["backups"] = Value::Array(load_backups(&connection)?);
    snapshot["pricingRules"] = Value::Array(load_pricing_rules(&connection)?);
    snapshot["delegationEvidence"] = Value::Array(load_json_rows(
        &connection,
        "SELECT payload FROM delegation_evidence ORDER BY occurred_at DESC LIMIT 100",
    )?);
    snapshot["logs"] = Value::Array(load_recent_logs(&connection)?);
    let default_budget = snapshot["budget"].clone();
    snapshot["budget"] = load_setting_value(&connection, "budget").unwrap_or(default_budget);
    snapshot["featureFlags"] =
        load_setting_value(&connection, "featureFlags").unwrap_or_else(|| {
            json!({
                "appServer": false,
                "mcp": false,
                "experimentalWorktrees": false
            })
        });
    snapshot["frontendStrategy"] = load_setting_value(&connection, "frontendStrategy")
        .filter(|strategy| valid_frontend_strategy(strategy))
        .unwrap_or_else(default_frontend_strategy);
    if !refresh_router {
        if let Some(cached) = load_setting_value(&connection, "runtimeFacts") {
            for key in ["codex", "router", "providers", "models", "agents", "update"] {
                if let Some(value) = cached.get(key) {
                    if key == "codex" && value["detected"].as_bool() != Some(true) {
                        continue;
                    }
                    if key == "router" {
                        continue;
                    }
                    snapshot[key] = value.clone();
                }
            }
        }
    }
    if let Some(mut saved_agents) = load_setting_value(&connection, "agentDefinitions") {
        if let Some(agents) = saved_agents.as_array_mut() {
            if valid_agent_collection(agents) {
                let mut migrated = false;
                for agent in agents {
                    if agent["role"].as_str() != Some("engineer") {
                        continue;
                    }
                    let provider = agent["providerId"].as_str().unwrap_or("grok-oauth");
                    let preferred = if provider == "grok-oauth" {
                        "grok-oauth/grok-4.6"
                    } else {
                        "grok-api/grok-4.6"
                    };
                    if agent["modelId"].as_str() != Some(preferred) {
                        agent["modelId"] = Value::String(preferred.to_string());
                        agent["health"] = Value::String("unknown".to_string());
                        migrated = true;
                    }
                }
                if migrated {
                    persist_setting_value(&connection, "agentDefinitions", &saved_agents)?;
                }
                snapshot["agents"] = saved_agents;
            }
        }
    }
    if refresh_router {
        enrich_router_facts(&mut snapshot);
    }
    if let Some(agent_tests) = load_setting_value(&connection, "agentTestResults") {
        if let Some(agents) = snapshot["agents"].as_array_mut() {
            for agent in agents {
                let Some(role) = agent["role"].as_str() else {
                    continue;
                };
                let Some(record) = agent_tests.get(role) else {
                    continue;
                };
                let provider_matches = record["provider"].as_str() == agent["providerId"].as_str();
                let model_matches = record["model"].as_str() == agent["modelId"].as_str();
                if provider_matches && model_matches {
                    let test = record["test"].as_str().unwrap_or("live check");
                    let status = record["status"].as_str().unwrap_or("unknown");
                    let checked_at = record["checkedAt"].as_str().unwrap_or("unknown time");
                    agent["lastTest"] = Value::String(format!("{test} {status} · {checked_at}"));
                    if status == "failed" {
                        agent["health"] = Value::String("unhealthy".to_string());
                    }
                }
            }
        }
    }
    let latest_health: Option<String> = connection
        .query_row(
            "SELECT payload FROM health_runs ORDER BY completed_at DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Health history failed: {error}"))?;
    if let Some(payload) = latest_health {
        snapshot["health"] = serde_json::from_str(&payload)
            .map_err(|error| format!("Health history JSON failed: {error}"))?;
    }
    snapshot["healthHistory"] = Value::Array(load_json_rows(
        &connection,
        "SELECT payload FROM health_runs ORDER BY completed_at DESC LIMIT 20",
    )?);
    snapshot["diagnostics"] = build_diagnostics(&snapshot);
    Ok(snapshot)
}

fn persist_runtime_facts(snapshot: &Value) -> Result<(), String> {
    let connection = open_state_db()?;
    let facts = json!({
        "codex": snapshot["codex"],
        "router": snapshot["router"],
        "providers": snapshot["providers"],
        "models": snapshot["models"],
        "agents": snapshot["agents"],
        "update": snapshot["update"],
        "refreshedAt": now()
    });
    persist_setting_value(&connection, "runtimeFacts", &facts)
}

fn persist_health(report: &Value) -> Result<(), String> {
    let connection = open_state_db()?;
    connection
        .execute(
            "INSERT OR REPLACE INTO health_runs (id, completed_at, payload) VALUES (?1, ?2, ?3)",
            params![
                report["id"].as_str().unwrap_or("health-unknown"),
                report["completedAt"]
                    .as_str()
                    .unwrap_or_else(|| report["startedAt"].as_str().unwrap_or("unknown")),
                report.to_string()
            ],
        )
        .map_err(|error| format!("Health history write failed: {error}"))?;
    Ok(())
}

fn health_report_status(checks: &[Value]) -> &'static str {
    if checks
        .iter()
        .any(|check| check["status"].as_str() == Some("unhealthy"))
    {
        "unhealthy"
    } else if checks
        .iter()
        .any(|check| matches!(check["status"].as_str(), Some("missing" | "degraded")))
    {
        "degraded"
    } else if checks
        .iter()
        .any(|check| check["status"].as_str() == Some("unknown"))
    {
        "unknown"
    } else {
        "healthy"
    }
}

fn persist_json_row(table: &str, id: &str, timestamp: &str, payload: &Value) -> Result<(), String> {
    let connection = open_state_db()?;
    let query = match table {
        "usage_events" => {
            "INSERT OR REPLACE INTO usage_events (id, timestamp, payload) VALUES (?1, ?2, ?3)"
        }
        _ => return Err("Unsupported state table".to_string()),
    };
    connection
        .execute(query, params![id, timestamp, payload.to_string()])
        .map_err(|error| format!("State write failed: {error}"))?;
    Ok(())
}

fn persist_project(profile: &Value) -> Result<(), String> {
    let connection = open_state_db()?;
    connection
        .execute(
            "INSERT OR REPLACE INTO projects (id, path, payload, updated_at) VALUES (?1, ?2, ?3, ?4)",
            params![
                profile["id"].as_str().unwrap_or("project-unknown"),
                profile["path"].as_str().unwrap_or(""),
                profile.to_string(),
                now()
            ],
        )
        .map_err(|error| format!("Project write failed: {error}"))?;
    Ok(())
}

fn persist_backup(target: &str, reason: &str, backup_path: Option<&str>) -> Result<(), String> {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let connection = open_state_db()?;
    let mut hasher = DefaultHasher::new();
    target.hash(&mut hasher);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let id = format!("backup-{nanos}-{:x}", hasher.finish());
    connection
        .execute(
            "INSERT INTO backups (id, target, backup_path, created_at, reason, restorable, redacted) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, target, backup_path, now(), reason, backup_path.is_some(), true],
        )
        .map_err(|error| format!("Backup history write failed: {error}"))?;
    Ok(())
}

fn find_codex() -> Option<String> {
    if let Some(override_path) = env::var_os("CODEX_ORCHESTRA_CODEX_BIN") {
        let path = PathBuf::from(override_path);
        if usable_codex_binary(&path) {
            return Some(path.to_string_lossy().to_string());
        }
    }
    find_codex_on_path().or_else(find_codex_known_locations)
}

fn usable_codex_binary(path: &Path) -> bool {
    path.is_file()
        && path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| {
                let lower = name.to_ascii_lowercase();
                lower == "codex" || lower == "codex.exe"
            })
}

fn find_codex_on_path() -> Option<String> {
    let command = if cfg!(windows) { "where.exe" } else { "which" };
    let mut lookup = Command::new(command);
    lookup.arg("codex");
    command_output_with_timeout(lookup, Duration::from_secs(2))
        .ok()
        .and_then(|output| {
            if !output.status.success() {
                return None;
            }
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .map(str::trim)
                .find_map(|line| {
                    if line.is_empty() {
                        return None;
                    }
                    let path = PathBuf::from(line);
                    usable_codex_binary(&path).then_some(path.to_string_lossy().to_string())
                })
        })
}

fn find_codex_known_locations() -> Option<String> {
    let mut candidates = Vec::new();
    if let Some(local) = env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        candidates.push(
            local
                .join("Microsoft")
                .join("WindowsApps")
                .join("codex.exe"),
        );
        if let Ok(entries) = fs::read_dir(local.join("OpenAI").join("Codex").join("bin")) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    candidates.push(path.join("codex.exe"));
                    candidates.push(path.join("codex"));
                }
            }
        }
    }
    if let Some(program_files) = env::var_os("ProgramFiles").map(PathBuf::from) {
        if let Ok(entries) = fs::read_dir(program_files.join("WindowsApps")) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let Some(name) = name.to_str() else {
                    continue;
                };
                if !name.starts_with("OpenAI.Codex_") {
                    continue;
                }
                let resources = entry.path().join("app").join("resources");
                candidates.push(resources.join("codex.exe"));
                candidates.push(resources.join("codex"));
            }
        }
    }
    candidates
        .into_iter()
        .find_map(|path| usable_codex_binary(&path).then_some(path.to_string_lossy().to_string()))
}

fn find_grok_cli() -> Option<String> {
    let command = if cfg!(windows) { "where.exe" } else { "which" };
    let mut lookup = Command::new(command);
    lookup.arg("grok");
    command_output_with_timeout(lookup, Duration::from_secs(2))
        .ok()
        .and_then(|output| {
            if !output.status.success() {
                return None;
            }
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .next()
                .map(|line| line.trim().to_string())
                .filter(|line| !line.is_empty())
        })
}

fn codex_version(executable: &str) -> Option<String> {
    let mut command = Command::new(executable);
    command.arg("--version");
    let output = command_output_with_timeout(command, Duration::from_secs(3)).ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .map(str::trim)
        .filter(|line| !line.is_empty() && line.len() <= 120)
        .map(ToOwned::to_owned)
}

fn codex_login_status(executable: &str) -> &'static str {
    let mut command = Command::new(executable);
    command.args(["login", "status"]);
    let output = match command_output_with_timeout(command, Duration::from_secs(4)) {
        Ok(output) => output,
        Err(_) => return "unknown",
    };
    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
    .to_lowercase();
    if output.status.success() {
        "configured"
    } else if combined.contains("not logged")
        || combined.contains("not authenticated")
        || combined.contains("login required")
    {
        "missing"
    } else {
        "unknown"
    }
}

fn app_server_probe_result(response: &Value) -> Value {
    let result = response.get("result").cloned().unwrap_or(Value::Null);
    let server_version = result["serverInfo"]["version"]
        .as_str()
        .filter(|value| !value.is_empty() && value.len() <= 120)
        .map(ToOwned::to_owned);
    let platform = result["platformFamily"]
        .as_str()
        .filter(|value| value.len() <= 80)
        .map(ToOwned::to_owned);
    let ok = response.get("error").is_none() && response.get("result").is_some();
    json!({
        "ok": ok,
        "handshake": if ok { "initialized" } else { "rejected" },
        "serverVersion": server_version,
        "platformFamily": platform,
        "redacted": true
    })
}

fn terminate_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn codex_app_server_probe(executable: &str) -> Result<Value, String> {
    let mut command = Command::new(executable);
    command
        .args(["app-server", "--listen", "stdio://"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Codex App Server could not start: {error}"))?;
    let mut stdin = match child.stdin.take() {
        Some(stdin) => stdin,
        None => {
            terminate_child(&mut child);
            return Err("Codex App Server stdin was unavailable".to_string());
        }
    };
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            terminate_child(&mut child);
            return Err("Codex App Server stdout was unavailable".to_string());
        }
    };
    let initialize = json!({
        "method": "initialize",
        "id": 0,
        "params": {
            "clientInfo": {
                "name": "codex_orchestra",
                "title": "Codex Orchestra",
                "version": "0.1.0"
            }
        }
    });
    if let Err(error) = stdin.write_all(format!("{}\n", initialize).as_bytes()) {
        terminate_child(&mut child);
        return Err(format!("Codex App Server initialize write failed: {error}"));
    }
    if let Err(error) = stdin.flush() {
        terminate_child(&mut child);
        return Err(format!("Codex App Server initialize flush failed: {error}"));
    }

    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        let result = reader
            .read_line(&mut line)
            .map(|_| line)
            .map_err(|error| error.to_string());
        let _ = sender.send(result);
    });
    let response_line = match receiver.recv_timeout(Duration::from_secs(8)) {
        Ok(Ok(line)) => line,
        Ok(Err(error)) => {
            terminate_child(&mut child);
            return Err(format!("Codex App Server response read failed: {error}"));
        }
        Err(_) => {
            terminate_child(&mut child);
            return Err("Codex App Server initialize timed out".to_string());
        }
    };
    let response: Value = match serde_json::from_str(response_line.trim()) {
        Ok(response) => response,
        Err(error) => {
            terminate_child(&mut child);
            return Err(format!("Codex App Server returned invalid JSON: {error}"));
        }
    };
    let result = app_server_probe_result(&response);
    if result["ok"].as_bool() == Some(true) {
        let _ = stdin.write_all(b"{\"method\":\"initialized\",\"params\":{}}\n");
        let _ = stdin.flush();
    }
    terminate_child(&mut child);
    Ok(result)
}

fn app_server_request_id() -> u64 {
    APP_SERVER_REQUEST_ID.fetch_add(1, Ordering::Relaxed)
}

fn write_app_server_message(
    stdin: &mut std::process::ChildStdin,
    message: &Value,
) -> Result<(), String> {
    let line = serde_json::to_string(message)
        .map_err(|error| format!("Codex App Server request could not be encoded: {error}"))?;
    stdin
        .write_all(format!("{line}\n").as_bytes())
        .map_err(|error| format!("Codex App Server request could not be sent: {error}"))?;
    stdin
        .flush()
        .map_err(|error| format!("Codex App Server request could not be flushed: {error}"))
}

fn read_app_server_response(
    receiver: &mpsc::Receiver<Result<Value, String>>,
    expected_id: u64,
) -> Result<Value, String> {
    // `thread/start` and `turn/start` may be preceded by notifications. Read
    // until their JSON-RPC response arrives; all other messages are retained
    // only by the live event reader after the initial turn has begun.
    let deadline = Instant::now() + Duration::from_secs(12);
    for _ in 0..48 {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("Codex App Server request timed out".to_string());
        }
        let response = receiver
            .recv_timeout(remaining)
            .map_err(|_| "Codex App Server request timed out".to_string())??;
        if response["id"].as_u64() == Some(expected_id) {
            if let Some(error) = response.get("error") {
                return Err(format!(
                    "Codex App Server rejected the request: {}",
                    redact_bounded(&error.to_string())
                ));
            }
            return Ok(response);
        }
    }
    Err("Codex App Server did not return the expected response".to_string())
}

fn valid_native_codex_model(model: &str) -> bool {
    matches!(model, "gpt-5.6-sol" | "gpt-5.6-luna" | "gpt-5.6-terra")
}

fn valid_execution_prompt(prompt: &str) -> Result<&str, String> {
    let prompt = prompt.trim();
    if prompt.is_empty() || prompt.len() > 40_000 {
        return Err("Task must contain between 1 and 40,000 characters".to_string());
    }
    Ok(prompt)
}

fn valid_requested_role(role: &str) -> bool {
    matches!(role, "frontend" | "engineer" | "visual" | "unspecified")
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct ObservedTokenUsage {
    input: u64,
    cached_input: u64,
    output: u64,
}

impl ObservedTokenUsage {
    fn delta_from(self, previous: Self) -> Option<Self> {
        if self.input < previous.input
            || self.cached_input < previous.cached_input
            || self.output < previous.output
        {
            return None;
        }
        let delta = Self {
            input: self.input - previous.input,
            cached_input: self.cached_input - previous.cached_input,
            output: self.output - previous.output,
        };
        (delta.input > 0 || delta.cached_input > 0 || delta.output > 0).then_some(delta)
    }
}

fn usage_number(value: &Value, names: &[&str]) -> u64 {
    names
        .iter()
        .find_map(|name| value.get(*name).and_then(Value::as_u64))
        .unwrap_or(0)
}

fn observed_usage_from_event(event: &Value) -> Option<(&str, ObservedTokenUsage)> {
    if event["method"].as_str()? != "thread/tokenUsage/updated" {
        return None;
    }
    let params = event.get("params")?;
    let thread_id = params
        .get("threadId")
        .or_else(|| params.get("thread_id"))?
        .as_str()?;
    let token_usage = params
        .get("tokenUsage")
        .or_else(|| params.get("token_usage"))?;
    let total = token_usage
        .get("total")
        .or_else(|| token_usage.get("totalTokenUsage"))
        .or_else(|| token_usage.get("total_token_usage"))?;
    let usage = ObservedTokenUsage {
        input: usage_number(total, &["inputTokens", "input_tokens"]),
        cached_input: usage_number(total, &["cachedInputTokens", "cached_input_tokens"]),
        output: usage_number(total, &["outputTokens", "output_tokens"]),
    };
    (usage.input > 0 || usage.cached_input > 0 || usage.output > 0).then_some((thread_id, usage))
}

fn usage_provider(model: &str) -> &str {
    model
        .split_once('/')
        .map(|(provider, _)| provider)
        .unwrap_or("openai")
}

fn persist_observed_usage(model: &str, role: Option<&str>, usage: ObservedTokenUsage) {
    let provider = usage_provider(model);
    let sequence = USAGE_EVENT_ID.fetch_add(1, Ordering::Relaxed);
    let timestamp = now();
    let mut event = json!({
        "id": format!("observed-{sequence}"),
        "timestamp": timestamp,
        "provider": provider,
        "model": model,
        "inputTokens": usage.input,
        "cachedInputTokens": usage.cached_input,
        "outputTokens": usage.output,
        "source": if provider == "openai" { "provider" } else { "router" }
    });
    if matches!(role, Some("root" | "frontend" | "engineer")) {
        event["role"] = Value::String(role.unwrap_or_default().to_string());
    }
    if let Err(error) = persist_json_row(
        "usage_events",
        &format!("observed-{sequence}"),
        &timestamp,
        &event,
    ) {
        persist_log("warn", "usage-observation", &error);
    }
}

fn start_app_server_execution(
    app: &tauri::AppHandle,
    state: &AppServerState,
    project_path: &str,
    model: &str,
    effort: &str,
    prompt: &str,
    requested_role: &str,
    requested_worker_model: Option<&str>,
) -> Result<Value, String> {
    if !app_server_enabled()? {
        return Err("Enable App Server in Settings before running a Codex task".to_string());
    }
    if !valid_native_codex_model(model) || !valid_model_argument(model) {
        return Err("Only native Codex Sol, Luna or Terra models may run here".to_string());
    }
    if !matches!(
        effort,
        "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
    ) {
        return Err("The selected reasoning effort is invalid".to_string());
    }
    let root = safe_project_root(project_path)?;
    let prompt = valid_execution_prompt(prompt)?;
    if !valid_requested_role(requested_role) {
        return Err("Requested worker role is invalid".to_string());
    }
    let requested_worker_model = requested_worker_model
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if requested_worker_model.is_some_and(|value| {
        value.len() > 160 || !valid_model_argument(value) || requested_role == "unspecified"
    }) {
        return Err("Requested worker model is invalid".to_string());
    }
    let executable = find_codex().ok_or_else(|| "Codex executable was not detected".to_string())?;

    let mut guard = state
        .session
        .lock()
        .map_err(|_| "Codex execution state is unavailable".to_string())?;
    if guard.is_some() {
        return Err(
            "A Codex task is already active. Stop it or send a follow-up instead.".to_string(),
        );
    }

    let mut command = Command::new(executable);
    command
        .args(["app-server", "--listen", "stdio://"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Codex App Server could not start: {error}"))?;
    let Some(mut stdin) = child.stdin.take() else {
        terminate_child(&mut child);
        return Err("Codex App Server stdin was unavailable".to_string());
    };
    let Some(stdout) = child.stdout.take() else {
        terminate_child(&mut child);
        return Err("Codex App Server stdout was unavailable".to_string());
    };
    let (event_sender, event_receiver) = mpsc::channel::<Result<Value, String>>();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let event = line
                .map_err(|error| format!("Codex App Server response read failed: {error}"))
                .and_then(|line| {
                    serde_json::from_str::<Value>(line.trim())
                        .map_err(|error| format!("Codex App Server returned invalid JSON: {error}"))
                });
            if event_sender.send(event).is_err() {
                break;
            }
        }
    });

    let initialize_id = app_server_request_id();
    let initialize = json!({
        "method": "initialize",
        "id": initialize_id,
        "params": { "clientInfo": { "name": "codex_orchestra", "title": "Codex Orchestra", "version": "0.1.0" } }
    });
    if let Err(error) = write_app_server_message(&mut stdin, &initialize)
        .and_then(|_| read_app_server_response(&event_receiver, initialize_id).map(|_| ()))
        .and_then(|_| {
            write_app_server_message(&mut stdin, &json!({"method":"initialized","params":{}}))
        })
    {
        terminate_child(&mut child);
        return Err(error);
    }

    let thread_request_id = app_server_request_id();
    let thread_request = json!({
        "method": "thread/start",
        "id": thread_request_id,
        "params": {
            "model": model,
            "cwd": root.to_string_lossy(),
            "serviceName": "codex-orchestra"
        }
    });
    let thread_response = match write_app_server_message(&mut stdin, &thread_request)
        .and_then(|_| read_app_server_response(&event_receiver, thread_request_id))
    {
        Ok(response) => response,
        Err(error) => {
            terminate_child(&mut child);
            return Err(error);
        }
    };
    let Some(thread_id) = thread_response["result"]["thread"]["id"]
        .as_str()
        .filter(|value| !value.is_empty())
    else {
        terminate_child(&mut child);
        return Err("Codex App Server returned no thread id".to_string());
    };
    let thread_id = thread_id.to_string();

    let turn_request_id = app_server_request_id();
    let turn_request = json!({
        "method": "turn/start",
        "id": turn_request_id,
        "params": {
            "threadId": thread_id,
            "input": [{"type":"text","text": prompt}],
            "cwd": root.to_string_lossy(),
            "model": model,
            "effort": effort,
            "summary": "concise"
        }
    });
    let turn_response = match write_app_server_message(&mut stdin, &turn_request)
        .and_then(|_| read_app_server_response(&event_receiver, turn_request_id))
    {
        Ok(response) => response,
        Err(error) => {
            terminate_child(&mut child);
            return Err(error);
        }
    };
    let Some(turn_id) = turn_response["result"]["turn"]["id"]
        .as_str()
        .filter(|value| !value.is_empty())
    else {
        terminate_child(&mut child);
        return Err("Codex App Server returned no turn id".to_string());
    };
    let turn_id = turn_id.to_string();
    let evidence_context = DelegationEvidenceContext {
        run_id: delegation_run_id(),
        root_model: model.to_string(),
        requested_role: requested_role.to_string(),
        requested_worker_model: requested_worker_model.map(ToOwned::to_owned),
        root_thread_id: thread_id.clone(),
    };
    let evidence_run_id = evidence_context.run_id.clone();
    let root_thread_for_usage = thread_id.clone();
    let root_model_for_usage = model.to_string();
    let worker_model_for_usage = requested_worker_model.map(ToOwned::to_owned);
    let worker_role_for_usage = requested_role.to_string();

    let event_app = app.clone();
    thread::spawn(move || {
        let mut observed_totals: HashMap<String, ObservedTokenUsage> = HashMap::new();
        for event in event_receiver {
            if let Ok(event) = event {
                if let Some((usage_thread, total)) = observed_usage_from_event(&event) {
                    let previous = observed_totals
                        .get(usage_thread)
                        .copied()
                        .unwrap_or_default();
                    if let Some(delta) = total.delta_from(previous) {
                        let is_root = usage_thread == root_thread_for_usage;
                        let model = if is_root {
                            root_model_for_usage.as_str()
                        } else {
                            worker_model_for_usage.as_deref().unwrap_or("unknown")
                        };
                        let role = if is_root {
                            Some("root")
                        } else if matches!(worker_role_for_usage.as_str(), "frontend" | "engineer")
                        {
                            Some(worker_role_for_usage.as_str())
                        } else {
                            None
                        };
                        persist_observed_usage(model, role, delta);
                        refresh_tray(&event_app);
                    }
                    observed_totals.insert(usage_thread.to_string(), total);
                }
                if let Some(record) = delegation_evidence_from_event(&event, &evidence_context) {
                    if let Err(error) = persist_delegation_evidence(&record) {
                        persist_log("warn", "delegation-evidence", &error);
                    }
                }
                // Full events are delivered only to the visible renderer. The
                // database receives the allow-listed projection above, never
                // prompts, responses, IDs, arguments or raw event bodies.
                let _ = event_app.emit(APP_SERVER_EVENT, event);
            }
        }
        let _ = event_app.emit(
            APP_SERVER_EVENT,
            json!({"method":"orchestra/sessionClosed","params":{}}),
        );
    });

    *guard = Some(AppServerSession {
        child,
        stdin,
        thread_id: thread_id.clone(),
        turn_id: Some(turn_id.clone()),
    });
    persist_log(
        "info",
        "codex-execution",
        "Codex thread and turn started; prompt and response bodies are not retained",
    );
    Ok(
        json!({"threadId": thread_id, "turnId": turn_id, "evidenceRunId": evidence_run_id, "status": "inProgress", "redacted": true}),
    )
}

fn send_app_server_request(
    state: &AppServerState,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let mut guard = state
        .session
        .lock()
        .map_err(|_| "Codex execution state is unavailable".to_string())?;
    let Some(session) = guard.as_mut() else {
        return Err("No active Codex task".to_string());
    };
    let id = app_server_request_id();
    write_app_server_message(
        &mut session.stdin,
        &json!({"method": method, "id": id, "params": params}),
    )?;
    Ok(
        json!({"accepted": true, "requestId": id, "threadId": session.thread_id, "turnId": session.turn_id}),
    )
}

#[tauri::command]
async fn start_codex_execution(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppServerState>,
    project_path: String,
    model: String,
    effort: String,
    prompt: String,
    requested_role: String,
    requested_worker_model: Option<String>,
) -> Result<Value, String> {
    let state = state.inner().clone();
    run_blocking("Codex execution", move || {
        start_app_server_execution(
            &app,
            &state,
            &project_path,
            &model,
            &effort,
            &prompt,
            &requested_role,
            requested_worker_model.as_deref(),
        )
    })
    .await
}

#[tauri::command]
async fn steer_codex_execution(
    state: tauri::State<'_, AppServerState>,
    prompt: String,
) -> Result<Value, String> {
    let state = state.inner().clone();
    run_blocking("Codex steer", move || {
        steer_codex_execution_blocking(&state, prompt)
    })
    .await
}

fn steer_codex_execution_blocking(state: &AppServerState, prompt: String) -> Result<Value, String> {
    let prompt = valid_execution_prompt(&prompt)?;
    let (thread_id, turn_id) = {
        let guard = state
            .session
            .lock()
            .map_err(|_| "Codex execution state is unavailable".to_string())?;
        let Some(session) = guard.as_ref() else {
            return Err("No active Codex task".to_string());
        };
        (
            session.thread_id.clone(),
            session
                .turn_id
                .clone()
                .ok_or_else(|| "No active Codex turn".to_string())?,
        )
    };
    send_app_server_request(
        &state,
        "turn/steer",
        json!({"threadId": thread_id, "expectedTurnId": turn_id, "input":[{"type":"text","text":prompt}]}),
    )
}

#[tauri::command]
async fn interrupt_codex_execution(
    state: tauri::State<'_, AppServerState>,
) -> Result<Value, String> {
    let state = state.inner().clone();
    run_blocking("Codex interrupt", move || {
        interrupt_codex_execution_blocking(&state)
    })
    .await
}

fn interrupt_codex_execution_blocking(state: &AppServerState) -> Result<Value, String> {
    let (thread_id, turn_id) = {
        let guard = state
            .session
            .lock()
            .map_err(|_| "Codex execution state is unavailable".to_string())?;
        let Some(session) = guard.as_ref() else {
            return Err("No active Codex task".to_string());
        };
        (
            session.thread_id.clone(),
            session
                .turn_id
                .clone()
                .ok_or_else(|| "No active Codex turn".to_string())?,
        )
    };
    send_app_server_request(
        &state,
        "turn/interrupt",
        json!({"threadId": thread_id, "turnId": turn_id}),
    )
}

#[tauri::command]
async fn resolve_codex_approval(
    state: tauri::State<'_, AppServerState>,
    request_id: u64,
    decision: String,
) -> Result<Value, String> {
    let state = state.inner().clone();
    run_blocking("Codex approval", move || {
        resolve_codex_approval_blocking(&state, request_id, decision)
    })
    .await
}

fn resolve_codex_approval_blocking(
    state: &AppServerState,
    request_id: u64,
    decision: String,
) -> Result<Value, String> {
    if !matches!(
        decision.as_str(),
        "accept" | "acceptForSession" | "decline" | "cancel"
    ) {
        return Err("Approval decision is invalid".to_string());
    }
    let mut guard = state
        .session
        .lock()
        .map_err(|_| "Codex execution state is unavailable".to_string())?;
    let Some(session) = guard.as_mut() else {
        return Err("No active Codex task".to_string());
    };
    write_app_server_message(
        &mut session.stdin,
        &json!({"id":request_id,"result":{"decision":decision}}),
    )?;
    Ok(json!({"accepted":true,"requestId":request_id,"redacted":true}))
}

#[tauri::command]
async fn close_codex_execution(state: tauri::State<'_, AppServerState>) -> Result<Value, String> {
    let state = state.inner().clone();
    run_blocking("Codex close", move || {
        close_codex_execution_blocking(&state)
    })
    .await
}

fn close_codex_execution_blocking(state: &AppServerState) -> Result<Value, String> {
    let mut guard = state
        .session
        .lock()
        .map_err(|_| "Codex execution state is unavailable".to_string())?;
    if guard.take().is_some() {
        persist_log(
            "info",
            "codex-execution",
            "Codex execution session closed by user",
        );
        Ok(json!({"closed":true}))
    } else {
        Ok(json!({"closed":false}))
    }
}

fn redact(value: &str) -> String {
    let mut output = value.to_string();
    for marker in [
        "authorization",
        "api_key",
        "api-key",
        "access_token",
        "refresh_token",
        "capability_url",
    ] {
        let lower = output.to_lowercase();
        if let Some(start) = lower.find(marker) {
            let end = output[start..]
                .find('\n')
                .map(|offset| start + offset)
                .unwrap_or(output.len());
            let prefix_end = output[start..]
                .find('=')
                .or_else(|| output[start..].find(':'))
                .map(|offset| start + offset + 1)
                .unwrap_or(start + marker.len());
            if prefix_end < end {
                output.replace_range(prefix_end..end, " [REDACTED]");
            }
        }
    }
    output
}

fn provider(id: &str, name: &str, family: &str, credential: &str, enabled: bool) -> Value {
    let (billing_type, billing_note, base_url) = match id {
        "qwen-plan" => (
            "subscription",
            "Alibaba Model Studio Token Plan; credential value never read",
            Value::String("https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1".to_string()),
        ),
        "grok-oauth" => (
            "subscription",
            "SuperGrok via official Grok CLI OAuth; token value never read",
            Value::Null,
        ),
        "opencode-go" => (
            "subscription",
            "OpenCode Go subscription; Orchestra selects only Go models and never falls back to Zen/PAYG",
            Value::String("https://opencode.ai/zen/go/v1".to_string()),
        ),
        "kimi-api" | "grok-api" => (
            "payg",
            "Separately billed API key; value never read",
            Value::Null,
        ),
        "openai" => (
            "native",
            "Native Codex/ChatGPT auth; value never read",
            Value::Null,
        ),
        _ => (
            "unknown",
            "Credential status only; value never read",
            Value::Null,
        ),
    };
    json!({ "id": id, "name": name, "family": family, "credential": credential, "enabled": enabled, "billingType": billing_type, "billingNote": billing_note, "baseUrl": base_url })
}

fn agent(
    id: &str,
    name: &str,
    role: &str,
    description: &str,
    provider_id: &str,
    model_id: &str,
    effort: &str,
    health: &str,
    paths: &[&str],
    shared_paths: &[&str],
) -> Value {
    json!({
        "id": id,
        "name": name,
        "role": role,
        "description": description,
        "providerId": provider_id,
        "modelId": model_id,
        "reasoningEffort": effort,
        "permissions": if role == "root" { vec!["workspace-write", "delegation"] } else { vec!["workspace-write"] },
        "routingHints": if role == "frontend" { vec!["visual fidelity", "responsive", "a11y"] } else if role == "engineer" { vec!["contracts first", "tests", "bounded scope"] } else { vec!["keep architecture", "review every handoff"] },
        "retryLimit": 1,
        "ownershipPaths": paths,
        "sharedPaths": shared_paths,
        "health": health,
        "lastTest": if role == "root" { "native login status" } else { "live check pending" },
        "estimatedCostPerMillion": if matches!(provider_id, "grok-oauth" | "opencode-go" | "qwen-plan") { 0.0 } else if role == "frontend" { 15.0 } else if role == "engineer" { 6.0 } else { 0.0 }
    })
}

fn detect_codex() -> Value {
    let executable = find_codex();
    let version = executable.as_deref().and_then(codex_version);
    let native_models_available = version.is_some();
    let config_path = codex_home().join("config.toml");
    let config_detected = fs::metadata(&config_path)
        .map(|metadata| metadata.is_file())
        .unwrap_or(false);
    let login = executable
        .as_deref()
        .map(codex_login_status)
        .unwrap_or("unknown");
    json!({
        "detected": executable.is_some(),
        "executable": executable,
        "version": version,
        "home": codex_home().to_string_lossy(),
        "configPath": config_path.to_string_lossy(),
        "configDetected": config_detected,
        "configHealth": if config_detected { "healthy" } else { "unknown" },
        "login": login,
        "nativeModelsAvailable": native_models_available,
        "source": if executable.as_deref().is_some_and(|path| path.contains("WindowsApps")) { "windows-app" } else if executable.is_some() { "path" } else { "unknown" }
    })
}

fn port_is_open(port: u16) -> bool {
    let address = ("127.0.0.1", port)
        .to_socket_addrs()
        .ok()
        .and_then(|mut addresses| addresses.next());
    address
        .and_then(|address| TcpStream::connect_timeout(&address, Duration::from_millis(120)).ok())
        .is_some()
}

const ROUTER_IDENTITY_PORT: u16 = 4202;
const ROUTER_OBSERVED_PORTS: [u16; 4] = [4200, 4201, 4202, 4203];
const ROUTER_OFFLINE_MESSAGE: &str = "Router offline — Codex model requests may fail.";
const ROUTER_RESTARTED_MESSAGE: &str = "Router restarted successfully";

fn observed_router_ports() -> Vec<u16> {
    ROUTER_OBSERVED_PORTS
        .into_iter()
        .filter(|port| port_is_open(*port))
        .collect()
}

fn looks_like_router_connection_failure(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("10061")
        || lower.contains("econnrefused")
        || lower.contains("connection refused")
        || lower.contains("os error 10061")
        || lower.contains("reconnecting 5/5")
        || lower.contains("reconnecting 5 / 5")
}

fn read_http_identity(port: u16, path: &str, timeout: Duration) -> Result<String, String> {
    let address = ("127.0.0.1", port)
        .to_socket_addrs()
        .ok()
        .and_then(|mut addresses| addresses.next())
        .ok_or_else(|| "connection refused".to_string())?;
    let mut stream = TcpStream::connect_timeout(&address, timeout)
        .map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|error| error.to_string())?;
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| error.to_string())?;
    let mut body = String::new();
    stream
        .read_to_string(&mut body)
        .map_err(|error| error.to_string())?;
    Ok(body)
}

fn router_identity_ok() -> Result<bool, String> {
    let response = read_http_identity(
        ROUTER_IDENTITY_PORT,
        "/health",
        Duration::from_millis(250),
    )?;
    let payload = response
        .split("\r\n\r\n")
        .nth(1)
        .or_else(|| response.split("\n\n").nth(1))
        .unwrap_or(response.as_str());
    let parsed: Value = serde_json::from_str(payload.trim())
        .map_err(|_| "health response was not JSON".to_string())?;
    Ok(parsed.get("service").and_then(Value::as_str) == Some("codex-router"))
}

fn router_runtime_files_present(state: &Path) -> bool {
    [
        "start-codex-router-hidden.ps1",
        "start-codex-router.cmd",
        "start-codex-router-hidden.vbs",
        "install-manifest.json",
        "merged-models.json",
        "router.err.log",
        "router.out.log",
        "router.err",
        "router.out",
    ]
    .into_iter()
    .any(|name| state.join(name).is_file())
}

fn router_start_script(state: &Path) -> Option<PathBuf> {
    [
        "start-codex-router-hidden.ps1",
        "start-codex-router.cmd",
        "start-codex-router-hidden.vbs",
    ]
    .into_iter()
    .map(|name| state.join(name))
    .find(|path| path.is_file())
}

fn router_fallback_entrypoint() -> Option<PathBuf> {
    let entry = router_root().join("src").join("start.mjs");
    entry.is_file().then_some(entry)
}

fn router_logs_available(state: &Path) -> bool {
    ["router.err.log", "router.out.log", "router.err", "router.out"]
        .into_iter()
        .any(|name| state.join(name).is_file())
}

fn app_server_session_active(state: &AppServerState) -> bool {
    state
        .session
        .lock()
        .map(|guard| guard.is_some())
        .unwrap_or(false)
}

fn router_health_value(active_execution: bool) -> Value {
    let ports = observed_router_ports();
    let identity = router_identity_ok();
    let identity_ok = identity.as_ref().is_ok_and(|value| *value);
    let identity_error = identity.err();
    let runtime_present =
        router_runtime_files_present(&router_state_root()) || router_start_script(&router_state_root()).is_some();
    let service = if identity_ok || !ports.is_empty() {
        "running"
    } else if runtime_present || router_launcher().is_some() {
        "stopped"
    } else {
        "unknown"
    };
    let (issue, message, healthy) = if identity_ok {
        (Value::Null, "Router healthy".to_string(), true)
    } else if !runtime_present && router_launcher().is_none() && ports.is_empty() {
        (
            Value::String("missing-runtime".to_string()),
            "Managed Router runtime was not detected.".to_string(),
            false,
        )
    } else if identity_error
        .as_deref()
        .is_some_and(looks_like_router_connection_failure)
        || ports.is_empty()
    {
        (
            Value::String("connection-refused".to_string()),
            ROUTER_OFFLINE_MESSAGE.to_string(),
            false,
        )
    } else {
        (
            Value::String("unhealthy".to_string()),
            identity_error.unwrap_or_else(|| ROUTER_OFFLINE_MESSAGE.to_string()),
            false,
        )
    };
    json!({
        "ok": true,
        "detected": runtime_present || router_launcher().is_some() || !ports.is_empty(),
        "healthy": healthy,
        "service": service,
        "ports": ports,
        "identityOk": identity_ok,
        "issue": issue,
        "message": redact(&message),
        "canRestart": true,
        "requiresConfirmation": active_execution,
        "activeExecution": active_execution,
        "redacted": true
    })
}

fn router_runtime_status_value(active_execution: bool) -> Value {
    let health = router_health_value(active_execution);
    json!({
        "detected": health["detected"],
        "healthy": health["healthy"],
        "service": health["service"],
        "ports": health["ports"],
        "identityOk": health["identityOk"],
        "issue": health["issue"],
        "message": health["message"],
        "canRestart": health["canRestart"],
        "requiresConfirmation": health["requiresConfirmation"],
        "activeExecution": health["activeExecution"]
    })
}

fn apply_router_runtime(router: &mut Value, active_execution: bool) {
    let runtime = router_runtime_status_value(active_execution);
    let healthy = runtime["healthy"].as_bool().unwrap_or(false);
    let detected = router["detected"].as_bool().unwrap_or(false);
    router["ports"] = runtime["ports"].clone();
    router["service"] = runtime["service"].clone();
    router["health"] = Value::String(if !detected {
        "missing".to_string()
    } else if healthy {
        "healthy".to_string()
    } else {
        "unhealthy".to_string()
    });
    router["runtime"] = runtime;
}

fn persist_detected_router_runtime() {
    if let Ok(mut snapshot) = load_snapshot_state(base_snapshot_local(), false) {
        snapshot["router"] = detect_router();
        let _ = persist_runtime_facts(&snapshot);
    }
}

fn configure_router_process_env(command: &mut Command) {
    let state = router_state_root();
    let home = codex_home();
    command.env("MODEL_ROUTER_TARGET", "codex");
    command.env("MODEL_ROUTER_STATE_DIR", &state);
    command.env("MODEL_ROUTER_QUIET", "1");
    command.env("MODEL_ROUTER_GATEWAY_PORT", "4200");
    command.env("MODEL_ROUTER_OAUTH_PORT", "4201");
    command.env("MODEL_ROUTER_PORT", "4202");
    command.env("MODEL_ROUTER_API_PORT", "4203");
    command.env("CODEX_HOME", &home);
    command.env("CODEX_ROUTER_STATE_DIR", &state);
    command.env("CODEX_ROUTER_QUIET", "1");
    command.env("CODEX_ROUTER_GATEWAY_PORT", "4200");
    command.env("CODEX_ROUTER_OAUTH_PORT", "4201");
    command.env("CODEX_ROUTER_PORT", "4202");
    command.env("CODEX_ROUTER_API_PORT", "4203");
    command.env("PYTHONIOENCODING", "utf-8");
    command.env("PYTHONUTF8", "1");
}

fn spawn_router_process() -> Result<String, String> {
    let state = router_state_root();
    if let Some(script) = router_start_script(&state) {
        let extension = script
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let mut command = match extension.as_str() {
            "ps1" => {
                let mut command = Command::new("powershell.exe");
                command.args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-WindowStyle",
                    "Hidden",
                    "-File",
                ]);
                command.arg(&script);
                command
            }
            "cmd" => {
                let mut command = Command::new("cmd.exe");
                command.args(["/D", "/C"]);
                command.arg(&script);
                command
            }
            "vbs" => {
                let mut command = Command::new("wscript.exe");
                command.arg(&script);
                command
            }
            _ => {
                return Err("Unsupported Router start script".to_string());
            }
        };
        command.current_dir(&state);
        configure_router_process_env(&mut command);
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("Router process could not start: {error}"))?;
        return Ok("script".to_string());
    }

    let Some(entrypoint) = router_fallback_entrypoint() else {
        return Err("Managed Router start mechanism was not detected.".to_string());
    };
    let mut command = Command::new("node");
    command.arg(&entrypoint);
    command.current_dir(router_root());
    configure_router_process_env(&mut command);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Router process could not start: {error}"))?;
    Ok("entrypoint".to_string())
}

fn wait_for_router_health(timeout: Duration) -> Value {
    let deadline = Instant::now() + timeout;
    loop {
        let health = router_health_value(false);
        if health["healthy"].as_bool().unwrap_or(false) || Instant::now() >= deadline {
            return health;
        }
        thread::sleep(Duration::from_millis(300));
    }
}

fn recover_router_process(confirm: bool, active_execution: bool, force_restart: bool) -> Value {
    let health = router_health_value(active_execution);
    if active_execution && !confirm {
        return json!({
            "ok": false,
            "restarted": false,
            "phase": "failed",
            "message": "An active Codex run is in progress. Confirm before restarting the Router process.",
            "health": health,
            "logsAvailable": router_logs_available(&router_state_root()),
            "redacted": true,
            "issue": "active-execution"
        });
    }
    if health["healthy"].as_bool().unwrap_or(false) && !force_restart {
        return json!({
            "ok": true,
            "restarted": false,
            "phase": "healthy",
            "message": "Router healthy",
            "health": health,
            "logsAvailable": router_logs_available(&router_state_root()),
            "redacted": true
        });
    }
    if !confirm {
        return json!({
            "ok": false,
            "restarted": false,
            "phase": "failed",
            "message": "Router process recovery requires explicit confirmation",
            "health": health,
            "logsAvailable": router_logs_available(&router_state_root()),
            "redacted": true
        });
    }

    #[cfg(not(windows))]
    {
        if router_start_script(&router_state_root()).is_none() && router_fallback_entrypoint().is_none()
        {
            return json!({
                "ok": false,
                "restarted": false,
                "phase": "failed",
                "message": "Router process start is not implemented on this platform yet.",
                "health": health,
                "logsAvailable": router_logs_available(&router_state_root()),
                "redacted": true,
                "issue": "missing-runtime"
            });
        }
    }

    if let Err(error) = spawn_router_process() {
        let mut failed = router_health_value(active_execution);
        failed["message"] = Value::String(redact(&error));
        return json!({
            "ok": false,
            "restarted": false,
            "phase": "failed",
            "message": redact(&error),
            "health": failed,
            "logsAvailable": router_logs_available(&router_state_root()),
            "redacted": true
        });
    }

    let restored = wait_for_router_health(Duration::from_secs(10));
    let ok = restored["healthy"].as_bool().unwrap_or(false);
    if ok {
        persist_detected_router_runtime();
    }
    json!({
        "ok": ok,
        "restarted": true,
        "phase": if ok { "restored" } else { "failed" },
        "message": if ok {
            ROUTER_RESTARTED_MESSAGE.to_string()
        } else {
            restored["message"]
                .as_str()
                .unwrap_or(ROUTER_OFFLINE_MESSAGE)
                .to_string()
        },
        "health": restored,
        "logsAvailable": router_logs_available(&router_state_root()),
        "redacted": true
    })
}

fn last_nonempty_lines(text: &str, limit: usize) -> Vec<String> {
    text.lines()
        .map(str::trim_end)
        .filter(|line| !line.is_empty())
        .rev()
        .take(limit)
        .map(|line| redact(line))
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

fn router_logs_value() -> Value {
    let state = router_state_root();
    let mut lines = Vec::new();
    for (name, source) in [
        ("router.out.log", "router.out"),
        ("router.out", "router.out"),
        ("router.err.log", "router.err"),
        ("router.err", "router.err"),
    ] {
        let path = state.join(name);
        if let Ok(contents) = fs::read_to_string(&path) {
            for text in last_nonempty_lines(&contents, 20) {
                if text.len() > 400 {
                    continue;
                }
                lines.push(json!({
                    "source": source,
                    "text": redact_bounded(&text)
                }));
            }
        }
    }
    if lines.len() > 40 {
        lines = lines.split_off(lines.len() - 40);
    }
    json!({
        "ok": true,
        "available": !lines.is_empty(),
        "lines": lines,
        "message": if lines.is_empty() {
            "No Router process log lines were available."
        } else {
            "Latest redacted Router process lines."
        },
        "redacted": true
    })
}


fn router_version(root: &PathBuf) -> Option<String> {
    let package = fs::read_to_string(root.join("package.json")).ok()?;
    let parsed: Value = serde_json::from_str(&package).ok()?;
    parsed
        .get("version")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn detect_router() -> Value {
    let root = router_root();
    let detected = router_launcher().is_some() || root.join("package.json").is_file();
    let ports: Vec<u16> = observed_router_ports();
    let version = router_version(&root).or_else(|| detected.then(|| ROUTER_VERSION.to_string()));
    let version = if detected {
        version.clone().map_or(Value::Null, Value::String)
    } else {
        Value::Null
    };
    let pinned_ref = if detected {
        git_revision(&root)
            .map(Value::String)
            .unwrap_or_else(|| version.clone())
    } else {
        Value::Null
    };
    let mut router = json!({
        "detected": detected,
        "root": root.to_string_lossy(),
        "version": version,
        "pinnedRef": pinned_ref,
        "health": if !detected { "missing" } else if ports.is_empty() { "degraded" } else { "healthy" },
        "ports": ports,
        "service": if !detected { "unknown" } else if ports.is_empty() { "stopped" } else { "running" }
    });
    apply_router_runtime(&mut router, false);
    router
}

fn reviewed_update_plan(router: &Value) -> Value {
    let detected = router["detected"].as_bool().unwrap_or(false);
    let current_ref = router["pinnedRef"].as_str().map(ToOwned::to_owned);
    let root = router["root"]
        .as_str()
        .map(PathBuf::from)
        .filter(|path| path.is_dir());
    let rollback_ref = root
        .as_deref()
        .and_then(|path| git_ref(path, "refs/codex-orchestra/rollback"));
    let (status, notes) = if !detected {
        (
            "unknown",
            vec!["Managed Router checkout not detected; installation is required before update planning."],
        )
    } else if current_ref.as_deref() == Some(ROUTER_PINNED_COMMIT) {
        (
            "current",
            vec!["Already at the reviewed Router pin. Orchestra never promotes upstream main automatically."],
        )
    } else if current_ref.as_deref().is_some_and(|value| {
        value.len() == 40 && value.chars().all(|character| character.is_ascii_hexdigit())
    }) {
        (
            "available",
            vec!["A different managed revision is detected. Stage the reviewed pin with backup and health verification."],
        )
    } else {
        (
            "blocked",
            vec!["The managed Router revision cannot be identified. Review the checkout before any update."],
        )
    };
    json!({
        "currentRef": current_ref,
        "targetRef": ROUTER_PINNED_COMMIT,
        "targetVersion": ROUTER_VERSION,
        "targetTag": ROUTER_PINNED_TAG,
        "requiresBackup": true,
        "healthGate": true,
        "rollbackRef": rollback_ref,
        "status": status,
        "notes": notes
    })
}

fn detect_codex_local() -> Value {
    let executable = find_codex();
    let config_path = codex_home().join("config.toml");
    let config_detected = fs::metadata(&config_path)
        .map(|metadata| metadata.is_file())
        .unwrap_or(false);
    json!({
        "detected": executable.is_some(),
        "executable": executable.clone(),
        "version": Value::Null,
        "home": codex_home().to_string_lossy(),
        "configPath": config_path.to_string_lossy(),
        "configDetected": config_detected,
        "configHealth": if config_detected { "healthy" } else { "unknown" },
        "login": "unknown",
        "nativeModelsAvailable": executable.is_some(),
        "source": if executable.as_deref().is_some_and(|path| path.contains("WindowsApps")) {
            "windows-app"
        } else if executable.is_some() {
            "path"
        } else {
            "cached"
        }
    })
}

fn detect_router_local() -> Value {
    let root = router_root();
    let detected = router_launcher().is_some() || root.join("package.json").is_file();
    let version = router_version(&root);
    let mut router = json!({
        "detected": detected,
        "root": root.to_string_lossy(),
        "version": version,
        "pinnedRef": Value::Null,
        "health": if detected { "unknown" } else { "missing" },
        "ports": [],
        "service": "unknown"
    });
    apply_router_runtime(&mut router, false);
    router
}

fn local_update_plan(router: &Value) -> Value {
    json!({
        "currentRef": Value::Null,
        "targetRef": ROUTER_PINNED_COMMIT,
        "targetVersion": ROUTER_VERSION,
        "targetTag": ROUTER_PINNED_TAG,
        "requiresBackup": true,
        "healthGate": true,
        "rollbackRef": Value::Null,
        "status": if router["detected"].as_bool().unwrap_or(false) { "unknown" } else { "blocked" },
        "notes": ["Run checks to refresh the reviewed Router revision and update status."]
    })
}

fn base_snapshot() -> Value {
    let router = detect_router();
    let update = reviewed_update_plan(&router);
    assemble_base_snapshot(detect_codex(), router, update)
}

fn base_snapshot_local() -> Value {
    let router = detect_router_local();
    let update = local_update_plan(&router);
    assemble_base_snapshot(detect_codex_local(), router, update)
}

fn visible_codex_model_id(model_id: &str) -> bool {
    !model_id.trim().is_empty()
}

#[cfg(test)]
fn hidden_codex_model_ids(_catalog_ids: &[String]) -> Vec<String> {
    Vec::new()
}

fn is_safe_provider_id(provider: &str) -> bool {
    let bytes = provider.as_bytes();
    if bytes.len() < 2 || bytes.len() > 32 {
        return false;
    }
    if !bytes[0].is_ascii_lowercase() {
        return false;
    }
    if !bytes[1..]
        .iter()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
    {
        return false;
    }
    !matches!(provider, "openai" | "codex")
}

fn assemble_base_snapshot(codex: Value, router: Value, update: Value) -> Value {
    let snapshot = json!({
        "appVersion": "0.1.0",
        "codex": codex,
        "router": router,
        "providers": [
            provider("qwen-plan", "Qwen / Alibaba Token Plan", "other", "missing", true),
            provider("kimi-api", "Kimi Platform", "kimi", "missing", true),
            provider("opencode-go", "OpenCode Go / Kimi K3", "other", "missing", true),
            provider("grok-oauth", "Grok / SuperGrok OAuth", "xai", "missing", true),
            provider("grok-api", "xAI", "xai", "missing", true),
            provider("openai", "Codex native", "openai", "unknown", true)
        ],
        "models": [
            { "id": "gpt-5.6-sol", "label": "GPT-5.6 Sol", "providerId": "openai", "available": true, "supportsStreaming": true, "supportsTools": true, "supportsSubagents": true, "reasoningEfforts": ["low", "medium", "high", "xhigh", "max", "ultra"], "source": "native" },
            { "id": "gpt-5.6-luna", "label": "GPT-5.6 Luna", "providerId": "openai", "available": true, "supportsStreaming": true, "supportsTools": true, "supportsSubagents": true, "reasoningEfforts": ["low", "medium", "high", "xhigh", "max"], "source": "native" },
            { "id": "gpt-5.6-terra", "label": "GPT-5.6 Terra", "providerId": "openai", "available": true, "supportsStreaming": true, "supportsTools": true, "supportsSubagents": true, "reasoningEfforts": ["low", "medium", "high", "xhigh", "max", "ultra"], "source": "native" },
            { "id": "qwen-plan/qwen3.8-max", "label": "Qwen3.8 Max (Plan)", "providerId": "qwen-plan", "available": false, "supportsStreaming": true, "supportsTools": true, "supportsSubagents": false, "reasoningEfforts": ["high"], "source": "registry", "contextWindow": 262144, "autoCompactionThreshold": 235000, "upstreamModel": "qwen3.8-max" },
            { "id": "opencode-go/kimi-k3", "label": "Kimi K3 via OpenCode Go", "providerId": "opencode-go", "available": false, "supportsStreaming": true, "supportsTools": true, "supportsSubagents": false, "reasoningEfforts": ["high", "max"], "source": "registry", "upstreamModel": "kimi-k3" },
            { "id": "opencode-go/deepseek-v4-pro", "label": "DeepSeek V4 Pro via OpenCode Go", "providerId": "opencode-go", "available": false, "supportsStreaming": true, "supportsTools": true, "supportsSubagents": false, "reasoningEfforts": ["high", "max"], "source": "registry", "upstreamModel": "deepseek-v4-pro" },
            { "id": "opencode-go/deepseek-v4-flash", "label": "DeepSeek V4 Flash via OpenCode Go", "providerId": "opencode-go", "available": false, "supportsStreaming": true, "supportsTools": true, "supportsSubagents": false, "reasoningEfforts": ["low", "high", "max"], "source": "registry", "upstreamModel": "deepseek-v4-flash" },
            { "id": "opencode-go-messages/qwen3.8-max", "label": "Qwen3.8 Max (opencode Go)", "providerId": "opencode-go", "available": false, "supportsStreaming": true, "supportsTools": true, "supportsSubagents": false, "reasoningEfforts": ["high"], "source": "registry", "upstreamModel": "qwen3.8-max" },
            { "id": "grok-oauth/grok-4.6", "label": "Grok 4.6 OAuth", "providerId": "grok-oauth", "available": false, "supportsStreaming": true, "supportsTools": true, "supportsSubagents": false, "reasoningEfforts": ["high"], "source": "curated" }
        ],
        "agents": [
            agent("root", "Sol / Root", "root", "Tech lead, architect and final reviewer.", "openai", "gpt-5.6-sol", "max", "unknown", &["*"], &["package.json", "types/**"]),
            agent("frontend", "Frontend / Model binding", "frontend", "Logical frontend role resolved from the selected strategy.", "qwen-plan", "qwen-plan/qwen3.8-max", "high", "unknown", &["app/**", "src/**", "components/**", "styles/**"], &[]),
            agent("engineer", "Grok / Engineer", "engineer", "Backend, integration, debugging and test specialist.", "grok-oauth", "grok-oauth/grok-4.6", "high", "unknown", &["server/**", "api/**", "db/**", "tests/**"], &[])
        ],
        "frontendStrategy": { "mode": "pinned", "pinnedModel": { "provider": "qwen-plan", "upstreamModel": "qwen3.8-max" } },
        "projects": [], "usage": [],
        "budget": { "monthlyLimit": 40, "warningAtPercent": 70, "criticalAtPercent": 90, "currency": "USD" },
        "backups": [],
        "update": update,
        "diagnostics": []
    });
    snapshot
}

fn default_frontend_strategy() -> Value {
    json!({
        "mode": "pinned",
        "pinnedModel": { "provider": "qwen-plan", "upstreamModel": "qwen3.8-max" }
    })
}

fn command_output_with_timeout(mut command: Command, timeout: Duration) -> Result<Output, String> {
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Router process could not start: {error}"))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(mut stream) = stdout {
            let _ = stream.read_to_end(&mut bytes);
        }
        bytes
    });
    let stderr_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(mut stream) = stderr {
            let _ = stream.read_to_end(&mut bytes);
        }
        bytes
    });
    let deadline = Instant::now() + timeout;
    loop {
        match child
            .try_wait()
            .map_err(|error| format!("Router process status failed: {error}"))?
        {
            Some(status) => {
                let stdout = stdout_reader.join().unwrap_or_default();
                let stderr = stderr_reader.join().unwrap_or_default();
                return Ok(Output {
                    status,
                    stdout,
                    stderr,
                });
            }
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(format!(
                    "Router operation timed out after {} seconds",
                    timeout.as_secs()
                ));
            }
            None => thread::sleep(Duration::from_millis(50)),
        }
    }
}

fn redact_bounded(value: &str) -> String {
    let redacted = redact(value);
    let mut chars = redacted.chars();
    let bounded: String = chars.by_ref().take(16_000).collect();
    if chars.next().is_some() {
        format!("{bounded}\n[truncated]")
    } else {
        bounded
    }
}

fn run_router_script_with_timeout(
    script: &Path,
    args: &[String],
    operation: &str,
    timeout: Duration,
) -> Result<Value, String> {
    let mut command = Command::new("powershell.exe");
    command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-WindowStyle",
            "Hidden",
            "-File",
        ])
        .arg(script)
        .args(args);
    let output = match command_output_with_timeout(command, timeout) {
        Ok(output) => output,
        Err(error) => {
            persist_log("error", operation, &error);
            return Err(error);
        }
    };
    let result = json!({
        "ok": output.status.success(),
        "status": output.status.code().unwrap_or(-1),
        "operation": operation,
        "stdout": redact_bounded(&String::from_utf8_lossy(&output.stdout)),
        "stderr": redact_bounded(&String::from_utf8_lossy(&output.stderr))
    });
    if !result["ok"].as_bool().unwrap_or(false) {
        persist_log(
            "error",
            operation,
            &format!("Router operation exited with status {}", result["status"]),
        );
    }
    Ok(result)
}

fn run_router_script(script: &Path, args: &[&str], operation: &str) -> Result<Value, String> {
    let owned: Vec<String> = args.iter().map(|arg| (*arg).to_string()).collect();
    run_router_script_with_timeout(script, &owned, operation, Duration::from_secs(15))
}

fn router_args(operation: &str) -> Vec<&'static str> {
    match operation {
        "install" => vec!["codex", "install"],
        "doctor" => vec!["codex", "doctor"],
        "status" => vec!["codex", "status"],
        "providers" => vec!["codex", "providers"],
        // The upstream catalog is a file, not a Router command. This entry is
        // retained only as a logical operation for the adapter/tests.
        "models" => Vec::new(),
        "refresh-catalog" => vec!["codex", "refresh-catalog"],
        "update-check" => vec!["codex", "update", "check"],
        "update" => vec!["codex", "update"],
        "rollback" => vec!["codex", "rollback"],
        "support-bundle" => vec!["codex", "support-bundle"],
        _ => Vec::new(),
    }
}

fn router_args_for_script(operation: &str, target_wrapper: bool) -> Vec<&'static str> {
    let args = router_args(operation);
    if target_wrapper {
        args
    } else {
        args.into_iter().skip(1).collect()
    }
}

fn router_result_text(result: &Value) -> String {
    format!(
        "{}\n{}",
        result["stdout"].as_str().unwrap_or_default(),
        result["stderr"].as_str().unwrap_or_default()
    )
}

fn provider_matches_text(text: &str, provider_id: &str) -> bool {
    let lower = text.to_lowercase();
    let tokens: Vec<&str> = lower
        .split(|character: char| {
            !character.is_ascii_alphanumeric() && character != '-' && character != '_'
        })
        .filter(|token| !token.is_empty())
        .collect();
    if tokens.iter().any(|token| *token == provider_id) {
        return true;
    }
    match provider_id {
        "kimi-api" => tokens.contains(&"moonshot") && !tokens.contains(&"kimi-oauth"),
        "grok-oauth" => {
            tokens.contains(&"grok-oauth")
                || (tokens.contains(&"grok")
                    && (tokens.contains(&"oauth") || lower.contains("official cli")))
                    && !tokens.contains(&"grok-api")
        }
        "grok-api" => {
            (tokens.contains(&"grok-api") || tokens.contains(&"xai")) && !tokens.contains(&"oauth")
        }
        "opencode-go" => {
            tokens.contains(&"opencode-go")
                || (tokens.contains(&"opencode") && tokens.contains(&"go"))
        }
        _ => false,
    }
}

fn credential_status_from_text(text: &str) -> Option<&'static str> {
    let lower = text.to_lowercase();
    if lower.contains("expired") {
        Some("expired")
    } else if lower.contains("invalid")
        || lower.contains("unauthorized")
        || lower.contains("rejected")
        || lower.contains("401")
        || lower.contains("403")
    {
        Some("invalid")
    } else if lower.contains("missing")
        || lower.contains("not configured")
        || lower.contains("not set")
        || lower.contains("no key")
        || lower.contains("needs key")
        || lower.contains("setup needed")
        || lower.contains("unconfigured")
    {
        Some("missing")
    } else if lower.contains("configured")
        || lower.contains("authenticated")
        || lower.contains("connected")
        || lower.contains("ready")
        || lower.contains("valid")
    {
        Some("configured")
    } else {
        None
    }
}

fn provider_status_from_json(value: &Value, provider_id: &str, matched: bool) -> Option<String> {
    match value {
        Value::Object(object) => {
            let local_match = matched
                || ["id", "provider", "providerId", "name", "family"]
                    .iter()
                    .filter_map(|key| object.get(*key).and_then(Value::as_str))
                    .any(|candidate| provider_matches_text(candidate, provider_id));
            if local_match {
                if let Some(configured) = object.get("configured").and_then(Value::as_bool) {
                    return Some(if configured { "configured" } else { "missing" }.to_string());
                }
                for key in [
                    "credential",
                    "status",
                    "state",
                    "auth",
                    "authentication",
                    "detail",
                ] {
                    if let Some(status) = object
                        .get(key)
                        .and_then(Value::as_str)
                        .and_then(credential_status_from_text)
                    {
                        return Some(status.to_string());
                    }
                }
                if let Some(status) = object.get("status").and_then(Value::as_str) {
                    let normalized = status.to_lowercase();
                    if matches!(normalized.as_str(), "ok" | "pass" | "passed" | "healthy") {
                        return Some("configured".to_string());
                    }
                }
            }
            object
                .values()
                .find_map(|child| provider_status_from_json(child, provider_id, local_match))
        }
        Value::Array(items) => items
            .iter()
            .find_map(|child| provider_status_from_json(child, provider_id, matched)),
        _ => None,
    }
}

fn provider_status_from_result(result: &Value, provider_id: &str) -> Option<String> {
    let stdout = result["stdout"].as_str().unwrap_or_default();
    if let Ok(value) = serde_json::from_str::<Value>(stdout.trim()) {
        if let Some(status) = provider_status_from_json(&value, provider_id, false) {
            return Some(status);
        }
    }
    let result_text = router_result_text(result);
    // Router table rows look like "SHOW qwen-plan ready ...". Only the matched
    // row may decide status; neighboring "setup needed" rows used to leak.
    for line in result_text.lines() {
        if !provider_matches_text(line, provider_id) {
            continue;
        }
        if let Some(status) = credential_status_from_text(line) {
            return Some(status.to_string());
        }
    }
    None
}

fn provider_enabled_from_json(value: &Value, provider_id: &str, matched: bool) -> Option<bool> {
    match value {
        Value::Object(object) => {
            let local_match = matched
                || ["id", "provider", "providerId", "name", "family"]
                    .iter()
                    .filter_map(|key| object.get(*key).and_then(Value::as_str))
                    .any(|candidate| provider_matches_text(candidate, provider_id));
            if local_match {
                if let Some(enabled) = object.get("enabled").and_then(Value::as_bool) {
                    return Some(enabled);
                }
                if let Some(visible) = object.get("visible").and_then(Value::as_bool) {
                    return Some(visible);
                }
            }
            object
                .values()
                .find_map(|child| provider_enabled_from_json(child, provider_id, local_match))
        }
        Value::Array(items) => items
            .iter()
            .find_map(|child| provider_enabled_from_json(child, provider_id, matched)),
        _ => None,
    }
}

fn provider_enabled_from_result(result: &Value, provider_id: &str) -> Option<bool> {
    let stdout = result["stdout"].as_str().unwrap_or_default();
    serde_json::from_str::<Value>(stdout.trim())
        .ok()
        .and_then(|value| provider_enabled_from_json(&value, provider_id, false))
}

fn model_variants(model_id: &str) -> Vec<String> {
    let lower = model_id.to_lowercase();
    let short = lower
        .split_once('/')
        .map(|(_, value)| value.to_string())
        .unwrap_or_else(|| lower.clone());
    vec![lower, short]
}

fn model_is_listed(result: &Value, model_id: &str) -> Option<bool> {
    if !result["ok"].as_bool().unwrap_or(false) {
        return None;
    }
    if let Some(models) = result["models"].as_array() {
        let variants = model_variants(model_id);
        return Some(models.iter().filter_map(model_value_id).any(|candidate| {
            let candidate = candidate.to_lowercase();
            variants.iter().any(|variant| candidate == *variant)
        }));
    }
    let lower = router_result_text(result).to_lowercase();
    let variants = model_variants(model_id);
    Some(variants.iter().any(|variant| lower.contains(variant)))
}

fn model_value_id(value: &Value) -> Option<String> {
    value.as_str().map(ToOwned::to_owned).or_else(|| {
        ["id", "slug", "model"].iter().find_map(|key| {
            value
                .get(*key)
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
    })
}

fn catalog_model_ids(value: &Value) -> Vec<String> {
    let entries = value
        .get("models")
        .and_then(Value::as_array)
        .or_else(|| value.as_array());
    entries
        .into_iter()
        .flatten()
        .filter_map(model_value_id)
        .filter(|id| id.len() <= 160)
        .collect()
}

fn catalog_model_entries(value: &Value) -> Vec<Value> {
    let entries = value
        .get("models")
        .and_then(Value::as_array)
        .or_else(|| value.as_array());
    entries
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let id = model_value_id(entry)?;
            let mut safe = serde_json::Map::new();
            safe.insert("id".to_string(), Value::String(id));
            for key in [
                "label",
                "displayName",
                "providerId",
                "provider",
                "upstreamModel",
                "contextWindow",
                "autoCompact",
                "autoCompactionThreshold",
                "supportsStreaming",
                "supportsTools",
                "supportsSubagents",
                "reasoningEfforts",
                "reasoningLevels",
            ] {
                if let Some(value) = entry.get(key) {
                    if matches!(
                        value,
                        Value::String(_) | Value::Number(_) | Value::Bool(_) | Value::Array(_)
                    ) {
                        safe.insert(key.to_string(), value.clone());
                    }
                }
            }
            Some(Value::Object(safe))
        })
        .collect()
}

fn read_router_catalog_result() -> Option<Value> {
    let path = router_state_root().join("merged-models.json");
    let contents = fs::read_to_string(&path).ok()?;
    let parsed = serde_json::from_str::<Value>(&contents).ok()?;
    let mut models = catalog_model_entries(&parsed);
    models.sort_by(|left, right| left["id"].as_str().cmp(&right["id"].as_str()));
    models.dedup_by(|left, right| left["id"] == right["id"]);
    if models.is_empty() {
        return None;
    }
    let ids = catalog_model_ids(&parsed);
    Some(json!({
        "ok": true,
        "operation": "models",
        "source": "merged-catalog",
        "path": path.to_string_lossy(),
        "models": models,
        "stdout": serde_json::to_string(&ids).unwrap_or_else(|_| "[]".to_string()),
        "stderr": ""
    }))
}

fn catalog_entry_for_model(result: &Value, model_id: &str) -> Option<Value> {
    result
        .get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|entry| model_value_id(entry).as_deref() == Some(model_id))
        .cloned()
}

fn catalog_provider_id(value: &Value) -> Option<&str> {
    value
        .get("providerId")
        .or_else(|| value.get("provider"))
        .and_then(Value::as_str)
}

fn catalog_model_for_target(models: &[Value], provider: &str, upstream: &str) -> Option<String> {
    models
        .iter()
        .find(|model| {
            model["available"].as_bool() == Some(true)
                && model["providerId"].as_str() == Some(provider)
                && model["upstreamModel"].as_str() == Some(upstream)
        })
        .and_then(|model| model["id"].as_str())
        .map(ToOwned::to_owned)
        .or_else(|| {
            let expected = format!("{provider}/{upstream}");
            models
                .iter()
                .find(|model| {
                    model["available"].as_bool() == Some(true)
                        && model["providerId"].as_str() == Some(provider)
                        && model["id"].as_str() == Some(expected.as_str())
                })
                .and_then(|model| model["id"].as_str())
                .map(ToOwned::to_owned)
        })
}

fn frontend_target_for_strategy(
    strategy: &Value,
    models: &[Value],
) -> Option<(String, String, String)> {
    let candidates = [("qwen-plan", "qwen3.8-max"), ("opencode-go", "kimi-k3")];
    let selected = if strategy["mode"].as_str() == Some("auto") {
        candidates.iter().find_map(|(provider, upstream)| {
            catalog_model_for_target(models, provider, upstream)
                .map(|model| ((*provider).to_string(), (*upstream).to_string(), model))
        })
    } else {
        let provider = strategy["pinnedModel"]["provider"].as_str()?;
        let upstream = strategy["pinnedModel"]["upstreamModel"].as_str()?;
        catalog_model_for_target(models, provider, upstream)
            .map(|model| (provider.to_string(), upstream.to_string(), model))
    };
    selected
}

fn enrich_router_facts(snapshot: &mut Value) {
    if !snapshot["router"]["detected"].as_bool().unwrap_or(false) {
        return;
    }
    let doctor_result = router_readonly("doctor");
    let providers_result = router_readonly("providers");
    if let Some(providers) = snapshot["providers"].as_array_mut() {
        for provider in providers {
            let Some(provider_id) = provider["id"].as_str().map(ToOwned::to_owned) else {
                continue;
            };
            let status = providers_result
                .as_ref()
                .and_then(|result| provider_status_from_result(result, &provider_id))
                .or_else(|| {
                    doctor_result
                        .as_ref()
                        .and_then(|result| provider_status_from_result(result, &provider_id))
                });
            if let Some(status) = status {
                provider["credential"] = Value::String(status);
                provider["lastChecked"] = Value::String(now());
            }
            if let Some(enabled) = providers_result
                .as_ref()
                .and_then(|result| provider_enabled_from_result(result, &provider_id))
            {
                provider["enabled"] = Value::Bool(enabled);
            }
        }
    }
    if let Some(result) = router_readonly("models") {
        if let Some(models) = snapshot["models"].as_array_mut() {
            for model in models.iter_mut() {
                let Some(model_id) = model["id"].as_str().map(ToOwned::to_owned) else {
                    continue;
                };
                if let Some(available) = model_is_listed(&result, &model_id) {
                    model["available"] = Value::Bool(available);
                    if available && model["source"] == "registry" {
                        model["source"] = Value::String("curated".to_string());
                    }
                }
                if let Some(entry) = catalog_entry_for_model(&result, &model_id) {
                    for key in [
                        "contextWindow",
                        "autoCompact",
                        "autoCompactionThreshold",
                        "upstreamModel",
                    ] {
                        if let Some(value) = entry.get(key) {
                            if key == "autoCompact" {
                                model["autoCompactionThreshold"] = value.clone();
                            } else {
                                model[key] = value.clone();
                            }
                        }
                    }
                    if model["label"].as_str().is_none() {
                        if let Some(label) = entry
                            .get("displayName")
                            .or_else(|| entry.get("label"))
                            .and_then(Value::as_str)
                        {
                            model["label"] = Value::String(label.to_string());
                        }
                    }
                }
            }
            let existing_ids: HashSet<String> = models
                .iter()
                .filter_map(|model| model["id"].as_str().map(ToOwned::to_owned))
                .collect();
            for entry in catalog_model_entries(&result) {
                let Some(model_id) = model_value_id(&entry) else {
                    continue;
                };
                let Some(provider_id) = catalog_provider_id(&entry) else {
                    continue;
                };
                if existing_ids.contains(&model_id) || !visible_codex_model_id(&model_id) {
                    continue;
                }
                let upstream_model = entry["upstreamModel"]
                    .as_str()
                    .or_else(|| model_id.split_once('/').map(|(_, model)| model))
                    .unwrap_or_default();
                let label = entry
                    .get("displayName")
                    .or_else(|| entry.get("label"))
                    .and_then(Value::as_str)
                    .unwrap_or(match provider_id {
                        "qwen-plan" => "Qwen model via Alibaba Token Plan",
                        "grok-oauth" => "Grok 4.6 OAuth",
                        "grok-api" => "Grok 4.6",
                        _ => "OpenCode Go model",
                    });
                let mut model = json!({
                    "id": model_id,
                    "label": label,
                    "providerId": provider_id,
                    "available": true,
                    "supportsStreaming": true,
                    "supportsTools": entry["supportsTools"].as_bool().unwrap_or(false),
                    "supportsSubagents": entry["supportsSubagents"].as_bool().unwrap_or(false),
                    "reasoningEfforts": if provider_id == "qwen-plan" { json!(["high"]) } else { json!(["high", "max"]) },
                    "source": "curated",
                    "upstreamModel": upstream_model
                });
                if let Some(context_window) = entry.get("contextWindow") {
                    model["contextWindow"] = context_window.clone();
                }
                if let Some(auto_compact) = entry
                    .get("autoCompactionThreshold")
                    .or_else(|| entry.get("autoCompact"))
                {
                    model["autoCompactionThreshold"] = auto_compact.clone();
                }
                models.push(model);
            }
        }
    }
    let providers = snapshot["providers"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let models = snapshot["models"].as_array().cloned().unwrap_or_default();
    let codex_login = snapshot["codex"]["login"].as_str().map(ToOwned::to_owned);
    let frontend_strategy = snapshot["frontendStrategy"].clone();
    let frontend_target = frontend_target_for_strategy(&frontend_strategy, &models);
    if let Some(agents) = snapshot["agents"].as_array_mut() {
        for agent in agents {
            let Some(role) = agent["role"].as_str().map(ToOwned::to_owned) else {
                continue;
            };
            let resolved_model = match role.as_str() {
                "frontend" => frontend_target.as_ref().map(|(_, _, model)| model.as_str()),
                "engineer" if agent["providerId"] == "grok-oauth" => ["grok-oauth/grok-4.6"]
                    .iter()
                    .find(|candidate| {
                        models.iter().any(|model| {
                            model["id"].as_str() == Some(*candidate)
                                && model["available"].as_bool() == Some(true)
                        })
                    })
                    .copied(),
                "engineer" => ["grok-api/grok-4.6"]
                    .iter()
                    .find(|candidate| {
                        models.iter().any(|model| {
                            model["id"].as_str() == Some(*candidate)
                                && model["available"].as_bool() == Some(true)
                        })
                    })
                    .copied(),
                _ => None,
            };
            let resolved_model = resolved_model;
            if role == "frontend" {
                if let Some((provider, upstream, _)) = &frontend_target {
                    agent["providerId"] = Value::String(provider.clone());
                    agent["modelTarget"] =
                        json!({ "provider": provider, "upstreamModel": upstream });
                } else {
                    if let Some(target) = frontend_strategy["pinnedModel"].as_object() {
                        if let (Some(provider), Some(upstream)) = (
                            target.get("provider").and_then(Value::as_str),
                            target.get("upstreamModel").and_then(Value::as_str),
                        ) {
                            agent["providerId"] = Value::String(provider.to_string());
                            agent["modelTarget"] =
                                json!({ "provider": provider, "upstreamModel": upstream });
                        }
                    }
                    agent["modelId"] = Value::Null;
                }
            }
            if let Some(model_id) = resolved_model {
                agent["modelId"] = Value::String(model_id.to_string());
            }
            let health = if role == "root" {
                match codex_login.as_deref() {
                    Some("configured") => "healthy",
                    Some("missing") => "missing",
                    _ => "unknown",
                }
            } else {
                let credential = providers
                    .iter()
                    .find(|provider| provider["id"] == agent["providerId"])
                    .and_then(|provider| provider["credential"].as_str());
                let model_id = agent["modelId"].as_str().unwrap_or_default();
                let available = models
                    .iter()
                    .find(|model| model["id"].as_str() == Some(model_id))
                    .and_then(|model| model["available"].as_bool())
                    .unwrap_or(false);
                match (credential, available) {
                    (Some("invalid" | "expired"), _) => "unhealthy",
                    (Some("configured"), true) => "healthy",
                    (Some("missing"), _) | (_, false) => "missing",
                    _ => "unknown",
                }
            };
            agent["health"] = Value::String(health.to_string());
        }
    }
}

fn build_diagnostics(snapshot: &Value) -> Value {
    let codex_detected = snapshot["codex"]["detected"].as_bool().unwrap_or(false);
    let router_detected = snapshot["router"]["detected"].as_bool().unwrap_or(false);
    let router_health = snapshot["router"]["health"].as_str().unwrap_or("unknown");
    let providers = snapshot["providers"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let models = snapshot["models"].as_array().cloned().unwrap_or_default();
    let agents = snapshot["agents"].as_array().cloned().unwrap_or_default();
    let external_providers: Vec<&Value> = providers
        .iter()
        .filter(|provider| provider["id"].as_str() != Some("openai"))
        .collect();
    let external_provider_state = if external_providers.iter().any(|provider| {
        provider["id"].as_str() != Some("openai")
            && matches!(provider["credential"].as_str(), Some("invalid" | "expired"))
    }) {
        "unhealthy"
    } else if !external_providers.is_empty()
        && external_providers
            .iter()
            .all(|provider| provider["credential"].as_str() == Some("configured"))
    {
        "healthy"
    } else if external_providers
        .iter()
        .any(|provider| provider["credential"].as_str() == Some("unknown"))
    {
        "unknown"
    } else if external_providers
        .iter()
        .any(|provider| provider["credential"].as_str() == Some("configured"))
    {
        "degraded"
    } else if !router_detected {
        "missing"
    } else {
        "unknown"
    };
    let frontend = agents.iter().find(|agent| agent["role"] == "frontend");
    let engineer = agents.iter().find(|agent| agent["role"] == "engineer");
    let opencode_provider = providers
        .iter()
        .find(|provider| provider["id"] == "opencode-go");
    let opencode_model = frontend
        .and_then(|agent| agent["modelId"].as_str())
        .and_then(|model_id| {
            models
                .iter()
                .find(|model| model["id"].as_str() == Some(model_id))
        });
    let model_status = |agent: Option<&Value>| {
        if agent.and_then(|value| value["health"].as_str()) == Some("healthy") {
            "healthy"
        } else if agent.is_some() {
            "missing"
        } else {
            "unknown"
        }
    };
    let available_models = models
        .iter()
        .filter(|model| model["available"].as_bool() == Some(true))
        .filter_map(|model| model["id"].as_str())
        .collect::<Vec<_>>();
    json!([
        {
            "id": "codex",
            "category": "codex",
            "label": "Codex executable",
            "status": if codex_detected { "healthy" } else { "missing" },
            "value": snapshot["codex"]["version"].as_str().unwrap_or("not detected"),
            "detail": "Read-only executable and login detection; credentials are never read by Orchestra.",
            "redacted": true
        },
        {
            "id": "router",
            "category": "router",
            "label": "Router engine",
            "status": if !router_detected { "missing" } else { router_health },
            "value": snapshot["router"]["pinnedRef"].as_str().unwrap_or("not pinned"),
            "detail": "Wrapper commands are allow-listed and output is bounded/redacted.",
            "redacted": true
        },
        {
            "id": "provider-state",
            "category": "provider",
            "label": "Provider credentials",
            "status": external_provider_state,
            "value": providers.iter().filter(|provider| provider["id"].as_str() != Some("openai")).map(|provider| provider["credential"].as_str().unwrap_or("unknown")).collect::<Vec<_>>().join(", "),
            "detail": "Only configured/missing/invalid/expired state is consumed from Router diagnostics.",
            "redacted": true
        },
        {
            "id": "opencode-go",
            "category": "provider",
            "label": "OpenCode Go credential",
            "status": match opencode_provider.and_then(|provider| provider["credential"].as_str()) {
                Some("configured") => "healthy",
                Some("invalid" | "expired") => "unhealthy",
                Some("missing") => "missing",
                _ => "unknown"
            },
            "value": format!("opencode-go · {}", opencode_provider.and_then(|provider| provider["baseUrl"].as_str()).unwrap_or("base URL unknown")),
            "detail": "OpenCode Go binding only. Orchestra never selects Zen/PAYG fallback or reads the key.",
            "redacted": true
        },
        {
            "id": "frontend-model",
            "category": "model",
            "label": "Frontend binding",
            "status": model_status(frontend),
            "value": frontend.and_then(|agent| agent["modelId"].as_str()).unwrap_or("unresolved"),
            "detail": "Resolved against the current merged catalog; curation remains explicit.",
            "redacted": true
        },
        {
            "id": "opencode-go-model",
            "category": "model",
            "label": "OpenCode Go model metadata",
            "status": if opencode_model.is_some_and(|model| model["available"].as_bool() == Some(true)) { "healthy" } else { "missing" },
            "value": format!("{} · upstream {} · context {}", frontend.and_then(|agent| agent["modelId"].as_str()).unwrap_or("unresolved"), opencode_model.and_then(|model| model["upstreamModel"].as_str()).unwrap_or("catalog pending"), opencode_model.and_then(|model| model["contextWindow"].as_u64()).map(|value| value.to_string()).unwrap_or_else(|| "catalog pending".to_string())),
            "detail": "Resolved slug and context window come from the current Router catalog; no 1M claim is hardcoded.",
            "redacted": true
        },
        {
            "id": "engineer-model",
            "category": "model",
            "label": "Engineer binding",
            "status": model_status(engineer),
            "value": engineer.and_then(|agent| agent["modelId"].as_str()).unwrap_or("unresolved"),
            "detail": "Grok 4.6 is the only supported engineer model in this profile.",
            "redacted": true
        },
        {
            "id": "agents",
            "category": "agent",
            "label": "Agent capability",
            "status": "unknown",
            "value": "live check pending",
            "detail": "Catalog support is not proof of tool-driven agent behavior; live evaluation is opt-in.",
            "redacted": true
        },
        {
            "id": "tool-calling",
            "category": "agent",
            "label": "Tool calling",
            "status": "unknown",
            "value": "live check pending",
            "detail": "Requires an explicit paid compatibility run; model metadata alone is insufficient.",
            "redacted": true
        },
        {
            "id": "compaction",
            "category": "agent",
            "label": "Compaction / replay",
            "status": "unknown",
            "value": "not executed",
            "detail": "Router owns compaction; Orchestra records only a redacted capability result when tested.",
            "redacted": true
        },
        {
            "id": "agent-definitions",
            "category": "agent",
            "label": "Generated agent definitions",
            "status": if agents.len() >= 3 { "healthy" } else { "missing" },
            "value": format!("{} role definitions", agents.len()),
            "detail": "Definitions are generated into allow-listed project paths after preview and confirmation.",
            "redacted": true
        },
        {
            "id": "ports",
            "category": "network",
            "label": "Router loopback",
            "status": if !router_detected {
                "missing"
            } else if snapshot["router"]["ports"].as_array().is_some_and(|ports| !ports.is_empty()) {
                "healthy"
            } else {
                "unhealthy"
            },
            "value": snapshot["router"]["ports"].as_array().map(|ports| ports.iter().filter_map(Value::as_u64).map(|port| port.to_string()).collect::<Vec<_>>().join(", ")).unwrap_or_else(|| "none".to_string()),
            "detail": "Expected local ports only; Orchestra does not infer LAN exposure from a process alone.",
            "redacted": true
        },
        {
            "id": "process",
            "category": "process",
            "label": "Router process",
            "status": if router_detected { router_health } else { "missing" },
            "value": format!("{} · {} port(s)", snapshot["router"]["service"].as_str().unwrap_or("unknown"), snapshot["router"]["ports"].as_array().map(|ports| ports.len()).unwrap_or(0)),
            "detail": "Process state is observed through bounded loopback checks; no global watcher is installed.",
            "redacted": true
        },
        {
            "id": "config",
            "category": "config",
            "label": "Local config state",
            "status": "healthy",
            "value": "SQLite + managed project files",
            "detail": "State is local; writes use managed markers, backups and atomic replacement.",
            "redacted": true
        },
        {
            "id": "codex-config",
            "category": "config",
            "label": "Native Codex config",
            "status": snapshot["codex"]["configHealth"].as_str().unwrap_or("unknown"),
            "value": if snapshot["codex"]["configDetected"].as_bool().unwrap_or(false) { "present" } else { "not present" },
            "detail": "Only CODEX_HOME/config.toml file metadata is checked; its contents and credential-shaped values are never consumed.",
            "redacted": true
        },
        {
            "id": "catalog",
            "category": "model",
            "label": "Curated catalog",
            "status": if available_models.is_empty() { "missing" } else { "healthy" },
            "value": format!("{} available model(s)", available_models.len()),
            "detail": "Identifiers only; merged-models.json contents are never copied into support output beyond model IDs.",
            "redacted": true
        }
    ])
}

fn router_readonly(operation: &str) -> Option<Value> {
    if !["doctor", "status", "providers", "models"].contains(&operation) {
        return None;
    }
    if operation == "models" {
        return read_router_catalog_result();
    }
    let (script, target_wrapper) = router_launcher()?;
    let args = router_args_for_script(operation, target_wrapper);
    run_router_script(&script, &args, operation).ok()
}

fn create_router_backup_manifest() -> Result<Option<PathBuf>, String> {
    let root = router_root();
    if !root.exists() {
        return Ok(None);
    }
    let backups = data_root().join("backups");
    fs::create_dir_all(&backups)
        .map_err(|error| format!("Router backup directory failed: {error}"))?;
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let manifest = backups.join(format!("router-before-update-{nanos}.json"));
    let current_ref = Command::new("git")
        .args(["-C"])
        .arg(&root)
        .args(["rev-parse", "HEAD"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|value| !value.is_empty());
    let payload = json!({
        "createdAt": now(),
        "root": root,
        "currentRef": current_ref,
        "version": router_version(&router_root()),
        "rollback": "Use the Router rollback operation; this manifest contains no credentials."
    });
    atomic_write_file(&manifest, &payload.to_string())?;
    Ok(Some(manifest))
}

fn router_has_tracked_changes(root: &Path) -> Result<bool, String> {
    let output = git_in(root, &["status", "--porcelain", "--untracked-files=no"])?;
    if !output.status.success() {
        return Err(git_failure("status", &output));
    }
    Ok(!String::from_utf8_lossy(&output.stdout).trim().is_empty())
}

fn git_checkout_detached(root: &Path, reference: &str) -> Result<(), String> {
    let output = git_in(root, &["checkout", "--detach", reference])?;
    if !output.status.success() {
        return Err(git_failure("checkout", &output));
    }
    Ok(())
}

fn set_orchestra_rollback_ref(root: &Path, revision: &str) -> Result<(), String> {
    let output = git_in(
        root,
        &["update-ref", "refs/codex-orchestra/rollback", revision],
    )?;
    if !output.status.success() {
        return Err(git_failure("rollback reference", &output));
    }
    Ok(())
}

fn run_router_install_and_doctor() -> Result<(Value, Value), String> {
    let (script, target_wrapper) =
        router_launcher().ok_or_else(|| "Managed Router checkout was not detected".to_string())?;
    let install_args = router_args_for_script("install", target_wrapper);
    let install = run_router_script(&script, &install_args, "install")?;
    if !install["ok"].as_bool().unwrap_or(false) {
        return Ok((install, json!({ "ok": false, "skipped": "install failed" })));
    }
    let doctor_args = router_args_for_script("doctor", target_wrapper);
    let doctor = run_router_script(&script, &doctor_args, "doctor")?;
    Ok((install, doctor))
}

fn restore_router_source(root: &Path, revision: &str) -> Value {
    let source = git_checkout_detached(root, revision)
        .map(|_| json!({ "ok": true }))
        .unwrap_or_else(|error| json!({ "ok": false, "error": error }));
    if source["ok"].as_bool() != Some(true) {
        return json!({ "source": source, "install": { "ok": false, "skipped": "source restore failed" } });
    }
    match run_router_install_and_doctor() {
        Ok((install, doctor)) => json!({ "source": source, "install": install, "doctor": doctor }),
        Err(error) => json!({ "source": source, "install": { "ok": false, "error": error } }),
    }
}

fn promote_router_to_reviewed_pin() -> Result<Value, String> {
    if !router_destination_is_managed() {
        return Err("Router destination is not the managed Orchestra directory".to_string());
    }
    let root = router_root();
    if router_launcher().is_none() {
        return Err("Managed Router checkout was not detected".to_string());
    }
    let current = git_revision(&root)
        .ok_or_else(|| "Managed Router revision could not be identified".to_string())?;
    if current == ROUTER_PINNED_COMMIT {
        return Ok(json!({
            "ok": true,
            "operation": "update",
            "status": "current",
            "currentRef": current,
            "targetRef": ROUTER_PINNED_COMMIT,
            "message": "Managed Router already matches the reviewed pin; no update was applied."
        }));
    }
    if router_has_tracked_changes(&root)? {
        return Err(
            "Managed Router has tracked local edits; update is blocked to preserve them"
                .to_string(),
        );
    }
    let backup_manifest = create_router_backup_manifest()?;
    set_orchestra_rollback_ref(&root, &current)?;
    let fetch = git_in(&root, &pinned_router_fetch_args())?;
    if !fetch.status.success() {
        return Err(git_failure("reviewed pin fetch", &fetch));
    }
    if let Err(error) = git_checkout_detached(&root, "FETCH_HEAD") {
        return Err(error);
    }
    if git_revision(&root).as_deref() != Some(ROUTER_PINNED_COMMIT) {
        let recovery = restore_router_source(&root, &current);
        return Ok(json!({
            "ok": false,
            "operation": "update",
            "phase": "pin-verification",
            "backupManifest": backup_manifest,
            "recovery": recovery
        }));
    }
    let (install, doctor) = match run_router_install_and_doctor() {
        Ok(result) => result,
        Err(error) => {
            let recovery = restore_router_source(&root, &current);
            return Ok(json!({
                "ok": false,
                "operation": "update",
                "phase": "promotion",
                "backupManifest": backup_manifest,
                "error": error,
                "recovery": recovery
            }));
        }
    };
    if !install["ok"].as_bool().unwrap_or(false) || !doctor["ok"].as_bool().unwrap_or(false) {
        let recovery = restore_router_source(&root, &current);
        return Ok(json!({
            "ok": false,
            "operation": "update",
            "phase": if install["ok"].as_bool().unwrap_or(false) { "health-gate" } else { "promotion" },
            "backupManifest": backup_manifest,
            "install": install,
            "doctor": doctor,
            "recovery": recovery
        }));
    }
    Ok(json!({
        "ok": true,
        "operation": "update",
        "phase": "health-gate",
        "backupManifest": backup_manifest,
        "previousRef": current,
        "currentRef": ROUTER_PINNED_COMMIT,
        "rollbackRef": "refs/codex-orchestra/rollback",
        "install": install,
        "doctor": doctor
    }))
}

fn rollback_router_to_orchestra_ref() -> Result<Value, String> {
    if !router_destination_is_managed() {
        return Err("Router destination is not the managed Orchestra directory".to_string());
    }
    let root = router_root();
    if router_launcher().is_none() {
        return Err("Managed Router checkout was not detected".to_string());
    }
    if router_has_tracked_changes(&root)? {
        return Err(
            "Managed Router has tracked local edits; rollback is blocked to preserve them"
                .to_string(),
        );
    }
    let current = git_revision(&root)
        .ok_or_else(|| "Managed Router revision could not be identified".to_string())?;
    let rollback = git_ref(&root, "refs/codex-orchestra/rollback").ok_or_else(|| {
        "No Orchestra rollback reference is available for this managed checkout".to_string()
    })?;
    if current == rollback {
        return Ok(json!({
            "ok": true,
            "operation": "rollback",
            "status": "current",
            "currentRef": current,
            "message": "Managed Router already matches the available Orchestra rollback reference."
        }));
    }
    let backup_manifest = create_router_backup_manifest()?;
    if let Err(error) = git_checkout_detached(&root, &rollback) {
        return Err(error);
    }
    let (install, doctor) = match run_router_install_and_doctor() {
        Ok(result) => result,
        Err(error) => {
            let recovery = restore_router_source(&root, &current);
            return Ok(json!({
                "ok": false,
                "operation": "rollback",
                "phase": "promotion",
                "backupManifest": backup_manifest,
                "error": error,
                "recovery": recovery
            }));
        }
    };
    if !install["ok"].as_bool().unwrap_or(false) || !doctor["ok"].as_bool().unwrap_or(false) {
        let recovery = restore_router_source(&root, &current);
        return Ok(json!({
            "ok": false,
            "operation": "rollback",
            "phase": if install["ok"].as_bool().unwrap_or(false) { "health-gate" } else { "promotion" },
            "backupManifest": backup_manifest,
            "install": install,
            "doctor": doctor,
            "recovery": recovery
        }));
    }
    set_orchestra_rollback_ref(&root, &current)?;
    Ok(json!({
        "ok": true,
        "operation": "rollback",
        "phase": "health-gate",
        "backupManifest": backup_manifest,
        "previousRef": current,
        "currentRef": rollback,
        "rollbackRef": "refs/codex-orchestra/rollback",
        "install": install,
        "doctor": doctor
    }))
}

fn router_command(operation: &str, confirm: bool) -> Result<Value, String> {
    let allowed = [
        "doctor",
        "status",
        "providers",
        "models",
        "refresh-catalog",
        "update-check",
        "update",
        "rollback",
        "support-bundle",
    ];
    if !allowed.contains(&operation) {
        return Err("Unsupported Router operation".to_string());
    }
    if ["refresh-catalog", "update", "rollback", "support-bundle"].contains(&operation) && !confirm
    {
        return Err("Mutation requires explicit confirmation".to_string());
    }
    if operation == "update-check" {
        return Ok(reviewed_update_plan(&detect_router()));
    }
    if operation == "update" {
        return promote_router_to_reviewed_pin();
    }
    if operation == "rollback" {
        return rollback_router_to_orchestra_ref();
    }
    if operation == "refresh-catalog" {
        let refresh = {
            let Some((script, target_wrapper)) = router_launcher() else {
                return Ok(json!({
                    "ok": false,
                    "status": "missing",
                    "operation": operation,
                    "detail": "Managed Router checkout was not detected."
                }));
            };
            let args = router_args_for_script(operation, target_wrapper);
            run_router_script(&script, &args, operation)?
        };
        return Ok(json!({
            "ok": refresh["ok"].as_bool().unwrap_or(false),
            "operation": operation,
            "refresh": refresh
        }));
    }
    if operation == "models" {
        return Ok(read_router_catalog_result().unwrap_or_else(|| {
            json!({
                "ok": false,
                "status": "missing",
                "operation": "models",
                "detail": "Router merged-models.json was not detected."
            })
        }));
    }
    let Some((script, target_wrapper)) = router_launcher() else {
        return Ok(
            json!({ "ok": false, "status": "missing", "operation": operation, "detail": "Managed Router checkout was not detected." }),
        );
    };
    let args = router_args_for_script(operation, target_wrapper);
    run_router_script(&script, &args, operation)
}

fn allowed_provider(provider: &str) -> bool {
    is_safe_provider_id(provider)
}

fn provider_toggle_args(provider: &str, enabled: bool, target_wrapper: bool) -> Vec<String> {
    let logical_args = vec![
        "codex".to_string(),
        "providers".to_string(),
        if enabled { "enable" } else { "disable" }.to_string(),
        provider.to_string(),
    ];
    if target_wrapper {
        logical_args
    } else {
        logical_args.into_iter().skip(1).collect()
    }
}

fn router_destination_is_managed() -> bool {
    let expected = data_root().join("engine").join("codex-router");
    router_root() == expected
}

fn pinned_router_fetch_args() -> [&'static str; 5] {
    ["fetch", "--depth", "1", "origin", ROUTER_PINNED_COMMIT]
}

fn pinned_router_checkout_args() -> [&'static str; 3] {
    ["checkout", "--detach", "FETCH_HEAD"]
}

fn git_in(root: &Path, args: &[&str]) -> Result<Output, String> {
    Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .map_err(|error| format!("Git could not start: {error}"))
}

fn git_failure(action: &str, output: &Output) -> String {
    let stderr = redact_bounded(&String::from_utf8_lossy(&output.stderr));
    if stderr.trim().is_empty() {
        format!("Git {action} failed with status {}", output.status)
    } else {
        format!("Git {action} failed: {stderr}")
    }
}

fn spawn_visible(mut command: Command) -> Result<(), String> {
    #[cfg(windows)]
    command.creation_flags(CREATE_NEW_CONSOLE);
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Interactive process could not open: {error}"))
}

#[tauri::command]
async fn install_router(confirm: bool) -> Result<Value, String> {
    run_blocking("Router installation", move || {
        install_router_blocking(confirm)
    })
    .await
}


fn orchestra_overlay_script() -> Option<std::path::PathBuf> {
    let mut cursor = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for _ in 0..8 {
        // A future desktop build must ship the same overlay the plugin package
        // carries, so resolve the packaged path before the monorepo fallback.
        let packaged = cursor
            .join("plugins")
            .join("codex-orchestra")
            .join("scripts")
            .join("router-overlay")
            .join("apply.mjs");
        if packaged.is_file() {
            return Some(packaged);
        }
        let candidate = cursor.join("engine").join("overlays").join("apply.mjs");
        if candidate.is_file() {
            return Some(candidate);
        }
        if !cursor.pop() {
            break;
        }
    }
    None
}

fn apply_router_overlay(checkout: &Path) -> Value {
    let Some(script) = orchestra_overlay_script() else {
        return json!({
            "ok": false,
            "status": "no-overlay",
            "detail": "plugins/codex-orchestra/scripts/router-overlay/apply.mjs was not found."
        });
    };
    if !checkout.join("src").is_dir() {
        return json!({
            "ok": false,
            "status": "missing-src",
            "detail": "Managed Router src/ directory was not detected."
        });
    }
    let mut command = Command::new("node");
    command.arg(&script).arg(checkout);
    match command_output_with_timeout(command, Duration::from_secs(60)) {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let parsed = serde_json::from_str::<Value>(&stdout).unwrap_or(json!({ "raw": redact(&stdout) }));
            json!({ "ok": true, "status": "applied", "checkout": checkout, "result": parsed })
        }
        Ok(output) => json!({
            "ok": false,
            "status": "failed",
            "detail": redact(&String::from_utf8_lossy(&output.stderr))
        }),
        Err(error) => json!({ "ok": false, "status": "failed", "detail": error }),
    }
}

fn install_router_blocking(confirm: bool) -> Result<Value, String> {
    if !confirm {
        return Err("Router installation requires explicit confirmation".to_string());
    }
    if !router_destination_is_managed() {
        return Err("Router destination is not the managed Orchestra directory".to_string());
    }
    let root = router_root();
    if router_launcher().is_some() {
        let overlay = apply_router_overlay(&root);
        return Ok(json!({
            "ok": true,
            "status": "already-detected",
            "root": root,
            "overlay": overlay,
            "pinnedBy": git_revision(&root).or_else(|| router_version(&root)).unwrap_or_else(|| ROUTER_VERSION.to_string())
        }));
    }
    if root.exists() {
        return Err(
            "The managed Router destination already exists without a recognized checkout; review it manually before installation."
                .to_string(),
        );
    }
    let parent = root
        .parent()
        .ok_or_else(|| "Router destination has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("Router directory failed: {error}"))?;
    let output = Command::new("git")
        .args(["init"])
        .arg(&root)
        .output()
        .map_err(|error| format!("Router initialization could not start: {error}"))?;
    if !output.status.success() {
        let _ = fs::remove_dir_all(&root);
        return Ok(json!({
            "ok": false,
            "status": output.status.code().unwrap_or(-1),
            "stderr": redact(&String::from_utf8_lossy(&output.stderr)),
            "stdout": redact(&String::from_utf8_lossy(&output.stdout))
        }));
    }
    let remote = git_in(&root, &["remote", "add", "origin", ROUTER_REPOSITORY])?;
    if !remote.status.success() {
        let failure = git_failure("remote setup", &remote);
        let _ = fs::remove_dir_all(&root);
        return Err(failure);
    }
    let fetch_args = pinned_router_fetch_args();
    let fetch = git_in(&root, &fetch_args)?;
    if !fetch.status.success() {
        let failure = git_failure("pinned revision fetch", &fetch);
        let _ = fs::remove_dir_all(&root);
        return Err(failure);
    }
    let checkout_args = pinned_router_checkout_args();
    let checkout = git_in(&root, &checkout_args)?;
    if !checkout.status.success() {
        let failure = git_failure("pinned revision checkout", &checkout);
        let _ = fs::remove_dir_all(&root);
        return Err(failure);
    }
    if router_launcher().is_none() {
        let _ = fs::remove_dir_all(&root);
        return Err("Cloned checkout does not contain a recognized Router wrapper".to_string());
    }
    let commit = git_revision(&root);
    if commit.as_deref() != Some(ROUTER_PINNED_COMMIT) {
        let _ = fs::remove_dir_all(&root);
        return Err(format!(
            "Router checkout resolved to an unexpected commit; expected {ROUTER_PINNED_COMMIT}"
        ));
    }
    let overlay = apply_router_overlay(&root);
    Ok(json!({
        "ok": true,
        "status": "installed",
        "root": root,
        "overlay": overlay,
        "pinnedCommit": commit,
        "pinnedBy": "verified signed release commit",
        "pinnedTag": ROUTER_PINNED_TAG,
        "next": "Open guided Router setup; Orchestra never receives provider credentials."
    }))
}

#[tauri::command]
async fn open_router_setup() -> Result<Value, String> {
    run_blocking("Router setup", open_router_setup_blocking).await
}

fn open_router_setup_blocking() -> Result<Value, String> {
    let script = router_root().join("install.ps1");
    if !script.exists() {
        return Err("Managed Router checkout was not detected".to_string());
    }
    let mut command = Command::new("powershell.exe");
    command
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&script)
        .args(["-Target", "codex", "-Guided"]);
    spawn_visible(command)
        .map_err(|error| format!("Router guided setup could not open: {error}"))?;
    Ok(json!({
        "ok": true,
        "interactive": true,
        "credentialValuesReadByOrchestra": false
    }))
}

#[tauri::command]
async fn open_provider_helper(provider: String) -> Result<Value, String> {
    run_blocking("provider helper", move || {
        open_provider_helper_blocking(provider)
    })
    .await
}

fn open_provider_helper_blocking(provider: String) -> Result<Value, String> {
    if !allowed_provider(&provider) {
        return Err("Provider helper is not available for this provider".to_string());
    }
    // Credential setup is an allow-listed Router helper and does not promote
    // or mutate the checkout. Keep the reviewed pin as the update/rollback
    // gate, but do not strand an existing managed checkout whose wrapper
    // already supports `provider-key`.
    if provider == "grok-oauth" {
        let executable = find_grok_cli().ok_or_else(|| {
            "Official Grok CLI was not found. Install it with `npm install -g @xai-official/grok`, then try OAuth again.".to_string()
        })?;
        #[cfg(windows)]
        let command = {
            let quoted = executable.replace('\'', "''");
            let mut command = Command::new("powershell.exe");
            command.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"]);
            command.arg(format!("& '{}' login --oauth", quoted));
            command
        };
        #[cfg(not(windows))]
        let mut command = {
            let mut command = Command::new(executable);
            command.args(["login", "--oauth"]);
            command
        };
        spawn_visible(command)
            .map_err(|error| format!("Grok OAuth login could not open: {error}"))?;
        return Ok(json!({
            "ok": true,
            "provider": provider,
            "interactive": true,
            "command": "grok login --oauth",
            "credentialValuesReadByOrchestra": false,
            "next": "Finish the browser login in the opened terminal, then refresh the Router catalog."
        }));
    }
    let Some((script, target_wrapper)) = router_launcher() else {
        return Err("Managed Router checkout was not detected".to_string());
    };
    let mut command = Command::new("powershell.exe");
    command
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&script)
        .args(if target_wrapper {
            vec!["codex", "provider-key", provider.as_str(), "set"]
        } else {
            vec!["provider-key", provider.as_str(), "set"]
        });
    spawn_visible(command).map_err(|error| format!("Provider helper could not open: {error}"))?;
    Ok(json!({
        "ok": true,
        "provider": provider,
        "interactive": true,
        "credentialValuesReadByOrchestra": false
    }))
}

#[tauri::command]
async fn set_provider_enabled(
    provider: String,
    enabled: bool,
    confirm: bool,
) -> Result<Value, String> {
    run_blocking("provider state", move || {
        set_provider_enabled_blocking(provider, enabled, confirm)
    })
    .await
}

fn set_provider_enabled_blocking(
    provider: String,
    enabled: bool,
    confirm: bool,
) -> Result<Value, String> {
    if !confirm {
        return Err("Changing provider state requires explicit confirmation".to_string());
    }
    if !allowed_provider(&provider) {
        return Err("Provider is not available for Router control".to_string());
    }
    let Some((script, target_wrapper)) = router_launcher() else {
        return Err("Managed Router checkout was not detected".to_string());
    };
    let args = provider_toggle_args(&provider, enabled, target_wrapper);
    let result =
        run_router_script_with_timeout(&script, &args, "provider-state", Duration::from_secs(15))?;
    Ok(json!({
        "ok": result["ok"].as_bool().unwrap_or(false),
        "provider": provider,
        "enabled": enabled,
        "result": result,
        "redacted": true
    }))
}

#[tauri::command]
async fn open_model_curation(provider: String) -> Result<Value, String> {
    run_blocking("model curation", move || {
        open_model_curation_blocking(provider)
    })
    .await
}

fn open_model_curation_blocking(provider: String) -> Result<Value, String> {
    if !matches!(provider.as_str(), "kimi-api" | "grok-api") {
        return Err("Model curation is not available for this provider".to_string());
    }
    let script = router_root().join("src").join("curate-models.mjs");
    if !script.is_file() {
        return Err("Managed Router curation script was not detected".to_string());
    }
    let mut command = Command::new("node");
    command.arg(&script).arg(&provider);
    spawn_visible(command).map_err(|error| format!("Model curation could not open: {error}"))?;
    Ok(json!({
        "ok": true,
        "provider": provider,
        "interactive": true,
        "credentialValuesReadByOrchestra": false,
        "next": "Review the discovered catalog, then apply it in the Router prompt."
    }))
}

fn apply_codex_picker_allowlist() -> Result<Value, String> {
    Ok(json!({
        "ok": true,
        "status": "router-hide-list",
        "hidden": 0,
        "detail": "Codex picker visibility stays on the Router hide-list. Orchestra does not rewrite it."
    }))
}

#[tauri::command]
async fn apply_codex_picker_allowlist_command() -> Result<Value, String> {
    run_blocking("picker allowlist", apply_codex_picker_allowlist).await
}

fn managed_markers() -> (&'static str, &'static str) {
    (
        "<!-- BEGIN CODEX-ORCHESTRA MANAGED -->",
        "<!-- END CODEX-ORCHESTRA MANAGED -->",
    )
}

fn merge_managed_block(existing: &str, block: &str) -> String {
    let (begin, end) = managed_markers();
    let replacement = format!(
        "{begin}\n{}\n{end}",
        block.replace(begin, "").replace(end, "").trim()
    );
    if let Some(start) = existing.find(begin) {
        if let Some(relative_end) = existing[start..].find(end) {
            let finish = start + relative_end + end.len();
            return format!(
                "{}{}{}",
                &existing[..start],
                replacement,
                &existing[finish..]
            );
        }
    }
    format!("{}\n\n{}\n", existing.trim_end(), replacement)
}

fn managed_preview_hash(value: &str) -> String {
    let mut hash: u32 = 0x811c9dc5;
    for byte in value.bytes() {
        hash ^= u32::from(byte);
        hash = hash.wrapping_mul(0x01000193);
    }
    format!("{hash:08x}")
}

fn managed_preview_summary(existing: &str, action: &str) -> String {
    let operation = match action {
        "create" => "Append a new Orchestra-managed block",
        "update" => "Replace the existing Orchestra-managed block",
        _ => "Keep the existing Orchestra-managed block unchanged",
    };
    let begin_marker = "<!-- BEGIN CODEX-ORCHESTRA MANAGED -->";
    let end_marker = "<!-- END CODEX-ORCHESTRA MANAGED -->";
    let foreign_lines = existing
        .find(begin_marker)
        .and_then(|begin| {
            existing[begin..]
                .find(end_marker)
                .map(|end| (begin, begin + end + end_marker.len()))
        })
        .map(|(begin, end)| existing[..begin].lines().count() + existing[end..].lines().count())
        .unwrap_or_else(|| existing.lines().count());
    format!(
        "{operation}. {foreign_lines} existing project line(s) are not included in this generated preview."
    )
}

fn merge_subagent_config(existing: &str, block: &str) -> String {
    const BEGIN: &str = "# BEGIN CODEX-ORCHESTRA MANAGED";
    const END: &str = "# END CODEX-ORCHESTRA MANAGED";
    let replacement = format!(
        "{BEGIN}\n{}\n{END}",
        block.replace(BEGIN, "").replace(END, "").trim()
    );
    if let Some(start) = existing.find(BEGIN) {
        if let Some(relative_end) = existing[start..].find(END) {
            let finish = start + relative_end + END.len();
            return format!(
                "{}{}{}",
                &existing[..start],
                replacement,
                &existing[finish..]
            );
        }
    }
    if existing.lines().any(|line| line.trim() == "[agents]") {
        let body = block
            .lines()
            .filter(|line| {
                let trimmed = line.trim();
                !trimmed.is_empty() && trimmed != "[agents]"
            })
            .collect::<Vec<_>>()
            .join("\n");
        let managed =
            format!("# BEGIN CODEX-ORCHESTRA MANAGED\n{body}\n# END CODEX-ORCHESTRA MANAGED");
        let lines: Vec<&str> = existing.lines().collect();
        let agents_index = lines
            .iter()
            .position(|line| line.trim() == "[agents]")
            .expect("agents section exists");
        let next_section = lines
            .iter()
            .enumerate()
            .skip(agents_index + 1)
            .find(|(_, line)| {
                let trimmed = line.trim();
                trimmed.starts_with('[') && trimmed.ends_with(']')
            })
            .map(|(index, _)| index)
            .unwrap_or(lines.len());
        let managed_keys = [
            "enabled =",
            "max_concurrent_threads_per_session =",
            "max_depth =",
        ];
        let existing_agents_body = lines[agents_index + 1..next_section]
            .iter()
            .filter(|line| {
                !managed_keys
                    .iter()
                    .any(|key| line.trim_start().starts_with(key))
            })
            .copied()
            .collect::<Vec<_>>();
        let mut output = lines[..agents_index + 1].join("\n");
        if !existing_agents_body.is_empty() {
            output.push('\n');
            output.push_str(&existing_agents_body.join("\n"));
        }
        output.push_str("\n\n");
        output.push_str(&managed);
        if next_section < lines.len() {
            output.push_str("\n\n");
            output.push_str(&lines[next_section..].join("\n"));
        }
        return format!("{output}\n");
    }
    format!("{}\n\n{}\n", existing.trim_end(), replacement)
}

fn safe_agents_target(path: &str) -> Result<PathBuf, String> {
    let requested = PathBuf::from(path);
    if !requested.is_absolute() {
        return Err("Managed config path must be absolute".to_string());
    }
    if requested.file_name().and_then(|name| name.to_str()) != Some("AGENTS.md") {
        return Err("Only AGENTS.md is managed by this command".to_string());
    }
    let parent = requested
        .parent()
        .ok_or_else(|| "Managed config has no parent directory".to_string())?;
    if !parent.exists() {
        return Err("Managed config parent directory does not exist".to_string());
    }
    let canonical_parent = parent
        .canonicalize()
        .map_err(|error| format!("Managed config parent cannot be resolved: {error}"))?;
    Ok(normalize_windows_extended_path(
        canonical_parent.join("AGENTS.md"),
    ))
}

#[cfg(windows)]
fn normalize_windows_extended_path(path: PathBuf) -> PathBuf {
    let value = path.to_string_lossy();
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = value.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        path
    }
}

#[cfg(not(windows))]
fn normalize_windows_extended_path(path: PathBuf) -> PathBuf {
    path
}

#[cfg(windows)]
fn replace_file_atomically(temp: &Path, target: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source: Vec<u16> = temp
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let destination: Vec<u16> = target
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let moved = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(format!(
            "Atomic replace failed: {}",
            std::io::Error::last_os_error()
        ))
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file_atomically(temp: &Path, target: &Path) -> Result<(), String> {
    fs::rename(temp, target).map_err(|error| format!("Atomic replace failed: {error}"))
}

#[derive(Debug)]
struct WriteRecord {
    target: PathBuf,
    backup: Option<PathBuf>,
}

fn atomic_write_file(target: &Path, content: &str) -> Result<WriteRecord, String> {
    let parent = target
        .parent()
        .ok_or_else(|| "Managed file has no parent directory".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("Managed directory failed: {error}"))?;
    let backup = if target.exists() {
        let backup = target.with_extension(format!(
            "{}codex-orchestra-backup-{}",
            target
                .extension()
                .and_then(|extension| extension.to_str())
                .map(|extension| format!("{extension}."))
                .unwrap_or_default(),
            now().replace(':', "-")
        ));
        fs::copy(target, &backup).map_err(|error| format!("Backup failed: {error}"))?;
        Some(backup)
    } else {
        None
    };
    let temp = target.with_extension(format!("codex-orchestra-tmp-{}", now().replace(':', "-")));
    let write_result = (|| {
        let mut file = File::create(&temp).map_err(|error| format!("Temp file failed: {error}"))?;
        file.write_all(content.as_bytes())
            .map_err(|error| format!("Temp write failed: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("Temp sync failed: {error}"))?;
        replace_file_atomically(&temp, target)
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    write_result?;
    Ok(WriteRecord {
        target: target.to_path_buf(),
        backup,
    })
}

fn rollback_write(record: &WriteRecord) {
    if let Some(backup) = &record.backup {
        let _ = fs::copy(backup, &record.target);
    } else {
        let _ = fs::remove_file(&record.target);
    }
}

fn safe_generated_target(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let normalised = relative.replace('\\', "/");
    let allowed = normalised == ".codex/skills/orchestra-routing/SKILL.md"
        || matches!(
            normalised.as_str(),
            ".codex/agents/orchestra_frontend.toml"
                | ".codex/agents/orchestra_engineer.toml"
                | ".codex/agents/orchestra_visual.toml"
                | ".codex/config.toml"
        );
    if !allowed {
        return Err(format!("Unsupported generated path: {relative}"));
    }
    let candidate = PathBuf::from(&normalised);
    if candidate.is_absolute()
        || candidate
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("Generated path must stay inside the project".to_string());
    }
    Ok(root.join(candidate))
}

fn safe_backup_pair(target: &str, backup: &str) -> Result<(PathBuf, PathBuf), String> {
    let target = PathBuf::from(target);
    let backup = PathBuf::from(backup);
    if !target.is_absolute() || !backup.is_absolute() {
        return Err("Backup paths must be absolute".to_string());
    }
    let target_name = target
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Backup target has no file name".to_string())?;
    let backup_name = backup
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Backup has no file name".to_string())?;
    let managed_target = matches!(
        target_name,
        "AGENTS.md"
            | "orchestra_frontend.toml"
            | "orchestra_engineer.toml"
            | "orchestra_visual.toml"
            | "SKILL.md"
            | "config.toml"
    );
    if !managed_target
        || backup.parent() != target.parent()
        || !backup_name.starts_with(&format!("{target_name}."))
        || !backup_name.contains("codex-orchestra-backup-")
        || !backup.is_file()
    {
        return Err("Backup is not a valid Orchestra-managed sibling".to_string());
    }
    Ok((target, backup))
}

#[derive(Debug, Deserialize)]
struct GeneratedFile {
    path: String,
    #[serde(alias = "contents")]
    content: String,
}

fn safe_project_root(path: &str) -> Result<PathBuf, String> {
    let candidate = PathBuf::from(path);
    if !candidate.is_absolute() {
        return Err("Project path must be absolute".to_string());
    }
    let root = candidate
        .canonicalize()
        .map_err(|error| format!("Project path is not accessible: {error}"))?;
    if !root.is_dir() {
        return Err("Project path must be a directory".to_string());
    }
    Ok(root)
}

fn path_values_match(left: &Path, right: &Path) -> bool {
    fn normalize(path: &Path) -> String {
        let resolved = path
            .canonicalize()
            .map(normalize_windows_extended_path)
            .unwrap_or_else(|_| path.to_path_buf());
        resolved
            .to_string_lossy()
            .trim_end_matches(['\\', '/'])
            .replace('/', "\\")
            .to_ascii_lowercase()
    }
    normalize(left) == normalize(right)
}

fn registered_project_root(path: &str) -> Result<PathBuf, String> {
    let root = safe_project_root(path)?;
    let connection = open_state_db()?;
    let mut statement = connection
        .prepare("SELECT path FROM projects")
        .map_err(|error| format!("Registered project query failed: {error}"))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Registered project rows failed: {error}"))?;
    let registered = rows
        .filter_map(Result::ok)
        .any(|stored| path_values_match(&root, Path::new(&stored)));
    if !registered {
        return Err("Project path is not a registered Orchestra project".to_string());
    }
    Ok(root)
}

fn safe_worktree_slug(value: &str) -> Result<String, String> {
    if value.is_empty() || value.len() > 40 || value == "." || value == ".." {
        return Err("Worktree slug must contain 1-40 safe characters".to_string());
    }
    if !value
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.'))
    {
        return Err(
            "Worktree slug may use only letters, numbers, dot, dash and underscore".to_string(),
        );
    }
    Ok(value.to_string())
}

fn worktree_spec(project_root: &Path, role: &str, slug: &str) -> Result<(PathBuf, String), String> {
    if !matches!(role, "frontend" | "engineer") {
        return Err("Only frontend and engineer worktrees are supported".to_string());
    }
    let slug = safe_worktree_slug(slug)?;
    let target = project_root
        .join(".codex-orchestra")
        .join("worktrees")
        .join(format!("{role}-{slug}"));
    Ok((target, slug))
}

fn git_repo_root(project_root: &Path) -> Result<PathBuf, String> {
    let mut command = Command::new("git");
    command
        .args(["-C"])
        .arg(project_root)
        .args(["rev-parse", "--show-toplevel"]);
    let output = command_output_with_timeout(command, Duration::from_secs(5))?;
    if !output.status.success() {
        return Err("Project is not a Git working tree".to_string());
    }
    let root = String::from_utf8_lossy(&output.stdout).trim().to_string();
    PathBuf::from(root)
        .canonicalize()
        .map_err(|error| format!("Git repository root could not be resolved: {error}"))
}

fn git_output(root: &Path, args: &[&str], timeout: Duration) -> Result<Output, String> {
    let mut command = Command::new("git");
    command.args(["-C"]).arg(root).args(args);
    command_output_with_timeout(command, timeout)
}

fn git_text(root: &Path, args: &[&str], timeout: Duration) -> Result<String, String> {
    let output = git_output(root, args, timeout)?;
    if !output.status.success() {
        return Err(format!(
            "Git operation failed: {}",
            redact_bounded(&String::from_utf8_lossy(&output.stderr))
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn persist_worktree_record(
    project_root: &Path,
    role: &str,
    slug: &str,
    target: &Path,
    base_ref: &str,
) -> Result<(), String> {
    let connection = open_state_db()?;
    connection
        .execute(
            "INSERT OR REPLACE INTO worktrees (id, project_path, role, slug, target, base_ref, created_at, state)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'active')",
            params![
                format!("worktree-{role}-{slug}"),
                project_root.to_string_lossy(),
                role,
                slug,
                target.to_string_lossy(),
                base_ref,
                now()
            ],
        )
        .map_err(|error| format!("Worktree state write failed: {error}"))?;
    Ok(())
}

fn worktree_base_ref(target: &Path) -> Result<Option<String>, String> {
    let connection = open_state_db()?;
    connection
        .query_row(
            "SELECT base_ref FROM worktrees WHERE target = ?1",
            params![target.to_string_lossy()],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Worktree state query failed: {error}"))
}

fn remove_worktree_record(target: &Path) -> Result<(), String> {
    let connection = open_state_db()?;
    connection
        .execute(
            "DELETE FROM worktrees WHERE target = ?1",
            params![target.to_string_lossy()],
        )
        .map_err(|error| format!("Worktree state cleanup failed: {error}"))?;
    Ok(())
}

fn changed_worktree_files(status: &str, diff: &str) -> Vec<String> {
    let mut files = HashSet::new();
    for line in status.lines() {
        if line.len() > 3 {
            files.insert(line[3..].trim().to_string());
        }
    }
    for line in diff.lines() {
        if let Some(path) = line.split('\t').next_back() {
            if !path.trim().is_empty() {
                files.insert(path.trim().to_string());
            }
        }
    }
    let mut files: Vec<String> = files.into_iter().take(250).collect();
    files.sort();
    files
}

fn worktree_status_value(project_path: &str, role: &str, slug: &str) -> Result<Value, String> {
    let project_root = registered_project_root(project_path)?;
    let git_root = git_repo_root(&project_root)?;
    let (target, slug) = worktree_spec(&git_root, role, slug)?;
    let base_ref = worktree_base_ref(&target)?;
    if !target.is_dir() {
        return Ok(json!({
            "ok": true,
            "role": role,
            "slug": slug,
            "target": target.to_string_lossy(),
            "state": if base_ref.is_some() { "missing" } else { "not-created" },
            "recorded": base_ref.is_some(),
            "dirty": false,
            "commitsAhead": 0,
            "changedFiles": [],
            "canRemoveSafely": false,
            "requiresManualMerge": false,
            "redacted": true
        }));
    }
    let base_ref = base_ref.ok_or_else(|| {
        "This worktree exists but is not managed by Orchestra; it will not be modified".to_string()
    })?;
    let status = git_text(
        &target,
        &["status", "--porcelain=v1", "--untracked-files=all"],
        Duration::from_secs(8),
    )?;
    let diff = git_text(
        &target,
        &["diff", "--name-status", &base_ref],
        Duration::from_secs(8),
    )?;
    let worktree_head = git_text(&target, &["rev-parse", "HEAD"], Duration::from_secs(5))?;
    let project_head = git_text(&git_root, &["rev-parse", "HEAD"], Duration::from_secs(5))?;
    let ahead = git_text(
        &target,
        &["rev-list", "--count", &format!("{base_ref}..HEAD")],
        Duration::from_secs(5),
    )?
    .parse::<u64>()
    .unwrap_or(0);
    let dirty = !status.trim().is_empty();
    let changed_files = changed_worktree_files(&status, &diff);
    Ok(json!({
        "ok": true,
        "role": role,
        "slug": slug,
        "projectRoot": git_root.to_string_lossy(),
        "target": target.to_string_lossy(),
        "state": "active",
        "recorded": true,
        "baseRef": base_ref,
        "worktreeHead": worktree_head,
        "projectHead": project_head,
        "baseDrifted": project_head != base_ref,
        "dirty": dirty,
        "commitsAhead": ahead,
        "changedFiles": changed_files,
        "canRemoveSafely": !dirty && ahead == 0,
        "requiresManualMerge": dirty || ahead > 0,
        "merge": "root review only; Orchestra never merges automatically",
        "redacted": true
    }))
}

fn experimental_worktrees_enabled() -> Result<bool, String> {
    let connection = open_state_db()?;
    Ok(load_setting_value(&connection, "featureFlags")
        .and_then(|flags| flags["experimentalWorktrees"].as_bool())
        .unwrap_or(false))
}

fn app_server_enabled() -> Result<bool, String> {
    let connection = open_state_db()?;
    Ok(load_setting_value(&connection, "featureFlags")
        .and_then(|flags| flags["appServer"].as_bool())
        .unwrap_or(false))
}

fn mcp_enabled() -> Result<bool, String> {
    let connection = open_state_db()?;
    Ok(load_setting_value(&connection, "featureFlags")
        .and_then(|flags| flags["mcp"].as_bool())
        .unwrap_or(false))
}

fn project_file_names(root: &Path) -> Vec<String> {
    fs::read_dir(root)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.flatten())
        .filter_map(|entry| {
            entry
                .file_type()
                .ok()
                .filter(|file_type| file_type.is_file())
                .and_then(|_| entry.file_name().to_str().map(ToOwned::to_owned))
        })
        .collect()
}

fn detected_stack(files: &[String]) -> Vec<String> {
    let lower: Vec<String> = files.iter().map(|file| file.to_lowercase()).collect();
    let mut stack = Vec::new();
    if lower.iter().any(|file| file == "package.json") {
        stack.push("Node.js");
    }
    if lower
        .iter()
        .any(|file| file == "next.config.js" || file == "next.config.ts")
    {
        stack.push("Next.js");
    }
    if lower
        .iter()
        .any(|file| file == "vite.config.ts" || file == "vite.config.js")
    {
        stack.push("Vite");
    }
    if lower
        .iter()
        .any(|file| file == "pyproject.toml" || file == "requirements.txt")
    {
        stack.push("Python");
    }
    if lower.iter().any(|file| file == "cargo.toml") {
        stack.push("Rust");
    }
    if lower.iter().any(|file| file.contains("tailwind")) {
        stack.push("Tailwind");
    }
    if lower
        .iter()
        .any(|file| file == "app.config.js" || file == "app.json")
    {
        stack.push("Expo/React Native");
    }
    if stack.is_empty() {
        stack.push("Unknown");
    }
    stack.into_iter().map(ToOwned::to_owned).collect()
}

fn project_profile(root: &Path) -> Value {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let files = project_file_names(root);
    let mut hasher = DefaultHasher::new();
    root.to_string_lossy().hash(&mut hasher);
    let mut scripts = serde_json::Map::new();
    if let Ok(package) = fs::read_to_string(root.join("package.json")) {
        if let Ok(package) = serde_json::from_str::<Value>(&package) {
            if let Some(package_scripts) = package.get("scripts").and_then(Value::as_object) {
                scripts = package_scripts.clone();
            }
        }
    }
    let known_tests = if scripts.get("test").is_some() {
        vec!["npm test"]
    } else {
        Vec::new()
    };
    let lint_script = scripts
        .get("lint")
        .and_then(Value::as_str)
        .map(|_| "npm run lint");
    let typecheck_script = scripts
        .get("typecheck")
        .and_then(Value::as_str)
        .map(|_| "npm run typecheck");
    json!({
        "id": format!("project-{:x}", hasher.finish()),
        "name": root.file_name().and_then(|name| name.to_str()).unwrap_or("Local project"),
        "path": root.to_string_lossy(),
        "stack": detected_stack(&files),
        "activeTeam": "default",
        "ownership": {
            "root": ["package.json", "types/**"],
            "frontend": ["src/**", "components/**"],
            "engineer": ["server/**", "tests/**"]
        },
        "sharedPaths": ["package.json", "types/**"],
        "routingPolicy": "sequential-on-overlap",
        "knownTests": known_tests,
        "lintScript": lint_script,
        "typecheckScript": typecheck_script,
        "status": "unknown",
        "usageEventCount": 0
    })
}

fn normalise_path(value: &str) -> String {
    value
        .replace('\\', "/")
        .trim_start_matches("./")
        .trim_end_matches('/')
        .to_string()
}

fn paths_overlap(left: &str, right: &str) -> bool {
    let left = normalise_path(left);
    let right = normalise_path(right);
    let left_base = left.strip_suffix("/**").unwrap_or(&left);
    let right_base = right.strip_suffix("/**").unwrap_or(&right);
    left == right
        || left == "*"
        || right == "*"
        || left.starts_with(&format!("{right}/"))
        || right.starts_with(&format!("{left}/"))
        || (left.ends_with("/**")
            && (right == left_base || right.starts_with(&format!("{left_base}/"))))
        || (right.ends_with("/**")
            && (left == right_base || left.starts_with(&format!("{right_base}/"))))
}

fn assignment_paths(assignments: &Value, role: &str) -> Vec<String> {
    assignments
        .get(role)
        .and_then(Value::as_array)
        .map(|paths| {
            paths
                .iter()
                .filter_map(Value::as_str)
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn scope_plan_value(assignments: Value, shared_paths: Vec<String>) -> Value {
    let roles = ["frontend", "engineer"];
    let mut conflicts = HashSet::new();
    for shared in &shared_paths {
        for role in roles {
            if assignment_paths(&assignments, role)
                .iter()
                .any(|path| paths_overlap(path, shared))
            {
                conflicts.insert(format!("shared: {shared}"));
            }
        }
    }
    let frontend = assignment_paths(&assignments, "frontend");
    let engineer = assignment_paths(&assignments, "engineer");
    for left in &frontend {
        for right in &engineer {
            if paths_overlap(left, right) {
                conflicts.insert(format!("frontend:{left} ↔ engineer:{right}"));
            }
        }
    }
    let mut conflicts: Vec<String> = conflicts.into_iter().collect();
    conflicts.sort();
    let parallel = conflicts.is_empty();
    json!({
        "parallel": parallel,
        "reason": if parallel { "Write scopes are disjoint." } else { "Overlapping or shared write scope requires sequential execution." },
        "assignments": {
            "root": assignment_paths(&assignments, "root"),
            "frontend": frontend,
            "engineer": engineer
        },
        "conflicts": conflicts,
        "worktreeRecommended": !parallel
    })
}

async fn run_blocking<T, F>(operation: &'static str, task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    // Router probes launch PowerShell and may wait on a bounded timeout. Keep
    // them off Tauri's window thread so Windows never marks the app as hung.
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| format!("{operation} task failed: {error}"))?
}

#[tauri::command]
async fn router_runtime_status(
    state: tauri::State<'_, AppServerState>,
) -> Result<Value, String> {
    let active = app_server_session_active(&state);
    run_blocking("router runtime status", move || Ok(router_health_value(active))).await
}

#[tauri::command]
async fn router_runtime_health(
    state: tauri::State<'_, AppServerState>,
) -> Result<Value, String> {
    let active = app_server_session_active(&state);
    run_blocking("router runtime health", move || Ok(router_health_value(active))).await
}

#[tauri::command]
async fn router_runtime_start(
    confirm: Option<bool>,
    state: tauri::State<'_, AppServerState>,
) -> Result<Value, String> {
    let active = app_server_session_active(&state);
    run_blocking("router runtime start", move || {
        Ok(recover_router_process(confirm.unwrap_or(false), active, false))
    })
    .await
}

#[tauri::command]
async fn router_runtime_restart(
    confirm: Option<bool>,
    state: tauri::State<'_, AppServerState>,
) -> Result<Value, String> {
    let active = app_server_session_active(&state);
    run_blocking("router runtime restart", move || {
        Ok(recover_router_process(confirm.unwrap_or(false), active, false))
    })
    .await
}

#[tauri::command]
async fn router_runtime_logs() -> Result<Value, String> {
    run_blocking("router runtime logs", || Ok(router_logs_value())).await
}

#[tauri::command]
async fn get_snapshot() -> Result<Value, String> {
    run_blocking("snapshot", || {
        let snapshot = load_snapshot_state(base_snapshot(), true)?;
        persist_runtime_facts(&snapshot)?;
        Ok(snapshot)
    })
    .await
}

#[tauri::command]
async fn get_snapshot_fast() -> Result<Value, String> {
    run_blocking("local snapshot", || {
        load_snapshot_state(base_snapshot_local(), false)
    })
    .await
}

#[tauri::command]
async fn run_health_check() -> Result<Value, String> {
    run_blocking("health check", || {
        let snapshot = load_snapshot_state(base_snapshot(), true)?;
        // Health refresh is also the explicit metadata refresh boundary. Keep
        // the fast snapshot in sync so the UI does not show stale provider or
        // model status after a successful check.
        persist_runtime_facts(&snapshot)?;
    let router_status = if !snapshot["router"]["detected"].as_bool().unwrap_or(false) {
        "missing"
    } else if let Some(doctor) = router_readonly("doctor") {
        if doctor["ok"].as_bool().unwrap_or(false) {
            snapshot["router"]["health"].as_str().unwrap_or("degraded")
        } else {
            "unhealthy"
        }
    } else {
        snapshot["router"]["health"].as_str().unwrap_or("unknown")
    };
    let external_providers: Vec<Value> = snapshot["providers"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|provider| provider["id"].as_str() != Some("openai"))
        .collect();
    let provider_status = if external_providers.is_empty() {
        "unknown"
    } else if external_providers
        .iter()
        .any(|provider| matches!(provider["credential"].as_str(), Some("invalid" | "expired")))
    {
        "unhealthy"
    } else if external_providers
        .iter()
        .any(|provider| provider["credential"].as_str() == Some("configured"))
    {
        "healthy"
    } else if external_providers
        .iter()
        .any(|provider| provider["credential"].as_str() == Some("unknown"))
    {
        "unknown"
    } else {
        "missing"
    };
    let agent_status = snapshot["agents"]
        .as_array()
        .map(|agents| {
            let mut workers = agents
                .iter()
                .filter(|agent| agent["role"].as_str() != Some("root"));
            if workers
                .clone()
                .any(|agent| agent["health"].as_str() == Some("unhealthy"))
            {
                "unhealthy"
            } else if workers
                .clone()
                .any(|agent| agent["health"].as_str() == Some("missing"))
            {
                "degraded"
            } else if workers.any(|agent| agent["health"].as_str() == Some("unknown")) {
                "unknown"
            } else if agents
                .iter()
                .any(|agent| agent["role"].as_str() != Some("root"))
            {
                "healthy"
            } else {
                "unknown"
            }
        })
        .unwrap_or("unknown");
    let model_status = if snapshot["models"].as_array().is_some_and(|models| {
        models.iter().any(|model| {
            model["providerId"].as_str() != Some("openai")
                && model["available"].as_bool() == Some(true)
        })
    }) {
        "healthy"
    } else {
        "missing"
    };
    let checks = vec![
        json!({ "id": "codex", "label": "Codex binary", "status": if snapshot["codex"]["detected"].as_bool().unwrap_or(false) { "healthy" } else { "missing" }, "detail": "Read-only executable detection", "checkedAt": now(), "sensitive": true }),
        json!({ "id": "router", "label": "Router checkout", "status": router_status, "detail": "Router doctor output is consumed redacted; credentials and response bodies are excluded", "checkedAt": now(), "sensitive": true }),
        json!({ "id": "providers", "label": "Provider credentials", "status": provider_status, "detail": "Only configured, missing, invalid or expired state is consumed", "checkedAt": now(), "sensitive": true }),
        json!({ "id": "models", "label": "Curated model catalog", "status": model_status, "detail": "Only model identifiers and availability are consumed; catalog contents remain local", "checkedAt": now(), "sensitive": true }),
        json!({ "id": "agents", "label": "Agent capability", "status": agent_status, "detail": "Binding health combines credential state with curated model availability; live calls remain opt-in", "checkedAt": now(), "sensitive": true }),
    ];
    let report_status = health_report_status(&checks);
    let report = json!({ "id": format!("health-{}", now()), "status": report_status, "startedAt": now(), "completedAt": now(), "checks": checks, "redacted": true });
        persist_health(&report)?;
        Ok(report)
    })
    .await
}

#[tauri::command]
async fn router_operation(operation: String, confirm: Option<bool>) -> Result<Value, String> {
    run_blocking("Router operation", move || {
        router_command(&operation, confirm.unwrap_or(false))
    })
    .await
}

#[tauri::command]
async fn managed_preview(path: String, existing: String, block: String) -> Result<Value, String> {
    run_blocking("managed preview", move || {
        managed_preview_blocking(path, existing, block)
    })
    .await
}

fn managed_preview_blocking(
    path: String,
    existing: String,
    block: String,
) -> Result<Value, String> {
    let target = safe_agents_target(&path)?;
    let current = fs::read_to_string(&target).unwrap_or(existing);
    let next = merge_managed_block(&current, &block);
    let action = if next == current {
        "unchanged"
    } else if current.contains("BEGIN CODEX-ORCHESTRA MANAGED") {
        "update"
    } else {
        "create"
    };
    Ok(json!([
        {
            "path": target,
            "action": action,
            "diff": managed_preview_summary(&current, action),
            "currentHash": managed_preview_hash(&current),
            "contentPreview": block,
            "safe": true
        },
        {"path": ".codex/agents/orchestra_frontend.toml", "action": "create", "diff": "generated frontend agent", "safe": true},
        {"path": ".codex/agents/orchestra_engineer.toml", "action": "create", "diff": "generated engineer agent", "safe": true},
        {"path": ".codex/agents/orchestra_visual.toml", "action": "create", "diff": "generated visual agent", "safe": true},
        {"path": ".codex/skills/orchestra-routing/SKILL.md", "action": "create", "diff": "generated routing skill", "safe": true},
        {"path": ".codex/config.toml", "action": "create", "diff": "bounded native subagent concurrency", "safe": true}
    ]))
}

#[tauri::command]
async fn apply_managed_changes(
    path: String,
    block: String,
    confirm: bool,
    files: Option<Vec<GeneratedFile>>,
    expected_current_hash: Option<String>,
) -> Result<Value, String> {
    run_blocking("managed write", move || {
        apply_managed_changes_blocking(path, block, confirm, files, expected_current_hash)
    })
    .await
}

fn apply_managed_changes_blocking(
    path: String,
    block: String,
    confirm: bool,
    files: Option<Vec<GeneratedFile>>,
    expected_current_hash: Option<String>,
) -> Result<Value, String> {
    if !confirm {
        return Err("Applying managed changes requires explicit confirmation".to_string());
    }
    let target = safe_agents_target(&path)?;
    let root = target
        .parent()
        .ok_or_else(|| "Managed config has no project root".to_string())?;
    let generated_files = files.unwrap_or_default();
    let generated_targets: Vec<PathBuf> = generated_files
        .iter()
        .map(|file| safe_generated_target(root, &file.path))
        .collect::<Result<_, _>>()?;
    open_state_db()?;
    let existing = fs::read_to_string(&target).unwrap_or_default();
    let expected_current_hash = expected_current_hash
        .ok_or_else(|| "Review the current managed preview before applying changes".to_string())?;
    if expected_current_hash.len() != 8
        || !expected_current_hash
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err("Managed preview token is invalid; regenerate the preview".to_string());
    }
    if managed_preview_hash(&existing) != expected_current_hash {
        return Err(
            "AGENTS.md changed after the preview; regenerate and review the managed preview"
                .to_string(),
        );
    }
    let next = merge_managed_block(&existing, &block);
    let mut records = Vec::new();
    match atomic_write_file(&target, &next) {
        Ok(record) => records.push(record),
        Err(error) => return Err(format!("AGENTS.md could not be written: {error}")),
    }
    for (file, generated_target) in generated_files.iter().zip(generated_targets.iter()) {
        let normalised = file.path.replace('\\', "/");
        let existing_generated = fs::read_to_string(generated_target).unwrap_or_default();
        let content = if normalised == ".codex/config.toml" {
            merge_subagent_config(&existing_generated, &file.content)
        } else {
            file.content.clone()
        };
        match atomic_write_file(generated_target, &content) {
            Ok(record) => records.push(record),
            Err(error) => {
                for record in records.iter().rev() {
                    rollback_write(record);
                }
                return Err(format!(
                    "Managed changes rolled back after {} failed: {error}",
                    file.path
                ));
            }
        }
    }
    for record in &records {
        if let Err(error) = persist_backup(
            &record.target.to_string_lossy(),
            "before-write",
            record.backup.as_deref().and_then(|path| path.to_str()),
        ) {
            for written in records.iter().rev() {
                rollback_write(written);
            }
            return Err(format!(
                "Managed files were rolled back because backup history failed: {error}"
            ));
        }
    }
    let backups: Vec<Value> = records
        .iter()
        .filter_map(|record| {
            record.backup.as_ref().map(|backup| {
                json!({
                    "target": record.target.to_string_lossy().to_string(),
                    "backupPath": backup.to_string_lossy().to_string(),
                    "restorable": true
                })
            })
        })
        .collect();
    Ok(json!({
        "ok": true,
        "managedOnly": true,
        "files": records.iter().map(|record| record.target.to_string_lossy().to_string()).collect::<Vec<_>>(),
        "backups": backups
    }))
}

#[tauri::command]
async fn add_project(path: String) -> Result<Value, String> {
    run_blocking("project registration", move || add_project_blocking(path)).await
}

fn add_project_blocking(path: String) -> Result<Value, String> {
    let root = safe_project_root(&path)?;
    let profile = project_profile(&root);
    persist_project(&profile)?;
    Ok(profile)
}

fn safe_project_paths(value: &Value) -> Result<Vec<String>, String> {
    let paths = value
        .as_array()
        .ok_or_else(|| "Project ownership paths must be an array".to_string())?;
    if paths.len() > 100 {
        return Err("Project ownership paths are limited to 100 entries".to_string());
    }
    paths
        .iter()
        .map(|path| {
            let path = path
                .as_str()
                .filter(|path| !path.is_empty() && path.len() <= 240 && !path.contains('\0'))
                .ok_or_else(|| "Project ownership path is invalid".to_string())?;
            Ok(path.to_string())
        })
        .collect()
}

fn safe_project_metadata_strings(value: &Value, field: &str) -> Result<Vec<String>, String> {
    let values = value
        .as_array()
        .ok_or_else(|| format!("Project {field} must be an array"))?;
    if values.len() > 25 {
        return Err(format!("Project {field} is limited to 25 entries"));
    }
    values
        .iter()
        .map(|value| {
            value
                .as_str()
                .filter(|value| {
                    !value.trim().is_empty()
                        && value.len() <= 180
                        && !value.contains('\0')
                        && !value.contains('\n')
                        && !value.contains('\r')
                })
                .map(|value| value.trim().to_string())
                .ok_or_else(|| format!("Project {field} entry is invalid"))
        })
        .collect()
}

fn safe_project_team(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 80
        || value.contains('\0')
        || value.contains('\n')
        || value.contains('\r')
    {
        return Err("Project active team is invalid".to_string());
    }
    Ok(value.to_string())
}

fn safe_project_routing_policy(value: &str) -> Result<String, String> {
    match value {
        "sequential-on-overlap" | "safe-disjoint-only" => Ok(value.to_string()),
        _ => Err("Project routing policy is invalid".to_string()),
    }
}

fn safe_project_command(value: &Value, label: &str) -> Result<Value, String> {
    if value.is_null() {
        return Ok(Value::Null);
    }
    let value = value
        .as_str()
        .ok_or_else(|| format!("Project {label} is invalid"))?
        .trim();
    if value.is_empty() {
        return Ok(Value::Null);
    }
    if value.len() > 180 || value.contains('\0') || value.contains('\n') || value.contains('\r') {
        return Err(format!("Project {label} is invalid"));
    }
    Ok(Value::String(value.to_string()))
}

fn imported_project_profile(root: &Path, imported: &Value) -> Result<Value, String> {
    let mut profile = project_profile(root);
    if let Some(ownership) = imported.get("ownership") {
        let ownership = ownership
            .as_object()
            .ok_or_else(|| "Project ownership must be an object".to_string())?;
        let mut safe_ownership = serde_json::Map::new();
        for role in ["root", "frontend", "engineer"] {
            let paths = ownership
                .get(role)
                .ok_or_else(|| format!("Project {role} ownership is required"))?;
            safe_ownership.insert(
                role.to_string(),
                Value::Array(
                    safe_project_paths(paths)?
                        .into_iter()
                        .map(Value::String)
                        .collect(),
                ),
            );
        }
        profile["ownership"] = Value::Object(safe_ownership);
    }
    if let Some(shared_paths) = imported.get("sharedPaths") {
        profile["sharedPaths"] = Value::Array(
            safe_project_paths(shared_paths)?
                .into_iter()
                .map(Value::String)
                .collect(),
        );
    }
    if let Some(active_team) = imported.get("activeTeam") {
        profile["activeTeam"] = Value::String(safe_project_team(
            active_team
                .as_str()
                .ok_or_else(|| "Project active team is invalid".to_string())?,
        )?);
    }
    if let Some(routing_policy) = imported.get("routingPolicy") {
        profile["routingPolicy"] = Value::String(safe_project_routing_policy(
            routing_policy
                .as_str()
                .ok_or_else(|| "Project routing policy is invalid".to_string())?,
        )?);
    }
    if let Some(known_tests) = imported.get("knownTests") {
        profile["knownTests"] = Value::Array(
            safe_project_metadata_strings(known_tests, "known tests")?
                .into_iter()
                .map(Value::String)
                .collect(),
        );
    }
    for (field, label) in [
        ("lintScript", "lint script"),
        ("typecheckScript", "typecheck script"),
    ] {
        if let Some(value) = imported.get(field) {
            profile[field] = safe_project_command(value, label)?;
        }
    }
    Ok(profile)
}

fn safe_agent_strings(value: &Value, field: &str) -> Result<Vec<String>, String> {
    let values = value
        .as_array()
        .ok_or_else(|| format!("Agent {field} must be an array"))?;
    if values.len() > 25 {
        return Err(format!("Agent {field} is limited to 25 entries"));
    }
    values
        .iter()
        .map(|value| {
            value
                .as_str()
                .filter(|value| {
                    !value.trim().is_empty()
                        && value.len() <= 180
                        && !value.contains('\0')
                        && !value.contains('\n')
                        && !value.contains('\r')
                })
                .map(|value| value.trim().to_string())
                .ok_or_else(|| format!("Agent {field} entry is invalid"))
        })
        .collect()
}

fn required_agent_text(agent: &Value, field: &str, max: usize) -> Result<String, String> {
    agent[field]
        .as_str()
        .filter(|value| {
            !value.trim().is_empty()
                && value.len() <= max
                && !value.contains('\0')
                && !value.contains('\n')
                && !value.contains('\r')
        })
        .map(|value| value.trim().to_string())
        .ok_or_else(|| format!("Agent {field} is invalid"))
}

fn valid_frontend_strategy(strategy: &Value) -> bool {
    let Some(mode) = strategy["mode"].as_str() else {
        return false;
    };
    match mode {
        "auto" => true,
        "pinned" => {
            let Some(provider) = strategy["pinnedModel"]["provider"].as_str() else {
                return false;
            };
            let Some(upstream_model) = strategy["pinnedModel"]["upstreamModel"].as_str() else {
                return false;
            };
            matches!(provider, "qwen-plan" | "opencode-go")
                && valid_model_argument(upstream_model)
                && !upstream_model.is_empty()
        }
        _ => false,
    }
}

fn validate_agent_definition(agent: &Value) -> Result<Value, String> {
    let role = required_agent_text(agent, "role", 20)?;
    let expected_provider = match role.as_str() {
        "root" => "openai",
        "frontend" => "qwen-plan",
        "engineer" => "grok-api",
        _ => return Err("Agent role is not supported".to_string()),
    };
    let id = required_agent_text(agent, "id", 80)?;
    if id != role {
        return Err("Agent id must match its stable role".to_string());
    }
    let provider = required_agent_text(agent, "providerId", 80)?;
    if !is_safe_provider_id(&provider) && provider != "openai" {
        return Err("Agent provider must be a Router slug or native openai".to_string());
    }
    let _expected_provider = expected_provider;
    let model = required_agent_text(agent, "modelId", 160)?;
    if !valid_model_argument(&model)
        || (role == "root" && !model.starts_with("gpt-"))
        || (role != "root" && !model.starts_with(&format!("{provider}/")))
    {
        return Err("Agent model does not match its provider binding".to_string());
    }
    let reasoning = required_agent_text(agent, "reasoningEffort", 40)?;
    if !reasoning
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || character == '-' || character == '_')
    {
        return Err("Agent reasoning effort is invalid".to_string());
    }
    let retry_limit = agent["retryLimit"]
        .as_u64()
        .filter(|value| *value <= 1)
        .ok_or_else(|| "Agent retry limit must be 0 or 1".to_string())?;
    let estimated_cost = agent["estimatedCostPerMillion"].as_f64().unwrap_or(0.0);
    if !estimated_cost.is_finite() || !(0.0..=1_000_000.0).contains(&estimated_cost) {
        return Err("Agent estimated cost is outside the safe range".to_string());
    }
    let mut stored = json!({
        "id": id,
        "name": required_agent_text(agent, "name", 100)?,
        "role": role,
        "description": required_agent_text(agent, "description", 500)?,
        "providerId": provider,
        "modelId": model,
        "reasoningEffort": reasoning,
        "permissions": safe_agent_strings(&agent["permissions"], "permissions")?,
        "routingHints": safe_agent_strings(&agent["routingHints"], "routing hints")?,
        "retryLimit": retry_limit,
        "ownershipPaths": safe_project_paths(&agent["ownershipPaths"])? ,
        "sharedPaths": safe_project_paths(&agent["sharedPaths"])? ,
        "health": "unknown",
        "estimatedCostPerMillion": estimated_cost
    });
    if let Some(target) = optional_model_target(agent)? {
        stored["modelTarget"] = target;
    }
    Ok(stored)
}

fn optional_model_target(agent: &Value) -> Result<Option<Value>, String> {
    match agent.get("modelTarget") {
        None | Some(Value::Null) => Ok(None),
        Some(target) => {
            let provider = target
                .get("provider")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty() && value.len() <= 80);
            let upstream = target
                .get("upstreamModel")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty() && value.len() <= 160);
            match (provider, upstream) {
                (Some(provider), Some(upstream)) => Ok(Some(json!({
                    "provider": provider,
                    "upstreamModel": upstream
                }))),
                _ => Err("Agent modelTarget is invalid".to_string()),
            }
        }
    }
}

fn valid_agent_collection(agents: &[Value]) -> bool {
    if agents.len() != 3
        || agents
            .iter()
            .any(|agent| validate_agent_definition(agent).is_err())
    {
        return false;
    }
    let roles: HashSet<&str> = agents
        .iter()
        .filter_map(|agent| agent["role"].as_str())
        .collect();
    roles == HashSet::from(["root", "frontend", "engineer"])
}

#[tauri::command]
async fn update_agent_definition(agent: Value) -> Result<Value, String> {
    run_blocking("agent definition", move || {
        let mut snapshot = load_snapshot_state(base_snapshot_local(), false)?;
        let validated = validate_agent_definition(&agent)?;
        let id = validated["id"]
            .as_str()
            .ok_or_else(|| "Agent id is invalid".to_string())?
            .to_string();
        let agents = snapshot["agents"]
            .as_array_mut()
            .ok_or_else(|| "Agent definitions are unavailable".to_string())?;
        let current = agents
            .iter()
            .find(|candidate| candidate["id"].as_str() == Some(id.as_str()))
            .cloned()
            .ok_or_else(|| "Agent definition was not found".to_string())?;
        let mut stored = validated;
        stored["health"] = current["health"].clone();
        if let Some(last_test) = current.get("lastTest") {
            stored["lastTest"] = last_test.clone();
        }
        if stored.get("modelTarget").is_none() {
            if let Some(target) = current.get("modelTarget") {
                stored["modelTarget"] = target.clone();
            }
        }
        let position = agents
            .iter()
            .position(|candidate| candidate["id"].as_str() == Some(id.as_str()))
            .ok_or_else(|| "Agent definition was not found".to_string())?;
        agents[position] = stored.clone();
        if !valid_agent_collection(agents) {
            return Err("Agent set is incomplete or invalid".to_string());
        }
        let connection = open_state_db()?;
        persist_setting_value(
            &connection,
            "agentDefinitions",
            &Value::Array(agents.clone()),
        )?;
        drop(connection);
        persist_log(
            "info",
            "agent-definition",
            &format!("Saved local {id} agent definition; project files remain unchanged"),
        );
        Ok(stored)
    })
    .await
}

#[tauri::command]
async fn save_frontend_strategy(strategy: Value) -> Result<Value, String> {
    run_blocking("frontend strategy", move || {
        if !valid_frontend_strategy(&strategy) {
            return Err("Frontend strategy is invalid".to_string());
        }
        let mut snapshot = load_snapshot_state(base_snapshot_local(), false)?;
        let models = snapshot["models"].as_array().cloned().unwrap_or_default();
        let resolved = frontend_target_for_strategy(&strategy, &models);
        if strategy["mode"].as_str() == Some("pinned") && resolved.is_none() {
            return Err(
                "The selected frontend provider or model is unavailable; no fallback was applied"
                    .to_string(),
            );
        }
        let mut agents = snapshot["agents"]
            .as_array()
            .cloned()
            .ok_or_else(|| "Agent definitions are unavailable".to_string())?;
        let frontend_index = agents
            .iter()
            .position(|agent| agent["role"].as_str() == Some("frontend"))
            .ok_or_else(|| "Frontend role was not found".to_string())?;
        if let Some((provider, upstream, model_id)) = &resolved {
            agents[frontend_index]["providerId"] = Value::String(provider.clone());
            agents[frontend_index]["modelId"] = Value::String(model_id.clone());
            agents[frontend_index]["modelTarget"] =
                json!({ "provider": provider, "upstreamModel": upstream });
            agents[frontend_index]["reasoningEffort"] = Value::String(
                if provider == "qwen-plan" {
                    "high"
                } else {
                    "max"
                }
                .to_string(),
            );
            agents[frontend_index]["name"] = Value::String("Frontend / Model binding".to_string());
        }
        let connection = open_state_db()?;
        let tx = connection
            .unchecked_transaction()
            .map_err(|error| format!("Frontend strategy transaction failed: {error}"))?;
        tx.execute(
            "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
            params!["frontendStrategy", strategy.to_string(), now()],
        )
        .map_err(|error| format!("Frontend strategy write failed: {error}"))?;
        if resolved.is_some() {
            tx.execute(
                "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
                params![
                    "agentDefinitions",
                    Value::Array(agents.clone()).to_string(),
                    now()
                ],
            )
            .map_err(|error| format!("Frontend agent binding write failed: {error}"))?;
        }
        tx.commit()
            .map_err(|error| format!("Frontend strategy transaction commit failed: {error}"))?;
        snapshot["frontendStrategy"] = strategy.clone();
        snapshot["agents"] = Value::Array(agents.clone());
        persist_log(
            "info",
            "frontend-strategy",
            "Saved frontend strategy and resolved model binding locally",
        );
        Ok(json!({ "ok": true, "strategy": strategy, "agent": agents[frontend_index] }))
    })
    .await
}

#[tauri::command]
async fn update_project_profile(
    project_id: String,
    ownership: Value,
    shared_paths: Vec<String>,
    active_team: Option<String>,
    routing_policy: Option<String>,
    known_tests: Option<Vec<String>>,
    lint_script: Option<String>,
    typecheck_script: Option<String>,
) -> Result<Value, String> {
    run_blocking("project profile", move || {
        if project_id.is_empty() || project_id.len() > 120 {
            return Err("Project id is invalid".to_string());
        }
        let mut snapshot = load_snapshot_state(base_snapshot_local(), false)?;
        let project = snapshot["projects"]
            .as_array_mut()
            .and_then(|projects| {
                projects
                    .iter_mut()
                    .find(|project| project["id"] == project_id)
            })
            .ok_or_else(|| "Project profile was not found".to_string())?;
        let ownership_object = ownership
            .as_object()
            .ok_or_else(|| "Project ownership must be an object".to_string())?;
        let mut safe_ownership = serde_json::Map::new();
        for role in ["root", "frontend", "engineer"] {
            safe_ownership.insert(
                role.to_string(),
                Value::Array(
                    safe_project_paths(
                        ownership_object
                            .get(role)
                            .unwrap_or(&Value::Array(Vec::new())),
                    )?
                    .into_iter()
                    .map(Value::String)
                    .collect(),
                ),
            );
        }
        let safe_shared = safe_project_paths(&Value::Array(
            shared_paths.into_iter().map(Value::String).collect(),
        ))?;
        let active_team = safe_project_team(&active_team.unwrap_or_else(|| {
            project["activeTeam"]
                .as_str()
                .unwrap_or("default")
                .to_string()
        }))?;
        let routing_policy = safe_project_routing_policy(&routing_policy.unwrap_or_else(|| {
            project["routingPolicy"]
                .as_str()
                .unwrap_or("sequential-on-overlap")
                .to_string()
        }))?;
        let known_tests = safe_project_metadata_strings(
            &Value::Array(
                known_tests
                    .unwrap_or_else(|| {
                        project["knownTests"]
                            .as_array()
                            .cloned()
                            .unwrap_or_default()
                            .into_iter()
                            .filter_map(|value| value.as_str().map(ToOwned::to_owned))
                            .collect()
                    })
                    .into_iter()
                    .map(Value::String)
                    .collect(),
            ),
            "known tests",
        )?;
        let lint_script = safe_project_command(
            &lint_script
                .map(Value::String)
                .unwrap_or_else(|| project["lintScript"].clone()),
            "lint script",
        )?;
        let typecheck_script = safe_project_command(
            &typecheck_script
                .map(Value::String)
                .unwrap_or_else(|| project["typecheckScript"].clone()),
            "typecheck script",
        )?;
        project["ownership"] = Value::Object(safe_ownership);
        project["sharedPaths"] = Value::Array(safe_shared.into_iter().map(Value::String).collect());
        project["activeTeam"] = Value::String(active_team);
        project["routingPolicy"] = Value::String(routing_policy);
        project["knownTests"] = Value::Array(known_tests.into_iter().map(Value::String).collect());
        project["lintScript"] = lint_script;
        project["typecheckScript"] = typecheck_script;
        persist_project(project)?;
        persist_log(
            "info",
            "project-profile",
            "Project ownership profile updated locally",
        );
        Ok(project.clone())
    })
    .await
}

fn worktree_preview_blocking(
    project_path: String,
    role: String,
    slug: String,
) -> Result<Value, String> {
    let project_root = registered_project_root(&project_path)?;
    let git_root = git_repo_root(&project_root)?;
    let (target, slug) = worktree_spec(&git_root, &role, &slug)?;
    if target.exists() {
        return Err("The requested worktree target already exists".to_string());
    }
    Ok(json!({
        "ok": true,
        "role": role,
        "slug": slug,
        "projectRoot": git_root.to_string_lossy(),
        "target": target.to_string_lossy(),
        "command": "git worktree add --detach <target> HEAD",
        "requiresConfirmation": true,
        "experimental": true,
        "merge": "manual review only"
    }))
}

#[tauri::command]
async fn worktree_preview(
    project_path: String,
    role: String,
    slug: String,
) -> Result<Value, String> {
    run_blocking("worktree preview", move || {
        worktree_preview_blocking(project_path, role, slug)
    })
    .await
}

fn create_worktree_blocking(
    project_path: String,
    role: String,
    slug: String,
    confirm: bool,
) -> Result<Value, String> {
    if !confirm {
        return Err("Creating a worktree requires explicit confirmation".to_string());
    }
    if !experimental_worktrees_enabled()? {
        return Err("Experimental worktrees are disabled in local feature flags".to_string());
    }
    let project_root = registered_project_root(&project_path)?;
    let git_root = git_repo_root(&project_root)?;
    let (target, slug) = worktree_spec(&git_root, &role, &slug)?;
    if target.exists() {
        return Err("The requested worktree target already exists".to_string());
    }
    let base_ref = git_text(&git_root, &["rev-parse", "HEAD"], Duration::from_secs(5))?;
    let parent = target
        .parent()
        .ok_or_else(|| "Worktree target has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("Worktree directory failed: {error}"))?;
    let mut command = Command::new("git");
    command
        .args(["-C"])
        .arg(&git_root)
        .args(["worktree", "add", "--detach"])
        .arg(&target)
        .arg(&base_ref);
    let output = command_output_with_timeout(command, Duration::from_secs(30))?;
    if !output.status.success() {
        return Err(format!(
            "Git worktree failed: {}",
            redact_bounded(&String::from_utf8_lossy(&output.stderr))
        ));
    }
    persist_worktree_record(&git_root, &role, &slug, &target, &base_ref)?;
    persist_log(
        "info",
        "worktree-create",
        "Experimental isolated worktree created",
    );
    Ok(json!({
        "ok": true,
        "role": role,
        "slug": slug,
        "target": target.to_string_lossy(),
        "baseRef": base_ref,
        "detached": true,
        "merge": "manual review only",
        "redacted": true
    }))
}

#[tauri::command]
async fn create_worktree(
    project_path: String,
    role: String,
    slug: String,
    confirm: bool,
) -> Result<Value, String> {
    run_blocking("worktree create", move || {
        create_worktree_blocking(project_path, role, slug, confirm)
    })
    .await
}

#[tauri::command]
async fn worktree_status(
    project_path: String,
    role: String,
    slug: String,
) -> Result<Value, String> {
    run_blocking("worktree status", move || {
        worktree_status_value(&project_path, &role, &slug)
    })
    .await
}

fn list_worktrees_blocking(project_path: String) -> Result<Value, String> {
    let project_root = registered_project_root(&project_path)?;
    let git_root = git_repo_root(&project_root)?;
    let connection = open_state_db()?;
    let mut statement = connection
        .prepare(
            "SELECT role, slug FROM worktrees WHERE project_path = ?1 ORDER BY created_at DESC",
        )
        .map_err(|error| format!("Worktree list query failed: {error}"))?;
    let rows = statement
        .query_map(params![git_root.to_string_lossy()], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| format!("Worktree list rows failed: {error}"))?;
    let mut worktrees = Vec::new();
    for row in rows {
        let (role, slug) = row.map_err(|error| format!("Worktree list row failed: {error}"))?;
        worktrees.push(worktree_status_value(
            &git_root.to_string_lossy(),
            &role,
            &slug,
        )?);
    }
    Ok(Value::Array(worktrees))
}

#[tauri::command]
async fn list_worktrees(project_path: String) -> Result<Value, String> {
    run_blocking("worktree list", move || {
        list_worktrees_blocking(project_path)
    })
    .await
}

fn safe_recovery_relative_path(value: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value);
    if path.is_absolute()
        || path.components().any(|component| {
            !matches!(
                component,
                std::path::Component::Normal(_) | std::path::Component::CurDir
            )
        })
    {
        return Err("Worktree recovery encountered an unsafe relative path".to_string());
    }
    Ok(path)
}

fn create_worktree_recovery(
    target: &Path,
    base_ref: &str,
    role: &str,
    slug: &str,
    status: &Value,
) -> Result<PathBuf, String> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let recovery = data_root()
        .join("backups")
        .join("worktrees")
        .join(format!("{role}-{slug}-{nanos}"));
    fs::create_dir_all(&recovery)
        .map_err(|error| format!("Worktree recovery directory failed: {error}"))?;

    let patch = git_output(
        target,
        &["diff", "--binary", base_ref],
        Duration::from_secs(30),
    )?;
    if !patch.status.success() {
        return Err(format!(
            "Worktree recovery patch failed: {}",
            redact_bounded(&String::from_utf8_lossy(&patch.stderr))
        ));
    }
    fs::write(recovery.join("tracked.patch"), &patch.stdout)
        .map_err(|error| format!("Worktree recovery patch write failed: {error}"))?;

    let untracked = git_output(
        target,
        &["ls-files", "--others", "--exclude-standard", "-z"],
        Duration::from_secs(20),
    )?;
    if !untracked.status.success() {
        return Err("Worktree untracked-file inventory failed".to_string());
    }
    let canonical_target = target
        .canonicalize()
        .map_err(|error| format!("Worktree recovery root failed: {error}"))?;
    let mut recovered_untracked = Vec::new();
    for raw in untracked
        .stdout
        .split(|byte| *byte == 0)
        .filter(|raw| !raw.is_empty())
    {
        let relative = safe_recovery_relative_path(&String::from_utf8_lossy(raw))?;
        let source = target.join(&relative);
        let canonical_source = source
            .canonicalize()
            .map_err(|error| format!("Worktree recovery file failed: {error}"))?;
        if !canonical_source.starts_with(&canonical_target) || !canonical_source.is_file() {
            return Err("Worktree recovery file escaped the managed worktree".to_string());
        }
        let destination = recovery.join("untracked").join(&relative);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Worktree recovery folder failed: {error}"))?;
        }
        fs::copy(&canonical_source, &destination)
            .map_err(|error| format!("Worktree recovery copy failed: {error}"))?;
        recovered_untracked.push(relative.to_string_lossy().to_string());
    }
    let manifest = json!({
        "createdAt": now(),
        "role": role,
        "slug": slug,
        "baseRef": base_ref,
        "changedFiles": status["changedFiles"],
        "untrackedFiles": recovered_untracked,
        "restore": "Review tracked.patch and untracked/ manually before applying to the root worktree.",
        "redacted": true
    });
    fs::write(recovery.join("manifest.json"), manifest.to_string())
        .map_err(|error| format!("Worktree recovery manifest failed: {error}"))?;
    persist_backup(
        &target.to_string_lossy(),
        "manual",
        Some(&recovery.to_string_lossy()),
    )?;
    Ok(recovery)
}

fn remove_worktree_blocking(
    project_path: String,
    role: String,
    slug: String,
    confirm: bool,
    force: bool,
) -> Result<Value, String> {
    if !confirm {
        return Err("Removing a worktree requires explicit confirmation".to_string());
    }
    if !experimental_worktrees_enabled()? {
        return Err("Experimental worktrees are disabled in local feature flags".to_string());
    }
    let project_root = registered_project_root(&project_path)?;
    let git_root = git_repo_root(&project_root)?;
    let (target, slug) = worktree_spec(&git_root, &role, &slug)?;
    let Some(base_ref) = worktree_base_ref(&target)? else {
        return Err("Only Orchestra-managed worktrees can be removed".to_string());
    };
    if !target.exists() {
        remove_worktree_record(&target)?;
        return Ok(
            json!({"ok": true, "removed": false, "staleRecordCleaned": true, "redacted": true}),
        );
    }
    let status = worktree_status_value(&project_path, &role, &slug)?;
    let has_changes = status["requiresManualMerge"].as_bool().unwrap_or(false);
    if has_changes && !force {
        return Err(
            "Worktree contains changes. Review the changed files, then choose recovery cleanup explicitly."
                .to_string(),
        );
    }
    let recovery = if has_changes {
        Some(create_worktree_recovery(
            &target, &base_ref, &role, &slug, &status,
        )?)
    } else {
        None
    };
    let mut command = Command::new("git");
    command
        .args(["-C"])
        .arg(&git_root)
        .args(["worktree", "remove"]);
    if force {
        command.arg("--force");
    }
    command.arg(&target);
    let output = command_output_with_timeout(command, Duration::from_secs(30))?;
    if !output.status.success() {
        return Err(format!(
            "Git worktree removal failed: {}",
            redact_bounded(&String::from_utf8_lossy(&output.stderr))
        ));
    }
    let _ = git_output(&git_root, &["worktree", "prune"], Duration::from_secs(10));
    remove_worktree_record(&target)?;
    persist_log(
        "info",
        "worktree-remove",
        "Experimental managed worktree removed",
    );
    Ok(json!({
        "ok": true,
        "removed": true,
        "recoveryPath": recovery.map(|path| path.to_string_lossy().to_string()),
        "redacted": true
    }))
}

#[tauri::command]
async fn remove_worktree(
    project_path: String,
    role: String,
    slug: String,
    confirm: bool,
    force: bool,
) -> Result<Value, String> {
    run_blocking("worktree cleanup", move || {
        remove_worktree_blocking(project_path, role, slug, confirm, force)
    })
    .await
}

#[tauri::command]
fn scope_plan(assignments: Value, shared_paths: Option<Vec<String>>) -> Result<Value, String> {
    Ok(scope_plan_value(
        assignments,
        shared_paths.unwrap_or_default(),
    ))
}

#[tauri::command]
fn live_check_preview(provider: String, model: String, test: String) -> Result<Value, String> {
    let Some((executed_test, covered_checks)) = live_check_definition(&test) else {
        return Err("Unsupported live check test".to_string());
    };
    let provider_matches = allowed_provider(&provider)
        && valid_model_argument(&model)
        && model.starts_with(&format!("{provider}/"));
    if !provider_matches {
        return Err("Provider and model do not match".to_string());
    }
    let (billing_type, billing_source) = live_check_billing(&provider);
    Ok(json!({
        "provider": provider,
        "model": model,
        "test": test,
        "coveredChecks": covered_checks,
        "billingType": billing_type,
        "billingSource": billing_source,
        "estimatedCostNote": if matches!(provider.as_str(), "opencode-go" | "qwen-plan") { "Uses the selected subscription allowance; automatic Zen/PAYG fallback is disabled. Execution requires a separate explicit confirmation." } else if executed_test == "upstream-native-agent-capability" { "Runs two real Codex tool-use attempts and may consume provider quota; execution requires a separate explicit confirmation." } else { "Runs Router's billed compatibility suite (basic response, streaming, tool calling and compaction); execution requires a separate explicit confirmation." },
        "requiresConfirmation": true
    }))
}

#[tauri::command]
async fn app_server_probe(confirm: bool) -> Result<Value, String> {
    run_blocking("App Server probe", move || {
        app_server_probe_blocking(confirm)
    })
    .await
}

fn app_server_probe_blocking(confirm: bool) -> Result<Value, String> {
    if !confirm {
        return Err("App Server probe requires explicit confirmation".to_string());
    }
    if !app_server_enabled()? {
        return Err("Enable the App Server experimental feature flag before probing".to_string());
    }
    let executable = find_codex().ok_or_else(|| "Codex executable was not detected".to_string())?;
    let result = codex_app_server_probe(&executable)?;
    persist_log(
        if result["ok"].as_bool() == Some(true) {
            "info"
        } else {
            "warn"
        },
        "app-server-probe",
        if result["ok"].as_bool() == Some(true) {
            "Codex App Server initialize handshake completed"
        } else {
            "Codex App Server initialize handshake was rejected"
        },
    );
    Ok(result)
}

fn valid_model_argument(model: &str) -> bool {
    !model.is_empty()
        && model.len() <= 160
        && model
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_./:".contains(character))
}

fn live_check_definition(test: &str) -> Option<(&'static str, &'static [&'static str])> {
    match test {
        "compatibility" => Some((
            "upstream-router-compatibility-suite",
            &["basic response", "streaming", "tool calling", "compaction"],
        )),
        "agent-behavior" => Some((
            "upstream-native-agent-capability",
            &["two real Codex exec tool-use attempts"],
        )),
        _ => None,
    }
}

fn live_check_billing(provider: &str) -> (&'static str, &'static str) {
    match provider {
        "qwen-plan" => ("subscription", "Alibaba/Qwen Token Plan allowance"),
        "opencode-go" => ("subscription", "OpenCode Go subscription allowance"),
        "grok-oauth" => ("subscription", "SuperGrok OAuth subscription allowance"),
        "kimi-api" => ("payg", "Kimi Platform API balance"),
        "grok-api" => ("payg", "xAI API balance"),
        _ => ("payg", "Provider-billed usage"),
    }
}

fn run_agent_behavior_check(model: &str) -> Result<Value, String> {
    let root = router_root();
    let script = root.join("src").join("agent-check.mjs");
    if !script.is_file() {
        return Err("Pinned Router agent capability script was not detected".to_string());
    }
    let mut command = Command::new("node");
    command.current_dir(&root).arg(script).arg(model);
    let output = match command_output_with_timeout(command, Duration::from_secs(900)) {
        Ok(output) => output,
        Err(error) => {
            persist_log("error", "agent-behavior", &error);
            return Err(error);
        }
    };
    let result = json!({
        "ok": output.status.success(),
        "status": output.status.code().unwrap_or(-1),
        "operation": "agent-behavior",
        "stdout": redact_bounded(&String::from_utf8_lossy(&output.stdout)),
        "stderr": redact_bounded(&String::from_utf8_lossy(&output.stderr))
    });
    if !result["ok"].as_bool().unwrap_or(false) {
        persist_log(
            "error",
            "agent-behavior",
            &format!(
                "Native agent capability check exited with status {}",
                result["status"]
            ),
        );
    }
    Ok(result)
}

#[tauri::command]
async fn run_live_check(
    provider: String,
    model: String,
    test: String,
    confirm: bool,
) -> Result<Value, String> {
    run_blocking("live provider check", move || {
        run_live_check_blocking(provider, model, test, confirm)
    })
    .await
}

fn run_live_check_blocking(
    provider: String,
    model: String,
    test: String,
    confirm: bool,
) -> Result<Value, String> {
    if !confirm {
        return Err("Live check requires explicit confirmation".to_string());
    }
    if !allowed_provider(&provider) || !valid_model_argument(&model) {
        return Err("Live check provider or model is not allow-listed".to_string());
    }
    let expected_prefix = format!("{provider}/");
    if !model.starts_with(&expected_prefix) {
        return Err("Provider and model do not match".to_string());
    }
    let Some((executed_test, covered_checks)) = live_check_definition(&test) else {
        return Err("Unsupported live check test".to_string());
    };
    let Some((script, target_wrapper)) = router_launcher() else {
        return Err("Managed Router checkout was not detected".to_string());
    };
    let result = if test == "agent-behavior" {
        run_agent_behavior_check(&model)?
    } else {
        let logical_args = vec![
            "codex".to_string(),
            "test-model".to_string(),
            model.clone(),
            "--live".to_string(),
            "--yes".to_string(),
            "--json".to_string(),
        ];
        let args: Vec<String> = if target_wrapper {
            logical_args
        } else {
            logical_args.into_iter().skip(1).collect()
        };
        run_router_script_with_timeout(&script, &args, "live-check", Duration::from_secs(180))?
    };
    let record = sanitized_live_check_record(&provider, &model, &test, executed_test, &result);
    persist_live_check_record(&record)?;
    Ok(json!({
        "provider": provider,
        "model": model,
        "requestedTest": test,
        "executedTest": executed_test,
        "coveredChecks": covered_checks,
        "recorded": true,
        "requiresConfirmation": false,
        "redacted": true,
        "result": result
    }))
}

#[tauri::command]
async fn record_usage_event(event: Value) -> Result<Value, String> {
    run_blocking("usage write", move || record_usage_event_blocking(event)).await
}

fn record_usage_event_blocking(event: Value) -> Result<Value, String> {
    let id = event["id"]
        .as_str()
        .ok_or_else(|| "Usage event id is required".to_string())?;
    let timestamp = event["timestamp"]
        .as_str()
        .ok_or_else(|| "Usage event timestamp is required".to_string())?;
    persist_json_row("usage_events", id, timestamp, &event)?;
    Ok(event)
}

#[tauri::command]
async fn get_pricing_rules() -> Result<Value, String> {
    run_blocking("pricing read", get_pricing_rules_blocking).await
}

fn get_pricing_rules_blocking() -> Result<Value, String> {
    let connection = open_state_db()?;
    Ok(Value::Array(load_pricing_rules(&connection)?))
}

#[tauri::command]
async fn preview_pricing_rules(rules: Vec<Value>) -> Result<Value, String> {
    run_blocking("pricing preview", move || pricing_import_preview(&rules)).await
}

#[tauri::command]
async fn save_pricing_rules(
    rules: Vec<Value>,
    preview_token: Option<String>,
    confirm: bool,
) -> Result<Value, String> {
    run_blocking("pricing write", move || {
        save_pricing_rules_blocking(rules, preview_token, confirm)
    })
    .await
}

fn save_pricing_rules_blocking(
    rules: Vec<Value>,
    preview_token: Option<String>,
    confirm: bool,
) -> Result<Value, String> {
    if !confirm {
        return Err("Saving pricing rules requires explicit confirmation".to_string());
    }
    let preview = pricing_import_preview(&rules)?;
    if preview_token.as_deref() != preview["token"].as_str() {
        return Err("Pricing rules changed after preview; review them again".to_string());
    }
    persist_pricing_rules(&rules)?;
    Ok(json!({
        "ok": true,
        "count": rules.len(),
        "previewToken": preview["token"],
        "message": "Pricing rules version saved locally; historical versions are retained."
    }))
}

#[tauri::command]
async fn save_feature_flags(flags: Value, confirm: bool) -> Result<Value, String> {
    run_blocking("feature flags", move || {
        save_feature_flags_blocking(flags, confirm)
    })
    .await
}

fn save_feature_flags_blocking(flags: Value, confirm: bool) -> Result<Value, String> {
    if !confirm {
        return Err("Saving feature flags requires explicit confirmation".to_string());
    }
    if !flags.is_object() {
        return Err("Feature flags must be an object".to_string());
    }
    let safe_flags = json!({
        "appServer": flags["appServer"].as_bool().unwrap_or(false),
        "mcp": flags["mcp"].as_bool().unwrap_or(false),
        "experimentalWorktrees": flags["experimentalWorktrees"].as_bool().unwrap_or(false)
    });
    let connection = open_state_db()?;
    persist_setting_value(&connection, "featureFlags", &safe_flags)?;
    persist_log(
        "info",
        "feature-flags",
        "Feature flags changed locally; experimental boundaries remain explicit",
    );
    Ok(json!({ "ok": true, "featureFlags": safe_flags }))
}

#[tauri::command]
async fn export_profile() -> Result<Value, String> {
    run_blocking("profile export", || {
        let snapshot = load_snapshot_state(base_snapshot_local(), false)?;
        Ok(json!({
            "schemaVersion": 1,
            "exportedAt": now(),
            "privacy": "profile only; credential values, prompts and response bodies excluded",
            "budget": snapshot["budget"],
            "pricingRules": snapshot["pricingRules"],
            "featureFlags": snapshot["featureFlags"],
            "frontendStrategy": snapshot["frontendStrategy"],
            "projects": snapshot["projects"],
            "agents": snapshot["agents"]
        }))
    })
    .await
}

#[tauri::command]
async fn import_profile(payload: Value, confirm: bool) -> Result<Value, String> {
    run_blocking("profile import", move || {
        import_profile_blocking(payload, confirm)
    })
    .await
}

fn import_profile_blocking(payload: Value, confirm: bool) -> Result<Value, String> {
    if !confirm {
        return Err("Importing a profile requires explicit confirmation".to_string());
    }
    if !payload.is_object() {
        return Err("Profile payload must be an object".to_string());
    }
    let connection = open_state_db()?;
    let mut imported = Vec::new();
    if let Some(budget) = payload.get("budget") {
        let monthly_limit = budget["monthlyLimit"]
            .as_f64()
            .ok_or_else(|| "Profile budget monthlyLimit is invalid".to_string())?;
        let warning = budget["warningAtPercent"]
            .as_f64()
            .ok_or_else(|| "Profile budget warningAtPercent is invalid".to_string())?;
        let critical = budget["criticalAtPercent"]
            .as_f64()
            .ok_or_else(|| "Profile budget criticalAtPercent is invalid".to_string())?;
        if !monthly_limit.is_finite()
            || !(0.0..=100_000_000.0).contains(&monthly_limit)
            || !warning.is_finite()
            || !(0.0..=100.0).contains(&warning)
            || !critical.is_finite()
            || !(0.0..=100.0).contains(&critical)
            || !matches!(budget["currency"].as_str(), Some("USD" | "CLP"))
        {
            return Err("Profile budget is outside the safe range".to_string());
        }
        persist_setting_value(&connection, "budget", budget)?;
        imported.push("budget");
    }
    if let Some(rules) = payload.get("pricingRules").and_then(Value::as_array) {
        persist_pricing_rules(rules)?;
        imported.push("pricingRules");
    }
    if let Some(flags) = payload.get("featureFlags") {
        let safe_flags = json!({
            "appServer": flags["appServer"].as_bool().unwrap_or(false),
            "mcp": flags["mcp"].as_bool().unwrap_or(false),
            "experimentalWorktrees": flags["experimentalWorktrees"].as_bool().unwrap_or(false)
        });
        persist_setting_value(&connection, "featureFlags", &safe_flags)?;
        imported.push("featureFlags");
    }
    if let Some(strategy) = payload.get("frontendStrategy") {
        if !valid_frontend_strategy(strategy) {
            return Err("Profile frontend strategy is invalid".to_string());
        }
        persist_setting_value(&connection, "frontendStrategy", strategy)?;
        imported.push("frontendStrategy");
    }
    if let Some(agents) = payload.get("agents").and_then(Value::as_array) {
        if !valid_agent_collection(agents) {
            return Err("Profile agents are incomplete or invalid".to_string());
        }
        let normalized = agents
            .iter()
            .map(validate_agent_definition)
            .collect::<Result<Vec<_>, _>>()?;
        persist_setting_value(&connection, "agentDefinitions", &Value::Array(normalized))?;
        imported.push("agents");
    }
    drop(connection);
    let mut imported_projects = 0;
    let mut skipped_projects = 0;
    if let Some(projects) = payload.get("projects").and_then(Value::as_array) {
        if projects.len() > 100 {
            return Err("Profile projects are limited to 100 entries".to_string());
        }
        for project in projects {
            let path = project["path"]
                .as_str()
                .ok_or_else(|| "Profile project path is invalid".to_string())?;
            let root = match safe_project_root(path) {
                Ok(root) => root,
                Err(_) => {
                    skipped_projects += 1;
                    continue;
                }
            };
            let profile = imported_project_profile(&root, project)?;
            persist_project(&profile)?;
            imported_projects += 1;
        }
        imported.push("projects");
    }
    persist_log(
        "info",
        "profile-import",
        "Redacted profile imported locally",
    );
    Ok(json!({
        "ok": true,
        "imported": imported,
        "importedProjects": imported_projects,
        "skippedProjects": skipped_projects,
        "projectPaths": "only existing local directories were re-registered"
    }))
}

#[tauri::command]
async fn restore_backup(target: String, backup: String, confirm: bool) -> Result<Value, String> {
    run_blocking("backup restore", move || {
        restore_backup_blocking(target, backup, confirm)
    })
    .await
}

fn restore_backup_blocking(target: String, backup: String, confirm: bool) -> Result<Value, String> {
    if !confirm {
        return Err("Restoring a backup requires explicit confirmation".to_string());
    }
    let (target, backup) = safe_backup_pair(&target, &backup)?;
    let contents = fs::read_to_string(&backup)
        .map_err(|error| format!("Backup could not be read: {error}"))?;
    let record = atomic_write_file(&target, &contents)?;
    persist_backup(
        &target.to_string_lossy(),
        "rollback",
        record.backup.as_deref().and_then(|path| path.to_str()),
    )?;
    Ok(json!({
        "ok": true,
        "target": target,
        "restoredFrom": backup,
        "rollbackBackup": record.backup
    }))
}

fn support_health_report(report: &Value) -> Value {
    let checks = report["checks"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|check| {
            json!({
                "id": check["id"],
                "label": check["label"],
                "status": check["status"],
                "checkedAt": check["checkedAt"]
            })
        })
        .collect::<Vec<_>>();
    json!({
        "id": report["id"],
        "status": report["status"],
        "startedAt": report["startedAt"],
        "completedAt": report["completedAt"],
        "checks": checks,
        "redacted": true
    })
}

fn support_bundle_value(snapshot: &Value) -> Value {
    let providers = snapshot["providers"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|provider| {
            json!({
                "id": provider["id"],
                "name": provider["name"],
                "credential": provider["credential"],
                "enabled": provider["enabled"],
                "billingType": provider["billingType"],
                "lastChecked": provider["lastChecked"]
            })
        })
        .collect::<Vec<_>>();
    let models = snapshot["models"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|model| {
            json!({
                "id": model["id"],
                "providerId": model["providerId"],
                "available": model["available"],
                "supportsTools": model["supportsTools"],
                "supportsSubagents": model["supportsSubagents"],
                "source": model["source"]
            })
        })
        .collect::<Vec<_>>();
    let agents = snapshot["agents"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|agent| {
            json!({
                "role": agent["role"],
                "providerId": agent["providerId"],
                "modelId": agent["modelId"],
                "reasoningEffort": agent["reasoningEffort"],
                "health": agent["health"],
                "lastTest": agent["lastTest"]
            })
        })
        .collect::<Vec<_>>();
    let diagnostics = snapshot["diagnostics"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|item| {
            json!({
                "id": item["id"],
                "category": item["category"],
                "label": item["label"],
                "status": item["status"]
            })
        })
        .collect::<Vec<_>>();
    let health_history = snapshot["healthHistory"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .take(10)
        .map(|report| support_health_report(&report))
        .collect::<Vec<_>>();
    let recent_errors = snapshot["logs"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|log| log["level"].as_str() == Some("error"))
        .take(20)
        .map(|log| {
            json!({
                "id": log["id"],
                "timestamp": log["timestamp"],
                "level": "error",
                "operation": log["operation"],
                "message": "Error detail retained only in local Orchestra logs"
            })
        })
        .collect::<Vec<_>>();
    json!({
        "schemaVersion": 3,
        "createdAt": now(),
        "privacy": {
            "redacted": true,
            "excluded": [
                "credential and OAuth values",
                "prompts and responses",
                "command output and arguments",
                "project, backup, executable and configuration paths",
                "native Codex thread and turn IDs"
            ]
        },
        "app": { "version": snapshot["appVersion"] },
        "codex": {
            "detected": snapshot["codex"]["detected"],
            "version": snapshot["codex"]["version"],
            "login": snapshot["codex"]["login"],
            "configDetected": snapshot["codex"]["configDetected"],
            "configHealth": snapshot["codex"]["configHealth"],
            "source": snapshot["codex"]["source"]
        },
        "router": {
            "detected": snapshot["router"]["detected"],
            "version": snapshot["router"]["version"],
            "pinnedRef": snapshot["router"]["pinnedRef"],
            "health": snapshot["router"]["health"],
            "service": snapshot["router"]["service"],
            "loopbackPorts": snapshot["router"]["ports"]
        },
        "providers": providers,
        "models": models,
        "agents": agents,
        "diagnostics": diagnostics,
        "healthHistory": health_history,
        "recentErrors": recent_errors,
        "counts": {
            "projects": snapshot["projects"].as_array().map(Vec::len).unwrap_or(0),
            "usageEvents": snapshot["usage"].as_array().map(Vec::len).unwrap_or(0),
            "backups": snapshot["backups"].as_array().map(Vec::len).unwrap_or(0),
            "delegationEvidence": snapshot["delegationEvidence"].as_array().map(Vec::len).unwrap_or(0)
        },
        "update": {
            "currentRef": snapshot["update"]["currentRef"],
            "targetRef": snapshot["update"]["targetRef"],
            "targetVersion": snapshot["update"]["targetVersion"],
            "status": snapshot["update"]["status"]
        }
    })
}

#[tauri::command]
async fn export_support_bundle() -> Result<Value, String> {
    run_blocking("support bundle", || {
        let snapshot = load_snapshot_state(base_snapshot_local(), false)?;
        Ok(support_bundle_value(&snapshot))
    })
    .await
}

#[tauri::command]
async fn mcp_server_info() -> Result<Value, String> {
    run_blocking("MCP info", mcp_server_info_blocking).await
}

fn mcp_server_info_blocking() -> Result<Value, String> {
    let executable = env::current_exe()
        .map_err(|error| format!("Orchestra executable path is unavailable: {error}"))?;
    Ok(json!({
        "enabled": mcp_enabled()?,
        "name": "codex-orchestra",
        "transport": "stdio",
        "command": executable.to_string_lossy(),
        "args": ["--mcp-stdio"],
        "tools": ["orchestra_status", "orchestra_usage_summary", "orchestra_scope_plan", "orchestra_sync_status"],
        "writes": false,
        "instructions": "In ChatGPT desktop: Settings > MCP servers > Add server > STDIO. Use this executable as command and --mcp-stdio as its only argument. Restart after saving.",
        "redacted": true
    }))
}

fn mcp_status() -> Result<Value, String> {
    let snapshot = load_snapshot_state(base_snapshot(), false)?;
    let providers = snapshot["providers"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|provider| {
            json!({
                "id": provider["id"],
                "enabled": provider["enabled"],
                "credential": provider["credential"]
            })
        })
        .collect::<Vec<_>>();
    let agents = snapshot["agents"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|agent| {
            json!({
                "role": agent["role"],
                "provider": agent["providerId"],
                "model": agent["modelId"],
                "health": agent["health"]
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "appVersion": snapshot["appVersion"],
        "codex": {
            "detected": snapshot["codex"]["detected"],
            "version": snapshot["codex"]["version"],
            "login": snapshot["codex"]["login"]
        },
        "router": {
            "detected": snapshot["router"]["detected"],
            "version": snapshot["router"]["version"],
            "health": snapshot["router"]["health"],
            "service": snapshot["router"]["service"]
        },
        "providers": providers,
        "agents": agents,
        "lastHealth": snapshot["health"]["status"],
        "redacted": true
    }))
}

fn mcp_usage_summary() -> Result<Value, String> {
    let connection = open_state_db()?;
    let events = load_json_rows(
        &connection,
        "SELECT payload FROM usage_events ORDER BY timestamp DESC",
    )?;
    let mut input_tokens = 0_u64;
    let mut cached_input_tokens = 0_u64;
    let mut output_tokens = 0_u64;
    let mut provider_reported = 0.0_f64;
    let mut estimated = 0.0_f64;
    for event in &events {
        input_tokens = input_tokens.saturating_add(event["inputTokens"].as_u64().unwrap_or(0));
        cached_input_tokens =
            cached_input_tokens.saturating_add(event["cachedInputTokens"].as_u64().unwrap_or(0));
        output_tokens = output_tokens.saturating_add(event["outputTokens"].as_u64().unwrap_or(0));
        provider_reported += event["providerCost"].as_f64().unwrap_or(0.0);
        estimated += event["estimatedCost"].as_f64().unwrap_or(0.0);
    }
    Ok(json!({
        "eventCount": events.len(),
        "inputTokens": input_tokens,
        "cachedInputTokens": cached_input_tokens,
        "outputTokens": output_tokens,
        "providerReportedCost": provider_reported,
        "estimatedCost": estimated,
        "currency": "USD",
        "note": "Reported and estimated values remain separate.",
        "redacted": true
    }))
}

fn mcp_scope_plan(arguments: &Value) -> Result<Value, String> {
    let assignments = arguments
        .get("assignments")
        .filter(|value| value.is_object())
        .cloned()
        .ok_or_else(|| "assignments must be an object".to_string())?;
    for role in ["root", "frontend", "engineer"] {
        let paths = assignment_paths(&assignments, role);
        if paths.len() > 100 || paths.iter().any(|path| path.is_empty() || path.len() > 256) {
            return Err("Each role may provide up to 100 bounded path patterns".to_string());
        }
    }
    let shared_paths = arguments
        .get("sharedPaths")
        .and_then(Value::as_array)
        .map(|paths| {
            paths
                .iter()
                .filter_map(Value::as_str)
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if shared_paths.len() > 100
        || shared_paths
            .iter()
            .any(|path| path.is_empty() || path.len() > 256)
    {
        return Err("sharedPaths may contain up to 100 bounded path patterns".to_string());
    }
    Ok(scope_plan_value(assignments, shared_paths))
}

fn mcp_sync_status() -> Result<Value, String> {
    let snapshot = load_snapshot_state(base_snapshot(), false)?;
    let projects = snapshot["projects"].as_array().map(Vec::len).unwrap_or(0);
    let agents = snapshot["agents"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|agent| {
            json!({
                "role": agent["role"],
                "model": agent["modelId"],
                "health": agent["health"]
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "registeredProjectCount": projects,
        "agents": agents,
        "managedArtifacts": [
            ".codex/agents/orchestra_frontend.toml",
            ".codex/agents/orchestra_engineer.toml",
            ".codex/agents/orchestra_visual.toml",
            ".codex/skills/orchestra-routing/SKILL.md",
            ".codex/config.toml",
            "AGENTS.md managed block"
        ],
        "mutationAvailable": false,
        "nextAction": "Use Orchestra's reviewed Setup flow to preview or apply changes.",
        "redacted": true
    }))
}

fn mcp_tools() -> Value {
    let annotations = json!({
        "readOnlyHint": true,
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false
    });
    json!([
        {
            "name": "orchestra_status",
            "description": "Read redacted local Codex, Router, provider and agent status without running Doctor or a model request.",
            "inputSchema": {"type":"object","properties":{},"additionalProperties":false},
            "annotations": annotations.clone()
        },
        {
            "name": "orchestra_usage_summary",
            "description": "Read aggregate local token and cost metadata. Reported and estimated values remain separate.",
            "inputSchema": {"type":"object","properties":{},"additionalProperties":false},
            "annotations": annotations.clone()
        },
        {
            "name": "orchestra_scope_plan",
            "description": "Check frontend/engineer ownership patterns for overlap. This does not create worktrees or edit files.",
            "inputSchema": {
                "type":"object",
                "required":["assignments"],
                "properties": {
                    "assignments": {
                        "type":"object",
                        "properties": {
                            "root":{"type":"array","items":{"type":"string"}},
                            "frontend":{"type":"array","items":{"type":"string"}},
                            "engineer":{"type":"array","items":{"type":"string"}}
                        },
                        "additionalProperties":false
                    },
                    "sharedPaths":{"type":"array","items":{"type":"string"}}
                },
                "additionalProperties":false
            },
            "annotations": annotations.clone()
        },
        {
            "name": "orchestra_sync_status",
            "description": "Read the logical team bindings and managed artifact inventory. Applying changes remains UI-only and confirmation-gated.",
            "inputSchema": {"type":"object","properties":{},"additionalProperties":false},
            "annotations": annotations
        }
    ])
}

fn mcp_result(value: Value) -> Value {
    json!({
        "content": [{"type":"text","text": value.to_string()}],
        "structuredContent": value,
        "isError": false
    })
}

fn mcp_error_result(message: &str) -> Value {
    json!({
        "content": [{"type":"text","text": redact_bounded(message)}],
        "isError": true
    })
}

fn mcp_response(request: &Value) -> Option<Value> {
    let id = request.get("id").cloned();
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    if id.is_none() {
        return None;
    }
    let id = id.unwrap_or(Value::Null);
    let response = match method {
        "initialize" => json!({
            "protocolVersion": request["params"]["protocolVersion"]
                .as_str()
                .unwrap_or("2025-06-18"),
            "capabilities": {"tools": {"listChanged": false}},
            "serverInfo": {"name":"codex-orchestra","version":"0.1.0"},
            "instructions": "Read-only local Orchestra control-plane facts. Never claim these tools apply config, authenticate providers, run paid checks, merge worktrees, or execute model turns. Use Orchestra's UI for every mutation and confirmation gate. Provider credentials, prompts, responses, config contents and project paths are excluded."
        }),
        "ping" => json!({}),
        "tools/list" => json!({"tools": mcp_tools()}),
        "tools/call" => {
            let name = request["params"]["name"].as_str().unwrap_or("");
            let arguments = request["params"]
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let result = match name {
                "orchestra_status" => mcp_status(),
                "orchestra_usage_summary" => mcp_usage_summary(),
                "orchestra_scope_plan" => mcp_scope_plan(&arguments),
                "orchestra_sync_status" => mcp_sync_status(),
                _ => Err("Unknown Orchestra MCP tool".to_string()),
            };
            return Some(json!({
                "jsonrpc":"2.0",
                "id": id,
                "result": match result {
                    Ok(value) => mcp_result(value),
                    Err(error) => mcp_error_result(&error)
                }
            }));
        }
        _ => {
            return Some(json!({
                "jsonrpc":"2.0",
                "id": id,
                "error":{"code":-32601,"message":"Method not found"}
            }));
        }
    };
    Some(json!({"jsonrpc":"2.0","id":id,"result":response}))
}

pub fn run_mcp_stdio() -> Result<(), String> {
    if !mcp_enabled()? {
        return Err(
            "Orchestra MCP is disabled. Enable it explicitly in Settings first.".to_string(),
        );
    }
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut reader = stdin.lock();
    let mut writer = stdout.lock();
    loop {
        let mut line = String::new();
        let bytes = reader
            .read_line(&mut line)
            .map_err(|error| format!("MCP stdin read failed: {error}"))?;
        if bytes == 0 {
            return Ok(());
        }
        let response = if line.len() > 1_000_000 {
            Some(
                json!({"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Request too large"}}),
            )
        } else {
            match serde_json::from_str::<Value>(line.trim()) {
                Ok(request) => mcp_response(&request),
                Err(_) => Some(
                    json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}),
                ),
            }
        };
        if let Some(response) = response {
            writeln!(writer, "{response}")
                .map_err(|error| format!("MCP stdout write failed: {error}"))?;
            writer
                .flush()
                .map_err(|error| format!("MCP stdout flush failed: {error}"))?;
        }
    }
}

fn tray_usage_rows() -> Vec<(String, u64)> {
    let Ok(connection) = open_state_db() else {
        return Vec::new();
    };
    let Ok(events) = load_json_rows(
        &connection,
        "SELECT payload FROM usage_events ORDER BY timestamp DESC",
    ) else {
        return Vec::new();
    };
    let mut totals: HashMap<String, u64> = HashMap::new();
    for event in events {
        let provider = event["provider"].as_str().unwrap_or("unknown");
        let model = event["model"].as_str().unwrap_or("unknown");
        let tokens = event["inputTokens"].as_u64().unwrap_or(0)
            + event["outputTokens"].as_u64().unwrap_or(0);
        *totals.entry(format!("{provider} · {model}")).or_default() += tokens;
    }
    let mut rows: Vec<_> = totals.into_iter().collect();
    rows.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
    rows
}

fn tray_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    let heading = MenuItem::with_id(app, "usage_heading", "Uso observado", false, None::<&str>)?;
    menu.append(&heading)?;
    let rows = tray_usage_rows();
    if rows.is_empty() {
        let empty = MenuItem::with_id(
            app,
            "usage_empty",
            "Sin datos observados",
            false,
            None::<&str>,
        )?;
        menu.append(&empty)?;
    } else {
        for (index, (label, tokens)) in rows.into_iter().enumerate() {
            let text = format!("{label}: {tokens} tokens");
            let item =
                MenuItem::with_id(app, format!("usage_row_{index}"), text, false, None::<&str>)?;
            menu.append(&item)?;
        }
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        "open_usage",
        "Abrir uso",
        true,
        None::<&str>,
    )?)?;
    menu.append(&MenuItem::with_id(
        app,
        "refresh_usage",
        "Actualizar",
        true,
        None::<&str>,
    )?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        "quit",
        "Salir",
        true,
        None::<&str>,
    )?)?;
    Ok(menu)
}

fn open_usage_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        let _ = window.emit("orchestra-open-usage", json!({}));
    }
}

fn refresh_tray(app: &tauri::AppHandle) {
    if let (Some(tray), Ok(menu)) = (app.tray_by_id("orchestra-usage"), tray_menu(app)) {
        let _ = tray.set_menu(Some(menu));
    }
}

pub fn run() {
    tauri::Builder::default()
        .manage(AppServerState::default())
        .setup(|app| {
            let menu = tray_menu(app.handle())?;
            let mut tray = TrayIconBuilder::with_id("orchestra-usage")
                .menu(&menu)
                .tooltip("Codex Orchestra · uso por modelo")
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open_usage" => open_usage_window(app),
                    "refresh_usage" => refresh_tray(app),
                    "quit" => app.exit(0),
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            get_snapshot_fast,
            run_health_check,
            router_runtime_status,
            router_runtime_health,
            router_runtime_start,
            router_runtime_restart,
            router_runtime_logs,
            router_operation,
            managed_preview,
            apply_managed_changes,
            open_provider_helper,
            set_provider_enabled,
            open_model_curation,
            apply_codex_picker_allowlist_command,
            install_router,
            open_router_setup,
            add_project,
            update_project_profile,
            save_frontend_strategy,
            update_agent_definition,
            worktree_preview,
            create_worktree,
            worktree_status,
            list_worktrees,
            remove_worktree,
            scope_plan,
            live_check_preview,
            app_server_probe,
            start_codex_execution,
            steer_codex_execution,
            interrupt_codex_execution,
            resolve_codex_approval,
            close_codex_execution,
            run_live_check,
            record_usage_event,
            get_pricing_rules,
            preview_pricing_rules,
            save_pricing_rules,
            save_feature_flags,
            export_profile,
            import_profile,
            restore_backup,
            export_support_bundle,
            mcp_server_info
        ])
        .run(tauri::generate_context!())
        .expect("error while running Codex Orchestra");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn isolated_router_env() -> (PathBuf, PathBuf) {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("codex-orchestra-router-runtime-{stamp}"));
        let home = root.join("codex-home");
        let state = home.join("codex-router");
        let managed = root.join("managed-router");
        fs::create_dir_all(&state).unwrap();
        fs::create_dir_all(managed.join("src")).unwrap();
        env::set_var("CODEX_HOME", &home);
        env::set_var("CODEX_ROUTER_STATE_DIR", &state);
        env::set_var("CODEX_ORCHESTRA_ROUTER_ROOT", &managed);
        env::remove_var("MODEL_ROUTER_STATE_DIR");
        env::remove_var("KIMI_CODEX_STATE_DIR");
        (root, state)
    }

    #[test]
    fn router_health_marks_connection_failures_and_stays_redacted() {
        assert!(looks_like_router_connection_failure(
            "os error 10061: Connection refused",
        ));
        assert!(looks_like_router_connection_failure("ECONNREFUSED 127.0.0.1:4202"));
        assert!(!looks_like_router_connection_failure("provider expired"));
        let (root, _state) = isolated_router_env();
        let health = router_health_value(false);
        assert_eq!(health["redacted"], true);
        assert!(health.get("healthy").is_some());
        assert!(!health["message"]
            .as_str()
            .unwrap()
            .to_ascii_lowercase()
            .contains("users\\lenov"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn router_start_is_blocked_without_confirm_when_execution_is_active() {
        let (root, _state) = isolated_router_env();
        let result = recover_router_process(false, true, true);
        assert_eq!(result["ok"], false);
        assert_eq!(result["issue"], "active-execution");
        assert_eq!(result["health"]["requiresConfirmation"], true);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn router_start_script_prefers_state_dir_not_a_hardcoded_user_path() {
        let (root, state) = isolated_router_env();
        fs::write(state.join("start-codex-router.cmd"), "@echo off\n").unwrap();
        let resolved = router_start_script(&state).unwrap();
        assert_eq!(resolved.file_name().unwrap(), "start-codex-router.cmd");
        assert!(resolved.starts_with(&state));
        assert!(!resolved.to_string_lossy().to_ascii_lowercase().contains("users\\lenov"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn router_logs_redact_secrets_and_omit_paths() {
        let (root, state) = isolated_router_env();
        fs::write(
            state.join("router.err.log"),
            "api_key=supersecret\nready\n",
        )
        .unwrap();
        let logs = router_logs_value();
        let serialized = logs.to_string();
        assert_eq!(logs["redacted"], true);
        assert!(!serialized.contains("supersecret"));
        assert!(!serialized.contains(&state.to_string_lossy().to_string()));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn router_missing_runtime_does_not_invent_a_start_script() {
        let (root, state) = isolated_router_env();
        assert!(router_start_script(&state).is_none());
        let result = recover_router_process(true, false, true);
        assert_eq!(result["ok"], false);
        assert_eq!(result["restarted"], false);
        assert!(result["message"].as_str().unwrap().contains("not detected"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn app_server_usage_projection_accepts_cumulative_camel_case() {
        let event = json!({
            "method": "thread/tokenUsage/updated",
            "params": {
                "threadId": "opaque-thread-id",
                "tokenUsage": {
                    "total": { "inputTokens": 120, "cachedInputTokens": 20, "outputTokens": 30 }
                }
            }
        });
        let (_, usage) = observed_usage_from_event(&event).expect("usage event");
        assert_eq!(
            usage,
            ObservedTokenUsage {
                input: 120,
                cached_input: 20,
                output: 30
            }
        );
    }

    #[test]
    fn cumulative_usage_only_emits_monotonic_non_zero_deltas() {
        let first = ObservedTokenUsage {
            input: 100,
            cached_input: 20,
            output: 30,
        };
        let next = ObservedTokenUsage {
            input: 160,
            cached_input: 35,
            output: 50,
        };
        assert_eq!(
            next.delta_from(first),
            Some(ObservedTokenUsage {
                input: 60,
                cached_input: 15,
                output: 20
            })
        );
        assert_eq!(next.delta_from(next), None);
        assert_eq!(first.delta_from(next), None);
    }

    #[test]
    fn usage_projection_rejects_unrelated_or_empty_events() {
        assert!(
            observed_usage_from_event(&json!({"method":"turn/completed","params":{}})).is_none()
        );
        assert!(observed_usage_from_event(&json!({
            "method":"thread/tokenUsage/updated",
            "params":{"threadId":"thread","tokenUsage":{"total":{"inputTokens":0,"outputTokens":0}}}
        }))
        .is_none());
    }

    #[test]
    fn managed_block_preserves_foreign_content() {
        let merged = merge_managed_block("# User\n\n<!-- BEGIN CODEX-ORCHESTRA MANAGED -->\nold\n<!-- END CODEX-ORCHESTRA MANAGED -->\n", "new");
        assert!(merged.contains("# User"));
        assert!(merged.contains("new"));
        assert!(!merged.contains("old"));
    }

    #[test]
    fn managed_preview_token_detects_changes_without_echoing_foreign_content() {
        let existing = "# Project\napi_key=foreign-value\n";
        assert_ne!(
            managed_preview_hash(existing),
            managed_preview_hash("# Project\n")
        );
        let summary = managed_preview_summary(existing, "create");
        assert!(summary.contains("Append a new Orchestra-managed block"));
        assert!(!summary.contains("foreign-value"));
    }

    #[test]
    fn redaction_removes_sensitive_line_values() {
        assert!(!redact("api_key=supersecret\n").contains("supersecret"));
    }

    #[test]
    fn support_bundle_uses_an_allowlist_and_excludes_local_paths_and_payloads() {
        let snapshot = json!({
            "appVersion": "0.1.0",
            "codex": {
                "detected": true, "version": "fixture", "login": "configured",
                "configDetected": true, "configHealth": "healthy", "source": "path",
                "executable": "C:\\private\\codex.exe",
                "home": "C:\\Users\\private\\.codex",
                "configPath": "C:\\Users\\private\\.codex\\config.toml"
            },
            "router": {
                "detected": true, "version": "0.4.0-beta.3", "pinnedRef": "signed-ref",
                "health": "healthy", "service": "running", "ports": [4200],
                "root": "D:\\private-router"
            },
            "providers": [{
                "id": "qwen-plan", "name": "Qwen", "credential": "configured",
                "enabled": true, "billingType": "subscription", "lastChecked": "unix:1",
                "baseUrl": "https://example.test/?token=never-persist"
            }],
            "models": [{
                "id": "qwen-plan/qwen3.8-max", "providerId": "qwen-plan",
                "available": true, "supportsTools": true, "supportsSubagents": true,
                "source": "registry"
            }],
            "agents": [{
                "role": "frontend", "providerId": "qwen-plan",
                "modelId": "qwen-plan/qwen3.8-max", "reasoningEffort": "high",
                "health": "healthy"
            }],
            "projects": [{"path": "D:\\secret-project", "name": "private-client"}],
            "usage": [{"projectId": "private-client", "runId": "native-secret-id"}],
            "backups": [{"target": "D:\\secret-project\\AGENTS.md", "backupPath": "D:\\backup"}],
            "delegationEvidence": [{"runId": "native-secret-id"}],
            "diagnostics": [{
                "id": "router", "category": "router", "label": "Router",
                "status": "healthy", "detail": "D:\\private-router"
            }],
            "healthHistory": [],
            "logs": [{
                "id": "error-1", "timestamp": "unix:1", "level": "error",
                "operation": "fixture", "message": "bearer never-persist at D:\\secret-project"
            }],
            "update": {
                "currentRef": "signed-ref", "targetRef": "signed-ref",
                "targetVersion": "0.4.0-beta.3", "status": "current"
            }
        });
        let bundle = support_bundle_value(&snapshot);
        let encoded = bundle.to_string();
        assert_eq!(bundle["schemaVersion"], 3);
        assert_eq!(bundle["counts"]["projects"], 1);
        assert!(bundle.get("snapshot").is_none());
        for excluded in [
            "secret-project",
            "private-client",
            "private-router",
            "never-persist",
            "native-secret-id",
            "config.toml",
        ] {
            assert!(!encoded.contains(excluded), "leaked {excluded}");
        }
    }

    #[test]
    fn health_report_status_preserves_healthy_and_prioritizes_failures() {
        assert_eq!(
            health_report_status(&[json!({"status":"healthy"})]),
            "healthy"
        );
        assert_eq!(
            health_report_status(&[json!({"status":"healthy"}), json!({"status":"unknown"})]),
            "unknown"
        );
        assert_eq!(
            health_report_status(&[json!({"status":"unknown"}), json!({"status":"missing"})]),
            "degraded"
        );
        assert_eq!(
            health_report_status(&[json!({"status":"missing"}), json!({"status":"unhealthy"})]),
            "unhealthy"
        );
    }

    #[test]
    fn atomic_write_backup_and_rollback_stay_on_managed_sibling_paths() {
        let root = std::env::temp_dir().join(format!(
            "codex-orchestra-rust-fixture-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let target = root.join(".codex").join("config.toml");
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, "[agents]\nenabled = false\n").unwrap();

        let record = atomic_write_file(&target, "[agents]\nenabled = true\n").unwrap();
        let backup = record.backup.as_ref().unwrap();
        assert_eq!(
            fs::read_to_string(&target).unwrap(),
            "[agents]\nenabled = true\n"
        );
        assert_eq!(
            safe_backup_pair(&target.to_string_lossy(), &backup.to_string_lossy()).unwrap(),
            (target.clone(), backup.clone())
        );

        rollback_write(&record);
        assert_eq!(
            fs::read_to_string(&target).unwrap(),
            "[agents]\nenabled = false\n"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn generated_paths_are_allowlisted_and_confined() {
        let root = PathBuf::from(r"C:\workspace\demo");
        assert!(safe_generated_target(&root, ".codex/agents/orchestra_frontend.toml").is_ok());
        assert!(safe_generated_target(&root, ".codex/skills/orchestra-routing/SKILL.md").is_ok());
        assert!(safe_generated_target(&root, ".codex/config.toml").is_ok());
        assert!(safe_generated_target(&root, ".env").is_err());
        assert!(safe_generated_target(&root, "../AGENTS.md").is_err());
    }

    #[test]
    fn router_install_uses_the_reviewed_commit_not_main() {
        let fetch = pinned_router_fetch_args();
        assert_eq!(fetch[0], "fetch");
        assert_eq!(fetch[3], "origin");
        assert_eq!(fetch[4], ROUTER_PINNED_COMMIT);
        assert!(!fetch.iter().any(|arg| *arg == "main"));
        assert_eq!(
            pinned_router_checkout_args(),
            ["checkout", "--detach", "FETCH_HEAD"]
        );
    }

    #[test]
    fn subagent_config_merges_without_duplicate_agents_table() {
        let existing = "[agents]\nenabled = false\nmax_depth = 4\ncustom = true\n\n[projects]\n";
        let block = "# BEGIN CODEX-ORCHESTRA MANAGED\n[agents]\nenabled = true\nmax_concurrent_threads_per_session = 2\nmax_depth = 1\n# END CODEX-ORCHESTRA MANAGED";
        let merged = merge_subagent_config(existing, block);
        assert_eq!(merged.matches("[agents]").count(), 1);
        assert!(merged.contains("custom = true"));
        assert!(merged.contains("max_concurrent_threads_per_session = 2"));
        assert!(!merged.contains("max_depth = 4"));
        assert!(merged.contains("[projects]"));
    }

    #[test]
    fn app_server_probe_parser_returns_redacted_handshake_state() {
        let result = app_server_probe_result(&json!({
            "id": 0,
            "result": {
                "serverInfo": {"version": "fixture"},
                "platformFamily": "windows"
            }
        }));
        assert_eq!(result["ok"], true);
        assert_eq!(result["handshake"], "initialized");
        assert_eq!(result["redacted"], true);
    }

    #[test]
    fn delegation_evidence_keeps_only_allowlisted_root_event_fields() {
        let context = DelegationEvidenceContext {
            run_id: "run-local".to_string(),
            root_model: "gpt-5.6-sol".to_string(),
            requested_role: "frontend".to_string(),
            requested_worker_model: Some("qwen-plan/qwen3.8-max".to_string()),
            root_thread_id: "root-secret-id".to_string(),
        };
        let event = json!({
            "method": "item/completed",
            "params": {"item": {
                "type": "collabToolCall",
                "tool": "spawnAgent",
                "status": "completed",
                "senderThreadId": "root-secret-id",
                "newThreadId": "child-secret-id",
                "prompt": "never persist this task or bearer-secret",
                "arguments": {"path": "C:\\private\\project"}
            }}
        });
        let record = delegation_evidence_from_event(&event, &context).unwrap();
        let encoded = record.to_string();
        assert_eq!(record["action"], "spawn-agent");
        assert_eq!(record["childCreated"], true);
        assert_eq!(record["rootMediated"], true);
        assert!(!encoded.contains("root-secret-id"));
        assert!(!encoded.contains("child-secret-id"));
        assert!(!encoded.contains("bearer-secret"));
        assert!(!encoded.contains("private"));
    }

    #[test]
    fn delegation_evidence_rejects_non_root_and_unknown_collab_calls() {
        let context = DelegationEvidenceContext {
            run_id: "run-local".to_string(),
            root_model: "gpt-5.6-sol".to_string(),
            requested_role: "engineer".to_string(),
            requested_worker_model: Some("grok-oauth/grok-4.6".to_string()),
            root_thread_id: "root-thread".to_string(),
        };
        let child_event = json!({
            "method": "item/completed",
            "params": {"item": {
                "type": "collabToolCall",
                "tool": "spawnAgent",
                "status": "completed",
                "senderThreadId": "child-thread"
            }}
        });
        let unknown_event = json!({
            "method": "item/completed",
            "params": {"item": {
                "type": "collabToolCall",
                "tool": "arbitraryTool",
                "status": "completed",
                "senderThreadId": "root-thread"
            }}
        });
        assert!(delegation_evidence_from_event(&child_event, &context).is_none());
        assert!(delegation_evidence_from_event(&unknown_event, &context).is_none());
    }

    #[test]
    fn worktree_spec_is_role_scoped_and_rejects_path_escape() {
        let root = PathBuf::from(r"C:\workspace\demo");
        let (target, slug) = worktree_spec(&root, "frontend", "task-1").unwrap();
        assert_eq!(slug, "task-1");
        assert_eq!(
            target,
            root.join(".codex-orchestra")
                .join("worktrees")
                .join("frontend-task-1")
        );
        assert!(worktree_spec(&root, "root", "task-1").is_err());
        assert!(worktree_spec(&root, "engineer", "..\\secret").is_err());
    }

    #[test]
    fn scope_plan_marks_overlapping_workers_sequential() {
        let plan = scope_plan_value(
            json!({
                "root": ["package.json"],
                "frontend": ["src/**"],
                "engineer": ["src/api/**"]
            }),
            vec!["package.json".to_string()],
        );
        assert_eq!(plan["parallel"], false);
        assert_eq!(plan["worktreeRecommended"], true);
        assert!(!plan["conflicts"].as_array().unwrap().is_empty());
    }

    #[test]
    fn stack_detection_uses_visible_file_names_only() {
        let stack = detected_stack(&[
            "package.json".to_string(),
            "vite.config.ts".to_string(),
            "tailwind.css".to_string(),
        ]);
        assert_eq!(stack, vec!["Node.js", "Vite", "Tailwind"]);
    }

    #[test]
    fn imported_project_profile_only_overlays_safe_local_metadata() {
        let root = std::env::temp_dir().join(format!(
            "codex-orchestra-project-profile-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("package.json"),
            r#"{"scripts":{"test":"node test"}}"#,
        )
        .unwrap();
        let imported = json!({
            "ownership": {
                "root": ["package.json"],
                "frontend": ["src/**"],
                "engineer": ["engine/**"]
            },
            "sharedPaths": ["package.json"],
            "activeTeam": "reviewed-team",
            "routingPolicy": "safe-disjoint-only",
            "knownTests": ["npm test", "cargo test"],
            "lintScript": "npm run lint",
            "typecheckScript": null,
            "name": "untrusted exported name",
            "status": "healthy"
        });
        let profile = imported_project_profile(&root, &imported).unwrap();
        assert_eq!(
            profile["name"].as_str(),
            root.file_name().and_then(|name| name.to_str())
        );
        assert_eq!(profile["activeTeam"], "reviewed-team");
        assert_eq!(profile["routingPolicy"], "safe-disjoint-only");
        assert_eq!(profile["knownTests"], json!(["npm test", "cargo test"]));
        assert_eq!(profile["status"], "unknown");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn router_arguments_keep_the_codex_namespace_and_allowlist() {
        assert_eq!(router_args("install"), vec!["codex", "install"]);
        assert_eq!(router_args("doctor"), vec!["codex", "doctor"]);
        assert_eq!(
            router_args("update-check"),
            vec!["codex", "update", "check"]
        );
        assert_eq!(
            router_args_for_script("refresh-catalog", true),
            vec!["codex", "refresh-catalog"]
        );
        assert_eq!(
            router_args_for_script("refresh-catalog", false),
            vec!["refresh-catalog"]
        );
        assert_eq!(
            router_args_for_script("support-bundle", true),
            vec!["codex", "support-bundle"]
        );
        assert!(router_args("models").is_empty());
        assert!(router_args("arbitrary-command").is_empty());
    }

    #[test]
    fn codex_picker_does_not_hide_community_or_user_models() {
        assert!(visible_codex_model_id("gpt-5.6-sol"));
        assert!(visible_codex_model_id("qwen-plan/qwen3.8-max"));
        assert!(visible_codex_model_id("qwen-plan/glm-5.2"));
        assert!(visible_codex_model_id("my-reseller/demo"));
        assert!(is_safe_provider_id("openrouter"));
        assert!(is_safe_provider_id("my-reseller"));
        assert!(!is_safe_provider_id("openai"));
        assert!(!is_safe_provider_id("OpenRouter/v1"));
        assert!(hidden_codex_model_ids(&[
            "gpt-5.6-sol".to_string(),
            "qwen-plan/glm-5.2".to_string(),
            "my-reseller/demo".to_string(),
        ])
        .is_empty());
    }

    #[test]
    fn provider_toggle_uses_the_upstream_providers_subcommand() {
        assert_eq!(
            provider_toggle_args("kimi-api", true, true),
            vec!["codex", "providers", "enable", "kimi-api"]
        );
        assert_eq!(
            provider_toggle_args("grok-api", false, false),
            vec!["providers", "disable", "grok-api"]
        );
        assert_eq!(
            provider_toggle_args("opencode-go", true, true),
            vec!["codex", "providers", "enable", "opencode-go"]
        );
    }

    #[test]
    fn opencode_go_matching_accepts_router_family_labels_without_matching_zen_as_model() {
        assert!(provider_matches_text("opencode Go/Zen", "opencode-go"));
        assert!(provider_matches_text(
            "provider opencode-go configured",
            "opencode-go"
        ));
        assert!(model_variants("opencode-go/kimi-k3").contains(&"kimi-k3".to_string()));
    }

    #[test]
    fn live_check_kinds_match_the_pinned_router_evidence() {
        let compatibility = live_check_definition("compatibility").unwrap();
        assert_eq!(compatibility.0, "upstream-router-compatibility-suite");
        assert_eq!(
            compatibility.1,
            &["basic response", "streaming", "tool calling", "compaction"]
        );
        let agent = live_check_definition("agent-behavior").unwrap();
        assert_eq!(agent.0, "upstream-native-agent-capability");
        assert_eq!(agent.1, &["two real Codex exec tool-use attempts"]);
        assert!(live_check_definition("tool-use").is_none());
    }

    #[test]
    fn live_check_preview_exposes_billing_before_execution() {
        let subscription = live_check_preview(
            "opencode-go".to_string(),
            "opencode-go/kimi-k3".to_string(),
            "compatibility".to_string(),
        )
        .unwrap();
        assert_eq!(subscription["billingType"], "subscription");
        assert_eq!(
            subscription["billingSource"],
            "OpenCode Go subscription allowance"
        );
        assert_eq!(subscription["requiresConfirmation"], true);

        let payg = live_check_preview(
            "grok-api".to_string(),
            "grok-api/grok-4.6".to_string(),
            "agent-behavior".to_string(),
        )
        .unwrap();
        assert_eq!(payg["billingType"], "payg");
        assert_eq!(payg["billingSource"], "xAI API balance");
    }

    #[test]
    fn live_check_record_keeps_only_safe_metadata() {
        let record = sanitized_live_check_record(
            "kimi-api",
            "kimi-api/kimi-k3",
            "compatibility",
            "upstream-router-compatibility-suite",
            &json!({ "ok": true, "stdout": "api_key=never-store-this" }),
        );
        assert_eq!(record["role"], "frontend");
        assert_eq!(record["status"], "passed");
        assert_eq!(record["model"], "kimi-api/kimi-k3");
        assert!(!record.to_string().contains("never-store-this"));
    }

    #[test]
    fn agent_definition_keeps_role_provider_and_retry_boundaries() {
        let agent = json!({
            "id": "frontend",
            "name": "Orchestra Frontend",
            "role": "frontend",
            "description": "Own the visual implementation.",
            "providerId": "qwen-plan",
            "modelId": "qwen-plan/qwen3.8-max",
            "reasoningEffort": "high",
            "permissions": ["workspace-write"],
            "routingHints": ["a11y"],
            "retryLimit": 1,
            "ownershipPaths": ["src/**"],
            "sharedPaths": ["types/**"],
            "estimatedCostPerMillion": 4.8
        });
        let validated = validate_agent_definition(&agent).unwrap();
        assert_eq!(validated["health"], "unknown");
        assert_eq!(validated["providerId"], "qwen-plan");
        assert!(validated.get("modelTarget").is_none());
        let mut unsafe_retry = agent.clone();
        unsafe_retry["retryLimit"] = json!(2);
        assert!(validate_agent_definition(&unsafe_retry).is_err());
        let mut wrong_provider = agent.clone();
        wrong_provider["providerId"] = json!("OpenRouter/v1");
        assert!(validate_agent_definition(&wrong_provider).is_err());
        let mut community = agent;
        community["providerId"] = json!("openrouter");
        community["modelId"] = json!("openrouter/demo");
        assert!(validate_agent_definition(&community).is_ok());
        let mut with_target = json!({
            "id": "frontend",
            "name": "Orchestra Frontend",
            "role": "frontend",
            "description": "Own the visual implementation.",
            "providerId": "qwen-plan",
            "modelId": "qwen-plan/qwen3.8-max",
            "modelTarget": { "provider": "qwen-plan", "upstreamModel": "qwen3.8-max" },
            "reasoningEffort": "high",
            "permissions": ["workspace-write"],
            "routingHints": ["a11y"],
            "retryLimit": 1,
            "ownershipPaths": ["src/**"],
            "sharedPaths": ["types/**"],
            "estimatedCostPerMillion": 4.8
        });
        let validated_target = validate_agent_definition(&with_target).unwrap();
        assert_eq!(
            validated_target["modelTarget"]["upstreamModel"],
            "qwen3.8-max"
        );
        with_target["modelTarget"] = json!({ "provider": "" });
        assert!(validate_agent_definition(&with_target).is_err());
    }

    #[test]
    fn usable_codex_binary_accepts_store_cli_names() {
        let root = std::env::temp_dir().join(format!(
            "codex-orchestra-codex-bin-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let exe = root.join("codex.exe");
        fs::write(&exe, []).unwrap();
        assert!(usable_codex_binary(&exe));
        assert!(!usable_codex_binary(&root.join("codex-code-mode-host.exe")));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn path_values_match_normalizes_windows_prefix_and_slash() {
        assert!(path_values_match(
            Path::new(r"C:\Workspace\demo"),
            Path::new("C:\\Workspace\\demo\\"),
        ));
        assert!(path_values_match(
            Path::new(r"C:\Workspace\demo"),
            Path::new(r"c:\workspace\demo"),
        ));
        assert!(!path_values_match(
            Path::new(r"C:\Workspace\demo"),
            Path::new(r"C:\Workspace\other"),
        ));
    }

    #[test]
    fn reviewed_update_plan_never_promotes_main_implicitly() {
        let current = reviewed_update_plan(&json!({
            "detected": true,
            "pinnedRef": ROUTER_PINNED_COMMIT,
            "root": "C:\\fixture-router"
        }));
        assert_eq!(current["status"], "current");
        assert_eq!(current["targetRef"], ROUTER_PINNED_COMMIT);
        assert_eq!(current["targetVersion"], ROUTER_VERSION);

        let available = reviewed_update_plan(&json!({
            "detected": true,
            "pinnedRef": "0123456789abcdef0123456789abcdef01234567",
            "root": "C:\\fixture-router"
        }));
        assert_eq!(available["status"], "available");
        assert_eq!(available["targetRef"], ROUTER_PINNED_COMMIT);

        let blocked = reviewed_update_plan(&json!({
            "detected": true,
            "pinnedRef": "0.4.0-beta.3",
            "root": "C:\\fixture-router"
        }));
        assert_eq!(blocked["status"], "blocked");
    }

    #[test]
    fn backup_rows_keep_backup_paths_and_metadata_aligned() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE backups (
                    id TEXT PRIMARY KEY,
                    target TEXT NOT NULL,
                    backup_path TEXT,
                    created_at TEXT NOT NULL,
                    reason TEXT NOT NULL,
                    restorable INTEGER NOT NULL,
                    redacted INTEGER NOT NULL
                );",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO backups (id, target, backup_path, created_at, reason, restorable, redacted)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    "backup-fixture",
                    "C:\\workspace\\AGENTS.md",
                    "C:\\workspace\\AGENTS.md.codex-orchestra-backup-fixture",
                    "2026-08-12T12:00:00Z",
                    "before-write",
                    1,
                    1
                ],
            )
            .unwrap();
        let rows = load_backups(&connection).unwrap();
        assert_eq!(
            rows[0]["backupPath"],
            "C:\\workspace\\AGENTS.md.codex-orchestra-backup-fixture"
        );
        assert_eq!(rows[0]["createdAt"], "2026-08-12T12:00:00Z");
        assert_eq!(rows[0]["reason"], "before-write");
        assert_eq!(rows[0]["restorable"], true);
    }

    #[test]
    fn router_provider_parser_returns_state_without_secret_values() {
        let result = json!({
            "ok": true,
            "stdout": r#"{"providers":[{"id":"kimi-api","configured":true}]}"#,
            "stderr": "api_key=supersecret"
        });
        assert_eq!(
            provider_status_from_result(&result, "kimi-api"),
            Some("configured".to_string())
        );
        assert!(!provider_status_from_result(&result, "kimi-api")
            .unwrap()
            .contains("secret"));
    }

    #[test]
    fn credential_parser_prioritizes_expired_and_invalid_over_generic_readiness() {
        assert_eq!(
            credential_status_from_text("provider expired but ready"),
            Some("expired")
        );
        assert_eq!(
            credential_status_from_text("401 unauthorized"),
            Some("invalid")
        );
        assert_eq!(
            credential_status_from_text("not configured"),
            Some("missing")
        );
        assert_eq!(credential_status_from_text("connected"), Some("configured"));
        assert_eq!(
            credential_status_from_text("SHOW qwen-plan    ready  Qwen Token Plan"),
            Some("configured")
        );
        assert_eq!(
            credential_status_from_text("HIDE grok-api     setup needed  xAI Grok API"),
            Some("missing")
        );
    }

    #[test]
    fn provider_status_reads_only_the_matched_router_row() {
        let result = json!({
            "ok": true,
            "stdout": "SHOW grok-oauth   ready  xAI Grok OAuth\nHIDE grok-api     setup needed  xAI Grok API\nSHOW kimi-oauth   ready  Kimi Code OAuth\nHIDE kimi-api     setup needed  Kimi Platform API\nSHOW opencode-go  ready  opencode Go/Zen\nSHOW qwen-plan    ready  Qwen Token Plan\n"
        });
        assert_eq!(
            provider_status_from_result(&result, "grok-oauth"),
            Some("configured".to_string())
        );
        assert_eq!(
            provider_status_from_result(&result, "grok-api"),
            Some("missing".to_string())
        );
        assert_eq!(
            provider_status_from_result(&result, "opencode-go"),
            Some("configured".to_string())
        );
        assert_eq!(
            provider_status_from_result(&result, "qwen-plan"),
            Some("configured".to_string())
        );
        assert_eq!(
            provider_status_from_result(&result, "kimi-api"),
            Some("missing".to_string())
        );
    }

    #[test]
    fn router_model_parser_distinguishes_listed_models() {
        let result = json!({
            "ok": true,
            "stdout": "kimi-api/kimi-k3\ngrok-api/grok-4.6"
        });
        assert_eq!(model_is_listed(&result, "kimi-api/kimi-k3"), Some(true));
        assert_eq!(model_is_listed(&result, "grok-api/grok-4.7"), Some(false));
    }

    #[test]
    fn catalog_parser_reads_identifiers_only() {
        let result = json!({
            "ok": true,
            "models": [
                {"slug": "kimi-api/kimi-k3", "apiKey": "never-consumed"},
                {"id": "grok-api/grok-4.6"}
            ]
        });
        assert_eq!(model_is_listed(&result, "kimi-api/kimi-k3"), Some(true));
        assert_eq!(model_is_listed(&result, "grok-api/grok-4.7"), Some(false));
        assert_eq!(
            catalog_model_ids(&result),
            vec!["kimi-api/kimi-k3", "grok-api/grok-4.6"]
        );
        let entries = catalog_model_entries(&json!({
            "models": [{
                "slug": "opencode-go/kimi-k3",
                "upstreamModel": "kimi-k3",
                "contextWindow": 256000,
                "autoCompact": 230000,
                "apiKey": "never-consumed"
            }]
        }));
        assert_eq!(entries[0]["id"], "opencode-go/kimi-k3");
        assert_eq!(entries[0]["contextWindow"], 256000);
        assert_eq!(entries[0]["autoCompact"], 230000);
        assert!(!entries[0].to_string().contains("never-consumed"));
    }

    #[test]
    fn state_migration_versions_schema_and_creates_local_tables() {
        let mut connection = Connection::open_in_memory().unwrap();
        migrate_state_db(&mut connection).unwrap();
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        let table: String = connection
            .query_row(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'worktrees'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let evidence_table: String = connection
            .query_row(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'delegation_evidence'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(version, STATE_SCHEMA_VERSION);
        assert_eq!(table, "worktrees");
        assert_eq!(evidence_table, "delegation_evidence");
    }

    #[test]
    fn pricing_preview_requires_official_source_and_exact_effective_time() {
        let valid = json!([{
            "provider": "qwen-plan",
            "model": "qwen-plan/qwen3.8-max",
            "currency": "USD",
            "inputPerMillion": 0.0,
            "cachedInputPerMillion": 0.0,
            "outputPerMillion": 0.0,
            "effectiveFrom": "2026-08-13T00:00:00Z",
            "version": "qwen-plan-2026-08",
            "billingType": "subscription",
            "sourceLabel": "Alibaba official Token Plan documentation",
            "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/"
        }]);
        let preview = pricing_import_preview(valid.as_array().unwrap()).unwrap();
        assert_eq!(preview["count"], 1);
        assert_eq!(preview["subscriptionRules"], 1);
        assert_eq!(preview["writesCredentialValues"], false);

        let mut invalid = valid[0].clone();
        invalid["sourceUrl"] = Value::String("https://example.com/pricing".to_string());
        assert!(pricing_import_preview(&[invalid])
            .unwrap_err()
            .contains("official provider domain"));
    }

    #[test]
    fn pricing_preview_rejects_provider_mismatch_and_subscription_charges() {
        let mut rule = default_pricing_rules()[0].clone();
        rule["model"] = Value::String("opencode-go/kimi-k3".to_string());
        assert!(validate_pricing_rule(&rule)
            .unwrap_err()
            .contains("provider and model"));

        let mut charged = default_pricing_rules()[0].clone();
        charged["inputPerMillion"] = json!(1.0);
        assert!(validate_pricing_rule(&charged)
            .unwrap_err()
            .contains("cannot invent"));
    }

    #[test]
    fn mcp_surface_is_read_only_and_carries_server_instructions() {
        let tools = mcp_tools();
        for tool in tools.as_array().unwrap() {
            assert_eq!(tool["annotations"]["readOnlyHint"], true);
            assert_eq!(tool["annotations"]["destructiveHint"], false);
        }
        let response = mcp_response(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {"protocolVersion": "2025-06-18"}
        }))
        .unwrap();
        assert_eq!(response["result"]["protocolVersion"], "2025-06-18");
        assert!(response["result"]["instructions"]
            .as_str()
            .unwrap()
            .contains("Read-only"));
    }

    #[test]
    fn mcp_scope_plan_keeps_cross_role_overlap_sequential() {
        let plan = mcp_scope_plan(&json!({
            "assignments": {
                "root": ["package.json"],
                "frontend": ["src/**"],
                "engineer": ["src/api/**"]
            },
            "sharedPaths": ["package.json"]
        }))
        .unwrap();
        assert_eq!(plan["parallel"], false);
        assert_eq!(plan["worktreeRecommended"], true);
    }
}
