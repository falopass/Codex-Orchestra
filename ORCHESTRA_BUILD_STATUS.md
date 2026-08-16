# Codex Orchestra - build status

Updated: 2026-08-15

## Real state

The local control-plane core is implemented and compiling. The remaining
gates are external or runtime-bound: explicitly authorized live model checks,
proof of Sol worker turns, application signing and rendered desktop QA.

- Canonical source: `CODEX_ORCHESTRA_MASTER_BUILD_PLAN.html`
- Canonical source lines: 900
- Canonical source SHA-256: `EBE04BC1F89A94F0CAB595F2E85941E252AE7FB6CE20C04F4FDBC3B6FC60D7C3`
- Working tree: dirty by design; no commit or push was performed.
- Approximate completion: **85% of end-to-end acceptance evidence**. Local
  implementation is substantially further along, but live provider behavior,
  native worker turns, rendered QA and long-running idle-memory behavior cannot
  be inferred from code or build output.
- Current gate: **acceptance evidence**, after closing the preview/apply safety
  gap and aligning the canonical role policy with the Qwen-general/Kimi-visual
  split. The requirement-by-requirement ledger is
  [docs/ACCEPTANCE_AUDIT.md](docs/ACCEPTANCE_AUDIT.md).

## Implemented

- Marketplace plugin at `plugins/codex-orchestra` with Orchestra Core, Router/App Server adapters, local stdio MCP and setup/doctor/repair/team/models skills. Desktop remains the advanced surface.

- Tauri 2 + React/Vite shell, dashboard, setup, team, projects, diagnostics,
  usage/cost and advanced screens.
- Native Rust boundary for executable discovery, bounded/background processes,
  structured arguments, redaction, schema-versioned SQLite state, backups and
  atomic managed writes. Startup no longer launches automatic Router Doctor or
  provider probes on the window thread.
- Router adapter with wrapper selection, catalog read, doctor/providers/status,
  exact provider enable/disable, model curation, reviewed-pin promotion with
  rollback recovery and explicit live-check confirmation.
- Grok OAuth is a first-class engineer route. The UI launches the official
  `grok login --oauth` command visibly, keeps `grok-4.6` as the only supported
  Grok engineer model, and leaves `grok-api` as an explicit alternative.
- Qwen 3.8 Max through Alibaba Token Plan is the default general frontend
  binding. OpenCode Go exposes `opencode-go/kimi-k3` as the selective visual/UI
  specialist with dynamic catalog metadata; no silent provider switch or
  OpenCode Zen/PAYG overflow is exposed.
- Native Codex root supports GPT-5.6 Sol, Luna and Terra with the available
  reasoning-effort ladder. Setup generates
  frontend/engineer TOML definitions, the routing skill, managed `AGENTS.md`
  ownership and bounded `.codex/config.toml` subagent settings.
- Codex inventory now reports `CODEX_HOME/config.toml` presence from file
  metadata only; native config contents are not parsed, exported or logged.
- App Server local stdio integration with child cleanup, persisted opt-in gate,
  explicit native thread/turn start, temporary streamed activity, approval and
  interruption controls. Completed root collaboration calls create a strict
  redacted evidence row with the root model, requested worker binding,
  normalized action/status and child-created boolean. Prompts, responses,
  arguments, paths and native thread IDs are never persisted.
- Root-mediated multi-agent policy: GPT-5.6 Sol routes all cross-role work;
  Grok 4.6 is the engineer, Qwen 3.8 Max is frontend general and a separate
  Kimi K3 custom agent is reserved for selective visual/UI work. Parallel
  delegation requires disjoint ownership; workers cannot form arbitrary trees.
- Editable team definitions are persisted locally with role/provider/model,
  retry, scope and instruction validation. Setup renders the saved worker
  definitions into the reviewed TOML/config/skill artifacts.
- Editable project ownership/shared paths, active team, routing policy and
  test-command metadata are persisted locally; overlap planning forces
  sequential execution. Profile import re-registers only paths that exist on
  the current machine.
- Paid diagnostics now distinguish the Router compatibility suite (basic,
  streaming, tool calling and compaction) from the pinned two-turn native
  Codex agent-behavior probe. Only safe result metadata is retained locally.
- Diagnostics now exposes the 20 most recent persisted health runs, preserves
  a genuinely healthy aggregate instead of collapsing it to unknown, and
  renders legacy `unix:` timestamps without `Invalid Date`.
