# Orchestra Core

Reusable TypeScript surface shared by the desktop app and the Codex plugin.

It re-exports `@codex-orchestra/contracts` and documents the plugin/desktop feature map. Python in `plugins/codex-orchestra/scripts` is the runtime used by MCP; this package is the typed contract those scripts must stay aligned with.

```powershell
npx tsc -p packages/orchestra-core/tsconfig.json --noEmit
npx tsx --test packages/orchestra-core/test/core.test.ts
```
