# Security model

## Secrets

API keys, OAuth tokens, capability URLs and session files never enter SQLite, JSON settings, localStorage, prompts, `AGENTS.md`, HTML or logs. The UI consumes status only. Credential entry belongs to the router's hidden local prompt or OS secure store; OpenCode Go uses the Router helper and Grok OAuth is launched visibly through the official CLI. Orchestra never opens either provider's credential/session file and never promotes OpenCode Zen/PAYG as a fallback.

## Process and path safety

- Rust uses structured argument arrays and an allow-list of executable operations.
- User-provided paths are canonicalized and checked before read/write.
- Router services default to `127.0.0.1`; no LAN binding or permissive CORS.
- Real Codex home is read-only by default and never touched by tests.
- Native Codex config diagnostics inspect only `config.toml` file metadata;
  Orchestra does not parse or export its contents.
- Experimental worktrees are created only from a canonical Git project, under a derived `.codex-orchestra/worktrees` path, with detached `git worktree add`, explicit confirmation and no automatic merge. Dirty cleanup first creates a local patch/untracked-file recovery bundle and validates every copied path remains inside the managed worktree.
- Orchestra MCP is a feature-gated local STDIO child with read-only tool annotations. It exposes redacted status/aggregates only and has no network listener or mutation tool.

## Config writes

1. Generate preview/diff.
2. Back up the exact target.
3. Replace only the Orchestra managed marker block.
4. Write a sibling temp file and atomically rename it.
5. Run validation/doctor.
6. Roll back the backup on failure.

Foreign content is preserved. A missing or malformed marker is never repaired by replacing the full file silently.

## Diagnostics

Structured logs are local and do not store complete prompts/responses by
default. Support bundles are built from an explicit allow-list rather than the
runtime snapshot. They contain versions, statuses, loopback process/port state,
config health, health summaries and error categories; project, backup,
executable and configuration paths are excluded together with raw error text.
Any live provider check is explicit and may consume provider or subscription
allowance.

A completed live check persists only its provider, model, test kind, executed
operation, status and timestamp. Bounded/redacted command output is returned to
the initiating UI but is not retained as profile, usage or support-bundle data.
Project command fields are descriptive metadata, never shell input from the
project editor. Imported project settings apply only after the local path is
canonicalized as an existing directory; unavailable paths are skipped.

The App Server integration can perform a short handshake probe or one explicit
thread/turn. Startup reads are bounded and run outside the window thread.
Activity remains in memory; native session data, prompt/response bodies and
approval content are not written to Orchestra state. Completed collaboration
items are reduced in Rust to a strict evidence record containing only the root
model, requested logical binding, normalized action/status and boolean child
creation. Raw Codex IDs are compared in memory and discarded.
