import type {
  AgentDefinition,
  DiagnosticItem,
  HealthReport,
  LiveCheckPreview,
  OrchestraSnapshot,
  PreviewFile,
  ProjectProfile,
  RouterHealthResult,
  RouterLogsResult,
  RouterOperation,
  RouterRestartResult,
  ScopePlan,
  WorktreeStatus,
} from "@codex-orchestra/contracts";
import {
  DEFAULT_BINDINGS,
  DEFAULT_FRONTEND_STRATEGY,
  DEFAULT_PRICING_RULES,
  FRONTEND_MODEL_CANDIDATES,
  managedConfigPreview,
  planScopes,
  renderManagedBlock,
  resolveModelBinding,
  resolveFrontendModelStrategy,
} from "@codex-orchestra/contracts";

const now = () => new Date().toISOString();

function pricingToken(rules: unknown[]) {
  let hash = 0x811c9dc5;
  for (const character of JSON.stringify(rules)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function previewPricingRules(rules: unknown[]) {
  if (rules.length === 0 || rules.length > 100)
    throw new Error("Provide between 1 and 100 pricing rules");
  const allowedHosts: Record<string, string[]> = {
    "qwen-plan": ["alibabacloud.com", "aliyun.com"],
    "opencode-go": ["opencode.ai"],
    "kimi-api": ["moonshot.ai"],
    "grok-api": ["x.ai"],
    "grok-oauth": ["x.ai"],
    openai: ["openai.com"],
  };
  const identities = new Set<string>();
  const providers = new Set<string>();
  const versions = new Set<string>();
  const effective: string[] = [];
  let subscriptionRules = 0;
  for (const raw of rules) {
    if (!raw || typeof raw !== "object")
      throw new Error("Pricing rule must be an object");
    const rule = raw as Record<string, unknown>;
    const provider = String(rule.provider ?? "");
    const model = String(rule.model ?? "");
    const version = String(rule.version ?? "");
    const effectiveFrom = String(rule.effectiveFrom ?? "");
    if (!allowedHosts[provider] || !model.startsWith(`${provider}/`))
      throw new Error("Pricing rule provider and model do not match");
    if (!/^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(effectiveFrom))
      throw new Error("Pricing rule effectiveFrom must be UTC RFC3339 seconds");
    const source = new URL(String(rule.sourceUrl ?? ""));
    if (
      source.protocol !== "https:" ||
      !allowedHosts[provider].some(
        (domain) =>
          source.hostname === domain || source.hostname.endsWith(`.${domain}`),
      )
    )
      throw new Error(
        "Pricing rule sourceUrl is not an approved official provider domain",
      );
    if (!String(rule.sourceLabel ?? "").trim())
      throw new Error("Pricing rule sourceLabel is required");
    const billingType = String(rule.billingType ?? "payg");
    if (billingType === "subscription") {
      subscriptionRules += 1;
      if (
        [
          rule.inputPerMillion,
          rule.cachedInputPerMillion,
          rule.outputPerMillion,
        ].some((value) => Number(value) !== 0)
      )
        throw new Error(
          "Subscription pricing rules cannot invent per-token charges",
        );
    }
    const identity = `${model}\0${version}\0${effectiveFrom}`;
    if (identities.has(identity))
      throw new Error(
        "Pricing import contains a duplicate model/version/effectiveFrom",
      );
    identities.add(identity);
    providers.add(provider);
    versions.add(version);
    effective.push(effectiveFrom);
  }
  effective.sort();
  return {
    token: pricingToken(rules),
    count: rules.length,
    providers: [...providers].sort(),
    versions: [...versions].sort(),
    effectiveFrom: effective.at(0) ?? "",
    effectiveTo: effective.at(-1) ?? "",
    subscriptionRules,
    paygRules: rules.length - subscriptionRules,
    writesCredentialValues: false,
  };
}

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
    name: "Frontend / Model binding",
    role: "frontend",
    description: "Logical frontend role resolved from the selected strategy.",
    providerId: "qwen-plan",
    modelId: "qwen-plan/qwen3.8-max",
    modelTarget: { provider: "qwen-plan", upstreamModel: "qwen3.8-max" },
    reasoningEffort: "high",
    permissions: ["workspace-write"],
    routingHints: ["visual fidelity", "responsive", "a11y"],
    retryLimit: 1,
    ownershipPaths: ["app/**", "src/**", "components/**", "styles/**"],
    sharedPaths: [],
    health: "degraded",
    lastTest: "live check pending",
    estimatedCostPerMillion: 0,
  },
  {
    id: "engineer",
    name: "Grok / Engineer",
    role: "engineer",
    description: "Backend, integration, debugging and test specialist.",
    providerId: "grok-oauth",
    modelId: "grok-oauth/grok-4.6",
    reasoningEffort: "high",
    permissions: ["workspace-write"],
    routingHints: ["contracts first", "tests", "bounded scope"],
    retryLimit: 1,
    ownershipPaths: ["server/**", "api/**", "db/**", "tests/**"],
    sharedPaths: [],
    health: "missing",
    lastTest: "Grok OAuth login pending",
    estimatedCostPerMillion: 0,
  },
];

