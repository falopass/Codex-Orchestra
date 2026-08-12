# ADR-007: safe parallelism

Status: accepted

Only disjoint write scopes run in parallel. Shared files and overlaps force sequential execution. Worktrees are an experimental escape hatch, never an implicit permission to collide.
