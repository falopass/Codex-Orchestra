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

| Tool                      | Mode  | Purpose                                                |
| ------------------------- | ----- | ------------------------------------------------------ |
| `orchestra_status`        | read  | Redacted Codex / Router / provider / desktop overview  |
| `orchestra_usage_summary` | read  | Existing local usage events only                       |
| `orchestra_scope_plan`    | read  | Ownership overlap check                                |
| `orchestra_sync_status`   | read  | Bindings, managed artifacts, thread bridge             |
| `orchestra_doctor`        | read  | Health checks                                          |
| `orchestra_models`        | read  | Visible catalog and credential status                  |
| `orchestra_team`          | write | Logical role bindings                                  |
| `orchestra_router`        | mixed | Detect, doctor, start, restart, logs, update, rollback |
| `orchestra_setup`         | write | Preview or apply managed files                         |
| `orchestra_apply_managed` | write | Apply a reviewed preview                               |
| `orchestra_repair`        | write | Confirmed local recovery                               |
| `orchestra_worktrees`     | write | Experimental disjoint worktrees                        |
| `orchestra_threads`       | read  | Describes the `codex-control` bridge                   |

`orchestra_status` is redacted. It must not print API keys, OAuth sessions, `config.toml` contents or personal thread ids.

## Confirms

These require `confirm=true`:

- Router start / restart / install / refresh-catalog / update / rollback
- Team binding writes
- Managed apply
- Repair that starts a process
- Worktree create / remove

Preview and doctor stay read-only.

## Current format limits

- No embedded plugin UI.
- ChatGPT chats in Codex Desktop do not receive this local stdio MCP.
- Thread create / send / steer stays on `codex-control`.
- Pricing import, feature flags and support bundle stay in the desktop app.

## Troubleshooting

| Symptom                  | What to check                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| Skills missing           | Start a new thread after install                                                          |
| MCP tools missing        | Confirm `python` is on PATH and `.mcp.json` still points at `scripts/mcp_server.py`       |
| Router offline           | `orchestra_doctor`, then `orchestra_repair` with `confirm=true` if you want a local start |
| Personal paths in output | File a bug. Status and support output should be redacted                                  |
| Want the full UI         | Open the desktop app, not a ChatGPT chat                                                  |

## Publication checklist

- [x] Public repository URL in `plugins/codex-orchestra/.codex-plugin/plugin.json`
- [x] MIT license without personal paths
- [x] No usernames, home directories or API keys hard-coded as defaults
- [x] Router remains an external checkout
- [x] `codex-control` remains the thread-write plugin
- [ ] Run `python plugins/codex-orchestra/test/test_plugin_core.py`
- [ ] Run the official plugin validator against `plugins/codex-orchestra`
- [ ] `codex plugin marketplace add falopass/Codex-Orchestra`
- [ ] `codex plugin add codex-orchestra@codex-orchestra`
- [ ] New Codex thread and `$orchestra`
