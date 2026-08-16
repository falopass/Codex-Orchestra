#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))

from core import artifacts, policy
from core.redact import redact
from orchestra_core import dispatch
from adapters.codex_app_server import thread_bridge
from mcp_server import handle, tool_definitions


class PluginCoreTests(unittest.TestCase):
    def test_redact_hides_bearer_and_keys(self) -> None:
        text = redact("Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz")
        self.assertIn("[REDACTED]", text)
        self.assertNotIn("sk-abcdefghijklmnopqrstuvwxyz", text)

    def test_managed_merge_preserves_foreign_content(self) -> None:
        existing = "# Project rules\n\nKeep this.\n"
        block = artifacts.render_managed_block(
            [{"role": "frontend", "ownershipPaths": ["app/**"]}],
            ["package.json"],
        )
        merged = policy.merge_managed_block(existing, block)
        self.assertIn("Keep this.", merged)
        self.assertIn("BEGIN CODEX-ORCHESTRA MANAGED", merged)
        again = policy.merge_managed_block(merged, block)
        self.assertEqual(again.count("BEGIN CODEX-ORCHESTRA MANAGED"), 1)

    def test_preview_hash_is_stable(self) -> None:
        self.assertEqual(policy.preview_hash("abc"), policy.preview_hash("abc"))
        self.assertNotEqual(policy.preview_hash("abc"), policy.preview_hash("abd"))

    def test_scope_plan_detects_overlap(self) -> None:
        plan = dispatch(
            "orchestra_scope_plan",
            {
                "assignments": {"frontend": ["src/**"], "engineer": ["src/api.ts"], "root": []},
                "sharedPaths": ["package.json"],
            },
        )
        self.assertFalse(plan["parallel"])
        self.assertTrue(plan["conflicts"])

    def test_mutating_actions_require_confirm(self) -> None:
        with self.assertRaises(PermissionError):
            policy.require_confirm("setup.apply", False)

    def test_apply_is_marker_bounded(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            os.environ["CODEX_ORCHESTRA_DATA_DIR"] = str(root / "data")
            agents = root / "AGENTS.md"
            agents.write_text("# Foreign policy\n\nDo not destroy.\n", encoding="utf-8")
            preview = dispatch("orchestra_setup", {"project_path": str(root)})
            self.assertIn("preview", preview)
            result = dispatch(
                "orchestra_apply_managed",
                {
                    "project_path": str(root),
                    "expectedHash": preview["preview"]["currentHash"],
                    "confirm": True,
                },
            )
            self.assertTrue(result["ok"])
            text = agents.read_text(encoding="utf-8")
            self.assertIn("Foreign policy", text)
            self.assertIn("BEGIN CODEX-ORCHESTRA MANAGED", text)
            self.assertTrue((root / ".codex" / "agents" / "orchestra_frontend.toml").is_file())
            self.assertTrue((root / ".codex" / "skills" / "orchestra-routing" / "SKILL.md").is_file())

    def test_mcp_lists_expected_tools(self) -> None:
        names = {tool["name"] for tool in tool_definitions()}
        self.assertIn("orchestra_status", names)
        self.assertIn("orchestra_router", names)
        self.assertIn("orchestra_apply_managed", names)
        self.assertIn("orchestra_threads", names)

    def test_mcp_initialize_and_status(self) -> None:
        init = handle({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
        assert init is not None
        self.assertEqual(init["result"]["serverInfo"]["name"], "codex-orchestra")
        listed = handle({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        assert listed is not None
        self.assertGreaterEqual(len(listed["result"]["tools"]), 10)
        status = handle(
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {"name": "orchestra_status", "arguments": {}},
            }
        )
        assert status is not None
        payload = json.loads(status["result"]["content"][0]["text"])
        self.assertTrue(payload.get("redacted"))
        self.assertIn("router", payload)

    def test_thread_bridge_does_not_duplicate_writes(self) -> None:
        info = thread_bridge()
        self.assertEqual(info["plugin"], "codex-control")
        self.assertFalse(info.get("duplicate", False))


if __name__ == "__main__":
    unittest.main()
