# ADR-008: App Server and MCP boundary

Status: accepted

Use official App Server stdio only for optional activity/control experiments and MCP only for read-only Orchestra facts. Keep core setup and safety workflows independent of experimental transport surfaces.
