"""Windows-first Orchestra paths. No personal usernames are hard-coded."""

from __future__ import annotations

import os
from pathlib import Path


def user_home() -> Path:
    return Path(os.environ.get("USERPROFILE") or Path.home())


def data_root() -> Path:
    override = os.environ.get("CODEX_ORCHESTRA_DATA_DIR")
    if override:
        return Path(override)
    local = Path(os.environ.get("LOCALAPPDATA") or user_home() / "AppData" / "Local")
    return local / "CodexOrchestra"


def state_db_path() -> Path:
    return data_root() / "orchestra.db"


def codex_home() -> Path:
    override = os.environ.get("CODEX_HOME")
    if override:
        return Path(override)
    return user_home() / ".codex"


def router_root() -> Path:
    override = os.environ.get("CODEX_ORCHESTRA_ROUTER_ROOT")
    if override:
        return Path(override)
    return data_root() / "engine" / "codex-router"


def router_state_root() -> Path:
    for key in ("MODEL_ROUTER_STATE_DIR", "CODEX_ROUTER_STATE_DIR", "KIMI_CODEX_STATE_DIR"):
        value = os.environ.get(key)
        if value:
            return Path(value)
    return codex_home() / "codex-router"


def desktop_executable() -> Path | None:
    override = os.environ.get("CODEX_ORCHESTRA_DESKTOP")
    if override and Path(override).is_file():
        return Path(override)
    local = Path(os.environ.get("LOCALAPPDATA") or user_home() / "AppData" / "Local")
    candidates = [
        local / "CodexOrchestra" / "codex-orchestra.exe",
        user_home() / "AppData" / "Local" / "Programs" / "Codex Orchestra" / "codex-orchestra.exe",
    ]
    for path in candidates:
        if path.is_file():
            return path
    return None


def desktop_deeplink(view: str = "overview") -> str:
    exe = desktop_executable()
    if exe:
        return f"file:///{exe.as_posix()}?view={view}"
    return f"orchestra://desktop/{view}"


def plugins_home() -> Path:
    return user_home() / "plugins"
