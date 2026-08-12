# Evals

Normal tests are offline and fixture-backed. Live checks are intentionally separate because they may spend provider quota.

Before a live check the UI must display:

- provider;
- resolved model;
- test type (`basic`, `streaming`, `tool-use` or `agent-behavior`);
- the fact that the request may be billable;
- a local confirmation action.

The upstream router's agent capability check is meaningful only when the real Codex client runs a tool-driven turn twice; a catalog row alone is not proof. See the `agent-check.mjs` design in the upstream router and `docs/OPERATIONS.md`.
