# Contributing

Thanks for helping keep Codex Orchestra small, local and secret-safe.

## Scope

This repository is a local control plane:

- `plugins/codex-orchestra` — Codex App skills + stdio MCP
- `packages/orchestra-core` — reusable core
- `packages/adapters-codex-router` — external Router contract
- `packages/adapters-codex-app-server` — App Server / `codex-control` bridge
- `packages/contracts` — shared types
- `apps/desktop` — advanced Tauri UI

Do not vendor Codex Router. Do not duplicate `codex-control` thread writes. Do not hard-code a personal model stack as a requirement.

## Setup

```powershell
git clone https://github.com/falopass/Codex-Orchestra.git
cd Codex-Orchestra
npm install
npm run typecheck
npm test
```

Use a temporary `CODEX_ORCHESTRA_DATA_DIR` for native experiments. Never point tests at a real `%USERPROFILE%\.codex`.

## Branch and PR

1. Branch from `main` as `agent/<short-description>` or `fix/<short-description>`.
2. Keep commits conventional when it fits: `feat:`, `fix:`, `docs:`, `test:`, `chore:`.
3. Open a PR against `main`.
4. Fill the PR template. Call out secret scan, plugin compatibility and managed-config impact.

## Checks

Run what your change can break:

```powershell
npm run typecheck
npm test
npm run check:secrets
npm run format:check
```

Add `npm run test:rust` when you touch `apps/desktop/src-tauri`. Add `npm run build` when you touch the desktop renderer.

## Style

- TypeScript / React already in the tree. No new UI kit.
- Python plugin code stays stdlib-only.
- Personal paths, emails and machine names do not belong in fixtures or docs. Use `<you>`, `%USERPROFILE%` or temp directories.
- Roles are logical. Model ids are bindings, not identity.

## What not to commit

- `.env`, credentials, OAuth sessions, support bundles
- `%USERPROFILE%\.codex` copies, personal `config.toml`, marketplace personal files
- `node_modules`, `target`, `dist`, local DBs, artifacts, backups
- Screenshots that show usernames, tokens or private projects

## Security reports

Do not open a public issue for a real secret or vulnerability. Use [GitHub Security Advisories](https://github.com/falopass/Codex-Orchestra/security/advisories/new).
