# RouterEngine boundary

`RouterEngine` is the only product boundary allowed to know Codex Router commands. The implementation delegates to the managed upstream checkout; it does not reimplement Responses ↔ provider translation.

## Upstream lock

- Repository: https://github.com/duolahypercho/codex-router
- Observed package version during research: `0.4.0-beta.2`
- Runtime requirement observed upstream: Node `>=22.19.0`; Node 24 is recommended.
- Windows command surface: `./codex-router.ps1 codex ...`.
- Read-only diagnosis: `doctor`, `status`, `providers`, `models`.
- Lifecycle: `update check`, `update`, `rollback`; update must retain a rollback reference and run doctor after promotion.
- Model curation: `curate-models`; model/provider visibility is credential-aware.

The application stores a configured version/ref and never silently follows `main`. The UI exposes the target, backup requirement and health gate before mutation. The immutable commit is intentionally configured by the user/operator when the managed checkout is installed; this repository does not clone or mutate a real router during tests.

## Credential boundary

Orchestra asks the router or OS helper to perform credential setup. It only consumes `configured`, `missing`, `invalid` or `expired`. It does not read key files, environment secrets, or OAuth session contents.

## Fixture protocol

`evals/fixtures/router/` mirrors the JSON-shaped facts the adapter consumes. Tests use those fixtures and temporary directories; they never touch `%USERPROFILE%\\.codex` or the real router checkout.