let snapshot: OrchestraSnapshot = {
  appVersion: "0.1.0",
  codex: {
    detected: true,
    executable: "fixture://codex",
    version: "fixture",
    home: "%USERPROFILE%\\.codex",
    configPath: "%USERPROFILE%\\.codex\\config.toml",
    configDetected: true,
    configHealth: "healthy",
    login: "unknown",
    nativeModelsAvailable: false,
    source: "fixture",
  },
  router: {
    detected: true,
    root: "%LOCALAPPDATA%\\CodexOrchestra\\engine\\codex-router",
    version: "0.4.0-beta.3",
    pinnedRef: "a1be46aa02426d87a9e24e114ce8c22619c63c7a",
    health: "healthy",
    ports: [4200, 4201, 4202, 4203],
    service: "running",
    runtime: {
      detected: true,
      healthy: true,
      service: "running",
      ports: [4200, 4201, 4202, 4203],
      identityOk: true,
      message: "Router healthy",
      canRestart: true,
      requiresConfirmation: false,
      activeExecution: false,
    },
  },
  providers: [
    {
      id: "qwen-plan",
      name: "Qwen / Alibaba Token Plan",
      family: "other",
      credential: "configured",
      enabled: true,
      billingType: "subscription",
      billingNote:
        "Alibaba Model Studio Token Plan; credential stays in Router secure storage",
      baseUrl:
        "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
      lastChecked: now(),
    },
    {
      id: "kimi-api",
      name: "Kimi Platform",
      family: "kimi",
      credential: "missing",
      enabled: true,
      billingType: "payg",
      billingNote: "API key entered through Router helper",
      lastChecked: now(),
    },
    {
      id: "opencode-go",
      name: "OpenCode Go / Kimi K3",
      family: "other",
      credential: "configured",
      enabled: true,
      billingType: "subscription",
      billingNote:
        "OpenCode Go subscription; Orchestra selects only Go models and never falls back to Zen/PAYG",
      baseUrl: "https://opencode.ai/zen/go/v1",
      lastChecked: now(),
    },
    {
      id: "grok-oauth",
      name: "Grok / SuperGrok OAuth",
      family: "xai",
      credential: "missing",
      enabled: true,
      billingType: "subscription",
      billingNote: "SuperGrok via official Grok CLI OAuth",
      lastChecked: now(),
    },
    {
      id: "grok-api",
      name: "xAI",
      family: "xai",
      credential: "missing",
      enabled: true,
      billingType: "payg",
      billingNote: "API key entered through Router helper",
      lastChecked: now(),
    },
    {
      id: "openai",
      name: "Codex native",
      family: "openai",
      credential: "unknown",
      enabled: true,
      billingType: "native",
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
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      source: "native",
    },
    {
      id: "gpt-5.6-luna",
      label: "GPT-5.6 Luna",
      providerId: "openai",
      available: true,
      supportsStreaming: true,
      supportsTools: true,
      supportsSubagents: true,
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      source: "native",
    },
    {
      id: "gpt-5.6-terra",
      label: "GPT-5.6 Terra",
      providerId: "openai",
      available: true,
      supportsStreaming: true,
      supportsTools: true,
      supportsSubagents: true,
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      source: "native",
    },
    {
      id: "qwen-plan/qwen3.8-max",
      label: "Qwen3.8 Max (Plan)",
      providerId: "qwen-plan",
      available: true,
      supportsStreaming: true,
      supportsTools: true,
      supportsSubagents: true,
      reasoningEfforts: ["high"],
      source: "fixture",
      contextWindow: 262144,
      autoCompactionThreshold: 235000,
      upstreamModel: "qwen3.8-max",
    },
    {
      id: "opencode-go/kimi-k3",
      label: "Kimi K3 via OpenCode Go",
      providerId: "opencode-go",
      available: true,
      supportsStreaming: true,
      supportsTools: true,
      supportsSubagents: true,
      reasoningEfforts: ["high", "max"],
      source: "fixture",
      contextWindow: 256000,
      autoCompactionThreshold: 230000,
      upstreamModel: "kimi-k3",
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
      id: "grok-api/grok-4.6",
      label: "Grok 4.6",
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
  frontendStrategy: DEFAULT_FRONTEND_STRATEGY,
  projects: [],
  usage: [
    {
      id: "usage-1",
      timestamp: "2026-08-12T09:12:00Z",
      provider: "opencode-go",
      model: "opencode-go/kimi-k3",
      role: "frontend",
      inputTokens: 48200,
      cachedInputTokens: 12000,
      outputTokens: 9200,
      source: "router",
      providerCost: 0,
    },
    {
      id: "usage-2",
      timestamp: "2026-08-12T10:18:00Z",
      provider: "grok-api",
      model: "grok-api/grok-4.6",
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
    currentRef: "a1be46aa02426d87a9e24e114ce8c22619c63c7a",
    targetRef: "a1be46aa02426d87a9e24e114ce8c22619c63c7a",
    targetVersion: "0.4.0-beta.3",
    requiresBackup: true,
    healthGate: true,
    rollbackRef: "fixture-previous",
    status: "current",
    notes: ["Fixture state; real checkout is not modified."],
  },
  diagnostics: [],
  healthHistory: [],
  pricingRules: DEFAULT_PRICING_RULES,
  delegationEvidence: [],
  logs: [],
  featureFlags: {
    appServer: false,
    mcp: false,
    experimentalWorktrees: false,
  },
};

let mockWorktrees: WorktreeStatus[] = [];

function requireRegisteredProject(projectPath: string) {
  const registered = snapshot.projects.some(
    (project) => project.path === projectPath,
  );
  if (!registered) {
    throw new Error("Project path is not a registered Orchestra project");
  }
}

function buildDiagnostics(): DiagnosticItem[] {
  const qwen = snapshot.providers.find(
    (provider) => provider.id === "qwen-plan",
  );
  const kimi = snapshot.providers.find(
    (provider) => provider.id === "kimi-api",
  );
  const opencode = snapshot.providers.find(
    (provider) => provider.id === "opencode-go",
  );
  const grok = snapshot.providers.find(
    (provider) => provider.id === "grok-oauth",
  );
  const frontend = snapshot.agents.find((agent) => agent.role === "frontend");
  const frontendModel = snapshot.models.find(
    (model) => model.id === frontend?.modelId,
  );
  const frontendResolution = resolveFrontendModelStrategy(
    snapshot.frontendStrategy ?? DEFAULT_FRONTEND_STRATEGY,
    snapshot.models,
  );
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
      id: "qwen-plan",
      category: "provider",
      label: "Qwen Token Plan credential",
      status:
        qwen?.credential === "configured"
          ? "healthy"
          : qwen?.credential === "missing"
            ? "missing"
            : "unknown",
      value: qwen?.credential ?? "unknown",
      detail:
        "Alibaba plan credential status only; the credential value stays in Router secure storage.",
      redacted: true,
    },
    {
      id: "kimi",
      category: "provider",
      label: "Kimi credential",
      status: kimi?.credential === "configured" ? "healthy" : "missing",
      value: kimi?.credential ?? "unknown",
      detail: "Credential source is intentionally not displayed.",
      redacted: true,
    },
    {
      id: "grok",
      category: "provider",
      label: "xAI credential",
      status: grok?.credential === "configured" ? "healthy" : "missing",
      value: grok?.credential ?? "unknown",
      detail: "Credential source is intentionally not displayed.",
      redacted: true,
    },
    {
      id: "opencode-go",
      category: "provider",
      label: "OpenCode Go credential",
      status:
        opencode?.credential === "configured"
          ? "healthy"
          : opencode?.credential === "missing"
            ? "missing"
            : "unknown",
      value: `opencode-go · ${opencode?.baseUrl ?? "base URL unknown"}`,
      detail:
        "Subscription-backed Go route; Zen/PAYG is never selected as fallback and the key value is never read.",
      redacted: true,
    },
    {
      id: "frontend-candidates",
      category: "agent",
      label: "Frontend candidates",
      status: frontendResolution.status,
      value: `${frontendResolution.candidates.filter((entry) => entry.resolved).length}/${FRONTEND_MODEL_CANDIDATES.length} ready`,
      detail:
        "AUTO prefers Qwen for general work and Kimi for visual work; no PAYG fallback is automatic.",
      redacted: true,
    },
    {
      id: "opencode-go-model",
      category: "model",
      label: "OpenCode Go model metadata",
      status: frontendModel?.available ? "healthy" : "missing",
      value: `${frontend?.modelId ?? "unresolved"} · upstream ${frontendModel?.upstreamModel ?? "catalog pending"} · context ${frontendModel?.contextWindow ?? "catalog pending"}`,
      detail:
        "Resolved slug, upstream model and compaction metadata come from the current Router catalog; no 1M claim is hardcoded.",
      redacted: true,
    },
    {
      id: "grok-model",
      category: "model",
      label: "Engineer binding",
      status: engineer.resolved ? "degraded" : "missing",
      value: engineer.model?.id ?? "grok-oauth/grok-4.6",
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
      id: "tool-calling",
      category: "agent",
      label: "Tool calling",
      status: "unknown",
      value: "live check pending",
      detail: "Requires an explicit paid compatibility run.",
      redacted: true,
    },
    {
      id: "compaction",
      category: "agent",
      label: "Compaction / replay",
      status: "unknown",
      value: "not executed",
      detail: "Router-owned capability; not inferred from catalog metadata.",
      redacted: true,
    },
    {
      id: "agent-definitions",
      category: "agent",
      label: "Generated agent definitions",
      status: "healthy",
      value: `${snapshot.agents.length} role definitions`,
      detail:
        "Allow-listed generated files are behind preview and confirmation.",
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
    {
      id: "process",
      category: "process",
      label: "Router process",
      status: snapshot.router.health,
      value: `${snapshot.router.service} · ${snapshot.router.ports.length} port(s)`,
      detail: "Fixture loopback state; no process watcher is installed.",
      redacted: true,
    },
    {
      id: "config",
      category: "config",
      label: "Local config state",
      status: "healthy",
      value: "SQLite + managed files",
      detail: "Managed markers, backups and atomic replacement are enabled.",
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
  if (command === "get_snapshot" || command === "get_snapshot_fast") {
    return clone(snapshot) as T;
  }
  if (command === "start_codex_execution") {
    if (!snapshot.featureFlags?.appServer) {
      throw new Error(
        "Enable App Server in Settings before running a Codex task",
      );
    }
    return clone({
      threadId: `fixture-thread-${Date.now()}`,
      turnId: `fixture-turn-${Date.now()}`,
      evidenceRunId: `fixture-run-${Date.now()}`,
      status: "inProgress",
      redacted: true,
    }) as T;
  }
  if (
    command === "steer_codex_execution" ||
    command === "interrupt_codex_execution" ||
    command === "resolve_codex_approval" ||
    command === "close_codex_execution"
  ) {
    return clone({ accepted: true, redacted: true }) as T;
  }
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
    snapshot.healthHistory = [
      report,
      ...(snapshot.healthHistory ?? []).filter((item) => item.id !== report.id),
    ].slice(0, 20);
    snapshot.diagnostics = buildDiagnostics();
    return clone(report) as T;
  }
  if (
    command === "router_runtime_status" ||
    command === "router_runtime_health"
  ) {
    const healthy = snapshot.router.service === "running";
    const result: RouterHealthResult = {
      ok: true,
      healthy,
      service: snapshot.router.service,
      ports: snapshot.router.ports,
      identityOk: healthy,
      issue: healthy ? undefined : "offline",
      message: healthy
        ? "Router healthy"
        : "Router offline — Codex model requests may fail.",
      canRestart: true,
      requiresConfirmation: false,
      activeExecution: false,
      redacted: true,
    };
    snapshot.router.runtime = {
      detected: snapshot.router.detected,
      healthy: result.healthy,
      service: result.service,
      ports: result.ports,
      identityOk: result.identityOk,
      issue: result.issue,
      message: result.message,
      canRestart: result.canRestart,
      requiresConfirmation: result.requiresConfirmation,
      activeExecution: result.activeExecution,
    };
    snapshot.router.health = healthy ? "healthy" : "unhealthy";
    return clone(result) as T;
  }
  if (
    command === "router_runtime_start" ||
    command === "router_runtime_restart"
  ) {
    if (args.confirm !== true) {
      throw new Error("Router process recovery requires explicit confirmation");
    }
    snapshot.router.service = "running";
    snapshot.router.health = "healthy";
    snapshot.router.ports = [4200, 4201, 4202, 4203];
    snapshot.router.runtime = {
      detected: true,
      healthy: true,
      service: "running",
      ports: snapshot.router.ports,
      identityOk: true,
      message: "Router healthy",
      canRestart: true,
      requiresConfirmation: false,
      activeExecution: false,
    };
    const health: RouterHealthResult = {
      ok: true,
      healthy: true,
      service: "running",
      ports: snapshot.router.ports,
      identityOk: true,
      message: "Router healthy",
      canRestart: true,
      requiresConfirmation: false,
      activeExecution: false,
      redacted: true,
    };
    const result: RouterRestartResult = {
      ok: true,
      restarted: true,
      phase: "restored",
      message: "Router restarted successfully",
      health,
      logsAvailable: true,
      redacted: true,
    };
    return clone(result) as T;
  }
  if (command === "router_runtime_logs") {
    const result: RouterLogsResult = {
      ok: true,
      available: true,
      lines: [
        {
          source: "router.out",
          text: "[codex-router] listening on 127.0.0.1:4202",
        },
        { source: "router.err", text: "[gateway] health ok" },
      ],
      message: "Latest redacted Router process lines.",
      redacted: true,
    };
    return clone(result) as T;
  }
  if (command === "router_operation") {
    const operation = args.operation as RouterOperation;
    if (operation === "refresh-catalog" && args.confirm !== true) {
      throw new Error("Mutation requires explicit confirmation");
    }
    if (operation === "update-check") return clone(snapshot.update) as T;
    if (operation === "update") {
      return clone({
        ok: true,
        message:
          "Managed Router already matches the reviewed pin; no update was applied in fixture mode.",
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
        path: ".codex/agents/orchestra_frontend.toml",
        action: "create",
        diff: "generated frontend agent",
        safe: true,
      },
      {
        path: ".codex/agents/orchestra_engineer.toml",
        action: "create",
        diff: "generated engineer agent",
        safe: true,
      },
      {
        path: ".codex/agents/orchestra_visual.toml",
        action: "create",
        diff: "generated visual agent",
        safe: true,
      },
      {
        path: ".codex/skills/orchestra-routing/SKILL.md",
        action: "create",
        diff: "generated routing skill",
        safe: true,
      },
      {
        path: ".codex/config.toml",
        action: "create",
        diff: "bounded native subagent concurrency",
        safe: true,
      },
    ] as T;
  }
  if (command === "apply_managed_changes") {
    if (typeof args.expectedCurrentHash !== "string") {
      throw new Error(
        "Review the current managed preview before applying changes",
      );
    }
    const files = (args.files as Array<{ path?: string }> | undefined) ?? [];
    const backups = ["AGENTS.md", ...files.map((file) => file.path ?? "")]
      .filter(Boolean)
      .map((target, index) => {
        const id = `backup-${Date.now()}-${index}`;
        snapshot.backups.unshift({
          id,
          target,
          createdAt: now(),
          reason: "before-write",
          restorable: true,
          redacted: true,
        });
        return { target };
      });
    return clone({
      ok: true,
      backups,
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
  if (command === "update_project_profile") {
    const projectId = String(args.projectId ?? "");
    const current = snapshot.projects.find(
      (project) => project.id === projectId,
    );
    if (!current) throw new Error("Project profile was not found");
    const ownership = args.ownership as Record<string, unknown>;
    const toPaths = (value: unknown) =>
      Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
    const updated: ProjectProfile = {
      ...current,
      ownership: {
        root: toPaths(ownership.root),
        frontend: toPaths(ownership.frontend),
        engineer: toPaths(ownership.engineer),
      },
      sharedPaths: toPaths(args.sharedPaths),
      activeTeam:
        typeof args.activeTeam === "string" && args.activeTeam.trim()
          ? args.activeTeam.trim()
          : current.activeTeam,
      routingPolicy:
        args.routingPolicy === "safe-disjoint-only"
          ? "safe-disjoint-only"
          : "sequential-on-overlap",
      knownTests: toPaths(args.knownTests ?? current.knownTests),
      lintScript:
        typeof args.lintScript === "string" && args.lintScript.trim()
          ? args.lintScript.trim()
          : undefined,
      typecheckScript:
        typeof args.typecheckScript === "string" && args.typecheckScript.trim()
          ? args.typecheckScript.trim()
          : undefined,
    };
    snapshot.projects = snapshot.projects.map((project) =>
      project.id === projectId ? updated : project,
    );
    return clone(updated) as T;
  }
  if (command === "update_agent_definition") {
    const candidate = args.agent as AgentDefinition;
    const expectedProvider: Record<string, string> = {
      root: "openai",
      frontend: "qwen-plan",
      engineer: "grok-oauth",
    };
    if (
      !candidate ||
      candidate.id !== candidate.role ||
      (candidate.role === "engineer"
        ? !["grok-oauth", "grok-api"].includes(candidate.providerId)
        : candidate.role === "frontend"
          ? !["qwen-plan", "opencode-go"].includes(candidate.providerId)
          : expectedProvider[candidate.role] !== candidate.providerId) ||
      !candidate.modelId?.startsWith(
        candidate.role === "root" ? "gpt-" : `${candidate.providerId}/`,
      ) ||
      candidate.retryLimit < 0 ||
      candidate.retryLimit > 1
    ) {
      throw new Error("Agent definition is invalid");
    }
    const current = snapshot.agents.find((item) => item.id === candidate.id);
    if (!current) throw new Error("Agent definition was not found");
    const updated: AgentDefinition = {
      ...candidate,
      health: current.health,
      lastTest: current.lastTest,
    };
    snapshot.agents = snapshot.agents.map((agent) =>
      agent.id === updated.id ? updated : agent,
    );
    return clone(updated) as T;
  }
  if (command === "save_frontend_strategy") {
    const strategy = args.strategy as OrchestraSnapshot["frontendStrategy"];
    if (!strategy || !["auto", "pinned"].includes(strategy.mode)) {
      throw new Error("Frontend strategy is invalid");
    }
    const resolution = resolveFrontendModelStrategy(strategy, snapshot.models);
    if (strategy.mode === "pinned" && !resolution.selectedModel) {
      throw new Error(
        "The selected frontend provider or model is unavailable; no fallback was applied",
      );
    }
    const current = snapshot.agents.find((agent) => agent.role === "frontend");
    if (!current) throw new Error("Frontend role was not found");
    const selected = resolution.selectedCandidate;
    const updated: AgentDefinition = {
      ...current,
      providerId: selected?.provider ?? current.providerId,
      modelId: resolution.selectedModel?.id ?? current.modelId,
      modelTarget: selected
        ? { provider: selected.provider, upstreamModel: selected.upstreamModel }
        : current.modelTarget,
      reasoningEffort: selected?.reasoningEffort ?? current.reasoningEffort,
      name: "Frontend / Model binding",
    };
    snapshot.frontendStrategy = clone(strategy);
    snapshot.agents = snapshot.agents.map((agent) =>
      agent.role === "frontend" ? updated : agent,
    );
    snapshot.diagnostics = buildDiagnostics();
    return clone(updated) as T;
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
  if (command === "worktree_preview") {
    const projectPath = String(
      args.projectPath ?? "C:\\Workspace\\sample-project",
    );
    requireRegisteredProject(projectPath);
    const role = String(args.role ?? "frontend");
    const slug = String(args.slug ?? "fixture");
    return clone({
      ok: true,
      role,
      slug,
      projectRoot: projectPath,
      target: `${projectPath}\\.codex-orchestra\\worktrees\\${role}-${slug}`,
      command: "git worktree add --detach <target> HEAD",
      requiresConfirmation: true,
      experimental: true,
      merge: "manual review only",
      fixture: true,
    }) as T;
  }
  if (command === "create_worktree") {
    if (args.confirm !== true) {
      throw new Error("Creating a worktree requires explicit confirmation");
    }
    if (!snapshot.featureFlags?.experimentalWorktrees) {
      throw new Error(
        "Experimental worktrees are disabled in local feature flags",
      );
    }
    const projectPath = String(
      args.projectPath ?? "C:\\Workspace\\sample-project",
    );
    requireRegisteredProject(projectPath);
    const role = String(args.role ?? "frontend");
    const slug = String(args.slug ?? "fixture");
    const worktree: WorktreeStatus = {
      ok: true,
      role: role as WorktreeStatus["role"],
      slug,
      target: `${projectPath}\\.codex-orchestra\\worktrees\\${role}-${slug}`,
      projectRoot: projectPath,
      state: "active",
      recorded: true,
      dirty: false,
      commitsAhead: 0,
      changedFiles: [],
      canRemoveSafely: true,
      requiresManualMerge: false,
      merge: "manual review only",
      redacted: true,
    };
    mockWorktrees = [
      worktree,
      ...mockWorktrees.filter((item) => item.target !== worktree.target),
    ];
    return clone({ ...worktree, detached: true, fixture: true }) as T;
  }
  if (command === "list_worktrees") {
    const projectPath = String(args.projectPath ?? "");
    requireRegisteredProject(projectPath);
    return clone(
      mockWorktrees.filter((item) => item.projectRoot === projectPath),
    ) as T;
  }
  if (command === "worktree_status") {
    const projectPath = String(args.projectPath ?? "");
    if (projectPath) requireRegisteredProject(projectPath);
    const role = String(args.role ?? "frontend");
    const slug = String(args.slug ?? "fixture");
    const found = mockWorktrees.find(
      (item) => item.role === role && item.slug === slug,
    );
    if (!found) {
      throw new Error("Managed worktree was not found");
    }
    return clone(found) as T;
  }
  if (command === "remove_worktree") {
    if (args.confirm !== true) {
      throw new Error("Removing a worktree requires explicit confirmation");
    }
    const projectPath = String(args.projectPath ?? "");
    if (projectPath) requireRegisteredProject(projectPath);
    const role = String(args.role ?? "frontend");
    const slug = String(args.slug ?? "fixture");
    const found = mockWorktrees.find(
      (item) => item.role === role && item.slug === slug,
    );
    if (!found) throw new Error("Managed worktree was not found");
    if (found.requiresManualMerge && args.force !== true) {
      throw new Error("Worktree contains changes");
    }
    mockWorktrees = mockWorktrees.filter((item) => item !== found);
    return clone({
      ok: true,
      removed: true,
      recoveryPath: found.requiresManualMerge
        ? "D:\\Mock\\backups\\worktrees\\fixture"
        : undefined,
    }) as T;
  }
  if (command === "get_pricing_rules") {
    return clone(snapshot.pricingRules ?? DEFAULT_PRICING_RULES) as T;
  }
  if (command === "preview_pricing_rules") {
    const rules = args.rules;
    if (!Array.isArray(rules))
      throw new Error("Pricing JSON must be an array of rules");
    return clone(previewPricingRules(rules)) as T;
  }
  if (command === "save_pricing_rules") {
    if (args.confirm !== true) {
      throw new Error("Saving pricing rules requires explicit confirmation");
    }
    const rules = args.rules;
    if (!Array.isArray(rules) || rules.length === 0 || rules.length > 100) {
      throw new Error("Provide between 1 and 100 pricing rules");
    }
    const preview = previewPricingRules(rules);
    if (args.previewToken !== preview.token)
      throw new Error("Pricing rules changed after preview; review them again");
    snapshot.pricingRules = clone(rules) as typeof snapshot.pricingRules;
    return clone({
      ok: true,
      count: rules.length,
      previewToken: preview.token,
    }) as T;
  }
  if (command === "save_feature_flags") {
    if (
      args.confirm !== true ||
      !args.flags ||
      typeof args.flags !== "object"
    ) {
      throw new Error(
        "Saving feature flags requires an object and confirmation",
      );
    }
    snapshot.featureFlags = {
      appServer: (args.flags as Record<string, unknown>).appServer === true,
      mcp: (args.flags as Record<string, unknown>).mcp === true,
      experimentalWorktrees:
        (args.flags as Record<string, unknown>).experimentalWorktrees === true,
    };
    return clone({ ok: true, featureFlags: snapshot.featureFlags }) as T;
  }
  if (command === "export_profile") {
    return clone({
      schemaVersion: 1,
      exportedAt: now(),
      privacy:
        "profile only; credential values, prompts and response bodies excluded",
      budget: snapshot.budget,
      pricingRules: snapshot.pricingRules ?? DEFAULT_PRICING_RULES,
      featureFlags: snapshot.featureFlags,
      frontendStrategy: snapshot.frontendStrategy,
      projects: snapshot.projects,
      agents: snapshot.agents,
    }) as T;
  }
  if (command === "import_profile") {
    if (
      args.confirm !== true ||
      !args.payload ||
      typeof args.payload !== "object"
    ) {
      throw new Error(
        "Importing a profile requires an object and confirmation",
      );
    }
    const payload = args.payload as Record<string, unknown>;
    if (payload.budget)
      snapshot.budget = payload.budget as typeof snapshot.budget;
    if (Array.isArray(payload.pricingRules)) {
      snapshot.pricingRules =
        payload.pricingRules as typeof snapshot.pricingRules;
    }
    if (payload.featureFlags) {
      snapshot.featureFlags =
        payload.featureFlags as typeof snapshot.featureFlags;
    }
    if (payload.frontendStrategy) {
      const strategy =
        payload.frontendStrategy as OrchestraSnapshot["frontendStrategy"];
      if (!strategy || !["auto", "pinned"].includes(strategy.mode)) {
        throw new Error("Frontend strategy is invalid");
      }
      snapshot.frontendStrategy = clone(strategy);
    }
    if (Array.isArray(payload.agents) && payload.agents.length === 3) {
      snapshot.agents = payload.agents as AgentDefinition[];
    }
    let importedProjects = 0;
    if (Array.isArray(payload.projects)) {
      const profiles = payload.projects.filter(
        (project): project is ProjectProfile =>
          Boolean(project) &&
          typeof project === "object" &&
          typeof (project as ProjectProfile).id === "string" &&
          typeof (project as ProjectProfile).path === "string",
      );
      snapshot.projects = profiles.map((project) => clone(project));
      importedProjects = profiles.length;
    }
    return clone({
      ok: true,
      imported: [
        "budget",
        "pricingRules",
        "featureFlags",
        "frontendStrategy",
        "agents",
      ],
      importedProjects,
      skippedProjects: 0,
      projectPaths: "fixture profiles re-registered locally",
    }) as T;
  }
  if (command === "live_check_preview") {
    const test =
      args.test === "agent-behavior" ? "agent-behavior" : "compatibility";
    const provider = String(args.provider ?? "qwen-plan");
    const billing =
      provider === "qwen-plan"
        ? ["subscription", "Alibaba/Qwen Token Plan allowance"]
        : provider === "opencode-go"
          ? ["subscription", "OpenCode Go subscription allowance"]
          : provider === "grok-oauth"
            ? ["subscription", "SuperGrok OAuth subscription allowance"]
            : provider === "grok-api"
              ? ["payg", "xAI API balance"]
              : ["payg", "Kimi Platform API balance"];
    const preview: LiveCheckPreview = {
      provider,
      model: String(args.model ?? "qwen-plan/qwen3.8-max"),
      test,
      coveredChecks:
        test === "agent-behavior"
          ? ["two real Codex exec tool-use attempts"]
          : ["basic response", "streaming", "tool calling", "compaction"],
      billingType: billing[0] as LiveCheckPreview["billingType"],
      billingSource: billing[1],
      estimatedCostNote:
        "Puede consumir cuota del proveedor; no se ejecuta sin confirmación local.",
      requiresConfirmation: true,
    };
    return preview as T;
  }
  if (command === "app_server_probe") {
    if (args.confirm !== true) {
      throw new Error("App Server probe requires explicit confirmation");
    }
    return clone({
      ok: true,
      handshake: "initialized",
      serverVersion: "fixture",
      platformFamily: "windows",
      redacted: true,
      fixture: true,
    }) as T;
  }
  if (command === "mcp_server_info") {
    return clone({
      enabled: snapshot.featureFlags?.mcp === true,
      name: "codex-orchestra",
      transport: "stdio",
      command:
        "C:\\Users\\<you>\\AppData\\Local\\Programs\\Codex Orchestra\\codex-orchestra.exe",
      args: ["--mcp-stdio"],
      tools: [
        "orchestra_status",
        "orchestra_usage_summary",
        "orchestra_scope_plan",
        "orchestra_sync_status",
      ],
      writes: false,
      redacted: true,
    }) as T;
  }
  if (command === "open_provider_helper") {
    const provider = String(args.provider ?? "");
    if (
      ![
        "qwen-plan",
        "kimi-api",
        "opencode-go",
        "grok-oauth",
        "grok-api",
      ].includes(provider)
    ) {
      throw new Error("Provider helper is not available for this provider");
    }
    return clone({
      ok: true,
      provider,
      interactive: true,
      credentialValuesReadByOrchestra: false,
      ...(provider === "opencode-go"
        ? {
            command: "model-router.ps1 codex provider-key opencode-go set",
            next: "Enter the OpenCode Go key in the local hidden Router prompt, then refresh the catalog and run Doctor.",
          }
        : {}),
      ...(provider === "qwen-plan"
        ? {
            command: "model-router.ps1 codex provider-key qwen-plan set",
            next: "Enter the Alibaba Token Plan credential in the local hidden Router prompt, then refresh the catalog and run Doctor.",
          }
        : {}),
      ...(provider === "grok-oauth"
        ? {
            command: "grok login --oauth",
            next: "Finish the browser login in the opened terminal, then refresh the Router catalog.",
          }
        : {}),
    }) as T;
  }
  if (command === "apply_codex_picker_allowlist_command") {
    return clone({
      ok: true,
      status: "published",
      hidden: 0,
      visible: [
        "gpt-5.6-sol",
        "gpt-5.6-luna",
        "gpt-5.6-terra",
        "gpt-5.5",
        "gpt-5.2",
        "grok-oauth/grok-4.6",
        "opencode-go/kimi-k3",
        "opencode-go/deepseek-v4-pro",
        "opencode-go/deepseek-v4-flash",
        "qwen-plan/qwen3.8-max",
        "opencode-go-messages/qwen3.8-max",
      ],
    }) as T;
  }
  if (command === "open_model_curation") {
    const provider = String(args.provider ?? "");
    if (!["kimi-api", "grok-api"].includes(provider)) {
      throw new Error("Model curation is not available for this provider");
    }
    return clone({
      ok: true,
      provider,
      interactive: true,
      credentialValuesReadByOrchestra: false,
      next: "Review and apply the discovered catalog in the Router prompt.",
    }) as T;
  }
  if (command === "set_provider_enabled") {
    const provider = String(args.provider ?? "");
    const enabled = args.enabled === true;
    if (!args.confirm) {
      throw new Error("Changing provider state requires explicit confirmation");
    }
    if (
      ![
        "qwen-plan",
        "kimi-api",
        "opencode-go",
        "grok-oauth",
        "grok-api",
      ].includes(provider)
    ) {
      throw new Error("Provider is not available for Router control");
    }
    const target = snapshot.providers.find((item) => item.id === provider);
    if (target) target.enabled = enabled;
    return clone({
      ok: true,
      provider,
      enabled,
      fixture: true,
      output: "fixture provider state changed",
    }) as T;
  }
  if (command === "install_router") {
    return clone({
      ok: true,
      status: "already-detected",
      root: snapshot.router.root,
      pinnedBy: snapshot.router.pinnedRef,
    }) as T;
  }
  if (command === "open_router_setup") {
    return clone({
      ok: true,
      interactive: true,
      credentialValuesReadByOrchestra: false,
    }) as T;
  }
  if (command === "run_live_check") {
    if (args.confirm !== true) {
      throw new Error("Live check requires explicit confirmation");
    }
    const provider = String(args.provider ?? "");
    const model = String(args.model ?? "");
    if (
      ![
        "qwen-plan",
        "kimi-api",
        "opencode-go",
        "grok-oauth",
        "grok-api",
      ].includes(provider) ||
      !model.startsWith(`${provider}/`)
    ) {
      throw new Error("Provider and model do not match");
    }
    const test =
      args.test === "agent-behavior" ? "agent-behavior" : "compatibility";
    const role = ["qwen-plan", "kimi-api", "opencode-go"].includes(provider)
      ? "frontend"
      : "engineer";
    const agent = snapshot.agents.find((item) => item.role === role);
    if (agent) agent.lastTest = `${test} passed · fixture`;
    return clone({
      ok: true,
      fixture: true,
      provider,
      model,
      requestedTest: test,
      executedTest:
        test === "agent-behavior"
          ? "fixture-native-agent-capability"
          : "fixture-router-compatibility-suite",
      redacted: true,
      stdout:
        test === "agent-behavior"
          ? "fixture agent capability: 2/2 tool-use attempts passed"
          : "fixture compatibility: basic, streaming, tool calling and compaction passed",
      stderr: "",
    }) as T;
  }
  if (command === "export_support_bundle")
    return clone({
      schemaVersion: 3,
      createdAt: now(),
      privacy: {
        redacted: true,
        excluded: [
          "credential and OAuth values",
          "prompts and responses",
          "command output and arguments",
          "project, backup, executable and configuration paths",
          "native Codex thread and turn IDs",
        ],
      },
      app: { version: snapshot.appVersion },
      codex: {
        detected: snapshot.codex.detected,
        version: snapshot.codex.version,
        login: snapshot.codex.login,
        configDetected: snapshot.codex.configDetected,
        configHealth: snapshot.codex.configHealth,
        source: snapshot.codex.source,
      },
      router: {
        detected: snapshot.router.detected,
        version: snapshot.router.version,
        pinnedRef: snapshot.router.pinnedRef,
        health: snapshot.router.health,
        service: snapshot.router.service,
        loopbackPorts: snapshot.router.ports,
      },
      providers: snapshot.providers.map(
        ({ id, name, credential, enabled, billingType, lastChecked }) => ({
          id,
          name,
          credential,
          enabled,
          billingType,
          lastChecked,
        }),
      ),
      diagnostics: snapshot.diagnostics.map(
        ({ id, category, label, status }) => ({ id, category, label, status }),
      ),
      healthHistory: (snapshot.healthHistory ?? []).map(
        ({ id, status, startedAt, completedAt, checks }) => ({
          id,
          status,
          startedAt,
          completedAt,
          checks: checks.map(
            ({ id: checkId, label, status: checkStatus, checkedAt }) => ({
              id: checkId,
              label,
              status: checkStatus,
              checkedAt,
            }),
          ),
          redacted: true,
        }),
      ),
      counts: {
        projects: snapshot.projects.length,
        usageEvents: snapshot.usage.length,
        backups: snapshot.backups.length,
        delegationEvidence: snapshot.delegationEvidence?.length ?? 0,
      },
    }) as T;
  return clone(snapshot) as T;
}
