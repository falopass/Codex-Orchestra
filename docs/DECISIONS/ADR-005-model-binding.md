# ADR-005: logical model bindings

Status: accepted

Roles bind to candidate catalog IDs. `frontend` prefers Kimi K3 API and `engineer` targets Grok 4.6 with a fallback to the currently observed Grok 4.5 entry until curation/verification makes 4.6 available. This prevents a stale slug from silently becoming the product contract.
