"""Render Orchestra-managed artifacts from local team state."""

from __future__ import annotations

from typing import Any

from .policy import MANAGED_BEGIN, MANAGED_END


FRONTEND_INSTRUCTIONS = """Complete only the bounded frontend task delegated by the root.
This logical frontend role owns React, TypeScript, components, client state,
API wiring, responsive behavior and ordinary frontend implementation regardless
of its current model binding. Work autonomously with Codex tools inside the
assigned files. Do not call another primary worker. If you need another role,
report the exact blocker to the root."""

ENGINEER_INSTRUCTIONS = """Complete only the bounded engineering task delegated by the root.
This logical engineer role owns backend, architecture implementation, debugging,
tests, integrations and general engineering regardless of its current model
binding. Work autonomously with Codex tools inside the assigned files. Do not
call another primary worker. If you need another role, report the exact blocker
to the root."""

VISUAL_INSTRUCTIONS = """Complete only the visual/UI task delegated by the root.
This role is reserved for visual direction, UX, screenshots, composition and
design-system polish. Do not delegate. Stay inside assigned files."""


def render_agent_toml(name: str, description: str, model_id: str, effort: str, instructions: str) -> str:
    return (
        f'name = "{name}"\n'
        f'description = "{description}"\n\n'
        'model_provider = "codex-router"\n'
        f'model = "{model_id}"\n'
        f'model_reasoning_effort = "{effort}"\n'
        'sandbox_mode = "workspace-write"\n\n'
        'developer_instructions = """\n'
        f"{instructions.strip()}\n"
        '"""\n'
    )


def render_routing_skill() -> str:
    return """---
name: orchestra-routing
description: Route substantial coding work to Orchestra configured specialist subagents.
---

# Orchestra routing policy

The configured root alone routes cross-role work, owns shared files, integrates
handoffs and performs final review.

Roles are logical bindings, not permanently fixed models. Default bindings can
be changed in Orchestra: root stays native Codex, frontend and engineer resolve
against the live Router catalog.

Cross-role delegation always returns through the root. Workers never call
another primary worker. Parallel writes require disjoint ownership.

Do not delegate trivial changes merely to use an agent. Retry a failed worker
at most once. Never expose credentials to a subagent prompt.
"""


def render_subagent_config() -> str:
    return "[agents]\nenabled = true\nmax_concurrent_threads_per_session = 2\nmax_depth = 1\n"


def render_managed_block(agents: list[dict[str, Any]], shared_paths: list[str]) -> str:
    lines = []
    for agent in agents:
        role = agent.get("role", "unknown")
        ownership = ", ".join(agent.get("ownershipPaths") or []) or "configure in Orchestra"
        lines.append(f"- {role}: {ownership}")
    shared = ", ".join(shared_paths) or "package.json"
    body = (
        "For substantial engineering work, load the orchestra-routing skill.\n\n"
        "Delegation policy:\n"
        "- The configured root alone routes cross-role work and owns shared files, integration and final validation.\n"
        "- Frontend, engineer and visual are logical roles whose current model bindings come from Orchestra.\n"
        "- Workers report blockers to root instead of calling another primary worker; the visual role never delegates.\n\n"
        "Project ownership:\n"
        + "\n".join(lines)
        + f"\n- shared/root-owned: {shared}\n\n"
        "Parallel write delegation is allowed only for disjoint scopes. Never write overlapping files concurrently."
    )
    return f"{MANAGED_BEGIN}\n{body}\n{MANAGED_END}"


def generated_files(agents: list[dict[str, Any]], visual_model: str = "opencode-go/kimi-k3") -> list[dict[str, str]]:
    files: list[dict[str, str]] = []
    for agent in agents:
        role = agent.get("role")
        model = agent.get("modelId") or ""
        effort = agent.get("reasoningEffort") or "high"
        if role == "frontend":
            files.append(
                {
                    "path": ".codex/agents/orchestra_frontend.toml",
                    "content": render_agent_toml(
                        "orchestra_frontend",
                        "Logical frontend role for delegated client-side work.",
                        model,
                        effort,
                        FRONTEND_INSTRUCTIONS,
                    ),
                }
            )
        elif role == "engineer":
            files.append(
                {
                    "path": ".codex/agents/orchestra_engineer.toml",
                    "content": render_agent_toml(
                        "orchestra_engineer",
                        "Logical engineer role for delegated implementation work.",
                        model,
                        effort,
                        ENGINEER_INSTRUCTIONS,
                    ),
                }
            )
    files.append(
        {
            "path": ".codex/agents/orchestra_visual.toml",
            "content": render_agent_toml(
                "orchestra_visual",
                "Selective visual/UI specialist.",
                visual_model,
                "max",
                VISUAL_INSTRUCTIONS,
            ),
        }
    )
    files.append({"path": ".codex/skills/orchestra-routing/SKILL.md", "content": render_routing_skill()})
    files.append({"path": ".codex/config.toml", "content": render_subagent_config()})
    return files
