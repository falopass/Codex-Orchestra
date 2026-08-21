"""Safe write policy for Orchestra-managed files only."""

from __future__ import annotations

from pathlib import Path

MANAGED_BEGIN = "<!-- BEGIN CODEX-ORCHESTRA MANAGED -->"
MANAGED_END = "<!-- END CODEX-ORCHESTRA MANAGED -->"
CONFIG_BEGIN = "# BEGIN CODEX-ORCHESTRA MANAGED"
CONFIG_END = "# END CODEX-ORCHESTRA MANAGED"

GENERATED_RELATIVE = {
    ".codex/agents/orchestra_frontend.toml",
    ".codex/agents/orchestra_engineer.toml",
    ".codex/agents/orchestra_visual.toml",
    ".codex/skills/orchestra-routing/SKILL.md",
    ".codex/config.toml",
}

MUTATING_ACTIONS = {
    "router.install",
    "router.start",
    "router.restart",
    "router.connect-provider",
    "router.disconnect-provider",
    "router.upsert-user-provider",
    "router.upsert-user-models",
    "router.enable-provider",
    "router.disable-provider",
    "router.set-model-visible",
    "router.curate-models",
    "router.set-flag",
    "router.refresh-catalog",
    "router.update",
    "router.rollback",
    "setup.apply",
    "team.save",
    "worktree.create",
    "worktree.remove",
}


def require_confirm(action: str, confirm: bool) -> None:
    if action in MUTATING_ACTIONS and not confirm:
        raise PermissionError(f"{action} requires confirm=true")


def merge_managed_block(existing: str, block: str) -> str:
    body = block.replace(MANAGED_BEGIN, "").replace(MANAGED_END, "").strip()
    replacement = f"{MANAGED_BEGIN}\n{body}\n{MANAGED_END}"
    start = existing.find(MANAGED_BEGIN)
    end = existing.find(MANAGED_END)
    if start != -1 and end > start:
        return existing[:start] + replacement + existing[end + len(MANAGED_END) :]
    trimmed = existing.rstrip()
    if trimmed:
        return f"{trimmed}\n\n{replacement}\n"
    return f"{replacement}\n"


def merge_subagent_config(existing: str, block: str) -> str:
    body = block.replace(CONFIG_BEGIN, "").replace(CONFIG_END, "").strip()
    replacement = f"{CONFIG_BEGIN}\n{body}\n{CONFIG_END}"
    start = existing.find(CONFIG_BEGIN)
    end = existing.find(CONFIG_END)
    if start != -1 and end > start:
        return existing[:start] + replacement + existing[end + len(CONFIG_END) :]
    trimmed = existing.rstrip()
    if trimmed:
        return f"{trimmed}\n\n{replacement}\n"
    return f"{replacement}\n"


def preview_hash(value: str) -> str:
    digest = 0x811C9DC5
    for byte in value.encode("utf-8"):
        digest ^= byte
        digest = (digest * 0x01000193) & 0xFFFFFFFF
    return f"{digest:08x}"


def is_generated_relative(path: str) -> bool:
    return path.replace("\\", "/") in GENERATED_RELATIVE


def safe_agents_target(path: str) -> Path:
    target = Path(path)
    if not target.is_absolute():
        raise ValueError("Managed config path must be absolute")
    if target.name != "AGENTS.md":
        raise ValueError("Only AGENTS.md is managed by this command")
    parent = target.parent
    if not parent.exists():
        raise ValueError("Managed config parent directory does not exist")
    return parent.resolve() / "AGENTS.md"


def safe_generated_target(root: Path, relative: str) -> Path:
    normalized = relative.replace("\\", "/")
    if not is_generated_relative(normalized):
        raise ValueError(f"Refusing unmanaged generated path: {relative}")
    if ".." in Path(normalized).parts:
        raise ValueError("Generated path must stay inside the project")
    return root / Path(normalized)
