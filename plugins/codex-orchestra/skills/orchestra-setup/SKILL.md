---
name: orchestra-setup
description: Detect the local Codex/Router environment and configure Orchestra-managed project files without unnecessary manual edits. Use for /orchestra-setup, first-run onboarding, or applying the managed AGENTS block.
---

# Orchestra Setup

1. Call `orchestra_status` to see Codex, Router, desktop and providers.
2. If Router is missing, preview `orchestra_router` with `action=install` and only run it after `confirm=true`.
3. Ask for one absolute project path. Never guess a personal path.
4. Call `orchestra_setup` with that path to generate a managed preview.
5. Show the preview. Apply only with `orchestra_apply_managed` and `confirm=true`.
6. Leave foreign AGENTS.md content and non-Orchestra agents untouched.

Provider connection does not need the desktop app: `orchestra_router action=connect-provider provider=<slug> confirm=true` opens the visible Router helper (or `grok login --oauth` for Grok OAuth) and the user pastes the key there. Keyless loopback providers (Ollama, llama.cpp) register with `upsert-user-provider` plus `keyless: true` and never ask for a key. Never ask for a key in chat. Desktop stays optional and keeps pricing import, feature flags, support bundle and live paid checks.
