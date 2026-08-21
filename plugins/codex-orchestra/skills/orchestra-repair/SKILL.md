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

Recovery never involves credential values. If a provider shows unauthenticated, the fix is `orchestra_router action=connect-provider provider=<slug> confirm=true` so the user pastes the key in the visible Router helper; never ask for the key in chat. Keyless loopback providers have no credential to repair. If a custom provider never resolves, check `overlay.status` in the last provider response; `orchestra_router action=install|update confirm=true` reapplies the overlay. Paid live checks stay desktop-only; everything else works plugin-only.
