# Operations

## Development

```powershell
npm install
npm run dev
npm run typecheck
npm test
npm run check:secrets
npm run build
npm run format:check
```

Validation is risk-based, not a mandatory pre-close checklist. Docs or
metadata changes only need a link/path and diff review. Python/MCP/overlay
changes run the focused plugin tests; contracts/Rust changes run typecheck or
cargo; release or merge runs the full suite plus the isolated package check
once. See [CONTRIBUTING.md](../CONTRIBUTING.md#validation-policy).

The browser shell is fixture-backed. Native desktop requires Rust/Cargo and Tauri prerequisites. Set `CODEX_ORCHESTRA_DATA_DIR` to a temporary directory when exercising native commands in an isolated test; do not point tests at the real local application-data directory.

## Router lifecycle

Orchestra maps its actions to the upstream Windows surface without exposing arguments directly in React:

| Orchestra action | Router operation / source                  | Mutates real system?       |
| ---------------- | ------------------------------------------ | -------------------------- |
| Doctor           | `model-router.ps1 codex doctor`            | no                         |
| Providers        | `model-router.ps1 codex providers`         | no                         |
| Models           | redacted `merged-models.json` catalog read | no                         |
| Refresh catalog  | `model-router.ps1 codex refresh-catalog`   | yes, explicit confirmation |
| Update check     | local comparison against the reviewed pin  | no                         |
| Update           | fetch reviewed pin, reinstall, then doctor | yes, explicit confirmation |
| Rollback         | Orchestra rollback ref, reinstall, doctor  | yes, explicit confirmation |

Provider enable/disable and model curation are also explicit Router operations.
They are disabled until a managed checkout is detected, and both require a
confirmation at the UI boundary. Credentials are entered in the Router helper;
the control plane never receives their values. For the frontend, use
`Connect Qwen Token Plan`; it opens the pinned Router helper for
`provider-key qwen-plan set`, then refresh the catalog and run Doctor.
Qwen is the default subscription route. `Connect OpenCode Go` remains
available for Kimi's visual specialist route. Orchestra never selects or
overflows to OpenCode Zen/PAYG. Grok OAuth is the exception:
use `Login with OAuth`, which launches `grok login --oauth` in a visible
terminal. Finish the browser flow there, then refresh the Router catalog. The
AUTO prefers Qwen for general frontend work and Kimi for visual work. Pinned
selection never silently switches models. The engineer defaults to
`grok-oauth/grok-4.6`; `grok-api` is a separate API-key route, not an
automatic fallback in the current Router pin. Only the reviewed Grok 4.6
route is published in the Orchestra catalog.

## User providers and models

The plugin exposes the same surface without the desktop UI:
`orchestra_router action=connect-provider provider=<slug> confirm=true`
launches the Router helper in a visible terminal; the key is pasted there and
never in chat. Any lowercase slug the Router helper can own is accepted,
`openai`/`codex` excluded (native Codex login stays native).

Custom providers and models extend the pinned registry through the Router
state directory (see
[ADR-010](DECISIONS/ADR-010-user-provider-overlay.md)):

- `user-providers.json` and `user-models.json` are siblings in the Router
  state directory. The overlay merges metadata before validate/freeze in a
  patched `model-registry.mjs`.
- The overlay helper ships inside the plugin package at
  `plugins/codex-orchestra/scripts/router-overlay/apply.mjs`. Orchestra
  applies the patch when it installs or updates the managed checkout, and
  again on every `upsert-user-provider` / `connect-provider`. It does not
  vendor the Router and does not treat the live engine as source of truth
  for the patch.
- Those responses carry an `overlay` status block: `applied`, `no-overlay`,
  `missing-src` or `failed`. A custom provider is not usable until
  `overlay.status` reads `applied`.
- First-party provider ids from the pin cannot be overridden; broken overlay
  entries are skipped with a warning instead of failing startup.
- Keyless loopback providers (`keyless: true`, no credential fields, baseUrl
  on `127.0.0.1` / `localhost` / `[::1]`) serve Ollama or llama.cpp without
  any key. Remote providers still require HTTPS plus credential location
  descriptors; remote plain HTTP is blocked.
- Example fragments (not an allowlist) live in
  [docs/templates/providers](templates/providers). Generic
  `openai-compatible` transport does not imply every model feature works;
  `requestProfile` is an optional string naming a Router request profile,
  never an object; the default passthrough covers plain OpenAI-compatible
  resellers.

After any catalog change, `refresh-catalog` and Doctor run first, then Codex
must be fully quit and reopened: the picker reloads on restart only.

The Codex Desktop picker is a separate surface from the catalog. A confirmed
`refresh-catalog` publishes the Router catalog together with the
`user-providers.json` / `user-models.json` overlays: it does not hard-code a
closed model list. Visibility and curated pricing are optional configuration
kept in the Router picker state, not a hidden Orchestra allowlist, and
Orchestra does not remove third-party models from Router-managed custom agents.
Fully quit and reopen Codex after the refresh so the picker reloads the
published catalog.

The adapter prefers `model-router.ps1`, which carries the `codex` target
namespace. It can fall back to the direct `codex-router.ps1` wrapper and strips
that namespace because the direct wrapper is already Codex-specific. Models are
not requested through a fictitious `models` command: they come from the
Router-generated merged catalog and only model identifiers are consumed.

Installation is pinned to the GitHub-verified release commit for
`v0.4.0-beta.3`, `a1be46aa02426d87a9e24e114ce8c22619c63c7a`: the adapter
initializes the managed checkout, fetches that commit directly and checks it
out detached. It does not
clone the moving `main` branch and hope it still matches the pin.

The same rule applies to updates: Orchestra never invokes Router's upstream
`main`-branch updater for a detached reviewed checkout. It compares the local
revision to the reviewed pin, refuses a checkout with tracked source edits,
writes an Orchestra rollback ref, promotes the exact pin, reinstalls and runs
`doctor`. A failed promotion restores the original revision and repeats its
install/doctor health check.

The router upstream requires Node 22.19+, Git and a Python/uv environment. API
credentials are separately billed and must be entered through the router
helper. Native Codex login is not copied or replaced.

## Live check runbook

1. Open Diagnostics.
2. Choose a connected provider and resolved catalog model.
3. Review the provider, resolved model, billing source and test.
4. Confirm locally.
5. For **Compatibility**, confirm the live action; Orchestra invokes the
   Router's `test-model <model> --live --yes --json` suite with a bounded
   timeout. Its coverage is basic response, streaming, tool calling and
   compaction.
6. For **Agent behavior**, confirm the separate paid probe. Orchestra invokes
   the pinned Router `agent-check.mjs`, which runs two real `codex exec`
   tool-use attempts.
7. Record the redacted result; do not include prompt/response content in the
   support bundle. Only provider/model/test/status/timestamp metadata remains
   in local state.

Agent capability is only proven by two successful real Codex tool-driven attempts. Catalog presence is not enough.

For OpenCode Go, the live check consumes the subscription allowance for the
selected Go model. Usage labels it as subscription-backed and Router-observed;
it is not converted into a fake per-token API bill. If no allowance endpoint
is exposed, Orchestra remains observational and does not guess remaining quota.

## Native Codex delegation

Setup previews and, after confirmation, writes only the project-managed surfaces:
`.codex/agents/orchestra_frontend.toml`,
`.codex/agents/orchestra_engineer.toml`,
`.codex/skills/orchestra-routing/SKILL.md`, `.codex/config.toml` and the
managed block in `AGENTS.md`. The root remains the user's native Codex session;
Orchestra does not create a second root model or copy native credentials.

The generated `[agents]` config enables bounded native delegation with two
concurrent worker threads and depth one. Verify the actual Sol -> worker result
from the Run screen after applying the preview. Select the expected logical
worker, start the task with Sol and inspect **Delegaciones observadas**. A row is
written only after App Server reports a completed root collaboration item; it
contains no prompt, response, path, argument or native thread ID. Catalog
metadata and a successful initialize handshake are not evidence of a completed
worker turn.

## Usage, logs and profile portability

Usage is stored locally in SQLite. The Usage screen keeps provider-reported,
Router-reported and estimated cost visibly separate, then groups tokens and
cost by provider, role, project and day. Pricing rows are editable and retained
by model/version/effective date. Usage → Pricing rules accepts a JSON array,
but applying stays locked until the exact payload passes preview validation:
provider/model alignment, UTC effective date, official HTTPS source and zero
per-token charge for subscription routes. A profile export contains budget, pricing,
feature flags, frontend strategy, projects and agent definitions, never credentials, prompts or
response bodies. Import re-registers project profiles only when their exported
absolute path is an existing local directory; unavailable paths are skipped and
reported instead of being created or opened.

Diagnostics retains and displays the 20 most recent redacted health reports.
The support bundle is prepared in memory from a fixed field allow-list; unlike
the portable profile, it never includes project/configuration/backup paths or
raw error messages. Historical `unix:` timestamps remain displayable after an
upgrade.

Advanced shows bounded redacted operation logs, support-bundle errors and the
experimental App Server/MCP/worktree flags. Saving a flag does not start a
transport or create a worktree. Worktree creation requires a registered Git
project, the experimental flag, a safe role/slug, an explicit confirmation and
uses a detached checkout. Orchestra records the base revision in schema-versioned
SQLite, restores the worktree inventory after restart and shows dirty files,
commits and base drift. Clean worktrees can be removed directly. A worktree with
changes requires a second recovery confirmation; Orchestra saves a binary patch,
copies safe untracked files and writes a redacted recovery manifest before Git
removes it. Merging is always root-reviewed and manual.

After the saved `App Server stdio` feature flag is enabled, the App Server card
can run a confirmation-gated initialize-only probe. The Run view can separately
start one explicit local thread/turn with bounded startup waits; activity remains
in memory and the process is cleaned up when the session closes.

## Read-only MCP

Enable `Orchestra MCP`, save the flags and select **Show MCP connection**. In
ChatGPT desktop open **Settings → MCP servers → Add server**, choose **STDIO**,
use the displayed `codex-orchestra.exe` path as the command and
`--mcp-stdio` as its only argument, then restart ChatGPT. Local Codex clients
share this MCP configuration. Orchestra does not write `config.toml` for this
flow.

The MCP process exposes only `orchestra_status`, `orchestra_usage_summary`,
`orchestra_scope_plan` and `orchestra_sync_status`. All tools are annotated
read-only. They omit credentials, prompts, responses, native config contents
and project paths; setup/apply, provider auth, paid checks, worktree changes and
model execution remain unavailable through MCP.

Reference: https://developers.openai.com/codex/mcp

## Native Windows toolchains

The supported production path is MSVC plus the Tauri Windows prerequisites. On some contributor machines, MSVC may be unavailable during validation, so the GNU
fallback was installed through MSYS2. GNU `cargo check --lib` and
`cargo test --lib --no-run` pass with artifacts redirected to an ASCII target
directory. The project build script copies the WebView2 loader beside the GNU
release executable so the bundler can package it. It also embeds the Common
Controls v6 manifest from Cargo's ASCII target directory: without that resource
Windows resolves an older `comctl32.dll` that lacks `TaskDialogIndirect` and
the process cannot start. The same build script stages the loader beside the
Rust test harness in `debug\deps`, so the documented GNU command executes the
native unit tests without relying on a manually copied DLL.

For the distributable Windows package, Orchestra uses Tauri's NSIS target in
current-user mode and the downloaded WebView2 bootstrapper. Building that
bundle additionally requires NSIS (`makensis`); it produces a setup executable
in the target directory rather than modifying any Codex configuration. The
validated artifact was installed silently in `D:\Codex Orchestra`; it included
`WebView2Loader.dll` and its process remained active after launch. Do not ship
the raw executable without its sibling loader; prefer the NSIS setup package.

## Recovery

If a managed config write fails, use the backup row in Advanced → Backups. If a router update fails health verification, use the stored rollback reference and run doctor. Unknown service owners or foreign config blocks require manual review.

## Plugin surface

The Codex plugin uses the same Orchestra Core as the desktop app. Install it from the personal marketplace or this repo marketplace, then start a new Codex thread. Writes still require `confirm=true`. Thread create/send/steer remains on `codex-control`.
