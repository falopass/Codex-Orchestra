import type {
  AgentDefinition,
  DiagnosticItem,
  HealthReport,
  LiveCheckPreview,
  OrchestraSnapshot,
  PreviewFile,
  ProjectProfile,
  RouterOperation,
  ScopePlan,
} from "@codex-orchestra/contracts";
import {
  DEFAULT_BINDINGS,
  managedConfigPreview,
  planScopes,
  renderManagedBlock,
  resolveModelBinding,
} from "@codex-orchestra/contracts";

const now = () => new Date().toISOString();

const agents: AgentDefinition[] = [
  {
    id: "root",
    name: "Sol / Root",
    role: "root",
    description: "Tech lead, architect and final reviewer.",
    providerId: "openai",
    modelId: "gpt-5.6-sol",
    reasoningEffort: "max",
    permissions: ["workspace-write", "delegation"],
    routingHints: ["keep architecture", "review every handoff"],
    retryLimit: 1,
    ownershipPaths: ["*"],
    sharedPaths: ["package.json", "types/**"],
    health: "healthy",
    lastTest: "native login pending",
    estimatedCostPerMillion: 0,
  },
  {
    id: "frontend",
    name: "Kimi / Frontend",
    role: "frontend",
    description: "UI, UX, responsive and accessibility specialist.",
    providerId: "kimi-api",
    modelId: "kimi-api/kimi-k3",
    reasoningEffort: "max",
    permissions: ["workspace-write"],
    routingHints: ["visual fidelity", "responsive", "a11y"],
    retryLimit: 1,
    ownershipPaths: ["app/**", "src/**", "components/**", "styles/**"],
    sharedPaths: [],
    health: "degraded",
    lastTest: "live check pending",
    estimatedCostPerMillion: 4.8,
  },
  {
    id: "engineer",
    name: "Grok / Engineer",
    role: "engineer",
    description: "Backend, integration, debugging and test specialist.",
    providerId: "grok-api",
    modelId: "grok-api/grok-4.5",
    reasoningEffort: "high",
    permissions: ["workspace-write"],
    routingHints: ["contracts first", "tests", "bounded scope"],
    retryLimit: 1,
    ownershipPaths: ["server/**", "api/**", "db/**", "tests/**"],
    sharedPaths: [],
    health: "missing",
    lastTest: "Grok 4.6 curation pending",
    estimatedCostPerMillion: 15,
  },
];

let snapshot: OrchestraSnapshot = {
  appVersion: "0.1.0",
  codex: {
    detected: true,
    executable: "fixture://codex",
    version: "fixture",
    home: "%USERPROFILE%\\.codex",
    login: "unknown",
    nativeModelsAvailable: false,
    source: "fixture",
  },
  router: {
    detected: true,
    root: "%LOCALAPPDATA%\\CodexOrchestra\\engine\\codex-router",
    version: "0.4.0-beta.2",
    pinnedRef: "0.4.0-beta.2",
    health: "healthy",
    ports: [4200, 4201, 4202, 4203],
    service: "running",
  },
  providers: [
    {
      id: "kimi-api",
      name: "Kimi Platform",
      family: "kimi",
      credential: "missing",
      enabled: true,
      billingNote: "API key entered through Router helper",
      lastChecked: now(),
    },
    {
      id: "grok-api",
      name: "xAI",
      family: "xai",
      credential: "missing",
      enabled: true,
      billingNote: "API key entered through Router helper",
      lastChecked: now(),
    },
    {
      id: "openai",
      name: "Codex native",
      family: "openai",
      credential: "unknown",
      enabled: true,
      billingNote: "Native Codex/ChatGPT auth",
      lastChecked: now(),
    },
  ],
  models: [
    {
      id: "gpt-5.6-sol",
      label: "GPT-5.6 Sol",
      providerId: "openai",
      available: true,
      supportsStreaming: true,
      supportsTools: true,
      supportsSubagents: true,
      reasoningEfforts: ["high", "max"],
      source: "native",
    },
    {
      id: "kimi-api/kimi-k3",
      label: "Kimi K3",
      providerId: "kimi-api",
      available: true,
      supportsStreaming: true,
      supportsTools: true,
      supportsSubagents: true,
      reasoningEfforts: ["high", "max"],
      source: "fixture",
      contextWindow: 256000,
    },
    {
      id: "grok-api/grok-4.5",
      label: "Grok 4.5",
      providerId: "grok-api",
      available: true,
      supportsStreaming: true,
      supportsTools: true,
      supportsSubagents: true,
      reasoningEfforts: ["high"],
      source: "fixture",
      contextWindow: 256000,
    },
  ],
  agents,
  projects: [],
  usage: [
    {
      id: "usage-1",
      timestamp: "2026-08-12T09:12:00Z",
      provider: "kimi-api",
      model: "kimi-api/kimi-k3",
      role: "frontend",
      inputTokens: 48200,
      cachedInputTokens: 12000,
      outputTokens: 9200,
      source: "router",
      estimatedCost: 0.08,
    },
    {
      id: "usage-2",
      timestamp: "2026-08-12T10:18:00Z",
      provider: "grok-api",
      model: "grok-api/grok-4.5",
      role: "engineer",
      inputTokens: 25500,
      outputTokens: 7700,
      source: "estimate",
      estimatedCost: 0.24,
    },
    {
      id: "usage-3",
      timestamp: "2026-08-12T11:04:00Z",
      provider: "openai",
      model: "gpt-5.6-sol",
      role: "root",
      inputTokens: 76000,
      outputTokens: 11400,
      source: "provider",
      providerCost: 0,
    },
  ],
  budget: {
    monthlyLimit: 40,
    warningAtPercent: 70,
    criticalAtPercent: 90,
    currency: "USD",
  },
  backups: [
    {
      id: "backup-fixture",
      target: "config.toml",
      createdAt: "2026-08-12T08:32:00Z",
      reason: "before-write",
      restorable: true,
      redacted: true,
    },
  ],
  update: {
    currentRef: "0.4.0-beta.2",
    targetRef: "0.4.0-beta.2",
    targetVersion: "0.4.0-beta.2",
    requiresBackup: true,
    healthGate: true,
    rollbackRef: "fixture-previous",
    status: "current",
    notes: ["Fixture state; real checkout is not modified."],
  },
  diagnostics: [],
};

