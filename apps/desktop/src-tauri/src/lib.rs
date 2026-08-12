#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::env;
use std::fs::{self, File};
use std::io::Write;
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const ROUTER_VERSION: &str = "0.4.0-beta.2";

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

fn state_db_path() -> PathBuf {
    data_root().join("orchestra.db")
}

fn open_state_db() -> Result<Connection, String> {
    let root = data_root();
    fs::create_dir_all(&root).map_err(|error| format!("State directory failed: {error}"))?;
    let connection = Connection::open(state_db_path())
        .map_err(|error| format!("State database failed: {error}"))?;
    connection
        .execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS projects (
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
             );",
        )
        .map_err(|error| format!("State schema failed: {error}"))?;
    let _ = connection.execute("ALTER TABLE backups ADD COLUMN backup_path TEXT", []);
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
            "SELECT id, target, created_at, reason, restorable, redacted FROM backups ORDER BY created_at DESC",
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

fn load_snapshot_state(mut snapshot: Value) -> Result<Value, String> {
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
    Ok(snapshot)
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
        return Some(PathBuf::from(override_path).to_string_lossy().to_string());
    }
    let command = if cfg!(windows) { "where.exe" } else { "which" };
    Command::new(command)
        .arg("codex")
        .output()
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
    let output = Command::new(executable).arg("--version").output().ok()?;
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
    let output = match Command::new(executable).args(["login", "status"]).output() {
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
    json!({ "id": id, "name": name, "family": family, "credential": credential, "enabled": enabled, "billingNote": "Credential status only; value never read" })
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
        "estimatedCostPerMillion": if role == "frontend" { 4.8 } else if role == "engineer" { 15.0 } else { 0.0 }
    })
}

