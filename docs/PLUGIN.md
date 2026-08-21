# Plugin installation and publication

The Codex plugin lives in `plugins/codex-orchestra`. It is skills plus a local stdio MCP. It does not host an embedded Overview / Team / Diagnostics panel.

## Install from GitHub

```powershell
codex plugin marketplace add falopass/Codex-Orchestra
codex plugin add codex-orchestra@codex-orchestra
```

Start a **new Codex thread** so skills and MCP tools load. Existing threads keep the previous tool set.

The marketplace name is `codex-orchestra` from [`.agents/plugins/marketplace.json`](../.agents/plugins/marketplace.json). The plugin name is also `codex-orchestra`, so the install id is `codex-orchestra@codex-orchestra`.

## Install from a local clone

```powershell
codex plugin marketplace add <absolute-path-to-this-repo>
codex plugin add codex-orchestra@codex-orchestra
```

Use an absolute path. Relative paths and personal home-directory guesses are rejected by setup.

## Personal marketplace

The default Codex personal marketplace is `%USERPROFILE%\.agents\plugins\marketplace.json`. That file is local configuration. It is not this repository's marketplace and should not be copied into git.

If you already linked a local copy of the plugin there during development:

```powershell
codex plugin add codex-orchestra@personal
```

Do not run `codex plugin marketplace add` for that default personal file. Codex discovers it implicitly.

## After install

1. Open a new Codex thread.
2. Invoke `$orchestra`, `/orchestra-setup` or `/orchestra-doctor`.
3. Run read-only tools first: `orchestra_status`, `orchestra_doctor`, `orchestra_models`, `orchestra_team`.
4. For writes, use a scratch project and `confirm=true`.

## MCP tools

The plugin MCP currently exposes 13 tools:

| Tool                      | Mode  | Purpose                                                                                                                                                                                   |
| ------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orchestra_status`        | read  | Redacted Codex / Router / provider / desktop overview                                                                                                                                     |
| `orchestra_usage_summary` | read  | Existing local usage events only                                                                                                                                                          |
| `orchestra_scope_plan`    | read  | Ownership overlap check                                                                                                                                                                   |
| `orchestra_sync_status`   | read  | Bindings, managed artifacts, thread bridge                                                                                                                                                |
| `orchestra_doctor`        | read  | Health checks                                                                                                                                                                             |
| `orchestra_models`        | read  | Visible catalog and credential status                                                                                                                                                     |
| `orchestra_team`          | write | Logical role bindings                                                                                                                                                                     |
| `orchestra_router`        | mixed | Detect, doctor, start, restart, logs, connect/disconnect/list/enable/disable providers, upsert user providers/models, set-model-visible, curate-models, refresh-catalog, update, rollback |
| `orchestra_setup`         | write | Preview or apply managed files                                                                                                                                                            |
| `orchestra_apply_managed` | write | Apply a reviewed preview                                                                                                                                                                  |
| `orchestra_repair`        | write | Confirmed local recovery                                                                                                                                                                  |
| `orchestra_worktrees`     | write | Experimental disjoint worktrees                                                                                                                                                           |
| `orchestra_threads`       | read  | Describes the `codex-control` bridge                                                                                                                                                      |

`orchestra_status` is redacted. It must not print API keys, OAuth sessions, `config.toml` contents or personal thread ids.

## Confirms

These require `confirm=true`:

- Router start / restart / install / connect-provider / refresh-catalog / update / rollback
- Team binding writes
- Managed apply
- Repair that starts a process
- Worktree create / remove

Preview and doctor stay read-only.

## Connecting providers

The agent never asks for an API key in chat. `connect-provider` opens the
Router helper in a visible terminal, and the key is pasted there only.
Keyless loopback providers skip the helper entirely: there is no key.

- Provider already in the Router pin:
  `orchestra_router action=connect-provider provider=<slug> confirm=true`.
  If the provider ends up with no models, run `curate-models <slug>` or
  `upsert-user-models`.
- Custom reseller / OpenAI-compatible endpoint: `upsert-user-provider`
  (metadata only, no key values), then `connect-provider`, then
  `upsert-user-models` or `curate-models`. Remote providers require an HTTPS
  baseUrl plus `credentialFile`/`credentialEnvironment`; remote plain HTTP is
  rejected. First-party provider ids cannot be overridden. Check
  `overlay.status == "applied"` in the `upsert-user-provider` response. See
  [ADR-010](DECISIONS/ADR-010-user-provider-overlay.md) and
  [USER-GUIDE](USER-GUIDE.md).
- Keyless local server (Ollama, llama.cpp): `upsert-user-provider` with
  `keyless: true`, no credential fields, and a loopback baseUrl
  (`http://127.0.0.1:11434/v1`, `http://127.0.0.1:8080/v1`). Then
  `upsert-user-models`. No `connect-provider` step, no key anywhere.

`upsert-user-models` entries may carry an optional `requestProfile`: a
**string** naming a Router request profile, never an object. Most plain
OpenAI-compatible resellers need none (default passthrough); only vendors
with unusual reasoning or steering semantics need one.

Finish every path with `orchestra_router action=refresh-catalog confirm=true`
and `orchestra_doctor`, then close and reopen Codex: the picker reloads on
restart, there is no hot-reload. Example provider fragments (not an
allowlist) live in [templates/providers](templates/providers).

## Current format limits

- No embedded plugin UI.
- ChatGPT chats in Codex Desktop do not receive this local stdio MCP.
- Thread create / send / steer stays on `codex-control`.
- Pricing import, support bundle and live paid checks stay in the desktop
  app. The desktop app is optional for plugin-only provider flows.

## Troubleshooting

| Symptom                  | What to check                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| Skills missing           | Start a new thread after install                                                          |
| MCP tools missing        | Confirm `python` is on PATH and `.mcp.json` still points at `scripts/mcp_server.py`       |
| Router offline           | `orchestra_doctor`, then `orchestra_repair` with `confirm=true` if you want a local start |
| New model not in picker  | Fully quit and reopen Codex after `refresh-catalog`; the picker has no hot-reload         |
| Personal paths in output | File a bug. Status and support output should be redacted                                  |
| Want the full UI         | Open the desktop app, not a ChatGPT chat                                                  |

## Release checklist

This is the release/merge gate, not a per-turn requirement. Run it once before
publication. For day-to-day work, scale validation to the changed surface as
described in [CONTRIBUTING.md](../CONTRIBUTING.md#validation-policy).

- [x] Public repository URL in `plugins/codex-orchestra/.codex-plugin/plugin.json`
- [x] MIT license without personal paths
- [x] No usernames, home directories or API keys hard-coded as defaults
- [x] Router remains an external checkout
- [x] `codex-control` remains the thread-write plugin
- [ ] Run the plugin test suite and the isolated package check
- [ ] Run the official plugin validator against `plugins/codex-orchestra`
- [ ] `codex plugin marketplace add falopass/Codex-Orchestra`
- [ ] `codex plugin add codex-orchestra@codex-orchestra`
- [ ] New Codex thread and `$orchestra`

The marketplace `origin/main` does not ship the provider-overlay flows until
publication. Until then, install from a local clone of this repository.
