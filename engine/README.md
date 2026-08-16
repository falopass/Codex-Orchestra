# RouterEngine boundary

`RouterEngine` is the only product boundary allowed to know Codex Router commands. The implementation delegates to the managed upstream checkout; it does not reimplement Responses ↔ provider translation.

## Upstream lock

- Repository: https://github.com/duolahypercho/codex-router
- Observed package version during research: `0.4.0-beta.3`
- Runtime requirement observed upstream: Node `>=22.19.0`; Node 24 is recommended.
- Windows command surface: preferred `./model-router.ps1 codex ...`; the direct `./codex-router.ps1` fallback already targets Codex and therefore receives only the command.
- Read-only diagnosis: `codex doctor`, `codex status`, `codex providers`. Models are read from the generated `merged-models.json` catalog because upstream does not expose a `models` command.
- Lifecycle: update check compares against Orchestra's reviewed pin; promotion and rollback use the managed source revision, reinstall and `codex doctor`. Router's upstream `main`-only update command is intentionally not used for detached pins.
- Model curation: `node src/curate-models.mjs PROVIDER`; model/provider visibility is credential-aware and the interactive flow remains in the Router process.
- Orchestra bounds read-only Router calls to 15 seconds and explicit live compatibility checks to 180 seconds. It consumes only redacted status; a timeout or failed command does not become a configured credential or available model.
- Provider enable/disable stays behind an explicit confirmation and allow-list. Model curation delegates to the Router's interactive script, so discovery and credential entry remain outside the renderer.

The application stores the verified signed release commit for `v0.4.0-beta.3` (`a1be46aa02426d87a9e24e114ce8c22619c63c7a`) and never silently follows `main` after installation. Managed updates fetch that reviewed pin directly, record an Orchestra rollback ref, reinstall from the selected source revision, and run `doctor` before promotion. A failed promotion restores the prior source revision and reruns the same install/doctor path; Router's own `main`-only updater is not used for detached reviewed pins. Tests never clone or mutate a real router checkout.

Pricing rules, feature flags, operation logs and profile portability are persisted
in the local Orchestra SQLite state. Exported profiles omit credentials, prompts
and response bodies.

## Credential boundary

Orchestra asks the router or OS helper to perform credential setup. It only consumes `configured`, `missing`, `invalid` or `expired`. It does not read key files, environment secrets, or OAuth session contents.

## Fixture protocol

`evals/fixtures/router/` mirrors the JSON-shaped facts the adapter consumes. Tests use those fixtures and temporary directories; they never touch `%USERPROFILE%\\.codex` or the real router checkout.

When the user confirms installation, the native adapter initializes a managed
checkout, fetches the reviewed commit directly with `git fetch --depth 1
origin <pin>`, and checks out detached `FETCH_HEAD`. It never installs whatever
revision happens to be `main` at that moment.
