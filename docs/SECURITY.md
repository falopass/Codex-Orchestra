# Security model

## Secrets

API keys, OAuth tokens, capability URLs and session files never enter SQLite, JSON settings, localStorage, prompts, `AGENTS.md`, HTML or logs. The UI consumes status only. Credential entry belongs to the router's hidden local prompt or OS secure store.

## Process and path safety

- Rust uses structured argument arrays and an allow-list of executable operations.
- User-provided paths are canonicalized and checked before read/write.
- Router services default to `127.0.0.1`; no LAN binding or permissive CORS.
- Real Codex home is read-only by default and never touched by tests.

## Config writes

1. Generate preview/diff.
2. Back up the exact target.
3. Replace only the Orchestra managed marker block.
4. Write a sibling temp file and atomically rename it.
5. Run validation/doctor.
6. Roll back the backup on failure.

Foreign content is preserved. A missing or malformed marker is never repaired by replacing the full file silently.

## Diagnostics

Structured logs are local and do not store complete prompts/responses by default. Support bundles contain versions, statuses, process/port state, config health and recent errors after redaction. Any live provider check is explicit and billable.