- Live-check preview now exposes the selected test coverage and billing source
  before execution; the canonical plan and diagnostics styling use the logical
  frontend role with Qwen as default general frontend and Kimi as visual/UI
  specialist.
- OpenCode Go credential setup remains available through any detected managed
  Router wrapper that supports the allow-listed helper; the reviewed pin still
  gates update/rollback, not local credential entry. Explicit health runs now
  persist refreshed runtime facts for the fast snapshot.
- Support export no longer serializes the runtime snapshot. Schema v3 is an
  explicit allow-list and excludes project/configuration/backup/executable
  paths, native Codex IDs, command output and raw log messages.
- Experimental managed Git worktree lifecycle behind a feature flag: preview,
  detached creation, persisted base revision/status, changed-file and drift
  review, clean removal, and patch/untracked-file recovery before forced
  cleanup. Merge remains manual and root-owned.
- Optional local Orchestra MCP over STDIO exposes four read-only tools for
  redacted status, aggregate usage, pure scope planning and managed-artifact
  sync status. It has no network listener, config write, provider action,
  worktree mutation or model-execution tool.
- Usage event persistence, reported-vs-estimated cost separation, editable
  versioned pricing, budgets, feature flags, profile portability and redacted
  logs/support bundle. Persisted pricing now drives both Overview and Usage;
  imports require preview-token continuity, effective-date validation and an
  official provider source.
- Offline fixture integration test covers Windows paths, fake Codex home,
  Router catalog, generated files, managed config preview, overlap planning
  and secret redaction.
- Setup now requires a distinct generated preview before it enables apply. A
  native optimistic-concurrency token rejects a write if `AGENTS.md` changes
  after that review; generated content is shown without echoing foreign file
  content.

## Decisions

- The NSIS installer is the distributable artifact; a bare GNU executable is
  not supported because it requires the sibling WebView2 loader.
- The GNU fallback embeds the Common Controls v6 manifest as a COFF resource
  from Cargo's ASCII target directory. This avoids the Unicode-path `windres`
  limitation without omitting the manifest needed by `TaskDialogIndirect`.
- The Router remains an external, revision-pinned engine. No release tracks
  upstream `main` automatically.
- A preview token is an integrity check for a reviewed local file, not a
  credential or secret, and is never persisted as sensitive state.
- App Server activity is limited to one explicit local task session at a time;
  MCP stays optional and read-only to avoid building a second Codex execution
  surface. Direct ChatGPT desktop/Codex STDIO configuration is preferred over
  plugin packaging until a plugin adds concrete distribution value.
- Frontend and engineer generated instructions describe logical roles rather
  than Qwen/Grok names, so later model changes do not create contradictory
  agent policy.

## In progress

- No unattended local mutation is active. Local implementation work continues
  through ordinary code/test/package gates; the application deliberately stops
  before credentials, paid checks or native Codex changes.

## Pending live checks, blockers and risks

- The installed Codex Windows App executable was detected previously, but live
  invocation is access-denied in this environment. The App Server probe is
  implemented but not claimed as run here.
- Router installation/doctor, OpenCode Go/Kimi/xAI credential state and
  paid compatibility (basic/streaming/tools/compaction) and two-turn
  agent-behavior checks require explicit local user action. No credential value
  is accepted by Orchestra.
- OpenCode Go key entry, Router catalog refresh, and Grok OAuth browser login remain
  user-controlled; the local CLI is detected, but no login or paid request was
  run by this build.
- Actual Sol -> frontend/engineer worker turns, full-stack fixture execution
  and compaction/replay evidence remain live acceptance checks. The local
  evidence ledger is ready, but fixture rows do not substitute for native runs.
- Visual Studio Build Tools 2022/MSVC was installed on the validation machine and
  the current production NSIS package was compiled through its x64 developer
  environment. The GNU fallback remains available but is no longer the only
  validated native path.
- `tauri build --target x86_64-pc-windows-gnu` now passes with
  `CARGO_TARGET_DIR` pointed at a local ASCII target directory. The generated executable is
  `<target-dir>/x86_64-pc-windows-gnu/release/codex-orchestra.exe`
  with a sibling `WebView2Loader.dll`.
