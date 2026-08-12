# ADR-006: update and rollback

Status: accepted

Updates are explicit, backed up, health-gated and reversible. `update check` is read-only; promotion records the previous ref and doctor must pass before the new state is considered healthy.
