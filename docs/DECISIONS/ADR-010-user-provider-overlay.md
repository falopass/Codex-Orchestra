# ADR-010: user provider overlay in the Router state directory

Status: accepted

Custom and reseller providers must be expressible without forking the Router
engine, and without Orchestra ever reading or storing credential values.
See [ADR-002](ADR-002-router-engine.md) for the external-engine boundary and
[ADR-003](ADR-003-secrets.md) for the credential boundary.

## Decision

- User providers live in the Router state directory as `user-providers.json`,
  a sibling of the existing `user-models.json`.
- The overlay merges provider metadata before registry validate/freeze,
  through a patched `model-registry.mjs` applied to the managed checkout.
- An overlay entry whose `id` collides with a first-party provider from the
  pinned registry is rejected. Users extend the registry; they do not override
  it.
- Broken overlay entries do not fail Router startup. They are skipped with a
  warning, the same degradation model `user-models.json` already uses.
- `requestProfile` is an optional **string** naming a Router request profile,
  never an object. Default is passthrough: a plain OpenAI-compatible reseller
  needs none; only a vendor with unusual reasoning or steering semantics
  needs one.
- Keyless loopback providers are supported: `keyless: true`, no credential
  fields, and baseUrl restricted to `127.0.0.1`, `localhost` or `[::1]`
  (Ollama, llama.cpp). Remote providers still require HTTPS plus credential
  location descriptors; remote plain HTTP is blocked. Secrets never pass
  through chat, MCP or Orchestra: keys are pasted only into the visible
  Router helper console (`provider-key <id> set`), or not at all for keyless.

## Application

The overlay helper ships inside the plugin package at
`plugins/codex-orchestra/scripts/router-overlay/apply.mjs`. Orchestra applies
it when it installs or updates the managed Router checkout, and again on
`upsert-user-provider` / `connect-provider`; those responses report an
`overlay` status block (`applied` / `no-overlay` / `missing-src` / `failed`).
It is not vendoring the Router: the managed checkout stays detached at the
reviewed pin, and the live engine is never treated as source of truth for the
patch.

## Consequences

- `upsert-user-provider` writes metadata only: id, displayName, kind, ownedBy,
  baseUrl and credential location descriptors (or `keyless: true` for
  loopback servers). No key values.
- Credential entry still happens in the visible Router helper
  (`connect-provider`), never in chat.
- Transport compatibility is honest: `kind: openai-compatible` means the
  Router can authenticate and forward against that base URL. It does not
  imply every model behavior works; that is what curation, Doctor and the
  live checks are for.
