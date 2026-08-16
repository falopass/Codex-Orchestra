---
name: orchestra-models
description: List Orchestra-visible models and provider credential status without exposing secrets. Use for /orchestra-models, catalog refresh, provider availability, or Auto vs pinned frontend selection.
---

# Orchestra Models

Call `orchestra_models` for catalog and credential status.

Refresh the catalog only through `orchestra_router` `action=refresh-catalog` with `confirm=true`. Credential entry stays in Router helpers or the desktop app. Never print key values.
