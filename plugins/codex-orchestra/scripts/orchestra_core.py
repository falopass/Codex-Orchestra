"""Orchestra Core command surface shared by CLI, MCP and skills."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCRIPTS = Path(__file__).resolve().parent
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from adapters import codex_app_server, codex_router
from core import artifacts, policy, state
from core.paths import (
    codex_home,
    data_root,
    desktop_deeplink,
    desktop_executable,
    router_root,
    router_state_root,
)
from core.redact import redact
from core.state import feature_flags, load_json_rows, load_setting, persist_log, save_setting, usage_summary


SHARED_PATHS = ["package.json", "types/**", "schemas/**", "migrations/**"]
CRITICAL_CHECKS = {"codex", "router", "providers"}
ALLOWED_FLAGS = {"experimentalWorktrees"}


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _find_codex() -> str | None:
    override = os.environ.get("CODEX_ORCHESTRA_CODEX_BIN")
    if override and Path(override).is_file():
        return override
    which = shutil.which("codex")
    if which and "WindowsApps" not in which:
        return which
    local = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    bin_root = local / "OpenAI" / "Codex" / "bin"
    if bin_root.is_dir():
        matches = sorted(bin_root.glob("*/codex.exe"), key=lambda path: path.stat().st_mtime, reverse=True)
        if matches:
            return str(matches[0])
    return None


def _detect_codex() -> dict[str, Any]:
    executable = _find_codex()
    config = codex_home() / "config.toml"
    return {
        "detected": bool(executable),
        "version": None,
        "configDetected": config.is_file(),
        "configHealth": "healthy" if config.is_file() else "unknown",
        "login": "unknown",
        "source": "path" if executable else "unknown",
    }


def _default_agents() -> list[dict[str, Any]]:
    saved = load_setting("agentDefinitions")
    if isinstance(saved, list) and saved:
        return saved
    return [
        {
            "id": "root",
            "name": "Root / Tech Lead",
            "role": "root",
            "providerId": "openai",
            "modelId": "gpt-5.6-sol",
            "reasoningEffort": "max",
            "ownershipPaths": ["*"],
            "health": "unknown",
        },
        {
            "id": "frontend",
            "name": "Frontend / Model binding",
            "role": "frontend",
            "providerId": "qwen-plan",
            "modelId": "qwen-plan/qwen3.8-max",
            "reasoningEffort": "high",
            "ownershipPaths": ["app/**", "src/**", "components/**", "styles/**"],
            "health": "unknown",
        },
        {
            "id": "engineer",
            "name": "Engineer",
            "role": "engineer",
            "providerId": "grok-oauth",
            "modelId": "grok-oauth/grok-4.6",
            "reasoningEffort": "high",
            "ownershipPaths": ["server/**", "api/**", "db/**", "tests/**"],
            "health": "unknown",
        },
    ]


def _default_providers() -> list[dict[str, Any]]:
    cached = (load_setting("runtimeFacts") or {}).get("providers")
    if isinstance(cached, list) and cached:
        return [
            {
                "id": item.get("id"),
                "enabled": item.get("enabled"),
                "credential": item.get("credential", "unknown"),
                "name": item.get("name"),
            }
            for item in cached
            if isinstance(item, dict)
        ]
    return [
        {"id": "qwen-plan", "name": "Qwen / Alibaba Token Plan", "credential": "unknown", "enabled": True},
        {"id": "opencode-go", "name": "OpenCode Go", "credential": "unknown", "enabled": True},
        {"id": "deepseek", "name": "DeepSeek", "credential": "unknown", "enabled": True},
        {"id": "grok-oauth", "name": "Grok OAuth", "credential": "unknown", "enabled": True},
        {"id": "grok-api", "name": "xAI API", "credential": "unknown", "enabled": True},
        {"id": "openai", "name": "Codex native", "credential": "unknown", "enabled": True},
    ]


def status() -> dict[str, Any]:
    router = codex_router.detect()
    agents = [
        {
            "role": agent.get("role"),
            "provider": agent.get("providerId"),
            "model": agent.get("modelId"),
            "health": agent.get("health"),
        }
        for agent in _default_agents()
    ]
    return {
        "appVersion": "0.1.0",
        "surface": "plugin",
        "desktop": {
            "available": desktop_executable() is not None,
            "deeplink": desktop_deeplink("overview"),
        },
        "codex": _detect_codex(),
        "router": {
            "detected": router["detected"],
            "version": router["version"],
            "health": "healthy" if router["healthy"] else ("missing" if not router["detected"] else "unhealthy"),
            "service": router["service"],
            "ports": router["ports"],
        },
        "providers": _default_providers(),
        "agents": agents,
        "lastHealth": (load_json_rows("health_runs", limit=1) or [{}])[0].get("status"),
        "featureFlags": feature_flags(),
        "threads": codex_app_server.thread_bridge(),
        "redacted": True,
    }


def doctor() -> dict[str, Any]:
    snapshot = status()
    router = codex_router.detect()
    doctor_result = None
    if router["detected"]:
        try:
            doctor_result = codex_router.run_operation("doctor", confirm=False)
        except Exception as error:  # noqa: BLE001
            doctor_result = {"ok": False, "detail": redact(str(error))}
    checks = [
        {
            "id": "codex",
            "label": "Codex binary",
            "status": "healthy" if snapshot["codex"]["detected"] else "missing",
            "detail": "Read-only executable detection",
        },
        {
            "id": "router",
            "label": "Router checkout",
            "status": snapshot["router"]["health"],
            "detail": "External engine only. Credentials are not read.",
        },
        {
            "id": "providers",
            "label": "Provider credentials",
            "status": "healthy"
            if any(item.get("credential") == "configured" for item in snapshot["providers"] if item.get("id") != "openai")
            else "unknown",
            "detail": "Status only. Values stay in Router helpers.",
        },
        {
            "id": "desktop",
            "label": "Desktop app",
            "status": "healthy" if snapshot["desktop"]["available"] else "info",
            "detail": "Optional UI surface. Plugin-first commands work without it.",
        },
        {
            "id": "threads",
            "label": "codex-control",
            "status": "healthy" if snapshot["threads"]["available"] else "info",
            "detail": snapshot["threads"].get("reason") or "Reuse installed thread-control plugin.",
        },
    ]
    critical = [check for check in checks if check["id"] in CRITICAL_CHECKS]
    overall = "healthy"
    if not all(check["status"] == "healthy" for check in critical):
        overall = "degraded" if any(check["status"] in {"missing", "degraded", "unhealthy"} for check in critical) else "unknown"
    report = {
        "id": f"health-{_now()}",
        "status": overall,
        "startedAt": _now(),
        "completedAt": _now(),
        "checks": checks,
        "routerDoctor": doctor_result,
        "redacted": True,
    }
    persist_log("info", "doctor", f"Plugin doctor status={report['status']}")
    return report


def models() -> dict[str, Any]:
    catalog = codex_router.read_catalog()
    all_models = catalog.get("models", [])
    hidden = codex_router.read_hidden_slugs()
    strategy = load_setting("frontendStrategy") or {
        "mode": "pinned",
        "pinnedModel": {"provider": "qwen-plan", "upstreamModel": "qwen3.8-max"},
    }
    return {
        "ok": catalog.get("ok", False),
        "strategy": strategy,
        "providers": _default_providers(),
        "models": all_models,
        "hiddenCount": len(hidden),
        "note": "Credential values are never returned.",
        "redacted": True,
    }


def team() -> dict[str, Any]:
    return {
        "agents": _default_agents(),
        "strategy": load_setting("frontendStrategy")
        or {"mode": "pinned", "pinnedModel": {"provider": "qwen-plan", "upstreamModel": "qwen3.8-max"}},
        "rolesAreLogical": True,
        "redacted": True,
    }


def save_team(agent: dict[str, Any], confirm: bool) -> dict[str, Any]:
    policy.require_confirm("team.save", confirm)
    agents = _default_agents()
    role = agent.get("role") or agent.get("id")
    updated = False
    for index, current in enumerate(agents):
        if current.get("id") == agent.get("id") or current.get("role") == role:
            stored = {**current, **agent}
            stored["health"] = current.get("health", "unknown")
            agents[index] = stored
            updated = True
            break
    if not updated:
        raise ValueError("Only existing Orchestra roles can be updated")
    save_setting("agentDefinitions", agents)
    persist_log("info", "team", f"Updated local {role} definition; project files remain unchanged")
    return {"ok": True, "agents": agents, "redacted": True}


def save_strategy(mode: str, confirm: bool, provider: str | None = None, upstream: str | None = None) -> dict[str, Any]:
    policy.require_confirm("team.save", confirm)
    if mode == "auto":
        strategy = {"mode": "auto"}
    else:
        if not provider or not upstream:
            raise ValueError("Pinned strategy requires provider and upstreamModel")
        strategy = {"mode": "pinned", "pinnedModel": {"provider": provider, "upstreamModel": upstream}}
    save_setting("frontendStrategy", strategy)
    return {"ok": True, "strategy": strategy, "redacted": True}


def _to_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on", "enabled"}
    return bool(value)


def set_flag(flag: Any, value: Any, confirm: bool) -> dict[str, Any]:
    if not flag:
        return {"ok": True, "action": "flags", "flags": feature_flags(), "redacted": True}
    if flag not in ALLOWED_FLAGS:
        raise ValueError("Only experimentalWorktrees can be set from the plugin. Pricing, support bundle and live checks stay desktop-only.")
    policy.require_confirm("router.set-flag", confirm)
    flags = load_setting("featureFlags") or {}
    flags[flag] = _to_bool(value)
    save_setting("featureFlags", flags)
    return {"ok": True, "action": "set-flag", "flags": feature_flags(), "redacted": True}


def router_action(args: dict[str, Any]) -> dict[str, Any]:
    action = args.get("action") or "status"
    confirm = bool(args.get("confirm"))
    provider = args.get("provider")
    if action in {"detect", "status"}:
        return {"ok": True, "action": action, "router": codex_router.detect(), "redacted": True}
    if action == "logs":
        return {"ok": True, "action": action, **codex_router.logs(), "redacted": True}
    if action in {"start", "restart"}:
        policy.require_confirm(f"router.{action}", confirm)
        return {"ok": True, "action": action, **codex_router.start(confirm=confirm, force=action == "restart"), "redacted": True}
    if action == "connect-provider":
        policy.require_confirm("router.connect-provider", confirm)
        return {"ok": True, "action": action, **codex_router.connect_provider(provider or ""), "redacted": True}
    if action == "disconnect-provider":
        policy.require_confirm("router.disconnect-provider", confirm)
        return {"ok": True, "action": action, **codex_router.disconnect_provider(provider or ""), "redacted": True}
    if action == "list-providers":
        return {"ok": True, "action": action, **codex_router.list_providers(), "redacted": True}
    if action == "enable-provider":
        policy.require_confirm("router.enable-provider", confirm)
        return {"ok": True, "action": action, **codex_router.enable_provider(provider or ""), "redacted": True}
    if action == "disable-provider":
        policy.require_confirm("router.disable-provider", confirm)
        return {"ok": True, "action": action, **codex_router.disable_provider(provider or ""), "redacted": True}
    if action == "upsert-user-provider":
        policy.require_confirm("router.upsert-user-provider", confirm)
        return {"ok": True, "action": action, **codex_router.upsert_user_provider(args), "redacted": True}
    if action == "upsert-user-models":
        policy.require_confirm("router.upsert-user-models", confirm)
        return {"ok": True, "action": action, **codex_router.upsert_user_models(args.get("models") or []), "redacted": True}
    if action == "set-model-visible":
        policy.require_confirm("router.set-model-visible", confirm)
        slug = args.get("slug") or args.get("model")
        return {"ok": True, "action": action, **codex_router.set_model_visible(slug or "", bool(args.get("visible", True))), "redacted": True}
    if action == "curate-models":
        policy.require_confirm("router.curate-models", confirm)
        return {"ok": True, "action": action, **codex_router.curate_models(provider or ""), "redacted": True}
    if action == "refresh-catalog":
        policy.require_confirm("router.refresh-catalog", confirm)
        refresh = codex_router.run_operation("refresh-catalog", confirm=True)
        return {"ok": bool(refresh.get("ok")), "action": action, "refresh": refresh, "redacted": True}
    if action == "set-flag":
        return set_flag(args.get("flag"), args.get("value"), confirm)
    if action == "flags":
        return {"ok": True, "action": action, "flags": feature_flags(), "redacted": True}
    if action in {"doctor", "providers", "models", "update-check", "update", "rollback", "install"}:
        return {"ok": True, "action": action, **codex_router.run_operation(action, confirm=confirm), "redacted": True}
    raise ValueError(f"Unsupported router action: {action}")


def preview_managed(project_path: str) -> dict[str, Any]:
    root = Path(project_path)
    if not root.is_absolute() or not root.is_dir():
        raise ValueError("project_path must be an existing absolute directory")
    agents = [agent for agent in _default_agents() if agent.get("role") != "root"]
    block = artifacts.render_managed_block(agents, SHARED_PATHS)
    target = root / "AGENTS.md"
    existing = target.read_text(encoding="utf-8") if target.is_file() else ""
    files = artifacts.generated_files(agents)
    return {
        "ok": True,
        "path": str(target),
        "currentHash": policy.preview_hash(existing),
        "block": block,
        "files": [{"path": item["path"], "action": "create"} for item in files],
        "requiresConfirmation": True,
        "redacted": True,
    }


def apply_managed(project_path: str, confirm: bool, expected_hash: str | None = None) -> dict[str, Any]:
    policy.require_confirm("setup.apply", confirm)
    preview = preview_managed(project_path)
    target = policy.safe_agents_target(preview["path"])
    existing = target.read_text(encoding="utf-8") if target.is_file() else ""
    current_hash = policy.preview_hash(existing)
    if expected_hash and expected_hash != current_hash:
        raise ValueError("AGENTS.md changed after the preview; regenerate it")
    next_text = policy.merge_managed_block(existing, preview["block"])
    backups = []
    written = []
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.is_file():
        backup = target.with_name(f"{target.name}.codex-orchestra-backup-{int(datetime.now().timestamp())}")
        shutil.copy2(target, backup)
        backups.append(str(backup))
    temp = target.with_suffix(".codex-orchestra-tmp")
    temp.write_text(next_text, encoding="utf-8", newline="\n")
    temp.replace(target)
    written.append(str(target))
    agents = [agent for agent in _default_agents() if agent.get("role") != "root"]
    for item in artifacts.generated_files(agents):
        generated = policy.safe_generated_target(target.parent, item["path"])
        generated.parent.mkdir(parents=True, exist_ok=True)
        current = generated.read_text(encoding="utf-8") if generated.is_file() else ""
        content = policy.merge_subagent_config(current, item["content"]) if item["path"].endswith("config.toml") else item["content"]
        if generated.is_file():
            backup = generated.with_name(f"{generated.name}.codex-orchestra-backup-{int(datetime.now().timestamp())}")
            shutil.copy2(generated, backup)
            backups.append(str(backup))
        generated.write_text(content, encoding="utf-8", newline="\n")
        written.append(str(generated))
    persist_log("info", "apply", "Applied Orchestra-managed files with backups")
    return {"ok": True, "files": written, "backupCount": len(backups), "managedOnly": True, "redacted": True}


def scope_plan(assignments: dict[str, list[str]], shared_paths: list[str] | None = None) -> dict[str, Any]:
    shared = shared_paths or []

    def overlap(left: str, right: str) -> bool:
        a = left.replace("\\", "/").removeprefix("./").rstrip("/")
        b = right.replace("\\", "/").removeprefix("./").rstrip("/")
        a_base = a[:-3] if a.endswith("/**") else a
        b_base = b[:-3] if b.endswith("/**") else b
        return (
            a == b
            or a.startswith(f"{b}/")
            or b.startswith(f"{a}/")
            or a == "*"
            or b == "*"
            or (a.endswith("/**") and (b == a_base or b.startswith(f"{a_base}/")))
            or (b.endswith("/**") and (a == b_base or a.startswith(f"{b_base}/")))
        )

    conflicts = []
    for shared_path in shared:
        if any(overlap(path, shared_path) for role in ("frontend", "engineer") for path in assignments.get(role, [])):
            conflicts.append(f"shared: {shared_path}")
    for left in assignments.get("frontend", []):
        for right in assignments.get("engineer", []):
            if overlap(left, right):
                conflicts.append(f"frontend:{left} <-> engineer:{right}")
    unique = sorted(set(conflicts))
    return {
        "parallel": not unique,
        "reason": "Write scopes are disjoint." if not unique else "Overlapping or shared write scope requires sequential execution.",
        "assignments": assignments,
        "conflicts": unique,
        "worktreeRecommended": bool(unique),
        "redacted": True,
    }


def worktrees(project_path: str, action: str = "list", role: str = "frontend", slug: str = "task", confirm: bool = False) -> dict[str, Any]:
    root = Path(project_path)
    if not root.is_dir():
        raise ValueError("project_path must exist")
    flags = feature_flags()
    target = root / ".codex-orchestra" / "worktrees" / f"{role}-{slug}"
    if action == "list":
        rows = load_json_rows("worktrees", limit=20)
        return {"ok": True, "experimental": flags["experimentalWorktrees"], "recorded": len(rows), "rows": rows, "redacted": True}
    if action == "preview":
        return {
            "ok": True,
            "role": role,
            "slug": slug,
            "target": str(target),
            "command": "git worktree add --detach <target> HEAD",
            "requiresConfirmation": True,
            "experimental": True,
            "merge": "manual",
            "redacted": True,
        }
    if action == "create":
        policy.require_confirm("worktree.create", confirm)
        if not flags["experimentalWorktrees"]:
            raise PermissionError(
                "Enable experimental worktrees via orchestra_router action=set-flag flag=experimentalWorktrees value=true"
            )
        if target.exists():
            raise ValueError("Worktree target already exists")
        target.parent.mkdir(parents=True, exist_ok=True)
        completed = subprocess.run(
            ["git", "-C", str(root), "worktree", "add", "--detach", str(target), "HEAD"],
            capture_output=True,
            text=True,
        )
        return {"ok": completed.returncode == 0, "target": str(target), "detail": redact(completed.stderr or completed.stdout or ""), "redacted": True}
    if action == "remove":
        policy.require_confirm("worktree.remove", confirm)
        completed = subprocess.run(
            ["git", "-C", str(root), "worktree", "remove", str(target)],
            capture_output=True,
            text=True,
        )
        return {"ok": completed.returncode == 0, "removed": completed.returncode == 0, "redacted": True}
    raise ValueError(f"Unsupported worktree action: {action}")


def repair(confirm: bool = False) -> dict[str, Any]:
    health = doctor()
    router = codex_router.detect()
    actions = []
    if not router["healthy"]:
        if confirm:
            actions.append(codex_router.start(confirm=True, force=False))
        else:
            actions.append({"pending": "router.start", "requiresConfirmation": True})
    return {
        "ok": True,
        "health": health,
        "actions": actions,
        "desktop": desktop_deeplink("diagnostics"),
        "note": "Paid live checks stay in the desktop app. Provider keys stay in the local Router helper.",
        "redacted": True,
    }


def setup(project_path: str | None = None, confirm: bool = False) -> dict[str, Any]:
    snapshot = status()
    result: dict[str, Any] = {
        "ok": True,
        "detected": snapshot,
        "next": [],
        "desktop": desktop_deeplink("setup"),
        "redacted": True,
    }
    if not snapshot["codex"]["detected"]:
        result["next"].append("Install Codex Desktop / CLI before applying Orchestra files.")
    if not snapshot["router"]["detected"]:
        result["next"].append("Confirm orchestra_router action=install to clone the reviewed Router pin.")
    if project_path:
        preview = preview_managed(project_path)
        result["preview"] = preview
        if confirm:
            result["apply"] = apply_managed(project_path, confirm=True, expected_hash=preview["currentHash"])
        else:
            result["next"].append("Review the managed preview, then call orchestra_apply_managed with confirm=true.")
    else:
        result["next"].append("Pass project_path to preview or apply managed files.")
    return result


def sync_status() -> dict[str, Any]:
    projects = load_json_rows("projects", limit=50)
    return {
        "registeredProjectCount": len(projects),
        "agents": [
            {"role": agent.get("role"), "model": agent.get("modelId"), "health": agent.get("health")}
            for agent in _default_agents()
        ],
        "managedArtifacts": [
            ".codex/agents/orchestra_frontend.toml",
            ".codex/agents/orchestra_engineer.toml",
            ".codex/agents/orchestra_visual.toml",
            ".codex/skills/orchestra-routing/SKILL.md",
            ".codex/config.toml",
            "AGENTS.md managed block",
        ],
        "desktop": desktop_deeplink("setup"),
        "threads": codex_app_server.thread_bridge(),
        "redacted": True,
    }


def dispatch(name: str, arguments: dict[str, Any] | None = None) -> dict[str, Any]:
    args = arguments or {}
    confirm = bool(args.get("confirm"))
    if name in {"orchestra_status", "status"}:
        return status()
    if name in {"orchestra_usage_summary", "usage"}:
        return usage_summary()
    if name in {"orchestra_scope_plan", "plan"}:
        return scope_plan(args.get("assignments") or {}, args.get("sharedPaths") or [])
    if name in {"orchestra_sync_status", "sync"}:
        return sync_status()
    if name in {"orchestra_doctor", "doctor"}:
        return doctor()
    if name in {"orchestra_models", "models"}:
        return models()
    if name in {"orchestra_team", "team"}:
        if args.get("agent"):
            return save_team(args["agent"], confirm)
        if args.get("strategy"):
            strategy = args["strategy"]
            return save_strategy(strategy.get("mode", "pinned"), confirm, strategy.get("provider"), strategy.get("upstreamModel"))
        return team()
    if name in {"orchestra_router", "router"}:
        return router_action(args)
    if name in {"orchestra_setup", "setup"}:
        return setup(args.get("project_path") or args.get("projectPath"), confirm)
    if name in {"orchestra_apply_managed", "apply"}:
        return apply_managed(args["project_path"] if "project_path" in args else args["projectPath"], confirm, args.get("expectedHash"))
    if name in {"orchestra_repair", "repair"}:
        return repair(confirm)
    if name in {"orchestra_worktrees", "worktrees"}:
        return worktrees(
            args.get("project_path") or args.get("projectPath") or str(Path.cwd()),
            args.get("action") or "list",
            args.get("role") or "frontend",
            args.get("slug") or "task",
            confirm,
        )
    if name in {"orchestra_threads", "threads"}:
        return codex_app_server.thread_bridge()
    raise ValueError(f"Unknown Orchestra command: {name}")
