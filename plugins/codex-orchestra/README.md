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
```

Writes and process changes need `--confirm`.

## Desktop

Advanced screens stay in the desktop app: pricing import, feature flags, support bundle, live paid checks and the full Run / App Server session UI.

See [docs/PLUGIN.md](../../docs/PLUGIN.md).
