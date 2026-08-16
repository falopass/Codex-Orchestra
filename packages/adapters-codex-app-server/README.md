# Codex App Server adapter

Contract for optional App Server stdio and the thread-control bridge.

Write methods are listed so callers know what **not** to reimplement. If `codex-control` is installed, Orchestra should delegate thread create / send / steer instead of opening a second write path.

See [docs/DECISIONS/ADR-008-app-server-mcp-boundary.md](../../docs/DECISIONS/ADR-008-app-server-mcp-boundary.md).