fn detect_codex() -> Value {
    let executable = find_codex();
    let version = executable.as_deref().and_then(codex_version);
    let native_models_available = version.is_some();
    let login = executable
        .as_deref()
        .map(codex_login_status)
        .unwrap_or("unknown");
    json!({
        "detected": executable.is_some(),
        "executable": executable,
        "version": version,
        "home": codex_home().to_string_lossy(),
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
    let detected = root.join("codex-router.ps1").exists() || root.join("package.json").exists();
    let ports: Vec<u16> = [4200, 4201, 4202, 4203]
        .into_iter()
        .filter(|port| port_is_open(*port))
        .collect();
    let version = router_version(&root).or_else(|| detected.then(|| ROUTER_VERSION.to_string()));
    let version = if detected {
        version.clone().map_or(Value::Null, Value::String)
    } else {
        Value::Null
    };
    let pinned_ref = if detected {
        version.clone()
    } else {
        Value::Null
    };
    json!({
        "detected": detected,
        "root": root.to_string_lossy(),
        "version": version,
        "pinnedRef": pinned_ref,
        "health": if !detected { "missing" } else if ports.is_empty() { "degraded" } else { "healthy" },
        "ports": ports,
        "service": if !detected { "unknown" } else if ports.is_empty() { "stopped" } else { "running" }
    })
}

fn base_snapshot() -> Value {
    let router = detect_router();
    let router_detected = router
        .get("detected")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let current_ref = router.get("pinnedRef").cloned().unwrap_or(Value::Null);
    json!({
        "appVersion": "0.1.0",
        "codex": detect_codex(),
        "router": router,
        "providers": [
            provider("kimi-api", "Kimi Platform", "kimi", "missing", true),
            provider("grok-api", "xAI", "xai", "missing", true),
            provider("openai", "Codex native", "openai", "unknown", true)
        ],
        "models": [
            { "id": "gpt-5.6-sol", "label": "GPT-5.6 Sol", "providerId": "openai", "available": true, "supportsStreaming": true, "supportsTools": true, "supportsSubagents": true, "reasoningEfforts": ["high", "max"], "source": "native" },
            { "id": "kimi-api/kimi-k3", "label": "Kimi K3", "providerId": "kimi-api", "available": false, "supportsStreaming": true, "supportsTools": true, "supportsSubagents": false, "reasoningEfforts": ["high", "max"], "source": "registry" },
            { "id": "grok-api/grok-4.6", "label": "Grok 4.6", "providerId": "grok-api", "available": false, "supportsStreaming": true, "supportsTools": true, "supportsSubagents": false, "reasoningEfforts": ["high"], "source": "registry" }
        ],
        "agents": [
            agent("root", "Sol / Root", "root", "Tech lead, architect and final reviewer.", "openai", "gpt-5.6-sol", "max", "unknown", &["*"], &["package.json", "types/**"]),
            agent("frontend", "Kimi / Frontend", "frontend", "UI, UX, responsive and accessibility specialist.", "kimi-api", "kimi-api/kimi-k3", "max", "unknown", &["app/**", "src/**", "components/**", "styles/**"], &[]),
            agent("engineer", "Grok / Engineer", "engineer", "Backend, integration, debugging and test specialist.", "grok-api", "grok-api/grok-4.6", "high", "unknown", &["server/**", "api/**", "db/**", "tests/**"], &[])
        ], "projects": [], "usage": [],
        "budget": { "monthlyLimit": 40, "warningAtPercent": 70, "criticalAtPercent": 90, "currency": "USD" },
        "backups": [],
        "update": { "currentRef": current_ref, "targetRef": ROUTER_VERSION, "targetVersion": ROUTER_VERSION, "requiresBackup": true, "healthGate": true, "status": "unknown", "notes": ["Native detection only; run Router doctor for complete status."] },
        "diagnostics": []
    })
}

fn run_router_script(script: &Path, args: &[&str], operation: &str) -> Result<Value, String> {
    let output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(script)
        .args(args)
        .output()
        .map_err(|error| format!("Router process could not start: {error}"))?;
    Ok(json!({
        "ok": output.status.success(),
        "status": output.status.code().unwrap_or(-1),
        "operation": operation,
        "stdout": redact(&String::from_utf8_lossy(&output.stdout)),
        "stderr": redact(&String::from_utf8_lossy(&output.stderr))
    }))
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
    ];
    if !allowed.contains(&operation) {
        return Err("Unsupported Router operation".to_string());
    }
    if ["update", "rollback"].contains(&operation) && !confirm {
        return Err("Mutation requires explicit confirmation".to_string());
    }
    let script = router_root().join("codex-router.ps1");
    if !script.exists() {
        return Ok(
            json!({ "ok": false, "status": "missing", "operation": operation, "detail": "Managed Router checkout was not detected." }),
        );
    }
    if operation == "update" {
        let backup_manifest = create_router_backup_manifest()?;
        let update = run_router_script(&script, &["update"], operation)?;
        if !update["ok"].as_bool().unwrap_or(false) {
            return Ok(json!({
                "ok": false,
                "operation": operation,
                "phase": "update",
                "backupManifest": backup_manifest,
                "result": update
            }));
        }
        let doctor = run_router_script(&script, &["doctor"], "doctor")?;
        if !doctor["ok"].as_bool().unwrap_or(false) {
            let rollback = run_router_script(&script, &["rollback"], "rollback")?;
            return Ok(json!({
                "ok": false,
                "operation": operation,
                "phase": "health-gate",
                "backupManifest": backup_manifest,
                "result": update,
                "doctor": doctor,
                "rollback": rollback
            }));
        }
        return Ok(json!({
            "ok": true,
            "operation": operation,
            "phase": "health-gate",
            "backupManifest": backup_manifest,
            "result": update,
            "doctor": doctor
        }));
    }
    let args = match operation {
        "update-check" => vec!["update", "check"],
        "refresh-catalog" => vec!["refresh-catalog"],
        other => vec![other],
    };
    run_router_script(&script, &args, operation)
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
    Ok(canonical_parent.join("AGENTS.md"))
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
            ".codex/agents/orchestra_frontend.toml" | ".codex/agents/orchestra_engineer.toml"
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

fn atomic_write_managed(path: &str, block: &str) -> Result<Value, String> {
    let target = safe_agents_target(path)?;
    let existing = fs::read_to_string(&target).unwrap_or_default();
    let next = merge_managed_block(&existing, block);
    let record = atomic_write_file(&target, &next)?;
    persist_backup(
        &target.to_string_lossy(),
        "before-write",
        record.backup.as_deref().and_then(|path| path.to_str()),
    )?;
    Ok(json!({ "ok": true, "path": target, "backup": record.backup, "managedOnly": true }))
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
        "AGENTS.md" | "orchestra_frontend.toml" | "orchestra_engineer.toml" | "SKILL.md"
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

#[tauri::command]
fn get_snapshot() -> Result<Value, String> {
    load_snapshot_state(base_snapshot())
}

#[tauri::command]
fn run_health_check() -> Result<Value, String> {
    let snapshot = load_snapshot_state(base_snapshot())?;
    let router_status = snapshot["router"]["health"].as_str().unwrap_or("unknown");
    let provider_status = if snapshot["providers"]
        .as_array()
        .map(|providers| {
            providers.iter().any(|provider| {
                provider["credential"]
                    .as_str()
                    .is_some_and(|status| status == "configured")
            })
        })
        .unwrap_or(false)
    {
        "healthy"
    } else {
        "missing"
    };
    let checks = vec![
        json!({ "id": "codex", "label": "Codex binary", "status": if snapshot["codex"]["detected"].as_bool().unwrap_or(false) { "healthy" } else { "missing" }, "detail": "Read-only executable detection", "checkedAt": now(), "sensitive": true }),
        json!({ "id": "router", "label": "Router checkout", "status": router_status, "detail": "Managed checkout and loopback service are checked without reading credentials", "checkedAt": now(), "sensitive": true }),
        json!({ "id": "providers", "label": "Provider credentials", "status": provider_status, "detail": "Credential values are not inspected", "checkedAt": now(), "sensitive": true }),
        json!({ "id": "agents", "label": "Agent capability", "status": "unknown", "detail": "Requires explicit live tool-driven check", "checkedAt": now(), "sensitive": true }),
    ];
    let report = json!({ "id": format!("health-{}", now()), "status": if checks.iter().any(|check| check["status"] == "unhealthy") { "unhealthy" } else if checks.iter().any(|check| check["status"] == "missing" || check["status"] == "degraded") { "degraded" } else { "unknown" }, "startedAt": now(), "completedAt": now(), "checks": checks, "redacted": true });
    persist_health(&report)?;
    Ok(report)
}

#[tauri::command]
fn router_operation(operation: String, confirm: Option<bool>) -> Result<Value, String> {
    router_command(&operation, confirm.unwrap_or(false))
}

#[tauri::command]
fn managed_preview(path: String, existing: String, block: String) -> Result<Value, String> {
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
        {"path": target, "action": action, "diff": "managed block only", "safe": true},
        {"path": ".codex/agents/orchestra_frontend.toml", "action": "create", "diff": "generated frontend agent", "safe": true},
        {"path": ".codex/agents/orchestra_engineer.toml", "action": "create", "diff": "generated engineer agent", "safe": true},
        {"path": ".codex/skills/orchestra-routing/SKILL.md", "action": "create", "diff": "generated routing skill", "safe": true}
    ]))
}

