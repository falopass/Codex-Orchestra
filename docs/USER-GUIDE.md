# User guide: connecting providers and models

This guide covers the plugin-first flow: you work inside a Codex thread with
the `codex-orchestra` plugin, or the equivalent CLI commands. The Tauri
desktop app exposes the same core but is not required for these flows.

## Ground rules

- **The agent never asks for your API key in chat.** The key is pasted only in
  the visible Router helper terminal that `connect-provider` opens. If any
  prompt inside the chat asks you to paste a key, stop: that is not this flow.
  Keyless loopback providers (Ollama, llama.cpp) have no key anywhere.
- **Restart Codex after catalog changes.** The model picker reloads when the
  app restarts. There is no hot-reload.
- **Metadata vs credentials.** Provider and model definitions are metadata
  (ids, display names, base URLs, credential location descriptors). Keys are
  credentials and stay in the Router state directory, written by the Router
  helper.
- **Marketplace honesty.** This repository is the source. The marketplace
  `origin/main` does not ship this feature until it is published. If
  `codex plugin add` on your machine predates this work, update the plugin
  from this repo first.
- **Windows first.** Linux and macOS are not first-class surfaces in this
  cut.

## Path A — the provider is already known to the Router pin

Use this when the provider you want (OpenRouter, z.ai, DeepSeek, or any other
slug the pinned Router registry already defines) is part of the reviewed pin.

1. Ask the agent to connect the provider, for example "connect OpenRouter".
2. The agent runs `orchestra_router action=connect-provider provider=<slug>`
   with `confirm=true`. This opens the Router helper in a **visible
   terminal**. Paste the API key there, not in chat.
   Grok OAuth is the exception: it launches `grok login --oauth` and you
   finish the browser flow in the opened terminal.
3. If the provider still needs model curation (connected but nothing
   selected), curate its models:
   - `curate-models <provider>` — the Router's interactive curation script,
     run from the managed checkout, or
   - `upsert-user-models` — write model entries into the Router state
     directory's `user-models.json`.
4. Refresh the catalog and verify:
   `orchestra_router action=refresh-catalog confirm=true`, then
   `orchestra_doctor`.
5. Close Codex fully and reopen it so the picker reloads the published
   catalog.

## Path B — a custom reseller or self-hosted OpenAI-compatible endpoint

Use this when the endpoint is not in the pinned registry: a reseller, a
company gateway, or any OpenAI-compatible base URL you control.

1. Point the agent at the provider fragment. Use the templates in
   [docs/templates/providers](templates/providers) as the shape. A fragment
   is metadata only: id, displayName, kind, ownedBy, baseUrl and a credential
   location descriptor. **No key values in the fragment.**
2. The agent runs `upsert-user-provider` with that metadata. This writes the
   user provider overlay in the Router state directory
   ([ADR-010](DECISIONS/ADR-010-user-provider-overlay.md)). Overriding a
   first-party provider id is rejected by design.
   Check the `overlay` status block in the response: it must be
   `overlay.status == "applied"`. `no-overlay`, `missing-src` or `failed`
   mean the Router cannot resolve the new provider yet; `install` and
   `update` also apply the overlay.
3. Connect it: `orchestra_router action=connect-provider provider=<your-id>`
   with `confirm=true`. Paste the key in the opened Router helper terminal.
4. Register models with `upsert-user-models`, or `curate-models <your-id>`
   when the endpoint supports discovery.
5. `orchestra_router action=refresh-catalog confirm=true`, then
   `orchestra_doctor`.
6. Reopen Codex so the picker reloads.

## Path C — a keyless local server (Ollama, llama.cpp)

Use this for a local OpenAI-compatible server on loopback. There is no key
anywhere: no credential fields, no helper terminal, nothing to paste.

1. Run `upsert-user-provider` with `keyless: true`, no
   `credentialFile`/`credentialEnvironment`, and a loopback baseUrl:
   `http://127.0.0.1:11434/v1` (Ollama) or `http://127.0.0.1:8080/v1`
   (llama.cpp). Keyless accepts only `127.0.0.1`, `localhost` or `[::1]`.
2. Register models with `upsert-user-models`.
3. `orchestra_router action=refresh-catalog confirm=true`, then
   `orchestra_doctor`.
4. Reopen Codex so the picker reloads.

## What a fragment looks like

```json
{
  "version": 1,
  "providers": [
    {
      "id": "my-reseller",
      "displayName": "My Reseller",
      "kind": "openai-compatible",
      "ownedBy": "my-reseller",
      "baseUrl": "https://reseller.example/v1",
      "credential": {
        "environment": ["MY_RESELLER_API_KEY"],
        "file": "my-reseller-api-key.secret"
      }
    }
  ]
}
```

