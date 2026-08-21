#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))

from core import artifacts, policy
from core.redact import redact
from orchestra_core import dispatch
from adapters import codex_router
from adapters.codex_app_server import thread_bridge
from mcp_server import handle, tool_definitions


class PluginCoreTests(unittest.TestCase):
    def _router_env(self, root: Path) -> dict[str, str]:
        state = root / "state"
        state.mkdir(parents=True, exist_ok=True)
        return {
            "MODEL_ROUTER_STATE_DIR": str(state),
            "CODEX_ORCHESTRA_ROUTER_ROOT": str(root / "router"),
            "CODEX_ORCHESTRA_DATA_DIR": str(root / "data"),
            "CODEX_HOME": str(root / "home"),
        }

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

    def test_connect_provider_requires_confirm(self) -> None:
        with self.assertRaises(PermissionError):
            dispatch(
                "orchestra_router",
                {"action": "connect-provider", "provider": "deepseek", "confirm": False},
            )

    def test_connect_provider_rejects_unknown_provider(self) -> None:
        with self.assertRaises(ValueError):
            dispatch(
                "orchestra_router",
                {"action": "connect-provider", "provider": "OpenRouter/v1", "confirm": True},
            )

    def test_connect_provider_accepts_community_slug(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            script = Path(raw) / "model-router.ps1"
            script.write_text("", encoding="utf-8")
            with mock.patch(
                "adapters.codex_router._launcher", return_value=(script, True)
            ), mock.patch(
                "adapters.codex_router.first_party_provider_ids", return_value={"openrouter"}
            ), mock.patch(
                "adapters.codex_router.apply_overlay",
                return_value={"ok": True, "status": "applied", "files": ["src/user-providers.mjs"]},
            ), mock.patch("subprocess.Popen") as popen:
                result = dispatch(
                    "orchestra_router",
                    {"action": "connect-provider", "provider": "openrouter", "confirm": True},
                )
            self.assertTrue(result["ok"])
            self.assertEqual(result["provider"], "openrouter")
            self.assertEqual(result["overlay"]["status"], "applied")
            self.assertIn("openrouter", " ".join(popen.call_args.args[0]))

    def test_router_schema_has_no_secret_fields(self) -> None:
        router_tool = next(tool for tool in tool_definitions() if tool["name"] == "orchestra_router")
        schema = router_tool["inputSchema"]
        self.assertFalse(schema.get("additionalProperties"))
        properties = schema.get("properties", {})
        forbidden = {"apikey", "key", "token", "secret"}
        names = {name.lower() for name in properties}
        self.assertFalse(names & forbidden)

    def test_router_schema_lists_connect_provider(self) -> None:
        router_tool = next(tool for tool in tool_definitions() if tool["name"] == "orchestra_router")
        enum = router_tool["inputSchema"]["properties"]["action"]["enum"]
        self.assertIn("connect-provider", enum)
        self.assertIn("provider", router_tool["inputSchema"]["properties"])

    def test_upsert_user_provider_requires_confirm(self) -> None:
        with self.assertRaises(PermissionError):
            dispatch(
                "orchestra_router",
                {"action": "upsert-user-provider", "provider": "acme-corp", "confirm": False},
            )

    def test_upsert_user_provider_writes_fixture_and_rejects_secrets(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            env = self._router_env(root)
            with mock.patch.dict(os.environ, env, clear=False):
                result = dispatch(
                    "orchestra_router",
                    {
                        "action": "upsert-user-provider",
                        "provider": "acme-corp",
                        "displayName": "Acme Corp",
                        "baseUrl": "https://api.acme-corp.example/v1",
                        "ownedBy": "Acme",
                        "credentialFile": "acme-key.secret",
                        "credentialEnvironment": ["ACME_API_KEY"],
                        "protocol": "openai",
                        "confirm": True,
                    },
                )
            self.assertTrue(result["ok"])
            payload = json.loads((root / "state" / "user-providers.json").read_text(encoding="utf-8"))
            self.assertEqual(payload["version"], 1)
            self.assertEqual(payload["providers"][0]["id"], "acme-corp")
            self.assertEqual(payload["providers"][0]["kind"], "openai-compatible")
            self.assertEqual(payload["providers"][0]["credential"]["file"], "acme-key.secret")
            self.assertEqual(payload["providers"][0]["credential"]["environment"], ["ACME_API_KEY"])
            with mock.patch.dict(os.environ, env, clear=False):
                with self.assertRaises(ValueError):
                    dispatch(
                        "orchestra_router",
                        {
                            "action": "upsert-user-provider",
                            "provider": "acme-corp",
                            "baseUrl": "sk-abcdefghijklmnopqrstuvwxyz0123456789",
                            "confirm": True,
                        },
                    )
            with mock.patch.dict(os.environ, env, clear=False):
                with self.assertRaises(ValueError):
                    dispatch(
                        "orchestra_router",
                        {
                            "action": "upsert-user-provider",
                            "provider": "acme-corp",
                            "credentialEnvironment": ["ghp_abcdefghijklmnopqrstuvwxyz"],
                            "confirm": True,
                        },
                    )
            with mock.patch.dict(os.environ, env, clear=False):
                with self.assertRaises(ValueError):
                    dispatch(
                        "orchestra_router",
                        {"action": "upsert-user-provider", "provider": "deepseek", "confirm": True},
                    )

    def test_upsert_user_models_writes_contract(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            env = self._router_env(root)
            with mock.patch.dict(os.environ, env, clear=False):
                result = dispatch(
                    "orchestra_router",
                    {
                        "action": "upsert-user-models",
                        "models": [
                            {
                                "slug": "acme/model-x",
                                "displayName": "Acme Model X",
                                "contextWindow": 128000,
                                "inputModalities": ["text"],
                            }
                        ],
                        "confirm": True,
                    },
                )
            self.assertTrue(result["ok"])
            payload = json.loads((root / "state" / "user-models.json").read_text(encoding="utf-8"))
            self.assertEqual(payload["version"], 1)
            model = payload["models"][0]
            self.assertEqual(model["slug"], "acme/model-x")
            self.assertEqual(model["provider"], "acme")
            self.assertEqual(model["upstreamModel"], "model-x")
            self.assertEqual(model["gatewayModel"], "acme-model-x")
            self.assertTrue(model["listed"])
            self.assertEqual(model["contextWindow"], 128000)
            self.assertEqual(model["inputModalities"], ["text"])
            self.assertIn("compHash", model)
            self.assertNotIn("requestProfile", model)

    def test_upsert_user_model_request_profile_is_a_string(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            env = self._router_env(root)
            with mock.patch.dict(os.environ, env, clear=False):
                result = dispatch(
                    "orchestra_router",
                    {
                        "action": "upsert-user-models",
                        "models": [
                            {
                                "slug": "acme/model-rp",
                                "displayName": "Acme RP",
                                "contextWindow": 64000,
                                "requestProfile": "openai-responses",
                            }
                        ],
                        "confirm": True,
                    },
                )
            self.assertTrue(result["ok"])
            model = result["models"][0]
            self.assertEqual(model["requestProfile"], "openai-responses")

    def test_upsert_user_model_rejects_request_profile_object(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            env = self._router_env(root)
            with mock.patch.dict(os.environ, env, clear=False):
                with self.assertRaises(ValueError):
                    dispatch(
                        "orchestra_router",
                        {
                            "action": "upsert-user-models",
                            "models": [
                                {
                                    "slug": "acme/model-rp",
                                    "requestProfile": {"profile": "openai-responses"},
                                }
                            ],
                            "confirm": True,
                        },
                    )

    def test_upsert_user_provider_keyless_loopback(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            env = self._router_env(root)
            with mock.patch.dict(os.environ, env, clear=False):
                result = dispatch(
                    "orchestra_router",
                    {
                        "action": "upsert-user-provider",
                        "provider": "ollama-local",
                        "displayName": "Ollama Local",
                        "ownedBy": "ollama",
                        "baseUrl": "http://127.0.0.1:11434/v1",
                        "keyless": True,
                        "confirm": True,
                    },
                )
            self.assertTrue(result["ok"])
            entry = result["provider"]
            self.assertTrue(entry["keyless"])
            self.assertNotIn("credential", entry)
            self.assertEqual(entry["baseUrl"], "http://127.0.0.1:11434/v1")

    def test_upsert_user_provider_keyless_rejects_credential(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            env = self._router_env(root)
            with mock.patch.dict(os.environ, env, clear=False):
                with self.assertRaises(ValueError):
                    dispatch(
                        "orchestra_router",
                        {
                            "action": "upsert-user-provider",
                            "provider": "ollama-local",
                            "displayName": "Ollama Local",
                            "ownedBy": "ollama",
                            "baseUrl": "http://127.0.0.1:11434/v1",
                            "keyless": True,
                            "credentialFile": "ollama.secret",
                            "confirm": True,
                        },
                    )

    def test_upsert_user_provider_keyless_rejects_remote(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            env = self._router_env(root)
            with mock.patch.dict(os.environ, env, clear=False):
                with self.assertRaises(ValueError):
                    dispatch(
                        "orchestra_router",
                        {
                            "action": "upsert-user-provider",
                            "provider": "ollama-remote",
                            "displayName": "Ollama Remote",
                            "ownedBy": "ollama",
                            "baseUrl": "http://example.com:11434/v1",
                            "keyless": True,
                            "confirm": True,
                        },
                    )

    def test_upsert_user_provider_rejects_remote_http(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            env = self._router_env(root)
            with mock.patch.dict(os.environ, env, clear=False):
                with self.assertRaises(ValueError):
                    dispatch(
                        "orchestra_router",
                        {
                            "action": "upsert-user-provider",
                            "provider": "acme-http",
                            "displayName": "Acme HTTP",
                            "ownedBy": "acme",
                            "baseUrl": "http://api.acme.example/v1",
                            "credentialFile": "acme.secret",
                            "credentialEnvironment": ["ACME_API_KEY"],
                            "confirm": True,
                        },
                    )

    def test_set_model_visible_toggles_hidden_list(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            env = self._router_env(root)
            with mock.patch.dict(os.environ, env, clear=False):
                hide = dispatch(
                    "orchestra_router",
                    {"action": "set-model-visible", "slug": "acme/model-x", "visible": False, "confirm": True},
                )
                self.assertTrue(hide["ok"])
                self.assertIn("acme/model-x", hide["hidden"])
                show = dispatch(
                    "orchestra_router",
                    {"action": "set-model-visible", "slug": "acme/model-x", "visible": True, "confirm": True},
                )
                self.assertNotIn("acme/model-x", show["hidden"])
            payload = json.loads((root / "state" / "model-picker.json").read_text(encoding="utf-8"))
            self.assertEqual(payload["version"], 1)
            self.assertNotIn("acme/model-x", payload["hidden"])

    def test_refresh_catalog_does_not_rewrite_picker(self) -> None:
        self.assertFalse(hasattr(codex_router, "apply_picker_allowlist"))
        self.assertFalse(hasattr(codex_router, "VISIBLE_MODELS"))
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            state = root / "state"
            state.mkdir()
            picker = state / "model-picker.json"
            picker.write_text(json.dumps({"version": 1, "hidden": ["keep/me"]}), encoding="utf-8")
            env = {"MODEL_ROUTER_STATE_DIR": str(state)}
            with mock.patch.dict(os.environ, env, clear=False):
                with mock.patch.object(codex_router, "run_operation", return_value={"ok": True, "status": 0}) as run:
                    result = dispatch("orchestra_router", {"action": "refresh-catalog", "confirm": True})
            self.assertTrue(result["ok"])
            self.assertNotIn("picker", result)
            run.assert_called_once_with("refresh-catalog", confirm=True)
            self.assertEqual(json.loads(picker.read_text(encoding="utf-8"))["hidden"], ["keep/me"])

    def test_doctor_does_not_mark_desktop_missing_unhealthy(self) -> None:
        healthy_router = {
            "detected": True,
            "version": "0.4.0-beta.3",
            "healthy": True,
            "service": "running",
            "ports": [4200],
            "identityOk": True,
            "issue": None,
            "canRestart": True,
            "redacted": True,
        }
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            env = self._router_env(root)
            with mock.patch.dict(os.environ, env, clear=False):
                with mock.patch("orchestra_core._find_codex", return_value=str(root / "codex.exe")):
                    with mock.patch("orchestra_core.desktop_executable", return_value=None):
                        with mock.patch("adapters.codex_router.detect", return_value=healthy_router):
                            result = dispatch("orchestra_doctor", {})
            desktop = next(check for check in result["checks"] if check["id"] == "desktop")
            self.assertEqual(desktop["status"], "info")
            self.assertNotEqual(desktop["status"], "missing")
            self.assertNotEqual(desktop["status"], "unhealthy")
            self.assertIn(result["status"], {"healthy", "unknown"})

    def test_bootstrap_state_db_then_team_save_and_set_flag_persist(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            env = self._router_env(root)
            with mock.patch.dict(os.environ, env, clear=False):
                team = dispatch(
                    "orchestra_team",
                    {"agent": {"id": "frontend", "role": "frontend", "modelId": "acme/acme-v1"}, "confirm": True},
                )
                self.assertTrue(team["ok"])
                flags = dispatch(
                    "orchestra_router",
                    {"action": "set-flag", "flag": "experimentalWorktrees", "value": True, "confirm": True},
                )
                self.assertTrue(flags["ok"])
                self.assertTrue(flags["flags"]["experimentalWorktrees"])
                self.assertTrue((root / "data" / "orchestra.db").is_file())
            connection = sqlite3.connect(str(root / "data" / "orchestra.db"))
            rows = connection.execute("SELECT value FROM settings WHERE key = 'featureFlags'").fetchall()
            self.assertTrue(rows)
            connection.close()

    def test_disconnect_provider_spawns_visible_helper(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            script = Path(raw) / "model-router.ps1"
            script.write_text("", encoding="utf-8")
            with mock.patch("adapters.codex_router._launcher", return_value=(script, True)), mock.patch(
                "subprocess.Popen"
            ) as popen:
                result = dispatch(
                    "orchestra_router",
                    {"action": "disconnect-provider", "provider": "openrouter", "confirm": True},
                )
            self.assertTrue(result["ok"])
            self.assertTrue(result["interactive"])
            self.assertFalse(result["credentialValuesReadByOrchestra"])
            self.assertIn("provider-key", " ".join(popen.call_args.args[0]))
            self.assertIn("remove", " ".join(popen.call_args.args[0]))
            self.assertIn("openrouter", " ".join(popen.call_args.args[0]))

    def test_apply_overlay_invokes_official_helper(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            checkout = root / "router"
            (checkout / "src").mkdir(parents=True)
            helper = root / "apply.mjs"
            helper.write_text("", encoding="utf-8")
            completed = mock.Mock()
            completed.returncode = 0
            completed.stdout = json.dumps({"files": ["src/user-providers.mjs"]})
            completed.stderr = ""
            with mock.patch.dict(
                os.environ,
                {"CODEX_ORCHESTRA_ROUTER_ROOT": str(checkout)},
                clear=False,
            ):
                with mock.patch("adapters.codex_router.overlay_apply_script", return_value=helper):
                    with mock.patch("subprocess.run", return_value=completed) as run:
                        result = codex_router.apply_overlay()
            self.assertTrue(result["ok"])
            self.assertEqual(result["status"], "applied")
            self.assertEqual(result["files"], ["src/user-providers.mjs"])
            args = run.call_args.args[0]
            self.assertEqual(args[0], "node")
            self.assertEqual(args[1], str(helper))
            self.assertEqual(args[2], str(checkout))

    def test_overlay_apply_script_resolves_inside_package(self) -> None:
        script = codex_router.overlay_apply_script()
        self.assertIsNotNone(script)
        self.assertTrue(script.is_file())
        parts = list(script.parts)
        self.assertEqual(parts[-2:], ["router-overlay", "apply.mjs"])
        self.assertIn("plugins", parts)
        self.assertIn("codex-orchestra", parts)

    def test_apply_overlay_end_to_end_from_packaged_helper(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            checkout = root / "router"
            (checkout / "src").mkdir(parents=True)
            with mock.patch.dict(os.environ, {"CODEX_ORCHESTRA_ROUTER_ROOT": str(checkout)}, clear=False):
                result = codex_router.apply_overlay()
            self.assertTrue(result["ok"])
            self.assertEqual(result["status"], "applied")
            self.assertEqual(result["files"], ["src/user-providers.mjs", "src/model-registry.mjs"])
            self.assertTrue((checkout / "src" / "user-providers.mjs").is_file())
            self.assertTrue((checkout / "src" / "model-registry.mjs").is_file())
            self.assertTrue((checkout / ".orchestra-overlay.json").is_file())

    def test_connect_provider_spawns_visible_helper(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            script = Path(raw) / "model-router.ps1"
            script.write_text("", encoding="utf-8")
            with mock.patch(
                "adapters.codex_router._launcher", return_value=(script, True)
            ), mock.patch(
                "adapters.codex_router.first_party_provider_ids", return_value={"deepseek"}
            ), mock.patch(
                "adapters.codex_router.apply_overlay",
                return_value={"ok": True, "status": "applied", "files": ["src/user-providers.mjs"]},
            ), mock.patch("subprocess.Popen") as popen:
                result = dispatch(
                    "orchestra_router",
                    {"action": "connect-provider", "provider": "deepseek", "confirm": True},
                )
            self.assertTrue(result["ok"])
            self.assertTrue(result["interactive"])
            self.assertFalse(result["credentialValuesReadByOrchestra"])
            popen.assert_called_once()
            kwargs = popen.call_args.kwargs
            if os.name == "nt":
                self.assertEqual(kwargs.get("creationflags"), subprocess.CREATE_NEW_CONSOLE)
            self.assertNotIn("stdin", kwargs)
            self.assertIn("provider-key", " ".join(popen.call_args.args[0]))
            self.assertIn("deepseek", " ".join(popen.call_args.args[0]))
            self.assertNotIn("-NonInteractive", popen.call_args.args[0])

    def test_connect_provider_applies_overlay_before_spawning(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            script = Path(raw) / "model-router.ps1"
            script.write_text("", encoding="utf-8")
            order: list = []

            def record_overlay():
                order.append("overlay")
                return {"ok": True, "status": "applied", "files": ["src/user-providers.mjs"]}

            def record_popen(*args, **kwargs):
                order.append("spawn")

            with mock.patch(
                "adapters.codex_router._launcher", return_value=(script, True)
            ), mock.patch(
                "adapters.codex_router.first_party_provider_ids", return_value={"openrouter"}
            ), mock.patch(
                "adapters.codex_router.apply_overlay", side_effect=record_overlay
            ), mock.patch("subprocess.Popen", side_effect=record_popen):
                result = dispatch(
                    "orchestra_router",
                    {"action": "connect-provider", "provider": "openrouter", "confirm": True},
                )
            self.assertEqual(order, ["overlay", "spawn"])
            self.assertEqual(result["overlay"]["status"], "applied")

    def test_connect_provider_custom_overlay_failure_does_not_spawn(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            script = Path(raw) / "model-router.ps1"
            script.write_text("", encoding="utf-8")
            with mock.patch(
                "adapters.codex_router._launcher", return_value=(script, True)
            ), mock.patch(
                "adapters.codex_router.first_party_provider_ids", return_value=set()
            ), mock.patch(
                "adapters.codex_router.apply_overlay",
                return_value={"ok": False, "status": "failed", "detail": "overlay apply failed"},
            ), mock.patch("subprocess.Popen") as popen:
                with self.assertRaises(RuntimeError):
                    dispatch(
                        "orchestra_router",
                        {"action": "connect-provider", "provider": "acme-corp", "confirm": True},
                    )
            popen.assert_not_called()

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
