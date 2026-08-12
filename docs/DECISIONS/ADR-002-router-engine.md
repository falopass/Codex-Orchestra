# ADR-002: Codex Router as external engine

Status: accepted

The router already owns Responses translation, provider auth boundaries, catalog merging, compaction and native Codex preservation. Orchestra wraps its CLI and managed checkout through `RouterEngine` instead of reimplementing a proxy.
