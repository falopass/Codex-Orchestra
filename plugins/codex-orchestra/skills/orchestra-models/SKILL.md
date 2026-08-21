---
name: orchestra-models
description: List Orchestra-visible models and provider credential status without exposing secrets. Use for /orchestra-models, catalog refresh, provider availability, or Auto vs pinned frontend selection.
---

# Orchestra Models

Call `orchestra_models` for catalog and credential status.

Refresh the catalog only through `orchestra_router` `action=refresh-catalog` with `confirm=true`. Credential entry stays in the visible Router helper opened by `connect-provider`; keyless loopback providers (Ollama, llama.cpp) have no credential at all. The desktop app is optional, not required. Never print key values and never ask for a key in chat.

After a refresh, Codex must be closed and reopened for the picker to reload the published catalog. A catalog entry proves routability, not model quality; live paid checks remain a desktop Diagnostics feature. `requestProfile` in model metadata is an optional string, never an object, and most plain resellers need none.
