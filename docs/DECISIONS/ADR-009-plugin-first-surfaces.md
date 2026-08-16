# ADR-009: Plugin-first surfaces without replacing desktop

Status: accepted

Codex plugins currently ship skills and local stdio MCP. They do not provide an
embedded multi-panel UI. Orchestra therefore keeps the Tauri desktop app as the
advanced surface and exposes the same core through a marketplace plugin.

## Decision

- Orchestra Core is reusable by desktop, plugin CLI/MCP and future API callers.
- Codex Router stays an external engine behind an adapter.
- Codex App Server thread writes reuse `codex-control` instead of duplicating them.
- Plugin mutations require `confirm=true`, backups and Orchestra-managed markers.
- Desktop keeps pricing import, feature flags, support bundle and live paid checks.

## Consequences

Users can install Orchestra from a local path, a personal marketplace or GitHub.
The plugin is useful inside Codex App. ChatGPT chats in the same desktop app
still do not receive local stdio MCP tools.
