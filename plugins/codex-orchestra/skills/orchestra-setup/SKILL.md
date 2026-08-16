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

Desktop remains the advanced setup UI for provider helpers, Grok OAuth and live checks.