Example fragments live in [docs/templates/providers](templates/providers):
`openrouter.json`, `zai-coding.json`, `siliconflow.json`, `together.json`,
`fireworks.json`, `groq.json`, `reseller.openai-compatible.json`,
`ollama.keyless.json` and `llama-cpp.keyless.json`. They are examples, not an
allowlist.

For providers whose id is already first-party in the pin (OpenRouter, z.ai,
DeepSeek and the documented team defaults), the templates exist for
`connect-provider` and documentation. `upsert-user-provider` rejects
first-party id overrides: you connect those providers, you do not redefine
them.

## Honest limits

- **Generic transport is not infinite semantics.** A reseller that speaks
  OpenAI-compatible HTTP works as a transport. It does not automatically
  support every Codex feature. `requestProfile` is an optional **string**
  naming a Router request profile, never an object. Default is passthrough:
  a plain OpenAI-compatible reseller needs no `requestProfile`; only a vendor
  with unusual reasoning or steering semantics needs one.
- **The plugin cannot invent a provider the Router cannot authenticate or
  forward.** If the Router cannot resolve the credential descriptor or reach
  the base URL, no overlay entry makes it usable.
- **Desktop is optional for plugin-only flows.** Pricing import, support
  bundle and live paid checks stay desktop-only; they are not required to
  connect a provider.
- **Team defaults are examples.** Qwen/Grok defaults documented elsewhere are
  one working configuration, not a requirement. Logical bindings validate
  against the live catalog.
- **The overlay is a patch, not vendoring.** Orchestra applies the
  `model-registry.mjs` patch when it installs or updates the managed Router
  checkout. The overlay helper ships inside the plugin package at
  `plugins/codex-orchestra/scripts/router-overlay/apply.mjs`. It does not
  vendor the Router and does not treat the live engine as the source of
  truth.

## After connecting

- `orchestra_models` shows the visible catalog and credential status without
  secret values.
- `orchestra_doctor` reports health; `orchestra_router action=logs` returns
  redacted recent Router log lines when something fails.
- `orchestra_router action=set-model-visible` toggles one model in the
  picker state; `disconnect-provider` removes a connected provider. Both
  still require the catalog refresh and Codex restart to reach the picker.
- A model that appears in the catalog is routable. Whether it actually
  performs is what the desktop live checks verify; catalog presence alone is
  not proof.

## Lifecycle

Every mutating operation needs `confirm=true`. Read-only operations do not.
The CLI equivalent uses the same names through
`python plugins\codex-orchestra\scripts\orchestra.py`.

| Operation              | MCP action                                                              | CLI                                                                 |
| ---------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Detect / status        | `orchestra_router action=status` (or `detect`)                            | `python plugins\codex-orchestra\scripts\orchestra.py router status`  |
| Doctor                 | `orchestra_doctor`                                                        | `python plugins\codex-orchestra\scripts\orchestra.py doctor`         |
| Install Router         | `orchestra_router action=install confirm=true`                            | `... router install --confirm`                                       |
| Update Router          | `orchestra_router action=update confirm=true`                             | `... router update --confirm`                                        |
| Rollback Router        | `orchestra_router action=rollback confirm=true`                           | `... router rollback --confirm`                                      |
| Start / restart        | `orchestra_router action=start confirm=true` (or `restart`)               | `... router start --confirm` / `... router restart --confirm`        |
| Refresh catalog        | `orchestra_router action=refresh-catalog confirm=true`                    | `... router refresh-catalog --confirm`                               |
| Logs                   | `orchestra_router action=logs`                                            | `... router logs`                                                    |
| List providers         | `orchestra_router action=list-providers`                                  | `... router list-providers`                                          |
| Connect provider       | `orchestra_router action=connect-provider provider=<id> confirm=true`      | `... router connect-provider --provider <id> --confirm`              |
| Disconnect provider    | `orchestra_router action=disconnect-provider provider=<id> confirm=true`   | `... router disconnect-provider --provider <id> --confirm`           |
| Enable provider        | `orchestra_router action=enable-provider provider=<id> confirm=true`       | `... router enable-provider --provider <id> --confirm`               |
| Disable provider       | `orchestra_router action=disable-provider provider=<id> confirm=true`      | `... router disable-provider --provider <id> --confirm`              |

`install` and `update` apply the packaged Router overlay to the managed
checkout and report `overlay.status`; a custom provider is not usable until
that reads `applied`. `rollback` restores the managed checkout from the
Orchestra rollback reference (see [ADR-006](DECISIONS/ADR-006-update-strategy.md)).
The reference-management and restore flow is implemented in the desktop
Diagnostics/Advanced surface; a plugin-only recovery after a bad pin is to run
`update --confirm` back to the reviewed pin and then Doctor.

## Manual CLI

The plugin MCP and the CLI call the same core. The CLI writes JSON to stdout;
writes still need `--confirm`. Replace `<abs-path>` with an absolute project
path. These examples contain no key values.

### Path A — known provider

