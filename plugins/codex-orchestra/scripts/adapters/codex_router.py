"""Adapter over the external Codex Router engine. No proxy reimplementation."""

from __future__ import annotations

import json
import os
import socket
import subprocess
from pathlib import Path
from typing import Any

from core.paths import router_root, router_state_root
from core.redact import redact

ROUTER_REPOSITORY = "https://github.com/duolahypercho/codex-router"
ROUTER_PINNED_TAG = "v0.4.0-beta.3"
ROUTER_PINNED_COMMIT = "a1be46aa02426d87a9e24e114ce8c22619c63c7a"
ROUTER_PORTS = (4200, 4201, 4202, 4203)
IDENTITY_PORT = 4202
READ_OPS = {"doctor", "status", "providers", "models", "update-check"}
MUTATING_OPS = {"refresh-catalog", "update", "rollback", "support-bundle", "install"}


def _launcher() -> tuple[Path, bool] | None:
    root = router_root()
    target = root / "model-router.ps1"
    if target.is_file():
        return target, True
    direct = root / "codex-router.ps1"
    if direct.is_file():
        return direct, False
    return None


def _port_open(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.15)
        try:
            return sock.connect_ex(("127.0.0.1", port)) == 0
        except OSError:
            return False


def observed_ports() -> list[int]:
    return [port for port in ROUTER_PORTS if _port_open(port)]


def runtime_files_present() -> bool:
    state = router_state_root()
    names = (
        "start-codex-router-hidden.ps1",
        "start-codex-router.cmd",
        "start-codex-router-hidden.vbs",
        "install-manifest.json",
        "merged-models.json",
        "router.err.log",
        "router.out.log",
    )
    return any((state / name).is_file() for name in names)


def start_script() -> Path | None:
    state = router_state_root()
    for name in (
        "start-codex-router-hidden.ps1",
        "start-codex-router.cmd",
        "start-codex-router-hidden.vbs",
    ):
        path = state / name
        if path.is_file():
            return path
    return None


def detect() -> dict[str, Any]:
    root = router_root()
    launcher = _launcher()
    detected = launcher is not None or (root / "package.json").is_file()
    ports = observed_ports()
    version = None
    package = root / "package.json"
    if package.is_file():
        try:
            version = json.loads(package.read_text(encoding="utf-8")).get("version")
        except (OSError, json.JSONDecodeError):
            version = None
    identity_ok = False
    if IDENTITY_PORT in ports:
        try:
            with socket.create_connection(("127.0.0.1", IDENTITY_PORT), timeout=0.4) as sock:
                sock.sendall(b"GET /healthz HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n")
                payload = sock.recv(2048).decode("utf-8", "ignore").lower()
                identity_ok = "codex-router" in payload or "ok" in payload
        except OSError:
            identity_ok = False
    service = "running" if identity_ok or ports else ("stopped" if detected or runtime_files_present() else "unknown")
    healthy = identity_ok
    issue = None if healthy else ("connection-refused" if detected else "missing-runtime")
    return {
        "detected": detected,
        "rootPresent": detected,
        "version": version,
        "pinnedTag": ROUTER_PINNED_TAG,
        "targetRef": ROUTER_PINNED_COMMIT,
        "ports": ports,
        "service": service,
        "healthy": healthy,
        "identityOk": identity_ok,
        "issue": issue,
        "canRestart": True,
        "redacted": True,
    }


def _args(operation: str, target_wrapper: bool) -> list[str]:
    namespaced = {
        "install": ["codex", "install"],
        "doctor": ["codex", "doctor"],
        "status": ["codex", "status"],
        "providers": ["codex", "providers"],
        "refresh-catalog": ["codex", "refresh-catalog"],
        "support-bundle": ["codex", "support-bundle"],
    }
    args = namespaced.get(operation, [])
    return args if target_wrapper else args[1:]


def run_operation(operation: str, confirm: bool = False) -> dict[str, Any]:
    if operation in MUTATING_OPS and not confirm:
        raise PermissionError(f"{operation} requires confirm=true")
    if operation == "models":
        return read_catalog()
    if operation == "update-check":
        info = detect()
        current = _git_head()
        status = "current" if current == ROUTER_PINNED_COMMIT else ("available" if info["detected"] else "blocked")
        return {
            "ok": True,
            "operation": operation,
            "currentRef": current,
            "targetRef": ROUTER_PINNED_COMMIT,
            "targetVersion": ROUTER_PINNED_TAG,
            "status": status,
            "redacted": True,
        }
    if operation == "install":
        return install(confirm=confirm)
    launcher = _launcher()
    if launcher is None:
        return {"ok": False, "status": "missing", "operation": operation, "detail": "Managed Router checkout was not detected."}
    script, target_wrapper = launcher
    args = _args(operation, target_wrapper)
    if not args and operation not in {"models", "update-check"}:
        return {"ok": False, "status": "unsupported", "operation": operation}
    command = [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        str(script),
        *args,
    ]
    env = os.environ.copy()
    env.update(
        {
            "MODEL_ROUTER_TARGET": "codex",
            "MODEL_ROUTER_STATE_DIR": str(router_state_root()),
            "MODEL_ROUTER_QUIET": "1",
            "PYTHONIOENCODING": "utf-8",
        }
    )
    completed = subprocess.run(
        command,
        capture_output=True,
        text=True,
        timeout=20,
        env=env,
        cwd=str(router_root()),
    )
    return {
        "ok": completed.returncode == 0,
        "operation": operation,
        "status": completed.returncode,
        "stdout": redact(completed.stdout or "", 1200),
        "stderr": redact(completed.stderr or "", 400),
        "redacted": True,
    }


