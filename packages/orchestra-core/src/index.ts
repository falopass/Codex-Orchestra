export * from "@codex-orchestra/contracts";

export const ORCHESTRA_PLUGIN_NAME = "codex-orchestra";
export const ORCHESTRA_MANAGED_BEGIN = "<!-- BEGIN CODEX-ORCHESTRA MANAGED -->";
export const ORCHESTRA_MANAGED_END = "<!-- END CODEX-ORCHESTRA MANAGED -->";
export const ORCHESTRA_CONFIG_BEGIN = "# BEGIN CODEX-ORCHESTRA MANAGED";
export const ORCHESTRA_CONFIG_END = "# END CODEX-ORCHESTRA MANAGED";

export const ORCHESTRA_GENERATED_PATHS = [
  ".codex/agents/orchestra_frontend.toml",
  ".codex/agents/orchestra_engineer.toml",
  ".codex/agents/orchestra_visual.toml",
  ".codex/skills/orchestra-routing/SKILL.md",
  ".codex/config.toml",
] as const;

export const PLUGIN_SURFACES = {
  overview: "mcp:orchestra_status",
  router: "mcp:orchestra_router",
  models: "mcp:orchestra_models",
  team: "mcp:orchestra_team",
  routing: "mcp:orchestra_apply_managed",
  diagnostics: "mcp:orchestra_doctor",
  usage: "mcp:orchestra_usage_summary",
  worktrees: "mcp:orchestra_worktrees",
  threads: "adapter:codex-control",
  setup: "skill:orchestra-setup",
  settings: "desktop",
} as const;

export type PluginCapability =
  "read" | "confirm-write" | "desktop-only" | "external-plugin";

export interface PluginFeatureMap {
  id: keyof typeof PLUGIN_SURFACES;
  plugin: PluginCapability;
  desktop: "full";
  note: string;
}

export const PLUGIN_FEATURE_MAP: PluginFeatureMap[] = [
  {
    id: "overview",
    plugin: "read",
    desktop: "full",
    note: "Redacted Codex, Router, provider and agent health.",
  },
  {
    id: "router",
    plugin: "confirm-write",
    desktop: "full",
    note: "Detect, doctor, start, restart, logs, update and rollback through the Router adapter.",
  },
  {
    id: "models",
    plugin: "read",
    desktop: "full",
    note: "Catalog and credential status only. Values stay in Router helpers.",
  },
  {
    id: "team",
    plugin: "confirm-write",
    desktop: "full",
    note: "Logical roles stay separate from model bindings.",
  },
  {
    id: "routing",
    plugin: "confirm-write",
    desktop: "full",
    note: "Managed AGENTS.md and Orchestra agent files only.",
  },
  {
    id: "diagnostics",
    plugin: "confirm-write",
    desktop: "full",
    note: "Doctor, repair and redacted logs. Live paid checks stay explicit.",
  },
  {
    id: "usage",
    plugin: "read",
    desktop: "full",
    note: "Existing local events only. No invented telemetry.",
  },
  {
    id: "worktrees",
    plugin: "confirm-write",
    desktop: "full",
    note: "Disjoint frontend/engineer worktrees. Merge stays manual.",
  },
  {
    id: "threads",
    plugin: "external-plugin",
    desktop: "full",
    note: "Reuse installed codex-control. Do not duplicate App Server writes.",
  },
  {
    id: "setup",
    plugin: "confirm-write",
    desktop: "full",
    note: "Detect the environment and preview or apply managed artifacts.",
  },
  {
    id: "settings",
    plugin: "desktop-only",
    desktop: "full",
    note: "Pricing import, feature flags and support bundle stay in the desktop app.",
  },
];
