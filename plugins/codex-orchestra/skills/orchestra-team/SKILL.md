---
name: orchestra-team
description: Inspect or update Orchestra logical roles and model bindings. Use for /orchestra-team, Team Builder, root/frontend/engineer bindings, Auto vs pinned frontend, or custom Orchestra agents.
---

# Orchestra Team

Roles are logical. Do not hard-code one personal model stack as a requirement.

1. Read `orchestra_team`.
2. Keep root, frontend and engineer separate from the current model ids.
3. Update one role at a time with `confirm=true`.
4. Saving local bindings does not write project files. Use `$orchestra-setup` to preview/apply generated TOML.
5. Never overwrite agents that are not `orchestra_*`.
