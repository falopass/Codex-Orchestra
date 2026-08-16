# Codex Orchestra acceptance audit

Updated: 2026-08-14

This is the evidence ledger for the canonical master build plan. It is not a
claim that every acceptance criterion is complete: `verified` requires current
local evidence, `partial` means the implementation exists but lacks adequate
end-to-end proof, and `pending` requires an external account, permission or
billable live action.

## Phase evidence

| Phase                           | Current evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | State            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 0 - research and skeleton       | Monorepo, contracts, ADRs, architecture and operations documents exist; TypeScript and Rust compile gates pass.                                                                                                                                                                                                                                                                                                                                                                                                           | verified locally |
| 1 - desktop detection           | Tauri commands detect local metadata without reading credentials; the NSIS build installs, starts and reports `Responding=True`. Startup/reload use a cached local snapshot while discovery stays off the window thread. Computer Use refused the Orchestra window, so rendered interaction remains unverified.                                                                                                                                                                                                           | partial          |
| 2 - managed Router              | A real checkout is present at `f0c4be2a61d7d80bd26190beb4ad9496af6b476c`. Read-only Doctor reports Router `0.4.0-beta.3`, authenticated native Codex, protected Qwen/OpenCode credentials and an official Grok CLI session. Orchestra now targets the signed release commit `a1be46aa02426d87a9e24e114ce8c22619c63c7a`; promotion remains explicit. Doctor also reports config ACL, native routing, service, skill-pack and stale-catalog failures that cannot be repaired without changing protected user configuration. | partial          |
| 3 - team and generated agents   | Editable role definitions are validated and persisted locally; Setup renders Grok engineer, Qwen frontend and Kimi visual custom-agent TOML files plus a Sol-root routing skill into a preview-token, atomic-write and rollback flow. Run now persists a strictly redacted root-mediated collaboration ledger; native Codex delegation has not run.                                                                                                                                                                       | partial          |
| 4 - diagnostics and live agents | Redacted health, 20-run history, safe last-test metadata, App Server local thread/turn execution, temporary streaming, approval/interruption actions and an allow-listed support bundle are implemented. Historical `unix:` timestamps render correctly; paths and raw errors are excluded from support output. Compatibility runs basic/streaming/tools/compaction; agent behavior is a separate two-turn Codex probe; the preview names coverage and billing source before execution.                                   | partial          |
| 5 - usage and budgets           | Versioned pricing, explicit reported-versus-estimated cost and budget persistence have contract/integration coverage. Overview and Usage consume persisted effective-dated rules. JSON import requires preview-token continuity, provider/model matching, official HTTPS sources and zero invented token pricing for subscriptions.                                                                                                                                                                                       | verified locally |
| 6 - safe parallelism            | Ownership conflict planning plus managed worktree preview/create/status/recovery cleanup are implemented. Base revisions survive restart; changed files and drift are reviewable; merges remain manual. A routed full-stack fixture remains a live acceptance check.                                                                                                                                                                                                                                                      | partial          |
| 7 - deep integration            | App Server starts one explicit local thread/turn with in-memory activity and approvals. A feature-gated STDIO MCP exposes four read-only redacted tools; direct ChatGPT desktop/Codex configuration avoids an unnecessary plugin.                                                                                                                                                                                                                                                                                         | partial          |

## MVP acceptance criteria

