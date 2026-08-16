import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  DEFAULT_FRONTEND_STRATEGY,
  DEFAULT_BINDINGS,
  DEFAULT_PRICING_RULES,
  FRONTEND_MODEL_CANDIDATES,
  MODEL_REASONING_EFFORTS,
  VISIBLE_CODEX_MODEL_IDS,
  aggregateUsage,
  hiddenCodexModelIds,
  isVisibleCodexModelId,
  calculateEstimate,
  frontendStrategyForKey,
  looksLikeRouterConnectionFailure,
  orchestraReadiness,
  mergeManagedBlock,
  planScopes,
  redactSecrets,
  renderAgentToml,
  renderRoutingSkill,
  renderSubagentConfig,
  resolveFrontendModelStrategy,
  resolveModelBinding,
  routerIssueFromText,
} from "../src/index";

function readinessSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    appVersion: "0.1.0",
    codex: {
      detected: true,
      configDetected: true,
      configHealth: "healthy",
      login: "configured",
      nativeModelsAvailable: true,
      source: "fixture",
    },
    router: {
      detected: true,
      health: "degraded",
      ports: [],
      service: "stopped",
    },
    providers: [
      {
        id: "qwen-plan",
        name: "Qwen",
        family: "other",
        credential: "configured",
        enabled: true,
        billingType: "subscription",
        billingNote: "plan",
      },
    ],
    models: [],
    agents: [],
    projects: [
      {
        id: "p",
        name: "Demo",
        path: "D:\\demo",
        stack: [],
        activeTeam: "default",
        ownership: { root: [], frontend: [], engineer: [] },
        sharedPaths: [],
        routingPolicy: "root",
        knownTests: [],
        status: "healthy",
        usageEventCount: 0,
      },
    ],
    usage: [],
    budget: {
      monthlyLimit: 0,
      warningAtPercent: 80,
      criticalAtPercent: 100,
      currency: "USD",
    },
    backups: [],
    update: {
      targetRef: "pin",
      requiresBackup: true,
      healthGate: true,
      status: "current",
      notes: [],
    },
    diagnostics: [],
    featureFlags: { appServer: true, mcp: false, experimentalWorktrees: false },
    ...overrides,
  };
}

function modelFixture(
  providerId: string,
  id: string,
  upstreamModel: string,
  available = true,
) {
  return {
    id,
    label: id,
    providerId,
    upstreamModel,
    available,
    supportsStreaming: true,
    supportsTools: true,
    supportsSubagents: true,
    reasoningEfforts: ["high", "max"],
    source: "fixture" as const,
  };
}

test("logical model bindings resolve preferred available catalog entries", () => {
  const result = resolveModelBinding(DEFAULT_BINDINGS.engineer, [
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
    },
  ]);
  assert.equal(result.resolved, true);
  assert.equal(result.model?.id, "grok-api/grok-4.6");
  assert.equal(result.needsCuration, false);
});

