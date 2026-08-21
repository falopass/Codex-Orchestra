---
name: orchestra-doctor
description: Run Orchestra health checks for Codex, Router, providers, desktop and thread control. Use for /orchestra-doctor, overview, or when routing looks broken.
---

# Orchestra Doctor

Call `orchestra_doctor`. Summarize redacted checks only.

If Router is offline, say so clearly and offer `$orchestra-repair`. Do not invent provider invoices or live model results. If a custom provider is registered but unusable, check whether the last `upsert-user-provider` / `connect-provider` response reported `overlay.status == "applied"`; `install` or `update` reapplies the overlay. Paid checks stay in the desktop Diagnostics view, but the desktop app is optional for plugin-only provider flows: credential entry happens in the Router helper, not in the desktop app, and never in chat.
