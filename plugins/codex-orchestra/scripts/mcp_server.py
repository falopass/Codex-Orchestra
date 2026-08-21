#!/usr/bin/env python3
"""Stdio MCP server for Codex Orchestra. Local only."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

SCRIPTS = Path(__file__).resolve().parent
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from orchestra_core import dispatch
from core.redact import redact

SERVER_NAME = "codex-orchestra"
SERVER_VERSION = "0.1.0"

READ_ANNOTATIONS = {
    "readOnlyHint": True,
    "destructiveHint": False,
    "idempotentHint": True,
    "openWorldHint": False,
}
WRITE_ANNOTATIONS = {
    "readOnlyHint": False,
    "destructiveHint": False,
    "idempotentHint": False,
    "openWorldHint": False,
}


def _tool_result(payload: dict[str, Any], *, is_error: bool = False) -> dict[str, Any]:
    return {
        "content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False)}],
        "structuredContent": payload,
        "isError": is_error,
    }


def tool_definitions() -> list[dict[str, Any]]:
    confirm = {
        "type": "boolean",
        "description": "Must be true for writes, process starts and managed file changes.",
    }
    project_path = {
        "type": "string",
        "description": "Absolute local project directory. Never a list or *.",
    }
    return [
        {
            "name": "orchestra_status",
            "description": "Read redacted Codex, Router, provider, agent and desktop status.",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
            "annotations": READ_ANNOTATIONS,
        },
        {
            "name": "orchestra_usage_summary",
            "description": "Read aggregate local token and cost metadata. Reported and estimated stay separate.",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
            "annotations": READ_ANNOTATIONS,
        },
        {
            "name": "orchestra_scope_plan",
            "description": "Check frontend/engineer ownership patterns for overlap. Does not create worktrees.",
            "inputSchema": {
                "type": "object",
                "required": ["assignments"],
                "properties": {
                    "assignments": {
                        "type": "object",
                        "properties": {
                            "root": {"type": "array", "items": {"type": "string"}},
                            "frontend": {"type": "array", "items": {"type": "string"}},
                            "engineer": {"type": "array", "items": {"type": "string"}},
                        },
                        "additionalProperties": False,
                    },
                    "sharedPaths": {"type": "array", "items": {"type": "string"}},
                },
                "additionalProperties": False,
            },
            "annotations": READ_ANNOTATIONS,
        },
        {
            "name": "orchestra_sync_status",
            "description": "Read logical team bindings, managed artifact inventory and thread-bridge status.",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
            "annotations": READ_ANNOTATIONS,
        },
        {
            "name": "orchestra_doctor",
            "description": "Run redacted health checks for Codex, Router, providers, desktop and thread control.",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
            "annotations": READ_ANNOTATIONS,
        },
        {
            "name": "orchestra_models",
            "description": "List visible catalog models and credential status without exposing secret values.",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
            "annotations": READ_ANNOTATIONS,
        },
        {
            "name": "orchestra_team",
            "description": "Read or update local Orchestra role bindings. Writes require confirm=true and do not touch foreign agents.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "agent": {"type": "object"},
                    "strategy": {
                        "type": "object",
                        "properties": {
                            "mode": {"type": "string", "enum": ["auto", "pinned"]},
                            "provider": {"type": "string"},
                            "upstreamModel": {"type": "string"},
                        },
                    },
                    "confirm": confirm,
                },
                "additionalProperties": False,
            },
            "annotations": WRITE_ANNOTATIONS,
        },
        {
            "name": "orchestra_router",
            "description": (
                "Detect, doctor, start, restart, logs, catalog, update, rollback, "
                "manage providers and models, or refresh the catalog for the external Codex Router. "
                "connect-provider/disconnect-provider launch the local helper in a visible terminal "
                "and never read credential values. Writes require confirm=true."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": [
                            "detect",
                            "status",
                            "doctor",
                            "providers",
                            "models",
                            "logs",
                            "start",
                            "restart",
                            "install",
                            "connect-provider",
                            "disconnect-provider",
                            "list-providers",
                            "enable-provider",
                            "disable-provider",
                            "upsert-user-provider",
                            "upsert-user-models",
                            "set-model-visible",
                            "curate-models",
                            "refresh-catalog",
                            "set-flag",
                            "flags",
                            "update-check",
                            "update",
                            "rollback",
                        ],
                    },
                    "provider": {
                        "type": "string",
                        "description": (
                            "Router provider slug for connect-provider, disconnect-provider, "
                            "enable/disable-provider, upsert-user-provider, or curate-models. "
                            "Any lowercase slug is forwarded to the local Router helper. "
                            "Never pass apiKey, key, token or secret values."
                        ),
                    },
                    "displayName": {"type": "string"},
                    "baseUrl": {"type": "string"},
                    "ownedBy": {"type": "string"},
                    "protocol": {"type": "string", "enum": ["openai", "anthropic", "openai-responses"]},
                    "keyless": {
                        "type": "boolean",
                        "description": (
                            "True only for local loopback providers (Ollama, llama.cpp) that need no credential. "
                            "Keyless providers are restricted to 127.0.0.1/localhost/[::1] URLs."
                        ),
                    },
                    "credentialFile": {"type": "string", "description": "Filename only, never a secret value."},
                    "credentialEnvironment": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Environment variable names only, never secret values.",
                    },
                    "models": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "slug": {"type": "string", "description": "Provider/upstream model slug."},
                                "upstreamModel": {"type": "string"},
                                "displayName": {"type": "string"},
                                "contextWindow": {"type": "integer"},
                                "inputModalities": {"type": "array", "items": {"type": "string"}},
                                "requestProfile": {
                                    "type": "string",
                                    "description": "Optional Router request profile name. Omit for default passthrough.",
                                },
                            },
                            "additionalProperties": False,
                        },
                    },
                    "model": {"type": "string"},
                    "slug": {"type": "string"},
                    "visible": {"type": "boolean"},
                    "enabled": {"type": "boolean"},
                    "flag": {"type": "string"},
                    "value": {"type": ["boolean", "string"]},
                    "confirm": confirm,
                },
                "additionalProperties": False,
            },
            "annotations": WRITE_ANNOTATIONS,
        },
        {
            "name": "orchestra_setup",
            "description": "Detect the local environment and optionally preview or apply Orchestra-managed files.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project_path": project_path,
                    "confirm": confirm,
                },
                "additionalProperties": False,
            },
            "annotations": WRITE_ANNOTATIONS,
        },
        {
            "name": "orchestra_apply_managed",
            "description": "Apply only Orchestra-managed AGENTS.md and generated agent/skill files after a reviewed preview.",
            "inputSchema": {
                "type": "object",
                "required": ["project_path"],
                "properties": {
                    "project_path": project_path,
                    "expectedHash": {"type": "string"},
                    "confirm": confirm,
                },
                "additionalProperties": False,
            },
            "annotations": WRITE_ANNOTATIONS,
        },
        {
            "name": "orchestra_repair",
            "description": "Diagnose Router/Codex issues and optionally start a confirmed local recovery.",
            "inputSchema": {
                "type": "object",
                "properties": {"confirm": confirm},
                "additionalProperties": False,
            },
            "annotations": WRITE_ANNOTATIONS,
        },
        {
            "name": "orchestra_worktrees",
            "description": "Preview, list, create or remove disjoint frontend/engineer worktrees. Merge stays manual.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project_path": project_path,
                    "action": {"type": "string", "enum": ["list", "preview", "create", "remove"]},
                    "role": {"type": "string", "enum": ["frontend", "engineer"]},
                    "slug": {"type": "string"},
                    "confirm": confirm,
                },
                "additionalProperties": False,
            },
            "annotations": WRITE_ANNOTATIONS,
        },
        {
            "name": "orchestra_threads",
            "description": "Describe the codex-control bridge. Does not duplicate thread writes.",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
            "annotations": READ_ANNOTATIONS,
        },
    ]


def handle(request: dict[str, Any]) -> dict[str, Any] | None:
    request_id = request.get("id")
    if request_id is None:
        return None
    method = request.get("method") or ""
    if method == "initialize":
        result = {
            "protocolVersion": (request.get("params") or {}).get("protocolVersion") or "2025-06-18",
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
            "instructions": (
                "Local Orchestra control plane. Read tools are redacted. "
                "Writes require confirm=true and only touch Orchestra-managed files. "
                "Thread create/send/steer stays on the installed codex-control plugin. "
                "Pricing import, feature flags and the support bundle stay in the desktop app."
            ),
        }
    elif method == "ping":
        result = {}
    elif method == "tools/list":
        result = {"tools": tool_definitions()}
    elif method == "tools/call":
        params = request.get("params") or {}
        name = params.get("name") or ""
        arguments = params.get("arguments") or {}
        try:
            payload = dispatch(name, arguments if isinstance(arguments, dict) else {})
            return {"jsonrpc": "2.0", "id": request_id, "result": _tool_result(payload)}
        except Exception as error:  # noqa: BLE001
            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": _tool_result({"error": redact(str(error)), "redacted": True}, is_error=True),
            }
    else:
        return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": "Method not found"}}
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def main() -> int:
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        if len(line) > 1_000_000:
            print(json.dumps({"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Request too large"}}), flush=True)
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            print(json.dumps({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}}), flush=True)
            continue
        response = handle(request)
        if response is not None:
            print(json.dumps(response, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