function buildDiagnostics(): DiagnosticItem[] {
  const engineer = resolveModelBinding(
    DEFAULT_BINDINGS.engineer,
    snapshot.models,
  );
  return [
    {
      id: "codex",
      category: "codex",
      label: "Codex binary",
      status: "healthy",
      value: snapshot.codex.version ?? "not found",
      detail:
        snapshot.codex.source === "fixture"
          ? "Fixture-backed detection; native command was not executed."
          : "Detected read-only.",
      redacted: true,
    },
    {
      id: "login",
      category: "codex",
      label: "Native login",
      status: snapshot.codex.login === "configured" ? "healthy" : "unknown",
      value: snapshot.codex.login,
      detail:
        "Orchestra never reads the credential; use Codex login status locally.",
      redacted: true,
    },
    {
      id: "router",
      category: "router",
      label: "Router service",
      status: snapshot.router.health,
      value: `${snapshot.router.service} · 127.0.0.1`,
      detail: "Loopback-only fixture service with pinned version.",
      redacted: true,
    },
    {
      id: "kimi",
      category: "provider",
      label: "Kimi credential",
      status:
        snapshot.providers[0].credential === "configured"
          ? "healthy"
          : "missing",
      value: snapshot.providers[0].credential,
      detail: "Credential source is intentionally not displayed.",
      redacted: true,
    },
    {
      id: "grok",
      category: "provider",
      label: "xAI credential",
      status:
        snapshot.providers[1].credential === "configured"
          ? "healthy"
          : "missing",
      value: snapshot.providers[1].credential,
      detail: "Credential source is intentionally not displayed.",
      redacted: true,
    },
    {
      id: "grok-model",
      category: "model",
      label: "Engineer binding",
      status: engineer.resolved ? "degraded" : "missing",
      value: engineer.model?.id ?? "grok-api/grok-4.6",
      detail: engineer.needsCuration
        ? "Target model is not in the fixture registry; curation is required."
        : "Resolved against catalog.",
      redacted: true,
    },
    {
      id: "agents",
      category: "agent",
      label: "Native subagent mode",
      status: "unknown",
      value: "live check pending",
      detail: "Catalog support is not proof of tool-driven agent behavior.",
      redacted: true,
    },
    {
      id: "ports",
      category: "network",
      label: "Router ports",
      status: "healthy",
      value: snapshot.router.ports.join(", "),
      detail: "Expected local ports; no LAN binding.",
      redacted: true,
    },
  ];
}