| Criterion                                                  | State            | Evidence or missing proof                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Windows installation without VS Code                       | verified locally | Final NSIS package installed at `D:\Codex Orchestra` with exit code 0; both raw and installed executables stayed running for ten seconds. The raw release executable also passed without an external manifest.                                                                                                                 |
| Setup without manual file editing                          | partial          | Setup requires a persisted preview before atomic apply, but its rendered interaction is not desktop-verified because Computer Use refused the app window.                                                                                                                                                                      |
| Native Sol remains available                               | partial          | Read-only Router Doctor detects the native Codex binary, authenticated login and OpenAI login availability. An actual Sol model turn remains user-authorized live evidence.                                                                                                                                                    |
| Qwen, OpenCode Go/Kimi and Grok authenticated and verified | partial          | Doctor detects protected Qwen and OpenCode credentials plus the official Grok CLI OAuth session. Qwen is the default frontend, Kimi/OpenCode Go the visual specialist and Grok the engineer. Billable/allowance-consuming live model checks remain explicitly user-controlled.                                                 |
| Frontend/engineer bindings generated                       | verified locally | Saved team definitions are validated against stable provider bindings, then rendered into generated TOML/config/skill files; templates and routing behavior are covered by local tests.                                                                                                                                        |
| Sol delegates and receives results                         | pending          | Sol-root policy and generated worker instructions enforce root-mediated cross-role delegation. App Server `item/completed` events now produce a prompt/ID-free local evidence row, but a user-authorized Sol -> frontend and Sol -> engineer run is still required.                                                            |
| Apply/revert without destroying prior config               | verified locally | Atomic backup/rollback test executes in a temporary fixture; generated paths and managed-preview token checks also pass.                                                                                                                                                                                                       |
| No secret in tracked workspace or logs                     | verified locally | `npm run check:secrets` passes and support output is redacted by design; live provider output remains untested.                                                                                                                                                                                                                |
| Health detects outage/key/model conditions                 | partial          | Deterministic fixture states and parser logic exist; no real Router has been made unhealthy.                                                                                                                                                                                                                                   |
| Cost by model                                              | verified locally | Cost engine tests pass; persisted versioned rules now drive Overview and Usage. Import preview validates effective dates and official provider sources before an explicitly confirmed save.                                                                                                                                    |
| Failed Router update can roll back                         | partial          | The reviewed-pin promotion records an Orchestra rollback ref, reinstalls and runs doctor; failure restores the previous revision. No live Router update was authorized.                                                                                                                                                        |
| Small idle footprint                                       | verified locally | The 60-second budget is <=220 MiB tree private, <=16 MiB native private, <=20 MiB post-warm growth and <=450 MiB working set. The installed seven-process tree finished at 177.1 MiB private / 374.9 MiB working set; native max was 5.5 MiB and private growth was -1.5 MiB. A longer leak profile remains release hardening. |

## Exact blockers and next evidence

1. Approve Codex Orchestra for Computer Use, then perform rendered desktop QA
   at wide and narrow window sizes with keyboard interaction. The automation
   helper currently returns `Computer Use was not approved to use Codex Orchestra`.
2. Decide whether Orchestra may repair the Router Doctor failures. The required
   upstream actions alter `%USERPROFILE%\.codex\config.toml` ACL/routing and
   install the global Router skill pack, while the user explicitly protected
   that configuration from modification.
3. Use the existing preview/confirmation UI to run the live compatibility suite
   (basic, streaming, tool calling and compaction) and, separately, the
   two-turn agent-behavior probe for Qwen, Kimi/OpenCode Go and Grok OAuth.
4. Apply the reviewed project files, then use Orchestra Run with Sol and the
   expected worker selector to record a real redacted delegation row for both
   frontend and engineer.
5. Repeat the idle profile over a longer release-hardening window to detect
   slow WebView2 leaks; the 60-second acceptance budget already passes.
6. If desired, enable Orchestra MCP and add the displayed local STDIO command
   in ChatGPT desktop Settings. Orchestra deliberately does not edit the
   protected native Codex `config.toml`.

## Reproducible local gates

```powershell
npm run typecheck
npm test
npm run build
npm run format:check
npm run check:secrets

$env:CARGO_TARGET_DIR = "$env:TEMP\codex-orchestra-target"
$env:RUSTUP_TOOLCHAIN = "stable-x86_64-pc-windows-gnu"
cargo check --lib --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo test --lib --manifest-path apps/desktop/src-tauri/Cargo.toml
```

The GNU fallback runs the native test harness with the staged loader and
embedded Common Controls v6 manifest. The package launch test remains separate
runtime evidence.
