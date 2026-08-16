"""App Server / thread adapter. Reuses codex-control when installed."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from core.paths import plugins_home, user_home

CONTROL_PLUGIN = "codex-control"


def installed_control_root() -> Path | None:
    candidates = [
        plugins_home() / CONTROL_PLUGIN,
        user_home() / ".codex" / "plugins" / "cache" / CONTROL_PLUGIN,
    ]
    for path in candidates:
        if (path / "scripts" / "codex_control.py").is_file():
            return path
        if (path / "skills").is_dir() and path.is_dir():
            # cache layouts vary; keep looking for the CLI
            for child in path.rglob("codex_control.py"):
                return child.parent.parent
    return None


def thread_bridge() -> dict[str, Any]:
    root = installed_control_root()
    if root is None:
        return {
            "available": False,
            "plugin": CONTROL_PLUGIN,
            "reason": "codex-control is not installed. Install that plugin for list/read/create/send/steer.",
            "duplicate": False,
            "redacted": True,
        }
    return {
        "available": True,
        "plugin": CONTROL_PLUGIN,
        "rootPresent": True,
        "cli": str(root / "scripts" / "codex_control.py"),
        "tools": [
            "list_projects",
            "list_threads",
            "search_threads",
            "read_thread",
            "thread_status",
            "create_thread",
            "send_instruction",
            "steer_thread",
        ],
        "note": "Orchestra does not duplicate these writes. Use the installed codex-control MCP tools.",
        "redacted": True,
    }


def marketplace_hint() -> dict[str, str]:
    return {
        "plugin": CONTROL_PLUGIN,
        "install": "codex plugin add codex-control@personal",
    }