test("Codex picker allowlist keeps only native GPT plus the reviewed routed models", () => {
  assert.deepEqual(
    [...VISIBLE_CODEX_MODEL_IDS],
    [
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
  );
  assert.equal(isVisibleCodexModelId("qwen-plan/qwen3.8-max"), true);
  assert.equal(isVisibleCodexModelId("opencode-go/glm-5.2"), false);
  assert.deepEqual(
    hiddenCodexModelIds([
      "gpt-5.6-sol",
      "qwen-plan/qwen3.8-max",
      "qwen-plan/glm-5.2",
      "opencode-go/glm-5.2",
      "opencode-go/kimi-k3",
      "gpt-5.6-sol",
    ]),
    ["opencode-go/glm-5.2", "qwen-plan/glm-5.2"],
  );
});

test("native root exposes Sol, Luna and Terra with the effort ladder", () => {
  assert.deepEqual(DEFAULT_BINDINGS.root.candidateModelIds, [
    "gpt-5.6-sol",
    "gpt-5.6-luna",
    "gpt-5.6-terra",
  ]);
  assert.deepEqual(
    [...MODEL_REASONING_EFFORTS],
    ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
  );
  assert.equal(DEFAULT_BINDINGS.engineer.preferredUpstreamModel, "grok-4.6");
});

test("frontend binding defaults to Qwen and resolves live upstream slugs", () => {
  assert.equal(DEFAULT_BINDINGS.frontend.preferredProvider, "qwen-plan");
  assert.equal(DEFAULT_BINDINGS.frontend.preferredUpstreamModel, "qwen3.8-max");
  assert.deepEqual(DEFAULT_FRONTEND_STRATEGY, {
    mode: "pinned",
    pinnedModel: { provider: "qwen-plan", upstreamModel: "qwen3.8-max" },
  });
  const dynamic = resolveModelBinding(DEFAULT_BINDINGS.frontend, [
    modelFixture("qwen-plan", "qwen-plan/qwen3.8-max-live", "qwen3.8-max"),
  ]);
  assert.equal(dynamic.model?.id, "qwen-plan/qwen3.8-max-live");
});

test("frontend strategy covers pinned Qwen, pinned Kimi and AUTO", () => {
  const qwen = modelFixture(
    "qwen-plan",
    "qwen-plan/qwen3.8-max-live",
    "qwen3.8-max",
  );
  const kimi = modelFixture(
    "opencode-go",
    "opencode-go/kimi-k3-live",
    "kimi-k3",
  );
  const both = [qwen, kimi];

  const qwenPinned = resolveFrontendModelStrategy(
    frontendStrategyForKey("qwen"),
    both,
  );
  assert.equal(qwenPinned.selectedModel?.id, qwen.id);
  assert.equal(qwenPinned.status, "healthy");

  const kimiPinned = resolveFrontendModelStrategy(
    frontendStrategyForKey("kimi"),
    both,
  );
  assert.equal(kimiPinned.selectedModel?.id, kimi.id);

  const auto = resolveFrontendModelStrategy(
    frontendStrategyForKey("auto"),
    both,
  );
  assert.equal(auto.selectedCandidate?.key, "qwen");
});

test("frontend AUTO reports degraded candidates and pinned mode fails closed", () => {
  const qwen = modelFixture(
    "qwen-plan",
    "qwen-plan/qwen3.8-max-live",
    "qwen3.8-max",
  );
  const kimi = modelFixture(
    "opencode-go",
    "opencode-go/kimi-k3-live",
    "kimi-k3",
  );
  assert.equal(
    resolveFrontendModelStrategy(frontendStrategyForKey("auto"), [qwen]).status,
    "degraded",
  );
  assert.equal(
    resolveFrontendModelStrategy(frontendStrategyForKey("auto"), [kimi])
      .selectedCandidate?.key,
    "kimi",
  );
  assert.equal(
    resolveFrontendModelStrategy(frontendStrategyForKey("auto"), []).status,
    "missing",
  );
  const unavailableKimi = resolveFrontendModelStrategy(
    frontendStrategyForKey("kimi"),
    [qwen],
  );
  assert.equal(unavailableKimi.resolved, false);
  assert.equal(unavailableKimi.selectedModel, undefined);
  assert.deepEqual(
    FRONTEND_MODEL_CANDIDATES.map((candidate) => candidate.provider),
    ["qwen-plan", "opencode-go"],
  );
  assert.equal(
    resolveFrontendModelStrategy(frontendStrategyForKey("qwen"), [
      modelFixture("kimi-api", "kimi-api/kimi-k3", "kimi-k3"),
    ]).resolved,
    false,
  );
});

test("managed block replacement preserves user content", () => {
  const original =
    "# Project\n\nUser rules.\n\n<!-- BEGIN CODEX-ORCHESTRA MANAGED -->\nold\n<!-- END CODEX-ORCHESTRA MANAGED -->\n";
  const merged = mergeManagedBlock(
    original,
    "<!-- BEGIN CODEX-ORCHESTRA MANAGED -->\nnew\n<!-- END CODEX-ORCHESTRA MANAGED -->",
  );
  assert.match(merged, /User rules/);
  assert.match(merged, /new/);
  assert.doesNotMatch(merged, /old/);
});

test("generated agents and skill contain routing boundaries", () => {
  const toml = renderAgentToml(
    {
      id: "frontend",
      name: "orchestra_frontend",
      role: "frontend",
      description: "Frontend specialist",
      providerId: "kimi-api",
      reasoningEffort: "max",
      permissions: ["workspace-write"],
      routingHints: [],
      retryLimit: 1,
      ownershipPaths: ["src/**"],
      sharedPaths: [],
      health: "unknown",
    },
    "kimi-api/kimi-k3",
  );
  assert.match(toml, /model_provider = "codex-router"/);
  assert.match(toml, /logical frontend role/);
  assert.match(toml, /regardless of its current model binding/);
  assert.match(toml, /cross-role routing always returns through the root/);
  assert.match(renderRoutingSkill(), /Never expose credentials/);
});

test("generated subagent config enables bounded native delegation", () => {
  const config = renderSubagentConfig();
  assert.match(config, /\[agents\]/);
  assert.match(config, /enabled = true/);
  assert.match(config, /max_concurrent_threads_per_session = 2/);
  assert.match(config, /max_depth = 1/);
});

test("redaction removes credential-shaped values", () => {
  const output =
    "authorization: Bearer [fixture-bearer] api_key=demo-secret-value";
  assert.doesNotMatch(redactSecrets(output), /fixture-bearer/);
  assert.doesNotMatch(redactSecrets(output), /demo-secret-value/);
});

test("scope planner forces sequential mode on overlap", () => {
  const plan = planScopes(
    { root: ["package.json"], frontend: ["src/**"], engineer: ["src/api/**"] },
    ["package.json"],
  );
  assert.equal(plan.parallel, false);
  assert.equal(plan.worktreeRecommended, true);
  assert.ok(plan.conflicts.length > 0);
});

test("cost engine separates reported and estimated values", () => {
  const events = [
    {
      id: "1",
      timestamp: "2026-08-12T10:00:00Z",
      provider: "kimi",
      model: "kimi-api/kimi-k3",
      source: "provider" as const,
      inputTokens: 1000,
      outputTokens: 2000,
      providerCost: 0.42,
    },
    {
      id: "2",
      timestamp: "2026-08-12T10:00:00Z",
      provider: "xai",
      model: "grok-api/grok-4.6",
      source: "estimate" as const,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    },
  ];
  const total = aggregateUsage(events);
  assert.equal(total.providerReported, 0.42);
  assert.ok(total.estimated > 0);
  assert.equal(calculateEstimate(events[1]), total.estimated);
});

test("cost engine selects versioned effective pricing rules", () => {
  const event = {
    id: "versioned",
    timestamp: "2026-08-12T10:00:00Z",
    provider: "kimi-api",
    model: "kimi-api/kimi-k3",
    source: "estimate" as const,
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
  };
  const kimiRule = DEFAULT_PRICING_RULES.find(
    (rule) => rule.provider === "kimi-api",
  );
  assert.ok(kimiRule);
  const rules = [
    ...DEFAULT_PRICING_RULES,
    {
      ...kimiRule,
      inputPerMillion: 2,
      outputPerMillion: 8,
      effectiveFrom: "2026-08-10T00:00:00Z",
      version: "kimi-k3-2026-08-override",
    },
  ];
  assert.equal(calculateEstimate(event, rules), 10);
});

test("router connection failures map 10061 and connection refused", () => {
  assert.equal(
    looksLikeRouterConnectionFailure("os error 10061: Connection refused"),
    true,
  );
  assert.equal(
    looksLikeRouterConnectionFailure("Reconnecting 5/5 to 127.0.0.1:4202"),
    true,
  );
  assert.equal(looksLikeRouterConnectionFailure("provider expired"), false);
  assert.equal(
    routerIssueFromText("ECONNREFUSED 127.0.0.1:4202"),
    "connection-refused",
  );
});

test("readiness treats a stopped Router as not live", () => {
  const stopped = orchestraReadiness(readinessSnapshot());
  assert.equal(stopped.routerLive, false);
  assert.equal(stopped.level, "blocked");
  assert.equal(stopped.next.label, "Abrir el Router");

  const running = orchestraReadiness(
    readinessSnapshot({
      router: {
        detected: true,
        health: "healthy",
        ports: [4200],
        service: "running",
        runtime: {
          detected: true,
          healthy: true,
          service: "running",
          ports: [4200],
          identityOk: true,
          message: "Router healthy",
          canRestart: true,
          requiresConfirmation: false,
          activeExecution: false,
        },
      },
    }),
  );
  assert.equal(running.routerLive, true);
  assert.equal(running.level, "ready");
  assert.equal(running.headline, "En marcha");
});
