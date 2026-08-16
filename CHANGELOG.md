# Changelog

All notable changes to this project are documented here.

## 0.1.0 - 2026-08-16

First public alpha of Codex Orchestra as a plugin-first local control plane.

### Added

- Marketplace plugin at `plugins/codex-orchestra` with skills and local stdio MCP
- Reusable Orchestra Core plus Router and App Server adapters
- Tauri desktop app as the advanced UI
- Redacted health, Router lifecycle, catalog/status, logical team roles
- Marker-bounded managed AGENTS / agent / skill writes
- Experimental worktree planning behind a feature flag
- Local usage summary from existing events only
- Thread control delegated to `codex-control`

### Security

- Writes and process start require confirmation
- Secret values stay out of git, SQLite and support bundles
- Router remains an external pinned engine

### Known limits

- No embedded plugin UI
- ChatGPT chats do not receive the local MCP
- Desktop binaries are not published as signed GitHub Release assets