```powershell
python plugins\codex-orchestra\scripts\orchestra.py router connect-provider --provider openrouter --confirm
python plugins\codex-orchestra\scripts\orchestra.py router refresh-catalog --confirm
python plugins\codex-orchestra\scripts\orchestra.py doctor
```

If the provider ends up with no curated models:

```powershell
python plugins\codex-orchestra\scripts\orchestra.py router curate-models --provider openrouter --confirm
# or define models explicitly:
python plugins\codex-orchestra\scripts\orchestra.py router upsert-user-models --confirm --args '{"models":[{"slug":"openrouter/some-model","displayName":"Some Model"}]}'
```

### Path B — custom reseller / OpenAI-compatible endpoint

```powershell
python plugins\codex-orchestra\scripts\orchestra.py router upsert-user-provider --confirm --args '{"provider":"acme-corp","displayName":"Acme Corp","ownedBy":"Acme","baseUrl":"https://api.acme.example/v1","credentialFile":"acme-key.secret","credentialEnvironment":["ACME_API_KEY"]}'
python plugins\codex-orchestra\scripts\orchestra.py router connect-provider --provider acme-corp --confirm
python plugins\codex-orchestra\scripts\orchestra.py router upsert-user-models --confirm --args '{"models":[{"slug":"acme-corp/model-x","displayName":"Acme Model X","contextWindow":128000}]}'
python plugins\codex-orchestra\scripts\orchestra.py router refresh-catalog --confirm
python plugins\codex-orchestra\scripts\orchestra.py doctor
```

For a `requestProfile`, pass it as a string on the model entry:

```powershell
python plugins\codex-orchestra\scripts\orchestra.py router upsert-user-models --confirm --args '{"models":[{"slug":"acme-corp/model-x","requestProfile":"openai-responses"}]}'
```

### Path C — keyless local server

```powershell
python plugins\codex-orchestra\scripts\orchestra.py router upsert-user-provider --confirm --args '{"provider":"ollama","displayName":"Ollama","ownedBy":"ollama","baseUrl":"http://127.0.0.1:11434/v1","keyless":true}'
python plugins\codex-orchestra\scripts\orchestra.py router upsert-user-models --confirm --args '{"models":[{"slug":"ollama/llama3","displayName":"Llama 3"}]}'
python plugins\codex-orchestra\scripts\orchestra.py router refresh-catalog --confirm
python plugins\codex-orchestra\scripts\orchestra.py doctor
```

Keyless has no `connect-provider` step and no key anywhere.

## Troubleshooting

Work through the checks in order. Never paste a key in chat.

### 1. Is the overlay present?

For a custom provider, inspect the last `upsert-user-provider` or
`connect-provider` response for an `overlay` block.

- `overlay.status == "applied"` — the Router can resolve the provider.
- `no-overlay` — the packaged helper was not found. Reinstall the plugin from a
  checkout that contains `scripts/router-overlay/apply.mjs`.
- `missing-src` — no managed Router `src/` checkout. Run
  `orchestra_router action=install confirm=true` first.
- `failed` — `node` could not apply the patch. Read the redacted detail, then
  run `orchestra_router action=logs`.

`install` and `update` also apply the overlay; if a custom provider is
unusable after an upgrade, run `update --confirm` (which reapplies it) and
check the response again.

### 2. Is the Router healthy?

```text
orchestra_doctor
```

If the Router is offline, use `$orchestra-repair` or
`orchestra_router action=start confirm=true`. Doctor marks a missing desktop
app as optional, not unhealthy; Router, Codex and provider status are what
matter for plugin-only flows.

### 3. Is the model in the catalog?

```text
orchestra_models
orchestra_router action=list-providers
```

If the provider is connected but the picker is empty, run `curate-models` or
`upsert-user-models`, then `refresh-catalog` and Doctor again.

### 4. Is Codex reloaded?

Fully quit and reopen Codex after every catalog change. The picker has no
hot-reload. A catalog entry proves routability, not model quality; the desktop
live checks verify actual behavior.

### 5. Read the logs

```text
orchestra_router action=logs
```

Logs are redacted. If a base URL is unreachable, fix connectivity on the
machine and retry `refresh-catalog`; the overlay does not invent
authentication or forwarding the Router cannot perform.

## Pin changes and recovery

The Router is pinned to a reviewed commit; Orchestra never tracks a moving
`main`. A reviewed pin change means the overlay's patched `model-registry.mjs`
must be rebased against the new Router source before `install`/`update` reapply
it. Until that rebase lands, do not assume a custom provider survives a pin
bump: keep the older pin, or fall back to the first-party providers that the
new pin already ships.

For a failed update, use the stored Orchestra rollback reference (desktop
Advanced surface) and run Doctor. For plugin-only setups, `update --confirm`
re-pins the reviewed commit and reapplies the overlay. Providers may bill you
for real usage; verify the provider, model and billing source before running a
live check.
