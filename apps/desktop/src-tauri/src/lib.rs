#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use std::env;
use std::fs::{self, File};
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

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

fn codex_home() -> PathBuf {
    env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| current_user_home().join(".codex"))
}

fn router_root() -> PathBuf {
    env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| current_user_home().join("AppData").join("Local"))
        .join("CodexOrchestra")
        .join("engine")
        .join("codex-router")
}

fn find_codex() -> Option<String> {
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

fn detect_codex() -> Value {
    let executable = find_codex();
    json!({
        "detected": executable.is_some(),
        "executable": executable,
        "version": Value::Null,
        "home": codex_home().to_string_lossy(),
        "login": "unknown",
        "nativeModelsAvailable": false,
        "source": if cfg!(windows) { "path" } else { "unknown" }
    })
}

fn detect_router() -> Value {
    let root = router_root();
    let detected = root.join("codex-router.ps1").exists() || root.join("package.json").exists();
    let version = if detected {
        json!(ROUTER_VERSION)
    } else {
        Value::Null
    };
    let pinned_ref = if detected {
        json!(ROUTER_VERSION)
    } else {
        Value::Null
    };
    json!({
        "detected": detected,
        "root": root.to_string_lossy(),
        "version": version,
        "pinnedRef": pinned_ref,
        "health": if detected { "unknown" } else { "missing" },
        "ports": [4200, 4201, 4202, 4203],
        "service": "unknown"
    })
}

fn base_snapshot() -> Value {
    let router = detect_router();
    let router_detected = router
        .get("detected")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let current_ref = if router_detected {
        json!(ROUTER_VERSION)
    } else {
        Value::Null
    };
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
            { "id": "grok-api/grok-4.5", "label": "Grok 4.5", "providerId": "grok-api", "available": false, "supportsStreaming": true, "supportsTools": true, "supportsSubagents": false, "reasoningEfforts": ["high"], "source": "registry" }
        ],
        "agents": [], "projects": [], "usage": [],
        "budget": { "monthlyLimit": 40, "warningAtPercent": 70, "criticalAtPercent": 90, "currency": "USD" },
        "backups": [],
        "update": { "currentRef": current_ref, "targetRef": ROUTER_VERSION, "targetVersion": ROUTER_VERSION, "requiresBackup": true, "healthGate": true, "status": "unknown", "notes": ["Native detection only; run Router doctor for complete status."] },
        "diagnostics": []
    })
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
    let router_args = match operation {
        "update-check" => vec!["update", "check"],
        "refresh-catalog" => vec!["refresh-catalog"],
        other => vec![other],
    };
    let output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(&script)
        .args(router_args)
        .output()
        .map_err(|error| format!("Router process could not start: {error}"))?;
    Ok(
        json!({ "ok": output.status.success(), "status": output.status.code().unwrap_or(-1), "operation": operation, "stdout": redact(&String::from_utf8_lossy(&output.stdout)), "stderr": redact(&String::from_utf8_lossy(&output.stderr)) }),
    )
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
    let target = PathBuf::from(path);
    if !target.is_absolute() {
        return Err("Managed config path must be absolute".to_string());
    }
    if target.file_name().and_then(|name| name.to_str()) != Some("AGENTS.md") {
        return Err("Only AGENTS.md is managed by this command".to_string());
    }
    if target
        .parent()
        .map(|parent| !parent.exists())
        .unwrap_or(true)
    {
        return Err("Managed config parent directory does not exist".to_string());
    }
    Ok(target)
}

fn atomic_write_managed(path: &str, block: &str) -> Result<Value, String> {
    let target = safe_agents_target(path)?;
    let existing = fs::read_to_string(&target).unwrap_or_default();
    let backup = target.with_extension(format!(
        "md.codex-orchestra-backup-{}",
        now().replace(':', "-")
    ));
    if target.exists() {
        fs::copy(&target, &backup).map_err(|error| format!("Backup failed: {error}"))?;
    }
    let next = merge_managed_block(&existing, block);
    let temp = target.with_extension("md.codex-orchestra-tmp");
    let mut file = File::create(&temp).map_err(|error| format!("Temp file failed: {error}"))?;
    file.write_all(next.as_bytes())
        .map_err(|error| format!("Temp write failed: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("Temp sync failed: {error}"))?;
    fs::rename(&temp, &target).map_err(|error| format!("Atomic replace failed: {error}"))?;
    Ok(json!({ "ok": true, "path": target, "backup": backup, "managedOnly": true }))
}

#[tauri::command]
fn get_snapshot() -> Value {
    base_snapshot()
}

#[tauri::command]
fn run_health_check() -> Value {
    let snapshot = base_snapshot();
    let router_status = if snapshot["router"]["detected"].as_bool().unwrap_or(false) {
        "unknown"
    } else {
        "missing"
    };
    let checks = vec![
        json!({ "id": "codex", "label": "Codex binary", "status": if snapshot["codex"]["detected"].as_bool().unwrap_or(false) { "healthy" } else { "missing" }, "detail": "Read-only executable detection", "checkedAt": now(), "sensitive": true }),
        json!({ "id": "router", "label": "Router checkout", "status": router_status, "detail": "Managed checkout and service require local setup", "checkedAt": now(), "sensitive": true }),
        json!({ "id": "providers", "label": "Provider credentials", "status": "missing", "detail": "Credential values are not inspected", "checkedAt": now(), "sensitive": true }),
        json!({ "id": "agents", "label": "Agent capability", "status": "unknown", "detail": "Requires explicit live tool-driven check", "checkedAt": now(), "sensitive": true }),
    ];
    json!({ "id": format!("health-{}", now()), "status": if router_status == "missing" { "degraded" } else { "unknown" }, "startedAt": now(), "completedAt": now(), "checks": checks, "redacted": true })
}

#[tauri::command]
fn router_operation(operation: String, confirm: Option<bool>) -> Result<Value, String> {
    router_command(&operation, confirm.unwrap_or(false))
}

#[tauri::command]
fn managed_preview(path: String, existing: String, block: String) -> Result<Value, String> {
    safe_agents_target(&path)?;
    let next = merge_managed_block(&existing, &block);
    Ok(
        json!([{"path": path, "action": if next == existing { "unchanged" } else if existing.contains("BEGIN CODEX-ORCHESTRA MANAGED") { "update" } else { "create" }, "diff": "managed block only", "safe": true}, {"path": ".codex/skills/orchestra-routing/SKILL.md", "action": "create", "diff": "generated routing skill", "safe": true}]),
    )
}

#[tauri::command]
fn apply_managed_changes(path: String, block: String, confirm: bool) -> Result<Value, String> {
    if !confirm {
        return Err("Applying managed changes requires explicit confirmation".to_string());
    }
    atomic_write_managed(&path, &block)
}

#[tauri::command]
fn export_support_bundle() -> Value {
    json!({ "schemaVersion": 1, "createdAt": now(), "privacy": "credential values, prompts and response bodies excluded", "snapshot": base_snapshot() })
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            run_health_check,
            router_operation,
            managed_preview,
            apply_managed_changes,
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
}
