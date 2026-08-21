# Codex Orchestra plugin

Lightweight Codex App surface for the Orchestra control plane. The Tauri desktop app remains the advanced UI.

## What this plugin is

- Skills for setup, doctor, repair, team and models
- Local stdio MCP over Orchestra Core
- Adapters for Codex Router and Codex App Server
- A bridge to the existing `codex-control` plugin for thread writes

It is not a second Codex chat UI and it does not reimplement Codex Router.

## Install from GitHub

```powershell
codex plugin marketplace add falopass/Codex-Orchestra
codex plugin add codex-orchestra@codex-orchestra
```

Start a **new Codex thread** so the skills and MCP tools load.

## Install from this repo

```powershell
codex plugin marketplace add <absolute-path-to-this-repo>
codex plugin add codex-orchestra@codex-orchestra
```

Development against a personal marketplace stays local:

```powershell
codex plugin add codex-orchestra@personal
```

## Manual CLI

```powershell
python plugins\codex-orchestra\scripts\orchestra.py status
python plugins\codex-orchestra\scripts\orchestra.py doctor
python plugins\codex-orchestra\scripts\orchestra.py models
python plugins\codex-orchestra\scripts\orchestra.py setup --project <abs-path>
python plugins\codex-orchestra\scripts\orchestra.py router connect-provider --provider openrouter --confirm
```

Writes and process changes need `--confirm`.

## Connecting providers

The agent never asks for an API key in chat. `connect-provider` opens the
Router helper in a visible terminal; the key is pasted there only. Custom
OpenAI-compatible resellers are registered with `upsert-user-provider`
(metadata only) before connecting. See
[docs/USER-GUIDE.md](../../docs/USER-GUIDE.md) and
[ADR-010](../../docs/DECISIONS/ADR-010-user-provider-overlay.md). After any
catalog change, fully quit and reopen Codex: the picker reloads on restart.

Keyless local servers (Ollama, llama.cpp) are supported too:
`upsert-user-provider` with `keyless: true`, no credential fields and a
loopback baseUrl; no key anywhere. The Router overlay helper ships in the
plugin package (`scripts/router-overlay/apply.mjs`) and provider responses
report `overlay.status`.

## Desktop

Advanced screens stay in the desktop app: pricing import, feature flags, support bundle, live paid checks and the full Run / App Server session UI. The desktop app is optional for plugin-only provider flows.

See [docs/PLUGIN.md](../../docs/PLUGIN.md).