- NSIS installer bundling is enabled in `tauri.conf.json` in per-user mode
  with Tauri's downloaded WebView2 bootstrapper. The current MSVC installer is
  `<target-dir>/release/bundle/nsis/Codex Orchestra_0.1.0_x64-setup.exe`.
  Its SHA-256 is `0F5E608F0037ECBF345CA5937A92D2F9715757C347F253015659FEB0C478B20B`.
  The documented 60-second idle budget is <=220 MiB tree private, <=16 MiB
  native private, <=20 MiB post-warm growth and <=450 MiB working set. The
  installed seven-process tree finished at 177.1 MiB private / 374.9 MiB
  working set; native max was 5.5 MiB and private growth was -1.5 MiB. This is
  real local smoke evidence, not a long-running leak test.
- A drive-root ASCII target directory was not used. Build artifacts stayed in
  the configured local `CARGO_TARGET_DIR`.
- Rendered desktop QA is not claimed: Computer Use returned `Computer Use was
not approved to use Codex Orchestra`. No alternate automation surface was
  used to bypass that decision.
- The Router target is the GitHub-verified release commit for
  `v0.4.0-beta.3`, `a1be46aa02426d87a9e24e114ce8c22619c63c7a`. The installed
  checkout remains at its immediate child `f0c4be2a61d7d80bd26190beb4ad9496af6b476c`
  (only the Homebrew formula differs) until an explicit reviewed update.
- No signed application update channel is claimed. The Router's reviewed-pin
  update/health/rollback lifecycle is implemented separately.
- Connecting the read-only MCP in ChatGPT desktop remains an explicit user
  setting because Orchestra does not modify the protected native Codex config.

## Checks executed

- `npm run typecheck` - PASS.
- `npm test` - PASS, 13/13 tests, including the offline integration fixture and
  the no-silent-fallback frontend binding.
- Focused Rust billing-preview test - PASS; the OpenCode Go subscription source
  and xAI PAYG source are exposed before execution without running a provider.
- `npm run build` - PASS; Vite produced `apps/desktop/dist`.
- `npm run check:secrets` - PASS; no secret-like values found.
- `npm run format:check` - PASS.
- `git diff --check` - PASS; only Git's LF/CRLF normalization warnings.
- GNU `cargo fmt` - PASS.
- GNU `cargo check --lib` - PASS using the local ASCII target directory.
- GNU `cargo test --lib --no-run` - PASS; 23 test cases compiled and executable linked.
- MSVC `cargo test` - PASS; 33/33 tests executed successfully, including SQLite
  migration, MCP read-only boundaries, pricing import validation, delegation
  evidence, health aggregation and support-bundle privacy.
- Delegation evidence target - PASS; 3 focused Rust tests cover schema v3,
  root-only event acceptance and removal of prompts, paths and native IDs.
- Support/health targets - PASS; focused Rust tests prove the support allow-list
  removes injected paths/payloads and that healthy/degraded/unknown/unhealthy
  aggregation preserves the correct precedence.
- GNU `tauri build --target x86_64-pc-windows-gnu` - PASS; executable generated in the D target directory.
- GNU NSIS package build - PASS; installer contains the WebView2 loader.
- MSVC Tauri/NSIS package build - PASS; the installed executable was replaced
  at the per-user install path and Windows reported
  `Responding=True` after launch.
- Startup, reload and post-action snapshots now use an SQLite-backed local
  cache and do not launch Codex, Git, PowerShell, Router Doctor or port probes.
  Process, filesystem and SQLite mutations run through the blocking worker
  pool instead of Tauri's window thread.
- Installed idle budget - PASS over 60 seconds: 177.1 MiB private final,
  178.6 MiB private max, 374.9 MiB working set final, 5.5 MiB native private
  max and -1.5 MiB private growth after warm-up.
- Mock adapter smoke - PASS for agents, feature flags, managed preview,
  live-check confirmation, preview-token enforcement and fixture worktree flow.

## Main implementation files

- `apps/desktop/src/App.tsx` - setup, team, diagnostics, usage and advanced UI.
- `apps/desktop/src-tauri/src/lib.rs` - Rust process, persistence, managed
  writes, Router and App Server boundary.
- `apps/desktop/src/core/routerEngine.ts` and `codexAdapter.ts` - renderer
  adapters with no shell command construction.
- `packages/contracts/src/` and `packages/contracts/test/` - contracts, pure
  logic and fixture integration coverage.

## Next concrete acceptance step

Run rendered desktop QA from a user-enabled Windows session, apply the reviewed
project files, then execute explicitly confirmed live provider checks and the
Sol -> worker verification. Record only redacted evidence.