def read_catalog() -> dict[str, Any]:
    path = router_state_root() / "merged-models.json"
    if not path.is_file():
        return {"ok": False, "operation": "models", "status": "missing", "models": []}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"ok": False, "operation": "models", "status": "invalid", "models": []}
    models = []
    raw = payload.get("models") if isinstance(payload, dict) else payload
    if isinstance(raw, dict):
        iterable = raw.values()
    elif isinstance(raw, list):
        iterable = raw
    else:
        iterable = []
    for entry in iterable:
        if not isinstance(entry, dict):
            continue
        model_id = entry.get("id") or entry.get("model") or entry.get("slug")
        if not model_id:
            continue
        models.append(
            {
                "id": model_id,
                "label": entry.get("displayName") or entry.get("label") or model_id,
                "providerId": entry.get("providerId") or entry.get("provider"),
                "available": bool(entry.get("available", True)),
                "upstreamModel": entry.get("upstreamModel"),
                "source": "catalog",
            }
        )
    return {"ok": True, "operation": "models", "models": models, "redacted": True}


def logs(limit: int = 20) -> dict[str, Any]:
    state = router_state_root()
    lines: list[dict[str, str]] = []
    for name, source in (
        ("router.out.log", "router.out"),
        ("router.out", "router.out"),
        ("router.err.log", "router.err"),
        ("router.err", "router.err"),
    ):
        path = state / name
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for raw in [line.strip() for line in text.splitlines() if line.strip()][-limit:]:
            lines.append({"source": source, "text": redact(raw)})
    return {
        "ok": True,
        "available": bool(lines),
        "lines": lines[-40:],
        "message": "Latest redacted Router process lines." if lines else "No Router process log lines were available.",
        "redacted": True,
    }


def start(confirm: bool, force: bool = False) -> dict[str, Any]:
    if not confirm:
        raise PermissionError("Router start/restart requires confirm=true")
    current = detect()
    if current["healthy"] and not force:
        return {"ok": True, "restarted": False, "phase": "healthy", "health": current, "redacted": True}
    script = start_script()
    if script is None:
        entry = router_root() / "src" / "start.mjs"
        if not entry.is_file():
            return {"ok": False, "restarted": False, "phase": "failed", "message": "Managed Router start mechanism was not detected.", "health": current, "redacted": True}
        command = ["node", str(entry)]
        cwd = str(router_root())
    else:
        suffix = script.suffix.lower()
        if suffix == ".ps1":
            command = ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", str(script)]
        elif suffix == ".cmd":
            command = ["cmd.exe", "/D", "/C", str(script)]
        else:
            command = ["wscript.exe", str(script)]
        cwd = str(router_state_root())
    subprocess.Popen(command, cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return {"ok": True, "restarted": True, "phase": "starting", "health": detect(), "redacted": True}


def install(confirm: bool) -> dict[str, Any]:
    if not confirm:
        raise PermissionError("Router installation requires confirm=true")
    root = router_root()
    if _launcher() is not None:
        return {"ok": True, "status": "already-detected", "detail": "Managed Router checkout already present.", "redacted": True}
    if root.exists():
        return {"ok": False, "status": "blocked", "detail": "Destination exists without a recognized checkout.", "redacted": True}
    root.parent.mkdir(parents=True, exist_ok=True)
    init = subprocess.run(["git", "init", str(root)], capture_output=True, text=True)
    if init.returncode != 0:
        return {"ok": False, "status": "failed", "detail": redact(init.stderr or init.stdout or "git init failed"), "redacted": True}
    subprocess.run(["git", "-C", str(root), "remote", "add", "origin", ROUTER_REPOSITORY], capture_output=True, text=True)
    fetch = subprocess.run(
        ["git", "-C", str(root), "fetch", "--depth", "1", "origin", ROUTER_PINNED_COMMIT],
        capture_output=True,
        text=True,
    )
    if fetch.returncode != 0:
        return {"ok": False, "status": "failed", "detail": redact(fetch.stderr or "fetch failed"), "redacted": True}
    checkout = subprocess.run(["git", "-C", str(root), "checkout", "--detach", "FETCH_HEAD"], capture_output=True, text=True)
    if checkout.returncode != 0 or _launcher() is None:
        return {"ok": False, "status": "failed", "detail": "Pinned checkout did not produce a Router wrapper.", "redacted": True}
    return {"ok": True, "status": "installed", "pinnedCommit": ROUTER_PINNED_COMMIT, "pinnedTag": ROUTER_PINNED_TAG, "redacted": True}


def _git_head() -> str | None:
    root = router_root()
    if not (root / ".git").exists():
        return None
    completed = subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"], capture_output=True, text=True)
    if completed.returncode != 0:
        return None
    value = completed.stdout.strip()
    return value or None
