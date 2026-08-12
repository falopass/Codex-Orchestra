# Codex Orchestra - build status

Updated: 2026-08-12

## Real state

- Approximate progress: 90% of the specification implementable locally. Remaining gates are provider credentials/live checks, MSVC packaging, and integrated visual QA.
- Gate: Phases 0-6 implemented with persistence and native writes prepared. Phase 7 remains optional and documented.
- Canonical source read: `D:\Códigos\Codex Orchestra\CODEX_ORCHESTRA_MASTER_BUILD_PLAN.html`, 900 lines, 44,559 bytes.
- The checkout started empty. It now has a local base commit; this iteration is pending its own commit.

## Completed

- Phase 0: skeleton, contracts, ADRs, research and boundaries.
- Phase 1: React/Vite shell prepared for Tauri, dashboard, read-only detection and redacted logging.
- Phase 2: central RouterEngine, catalog, pin/version/update/rollback operations and fixtures.
- Phase 3: Team Builder, logical model bindings, agent TOML, `orchestra-routing` skill and managed block preview.
- Phase 4: diagnostics, health history, redacted support bundle and explicit live-check preview.
- Phase 5: usage events, versioned CostEngine, filters and budget warnings.
- Phase 6: ownership scopes, overlap -> sequential planning and experimental worktree recommendation.
- Native core: SQLite for projects, health history, usage and backups; read-only Codex version/login and Router version/port detection; project profiles, stack detection, scope planner, preview, atomic multi-file writes and rollback.
- Phase 7: App Server stdio/MCP boundaries documented without making them critical paths.

## External or environment-pending work

- Native Tauri compilation/tests: Cargo/Rust are installed, but `link.exe` from Visual C++ Build Tools is missing; the official installer ended with code `1602` in this session. `cargo fmt` passes.
- Running the installed Codex remains pending: `codex.exe` exists as a Windows App, but the sandbox receives access denied.
- Real Codex Router installation/doctor and Kimi/xAI resolution require local execution and credentials chosen by the user.
- Paid live checks and Sol -> Kimi/Grok verification are intentionally not part of the normal suite; the UI exposes the preview and confirmation gate.
- The observed Router upstream is pinned in the adapter; Grok 4.6 remains a logical binding that must be curated and verified by the local catalog.

## Decisions

- Tauri 2 + React/TypeScript, with Rust for process/configuration-sensitive work.
- Codex Router is wrapped as an external engine; Orchestra does not reimplement the proxy.
- Secrets remain in Router/OS; Orchestra only consumes status.
- `frontend` and `engineer` are logical bindings resolved against the current catalog.
- The UI uses an instrument-panel/editorial direction: dark sober surfaces, cyan activity signal, amber attention, monospace numbers and persistent context.

## Checks executed

- `npm run typecheck` - PASS.
- `npm test` - PASS, 6/6 contract tests.
- `npm run check:secrets` - PASS; no secret-like values found.
- `npm run build` - PASS; Vite produced `apps/desktop/dist`.
- `npm run format:check` - PASS.
- `npx tsx` mock adapter smoke - PASS: 3 agents, overlap becomes sequential, live-check preview requires confirmation.
- `cargo fmt -- --check` - PASS.
- HTTP smoke of the Vite shell at `http://127.0.0.1:1420/` - PASS, HTTP 200 and title `Codex Orchestra`.
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` - BLOCKED by missing `link.exe`; Cargo 1.97.1/Rustc 1.97.1 are available.
- Integrated browser visual/interaction QA - BLOCKED by the app rejecting local browser navigation permission.

## Risks

- Router APIs, CLI and model catalogs can change; the adapter uses explicit operations and a pinned observed version.
- A local healthy UI does not prove provider authentication or live agent capability; those states remain pending until a live check.
- Support bundles exclude prompts/responses by default; native redaction remains required for any Router stdout/stderr.

## Next concrete step

Complete Visual C++ Build Tools/Tauri prerequisites, run `cargo test` and `npm run tauri:build`, then execute Setup with credentials entered through the Router's local helper.
