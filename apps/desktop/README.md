# Desktop app

Advanced Tauri 2 UI for Codex Orchestra. The Codex plugin is the lightweight surface; this app keeps pricing import, feature flags, support bundle, live paid checks and the full Run / App Server session.

```powershell
npm install
npm run dev
npm --workspace apps/desktop run typecheck
```

Native:

```powershell
npm run tauri:dev
```

Requires Rust and the [Tauri Windows prerequisites](https://v2.tauri.app/start/prerequisites/). If the checkout path contains non-ASCII characters, set `CARGO_TARGET_DIR` to an ASCII directory.

No signed installer is published in GitHub Releases yet.
