"""Read Orchestra SQLite state without exposing secrets."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

from .paths import state_db_path
from .redact import redact


SCHEMA = [
    "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT)",
    "CREATE TABLE IF NOT EXISTS logs (id TEXT PRIMARY KEY, timestamp TEXT, level TEXT, operation TEXT, payload TEXT)",
    "CREATE TABLE IF NOT EXISTS health_runs (id TEXT PRIMARY KEY, started_at TEXT, completed_at TEXT, status TEXT, payload TEXT)",
    "CREATE TABLE IF NOT EXISTS usage_events (id TEXT PRIMARY KEY, timestamp TEXT, input_tokens INTEGER, output_tokens INTEGER, payload TEXT)",
    "CREATE TABLE IF NOT EXISTS backups (id TEXT PRIMARY KEY, created_at TEXT, payload TEXT)",
    "CREATE TABLE IF NOT EXISTS pricing_rules (id TEXT PRIMARY KEY, effective_from TEXT, payload TEXT)",
    "CREATE TABLE IF NOT EXISTS worktrees (id TEXT PRIMARY KEY, created_at TEXT, payload TEXT)",
    "CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, updated_at TEXT, payload TEXT)",
    "CREATE TABLE IF NOT EXISTS delegation_evidence (id TEXT PRIMARY KEY, occurred_at TEXT, payload TEXT)",
]


def _ensure_schema(connection: sqlite3.Connection) -> None:
    for statement in SCHEMA:
        connection.execute(statement)
    connection.commit()


def _connect(path: Path | None = None, *, create: bool = False) -> sqlite3.Connection | None:
    db = path or state_db_path()
    if not db.is_file() and not create:
        return None
    db.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(str(db))
    connection.row_factory = sqlite3.Row
    if create:
        _ensure_schema(connection)
    return connection


def load_setting(key: str, default: Any = None) -> Any:
    connection = _connect()
    if connection is None:
        return default
    try:
        row = connection.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        if not row:
            return default
        return json.loads(row[0])
    except (sqlite3.Error, json.JSONDecodeError):
        return default
    finally:
        connection.close()


def save_setting(key: str, value: Any) -> None:
    from datetime import datetime, timezone

    connection = _connect(create=True)
    assert connection is not None
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    connection.execute(
        "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)",
        (key, json.dumps(value), stamp),
    )
    connection.commit()
    connection.close()


def load_json_rows(table: str, column: str = "payload", limit: int = 50) -> list[dict[str, Any]]:
    connection = _connect()
    if connection is None:
        return []
    order = {
        "usage_events": "timestamp DESC",
        "health_runs": "completed_at DESC",
        "projects": "updated_at DESC",
        "logs": "timestamp DESC",
        "delegation_evidence": "occurred_at DESC",
        "worktrees": "created_at DESC",
        "backups": "created_at DESC",
        "pricing_rules": "effective_from DESC",
    }.get(table, "rowid DESC")
    try:
        rows = connection.execute(
            f"SELECT {column} FROM {table} ORDER BY {order} LIMIT ?",
            (limit,),
        ).fetchall()
        values: list[dict[str, Any]] = []
        for row in rows:
            try:
                parsed = json.loads(row[0])
            except (TypeError, json.JSONDecodeError):
                continue
            if isinstance(parsed, dict):
                values.append(parsed)
        return values
    except sqlite3.Error:
        return []
    finally:
        connection.close()


def usage_summary() -> dict[str, Any]:
    events = load_json_rows("usage_events", limit=500)
    input_tokens = 0
    cached = 0
    output_tokens = 0
    provider_reported = 0.0
    estimated = 0.0
    for event in events:
        input_tokens += int(event.get("inputTokens") or 0)
        cached += int(event.get("cachedInputTokens") or 0)
        output_tokens += int(event.get("outputTokens") or 0)
        provider_reported += float(event.get("providerCost") or 0)
        estimated += float(event.get("estimatedCost") or 0)
    return {
        "eventCount": len(events),
        "inputTokens": input_tokens,
        "cachedInputTokens": cached,
        "outputTokens": output_tokens,
        "providerReportedCost": provider_reported,
        "estimatedCost": estimated,
        "currency": "USD",
        "note": "Reported and estimated values remain separate. No telemetry was invented.",
        "redacted": True,
    }


def feature_flags() -> dict[str, bool]:
    flags = load_setting("featureFlags") or {}
    return {
        "appServer": bool(flags.get("appServer", False)),
        "mcp": bool(flags.get("mcp", False)),
        "experimentalWorktrees": bool(flags.get("experimentalWorktrees", False)),
    }


def persist_log(level: str, operation: str, message: str) -> None:
    connection = _connect(create=True)
    assert connection is not None
    from datetime import datetime, timezone

    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    payload = json.dumps({"message": redact(message), "redacted": True})
    try:
        connection.execute(
            "INSERT OR REPLACE INTO logs (id, timestamp, level, operation, payload) VALUES (?, ?, ?, ?, ?)",
            (f"log-{stamp}-{operation}", stamp, level, operation, payload),
        )
        connection.commit()
    except sqlite3.Error:
        return
    finally:
        connection.close()
