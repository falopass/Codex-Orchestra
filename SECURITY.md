# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | Yes, current public alpha |
| < 0.1.0 | No public support |

This is an early local control plane. Fixes land on `main`.

## Reporting a vulnerability

Use [GitHub Security Advisories](https://github.com/falopass/Codex-Orchestra/security/advisories/new) for private reports.

Do **not** include:

- API keys, OAuth tokens, cookies, refresh tokens or private keys
- Real `config.toml` contents
- Support bundles, crash dumps or local usage/cost exports
- Personal home paths, thread ids or screenshots of private projects

Describe the impact, a minimal reproduction and whether secrets may already have been logged.

## Product rules

Orchestra must never store provider secrets, prompts or native Codex session files. Credential entry belongs to Router helpers or OS stores. Plugin writes require `confirm=true` and stay inside Orchestra-managed markers.

See [docs/SECURITY.md](docs/SECURITY.md) for the in-product model.
