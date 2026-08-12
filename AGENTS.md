# Codex Orchestra project policy

Codex Orchestra is a local control plane. Codex Desktop remains the execution surface and the user-facing conversation surface.

## Development boundaries

- Never read, print, commit, or ask for API keys, cookies, bearer tokens, OAuth files, or session data.
- Tests use temporary `CODEX_HOME` fixtures and fake router output. They never mutate the real Codex installation.
- Live provider checks are opt-in, must show provider/model/test before execution, and never run in the normal test suite.
- Rust owns process invocation, path validation, atomic configuration writes, backups, rollback, redaction, and OS-sensitive operations.
- The renderer must call the central adapter; it must not concatenate shell commands or invoke router scripts directly.

<!-- BEGIN CODEX-ORCHESTRA MANAGED -->

For substantial engineering work, load the `orchestra-routing` skill.

Project ownership:

- frontend: apps/desktop/src/**, apps/desktop/index.html, apps/desktop/public/**, packages/ui/**
- engineer: apps/desktop/src-tauri/**, engine/**, evals/**, scripts/**, packages/contracts/**
- shared/root-owned: package.json, tsconfig*.json, templates/**, docs/**, AGENTS.md

Parallel write delegation is allowed only for disjoint scopes. Shared files, schemas, templates, migrations and configuration are root-owned.
The root thread owns final integration, security review and validation.
<!-- END CODEX-ORCHESTRA MANAGED -->
