# ADR-001: Tauri 2 instead of Electron

Status: accepted

Tauri keeps the renderer separate from a small Rust boundary and avoids shipping a second Chromium runtime. The tradeoff is a Rust toolchain requirement for native builds; this is documented rather than hidden.
