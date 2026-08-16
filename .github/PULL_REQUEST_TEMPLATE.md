## Summary

- What changed
- Why

## Surface

- [ ] Plugin / MCP
- [ ] Desktop
- [ ] Core / adapters
- [ ] Docs / CI

## Checks

- [ ] `npm test`
- [ ] `npm run typecheck` if TypeScript changed
- [ ] `npm run check:secrets`
- [ ] Plugin validator if `plugins/codex-orchestra` changed
- [ ] No personal paths, `.env` or support bundles

## Compatibility

- [ ] Router stays external
- [ ] `codex-control` still owns thread writes
- [ ] Managed writes stay marker-bounded
- [ ] Desktop still builds or is untouched
