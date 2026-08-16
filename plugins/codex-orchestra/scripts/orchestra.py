#!/usr/bin/env python3
"""CLI for Codex Orchestra Core. Same commands as the plugin MCP."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from orchestra_core import dispatch


def dump(payload: object) -> int:
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Codex Orchestra local control plane")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("status")
    sub.add_parser("doctor")
    sub.add_parser("models")
    sub.add_parser("team")
    sub.add_parser("usage")
    sub.add_parser("sync")
    sub.add_parser("threads")
    sub.add_parser("repair")

    router_p = sub.add_parser("router")
    router_p.add_argument("action", nargs="?", default="status")
    router_p.add_argument("--confirm", action="store_true")

    setup_p = sub.add_parser("setup")
    setup_p.add_argument("--project")
    setup_p.add_argument("--confirm", action="store_true")

    apply_p = sub.add_parser("apply")
    apply_p.add_argument("project")
    apply_p.add_argument("--hash")
    apply_p.add_argument("--confirm", action="store_true")

    plan_p = sub.add_parser("plan")
    plan_p.add_argument("--frontend", action="append", default=[])
    plan_p.add_argument("--engineer", action="append", default=[])
    plan_p.add_argument("--shared", action="append", default=[])

    work_p = sub.add_parser("worktrees")
    work_p.add_argument("project")
    work_p.add_argument("--action", default="list")
    work_p.add_argument("--role", default="frontend")
    work_p.add_argument("--slug", default="task")
    work_p.add_argument("--confirm", action="store_true")

    team_save = sub.add_parser("team-save")
    team_save.add_argument("role")
    team_save.add_argument("--model")
    team_save.add_argument("--provider")
    team_save.add_argument("--confirm", action="store_true")

    args = parser.parse_args()
    if args.command == "router":
        return dump(dispatch("orchestra_router", {"action": args.action, "confirm": args.confirm}))
    if args.command == "setup":
        return dump(dispatch("orchestra_setup", {"project_path": args.project, "confirm": args.confirm}))
    if args.command == "apply":
        return dump(dispatch("orchestra_apply_managed", {"project_path": args.project, "expectedHash": args.hash, "confirm": args.confirm}))
    if args.command == "plan":
        return dump(
            dispatch(
                "orchestra_scope_plan",
                {
                    "assignments": {"frontend": args.frontend, "engineer": args.engineer, "root": []},
                    "sharedPaths": args.shared,
                },
            )
        )
    if args.command == "worktrees":
        return dump(
            dispatch(
                "orchestra_worktrees",
                {
                    "project_path": args.project,
                    "action": args.action,
                    "role": args.role,
                    "slug": args.slug,
                    "confirm": args.confirm,
                },
            )
        )
    if args.command == "team-save":
        agent = {"id": args.role, "role": args.role}
        if args.model:
            agent["modelId"] = args.model
        if args.provider:
            agent["providerId"] = args.provider
        return dump(dispatch("orchestra_team", {"agent": agent, "confirm": args.confirm}))
    mapping = {
        "status": "orchestra_status",
        "doctor": "orchestra_doctor",
        "models": "orchestra_models",
        "team": "orchestra_team",
        "usage": "orchestra_usage_summary",
        "sync": "orchestra_sync_status",
        "threads": "orchestra_threads",
        "repair": "orchestra_repair",
    }
    return dump(dispatch(mapping[args.command], {}))


if __name__ == "__main__":
    raise SystemExit(main())
