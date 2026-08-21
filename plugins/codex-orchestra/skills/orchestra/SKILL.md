---
name: orchestra
description: Use Codex Orchestra for Router health, team roles, managed AGENTS files, diagnostics, usage and worktree planning. Trigger on Orchestra, router doctor, team builder, managed config, or /orchestra-setup /orchestra-doctor /orchestra-repair /orchestra-team /orchestra-models.
---

# Codex Orchestra

Use the plugin MCP tools first. They wrap Orchestra Core over local stdio.

## Progressive disclosure

1. Read `orchestra_status` or `orchestra_doctor` before mutating anything.
2. Use a specialized skill when the user asks for one surface:
   - `$orchestra-setup` for onboarding and managed files
   - `$orchestra-doctor` for health
   - `$orchestra-repair` for confirmed recovery
   - `$orchestra-team` for roles and bindings
   - `$orchestra-models` for catalog and credential status
3. Open the desktop app for pricing import, feature flags, support bundle and live paid checks.

## Tools

- `orchestra_status` — redacted Codex/Router/provider/agent overview
- `orchestra_router` — detect/doctor/start/restart/logs/connect-provider/refresh-catalog/update/rollback
- `orchestra_models` — visible catalog, no secret values
- `orchestra_team` — logical roles; writes need `confirm=true`
- `orchestra_setup` / `orchestra_apply_managed` — preview then apply managed files
- `orchestra_doctor` / `orchestra_repair` — health and optional Router start
- `orchestra_usage_summary` — existing local events only
- `orchestra_scope_plan` / `orchestra_worktrees` — disjoint ownership
- `orchestra_threads` — bridge to installed `codex-control`

## Safety

- Localhost/stdio only. No public ports.
- Confirm writes, Router process changes and managed file apply.
- Touch only Orchestra-managed markers and `orchestra_*.toml`.
- Never print API keys, OAuth sessions or `config.toml` contents.
- Never ask the user to paste an API key in chat. Keys go only into the
  visible Router helper terminal opened by `connect-provider`.
- Do not duplicate `codex-control` create/send/steer tools.

## Connecting providers

Three paths, all ending with `refresh-catalog`, Doctor and a Codex restart
(the picker reloads on restart; there is no hot-reload).

- Path A, provider already in the Router pin (openrouter, zai-coding,
  deepseek, groq, together, fireworks, siliconflow, documented team
  defaults): run
  `orchestra_router action=connect-provider provider=<slug> confirm=true`.
  The user pastes the key in the opened helper. If the provider ends up with
  no models, use `curate-models <provider>` or `upsert-user-models`.
- Path B, custom reseller / OpenAI-compatible endpoint:
  `upsert-user-provider` writes metadata only (no key values), then
  `connect-provider`, then `upsert-user-models` or `curate-models`.
  Remote providers require HTTPS baseUrl plus credential location
  descriptors; remote plain HTTP is rejected. Verify
  `overlay.status == "applied"` in the response; first-party provider ids
  cannot be overridden. See
  `docs/DECISIONS/ADR-010-user-provider-overlay.md`.
- Path C, keyless local server (Ollama, llama.cpp): `upsert-user-provider`
  with `keyless: true`, no credential fields, loopback baseUrl
  (`http://127.0.0.1:11434/v1`, `http://127.0.0.1:8080/v1`), then
  `upsert-user-models`. No `connect-provider`, no key anywhere.

The Router overlay helper ships in the plugin package at
`plugins/codex-orchestra/scripts/router-overlay/apply.mjs`;
`orchestra_router action=install|update` also applies it.

Example fragments (not an allowlist) live in `docs/templates/providers`.
Generic `openai-compatible` transport does not imply every model feature
works; `requestProfile` is an optional string naming a Router request
profile, never an object, and plain resellers default to passthrough.
