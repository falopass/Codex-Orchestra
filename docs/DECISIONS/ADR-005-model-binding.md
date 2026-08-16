# ADR-005: logical model bindings

Status: accepted

Roles bind to logical catalog targets, not permanently hardcoded provider slugs.
`frontend` persists a strategy with `auto` or `pinned` mode. Its initial
candidates are Qwen 3.8 Max through `qwen-plan` (default/general frontend) and
Kimi K3 through `opencode-go` (visual specialist); provider-qualified slugs are
resolved from the current Router catalog. AUTO may degrade when only one
candidate is ready. Pinned selection never silently switches providers and no
PAYG fallback is automatic. `engineer` prefers the reviewed Router's
`grok-oauth/grok-4.6` route,
which uses the official Grok CLI OAuth session. `grok-api` remains an explicit
separately billed alternative. The current Router pin has no automatic
cross-provider fallback contract, so a fallback is not silently implied by
the Orchestra binding.

The Codex Desktop picker is curated independently of role bindings. Orchestra
publishes only native GPT models plus `grok-oauth/grok-4.6`,
`opencode-go/kimi-k3`, `opencode-go/deepseek-v4-pro`,
`opencode-go/deepseek-v4-flash`, `qwen-plan/qwen3.8-max` and
`opencode-go-messages/qwen3.8-max`. Hidden slugs remain routable if already
selected, but they are not offered in the picker or as Router-managed custom
agents.
