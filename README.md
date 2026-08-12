# Codex Orchestra

Codex Orchestra is a Windows-first Tauri control plane for keeping Codex Desktop, Codex Router and a small delegated team coherent. It does not replace Codex Desktop and it is not an IDE or VS Code extension.

## What is implemented

- Dashboard for Codex, router, provider, team and budget health.
- Read-only Codex/router detection plus safe health diagnostics.
- Central `RouterEngine` boundary with fixture-backed commands, provider/model catalog and update/rollback plans.
- Team Builder for root, frontend and engineer roles with logical model bindings.
- Generated Codex agent templates, `orchestra-routing` skill and managed `AGENTS.md` preview/apply flow.
- Project profiles, stack detection, ownership scopes and conflict-aware parallelism planning.
- Usage events, versioned pricing rules, estimated cost aggregation and budget warnings.
- Redacted support bundle and local structured log model.
- Tauri 2/Rust command layer for process, path, backup and atomic-write boundaries.
- App Server stdio and MCP boundaries documented and represented as opt-in adapters; no critical workflow depends on experimental transports.

## Run locally

```powershell
npm install
npm run dev
```

The browser development shell uses a safe fixture-backed adapter when Tauri is unavailable. The desktop shell uses the same command contracts through Tauri invoke.

## Checks

```powershell
npm run typecheck
npm test
npm run check:secrets
npm run build
```

For a native Windows build, install Rust, Cargo and the Tauri prerequisites, then run:

```powershell
npm run tauri:build
```

The exact Codex Router setup is intentionally a user action: Orchestra never asks for credentials in chat and never runs a paid live check as part of normal tests. See [ORCHESTRA_BUILD_STATUS.md](ORCHESTRA_BUILD_STATUS.md) and [docs/OPERATIONS.md](docs/OPERATIONS.md).
