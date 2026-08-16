# Codex Orchestra project policy

Codex Orchestra is a local control plane. Codex Desktop remains the execution surface and the user-facing conversation surface.

## Development boundaries

- Never read, print, commit, or ask for API keys, cookies, bearer tokens, OAuth files, or session data.
- Tests use temporary `CODEX_HOME` fixtures and fake router output. They never mutate the real Codex installation.
- Live provider checks are opt-in, must show provider/model/test before execution, and never run in the normal test suite.
- Rust owns process invocation, path validation, atomic configuration writes, backups, rollback, redaction, and OS-sensitive operations.
- The renderer must call the central adapter; it must not concatenate shell commands or invoke router scripts directly.

<!-- BEGIN CODEX-ORCHESTRA MANAGED -->

For substantial engineering work, load the orchestra-routing skill.

Delegation policy:

- The configured root alone routes cross-role work and owns shared files, integration and final validation.
- Frontend, engineer and visual are logical roles whose current model bindings come from Orchestra.
- Workers report blockers to root instead of calling another primary worker; the visual role never delegates.

Project ownership:

- frontend: app/**, src/**, components/**, styles/**
- engineer: server/**, api/**, db/**, tests/**
- shared/root-owned: package.json, types/**, schemas/**, migrations/**

Parallel write delegation is allowed only for disjoint scopes. Never write overlapping files concurrently.
<!-- END CODEX-ORCHESTRA MANAGED -->
