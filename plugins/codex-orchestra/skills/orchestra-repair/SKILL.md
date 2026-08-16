---
name: orchestra-repair
description: Diagnose and optionally recover a local Orchestra/Router outage. Use for /orchestra-repair, connection refused, Router offline, or restart requests.
---

# Orchestra Repair

1. Run `orchestra_doctor`.
2. If Router is stopped or connection-refused, explain the planned local start.
3. Call `orchestra_repair` or `orchestra_router` `action=start|restart` only with `confirm=true`.
4. Return redacted logs via `orchestra_router` `action=logs` if recovery fails.
5. Do not edit the user's native Codex `config.toml`.