#[tauri::command]
fn apply_managed_changes(
    path: String,
    block: String,
    confirm: bool,
    files: Option<Vec<GeneratedFile>>,
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
    let next = merge_managed_block(&existing, &block);
    let mut records = Vec::new();
    match atomic_write_file(&target, &next) {
        Ok(record) => records.push(record),
        Err(error) => return Err(error),
    }
    for (file, generated_target) in generated_files.iter().zip(generated_targets.iter()) {
        match atomic_write_file(generated_target, &file.content) {
            Ok(record) => records.push(record),
            Err(error) => {
                for record in records.iter().rev() {
                    rollback_write(record);
                }
                return Err(format!("Managed changes rolled back: {error}"));
            }
        }
    }
    for record in &records {
        persist_backup(
            &record.target.to_string_lossy(),
            "before-write",
            record.backup.as_deref().and_then(|path| path.to_str()),
        )?;
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
fn add_project(path: String) -> Result<Value, String> {
    let root = safe_project_root(&path)?;
    let profile = project_profile(&root);
    persist_project(&profile)?;
    Ok(profile)
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
    let valid_test = matches!(
        test.as_str(),
        "basic" | "streaming" | "tool-use" | "agent-behavior"
    );
    if !valid_test {
        return Err("Unsupported live check test".to_string());
    }
    let provider_matches = (provider == "kimi-api" && model.starts_with("kimi-api/"))
        || (provider == "grok-api" && model.starts_with("grok-api/"));
    if !provider_matches {
        return Err("Provider and model do not match".to_string());
    }
    Ok(json!({
        "provider": provider,
        "model": model,
        "test": test,
        "estimatedCostNote": "May consume provider quota; execution requires a separate explicit confirmation.",
        "requiresConfirmation": true
    }))
}

#[tauri::command]
fn record_usage_event(event: Value) -> Result<Value, String> {
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
fn restore_backup(target: String, backup: String, confirm: bool) -> Result<Value, String> {
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

#[tauri::command]
fn export_support_bundle() -> Result<Value, String> {
    let snapshot = load_snapshot_state(base_snapshot())?;
    Ok(
        json!({ "schemaVersion": 1, "createdAt": now(), "privacy": "credential values, prompts and response bodies excluded", "snapshot": snapshot }),
    )
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            run_health_check,
            router_operation,
            managed_preview,
            apply_managed_changes,
            add_project,
            scope_plan,
            live_check_preview,
            record_usage_event,
            restore_backup,
            export_support_bundle
        ])
        .run(tauri::generate_context!())
        .expect("error while running Codex Orchestra");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_block_preserves_foreign_content() {
        let merged = merge_managed_block("# User\n\n<!-- BEGIN CODEX-ORCHESTRA MANAGED -->\nold\n<!-- END CODEX-ORCHESTRA MANAGED -->\n", "new");
        assert!(merged.contains("# User"));
        assert!(merged.contains("new"));
        assert!(!merged.contains("old"));
    }

    #[test]
    fn redaction_removes_sensitive_line_values() {
        assert!(!redact("api_key=supersecret\n").contains("supersecret"));
    }

    #[test]
    fn generated_paths_are_allowlisted_and_confined() {
        let root = PathBuf::from(r"C:\workspace\demo");
        assert!(safe_generated_target(&root, ".codex/agents/orchestra_frontend.toml").is_ok());
        assert!(safe_generated_target(&root, ".codex/skills/orchestra-routing/SKILL.md").is_ok());
        assert!(safe_generated_target(&root, ".env").is_err());
        assert!(safe_generated_target(&root, "../AGENTS.md").is_err());
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
}
