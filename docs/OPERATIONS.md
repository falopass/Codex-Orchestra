# Operations

## Development

```powershell
npm install
npm run dev
npm run typecheck
npm test
npm run check:secrets
```

The browser shell is fixture-backed. Native desktop requires Rust/Cargo and Tauri prerequisites. Set `CODEX_ORCHESTRA_DATA_DIR` to a temporary directory when exercising native commands in an isolated test; do not point tests at the real local application-data directory.

## Router lifecycle

Orchestra maps its actions to the upstream Windows surface without exposing arguments directly in React:

| Orchestra action | Router operation                 | Mutates real system?                  |
| ---------------- | -------------------------------- | ------------------------------------- |
| Doctor           | `codex doctor`                   | no                                    |
| Providers        | `codex providers`                | no                                    |
| Models           | `refresh-catalog` / catalog read | possible catalog write; preview first |
| Update check     | `update check`                   | no                                    |
| Update           | `update`                         | yes, backup + health gate             |
| Rollback         | `rollback`                       | yes, explicit action                  |

The router upstream requires Node 22.19+, Git and a Python/uv environment. Provider credentials are separately billed and must be entered through the router helper. Native Codex login is not copied or replaced.

## Live check runbook

1. Open Diagnostics.
2. Choose a connected provider and resolved catalog model.
3. Review the provider, model, test and billable note.
4. Confirm locally.
5. Run the smallest requested check in a temporary workspace.
6. Record the redacted result; do not include prompt/response content in the support bundle.

Agent capability is only proven by two successful real Codex tool-driven attempts. Catalog presence is not enough.

## Recovery

If a managed config write fails, use the backup row in Advanced → Backups. If a router update fails health verification, use the stored rollback reference and run doctor. Unknown service owners or foreign config blocks require manual review.