snapshot.diagnostics = buildDiagnostics();

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export async function mockInvoke<T>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  await new Promise((resolve) =>
    setTimeout(resolve, command === "run_health_check" ? 420 : 90),
  );
  if (command === "get_snapshot") return clone(snapshot) as T;
  if (command === "run_health_check") {
    const checks = snapshot.diagnostics.map((item) => ({
      id: item.id,
      label: item.label,
      status: item.status,
      detail: item.detail,
      remediation:
        item.status === "missing"
          ? "Configure locally through the Router helper, then rerun."
          : undefined,
      checkedAt: now(),
      sensitive: item.redacted,
    }));
    const report: HealthReport = {
      id: `health-${Date.now()}`,
      status: checks.some((check) => check.status === "unhealthy")
        ? "unhealthy"
        : checks.some((check) => check.status === "missing")
          ? "degraded"
          : "healthy",
      startedAt: new Date(Date.now() - 420).toISOString(),
      completedAt: now(),
      checks,
      redacted: true,
    };
    snapshot.health = report;
    snapshot.diagnostics = buildDiagnostics();
    return clone(report) as T;
  }
  if (command === "router_operation") {
    const operation = args.operation as RouterOperation;
    if (operation === "update-check") return clone(snapshot.update) as T;
    if (operation === "update") {
      snapshot.backups.unshift({
        id: `backup-${Date.now()}`,
        target: "router-checkout",
        createdAt: now(),
        reason: "before-update",
        restorable: true,
        redacted: true,
      });
      snapshot.update = {
        ...snapshot.update,
        status: "current",
        notes: ["Update is health-gated and backed up."],
      };
      return clone({
        ok: true,
        message:
          "Update plan staged; native Tauri execution is required to mutate the managed checkout.",
      }) as T;
    }
    if (operation === "rollback")
      return clone({
        ok: true,
        message:
          "Rollback plan ready; no real checkout was modified in fixture mode.",
      }) as T;
    return clone({
      ok: true,
      operation,
      output:
        operation === "doctor"
          ? "PASS fixture doctor"
          : "fixture output redacted",
    }) as T;
  }
  if (command === "managed_preview") {
    const block = renderManagedBlock(snapshot.agents, [
      "package.json",
      "packages/contracts/**",
      "templates/**",
    ]);
    const preview = managedConfigPreview(
      String(args.path ?? "AGENTS.md"),
      String(args.existing ?? "# Project rules\n"),
      block,
    );
    return [
      preview.file,
      {
        path: ".codex/skills/orchestra-routing/SKILL.md",
        action: "create",
        diff: "create generated routing skill",
        safe: true,
      },
    ] as T;
  }
  if (command === "apply_managed_changes") {
    snapshot.backups.unshift({
      id: `backup-${Date.now()}`,
      target: "AGENTS.md",
      createdAt: now(),
      reason: "before-write",
      restorable: true,
      redacted: true,
    });
    return clone({
      ok: true,
      message:
        "Managed files applied in fixture mode; real file write requires Tauri.",
    }) as T;
  }
  if (command === "add_project") {
    const path = String(args.path ?? "").trim();
    const profile: ProjectProfile = {
      id: `project-${Date.now()}`,
      name: path.split(/[\\/]/).filter(Boolean).pop() ?? "Local project",
      path: path || "C:\\Workspace\\sample-project",
      stack: ["Node.js", "React"],
      activeTeam: "default",
      ownership: {
        root: ["package.json", "types/**"],
        frontend: ["src/**", "components/**"],
        engineer: ["server/**", "tests/**"],
      },
      sharedPaths: ["package.json", "types/**"],
      routingPolicy: "sequential-on-overlap",
      knownTests: ["npm test"],
      lintScript: "npm run lint",
      typecheckScript: "npm run typecheck",
      status: "unknown",
      usageEventCount: 0,
    };
    snapshot.projects = [
      ...snapshot.projects.filter((project) => project.path !== profile.path),
      profile,
    ];
    return clone(profile) as T;
  }
  if (command === "scope_plan") {
    const plan: ScopePlan = planScopes(
      (args.assignments ?? {
        root: ["package.json"],
        frontend: ["src/**"],
        engineer: ["server/**"],
      }) as ScopePlan["assignments"],
      (args.sharedPaths ?? ["package.json"]) as string[],
    );
    return clone(plan) as T;
  }
  if (command === "live_check_preview") {
    const preview: LiveCheckPreview = {
      provider: String(args.provider ?? "kimi-api"),
      model: String(args.model ?? "kimi-api/kimi-k3"),
      test: (args.test as LiveCheckPreview["test"]) ?? "tool-use",
      estimatedCostNote:
        "Puede consumir cuota del proveedor; no se ejecuta sin confirmación local.",
      requiresConfirmation: true,
    };
    return preview as T;
  }
  if (command === "export_support_bundle")
    return clone({
      appVersion: snapshot.appVersion,
      codex: snapshot.codex,
      router: snapshot.router,
      providers: snapshot.providers.map(
        ({ id, name, family, credential, enabled }) => ({
          id,
          name,
          family,
          credential,
          enabled,
        }),
      ),
      diagnostics: snapshot.diagnostics,
      createdAt: now(),
      privacy: "redacted; prompts and credential values excluded",
    }) as T;
  return clone(snapshot) as T;
}
