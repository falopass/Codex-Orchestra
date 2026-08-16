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
- `orchestra_router` — detect/doctor/start/restart/logs/update/rollback
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
- Do not duplicate `codex-control` create/send/steer tools.
