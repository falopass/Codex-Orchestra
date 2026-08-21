# Changelog

All notable changes to this project are documented here.

## 0.2.0 - 2026-08-20

Plugin-first provider release. The plugin manifest is the published version
and moves to `0.2.0`; repo workspaces and the desktop package stay at
`0.1.0`.

### Added

- `orchestra_router action=connect-provider provider=<slug>` launches the
  Router helper in a visible terminal; API keys never pass through chat
- User provider/model overlay in the Router state directory
  (`user-providers.json` next to `user-models.json`), applied by the
  Orchestra overlay on managed checkout install/update
  ([ADR-010](docs/DECISIONS/ADR-010-user-provider-overlay.md))
- Router overlay ships inside the plugin at
  `plugins/codex-orchestra/scripts/router-overlay/`, so installs that do not
  include `engine/` still apply user providers on top of the pinned checkout
- Example provider fragments in `docs/templates/providers` (not an allowlist)
- `docs/USER-GUIDE.md` with the connect-provider flows

### Changed

- Providers and visible models come from the Router catalog; the plugin no
  longer rewrites the model picker allowlist on `refresh-catalog`
- `connect-provider` applies and verifies the overlay before launching the
  key helper, and fails closed for custom providers when the overlay cannot
  be applied
- `requestProfile` in user-model upserts is an optional string
- Keyless OpenAI-compatible providers are accepted for loopback endpoints
  (Ollama, llama.cpp); remote endpoints still require HTTPS plus credentials
- Doctor reports a missing desktop app as optional, not unhealthy

### Notes

- This release is published to the repository and local marketplace entry;
  existing installs pick it up on plugin reinstall/update because the
  manifest version changes from `0.1.0` to `0.2.0`

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
