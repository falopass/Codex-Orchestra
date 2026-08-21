import type {
  AgentDefinition,
  AgentRole,
  CostBreakdown,
  FrontendModelCandidate,
  FrontendModelStrategy,
  FrontendModelTarget,
  ManagedConfig,
  Model,
  ModelBinding,
  PricingRule,
  PreviewFile,
  ScopePlan,
  UsageEvent,
} from "./types";

export * from "./types";
export * from "./readiness";

export const ROUTER_REPOSITORY =
  "https://github.com/duolahypercho/codex-router";
export const ROUTER_OBSERVED_VERSION = "0.4.0-beta.3";
export const MODEL_REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export const VISIBLE_NATIVE_MODEL_IDS = [
  "gpt-5.6-sol",
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.5",
  "gpt-5.2",
] as const;

export const VISIBLE_ROUTED_MODEL_IDS = [
  "grok-oauth/grok-4.6",
  "opencode-go/kimi-k3",
  "opencode-go/deepseek-v4-pro",
  "opencode-go/deepseek-v4-flash",
  "qwen-plan/qwen3.8-max",
  "opencode-go-messages/qwen3.8-max",
] as const;

/** Documented examples. Not an exclusive Codex picker allowlist. */
export const VISIBLE_CODEX_MODEL_IDS = [
  ...VISIBLE_NATIVE_MODEL_IDS,
  ...VISIBLE_ROUTED_MODEL_IDS,
] as const;

export function isExampleCodexModelId(modelId: string) {
  const id = modelId.trim();
  return (VISIBLE_CODEX_MODEL_IDS as readonly string[]).includes(id);
}

export function isVisibleCodexModelId(modelId: string) {
  // Router hide-list is the source of truth. Orchestra does not hide a
  // catalog, curated or user model just because it is outside the examples.
  return Boolean(modelId.trim());
}

export function hiddenCodexModelIds(_catalogIds: string[]) {
  return [];
}

export function isSafeProviderId(provider: string) {
  return (
    /^[a-z][a-z0-9-]{1,31}$/.test(provider) &&
    provider !== "openai" &&
    provider !== "codex"
  );
}

export const FRONTEND_MODEL_CANDIDATES: FrontendModelCandidate[] = [
  {
    key: "qwen",
    label: "Qwen 3.8 Max",
    provider: "qwen-plan",
    providerLabel: "Alibaba Token Plan",
    upstreamModel: "qwen3.8-max",
    purpose:
      "React, forms, state, APIs, TypeScript, refactors and ordinary UI work",
    reasoningEffort: "high",
  },
  {
    key: "kimi",
    label: "Kimi K3",
    provider: "opencode-go",
    providerLabel: "OpenCode Go",
    upstreamModel: "kimi-k3",
    purpose:
      "Visual redesigns, screenshots, composition, UX polish and animation",
    reasoningEffort: "max",
  },
];

export const DEFAULT_FRONTEND_STRATEGY: FrontendModelStrategy = {
  mode: "pinned",
  pinnedModel: {
    provider: "qwen-plan",
    upstreamModel: "qwen3.8-max",
  },
};

export const DEFAULT_BINDINGS: Record<AgentRole, ModelBinding> = {
  root: {
    binding: "root",
    label: "Root / Tech Lead",
    targetFamily: "OpenAI native",
    preferredProvider: "openai",
    preferredUpstreamModel: "gpt-5.6-sol",
    candidateModelIds: ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra"],
    desiredLabel: "GPT-5.6 Sol, Luna or Terra",
  },
  frontend: {
    binding: "frontend",
    label: "Frontend model binding",
    targetFamily: "Qwen default / Kimi visual",
    preferredProvider: "qwen-plan",
    preferredUpstreamModel: "qwen3.8-max",
    candidateModelIds: [],
    candidateTargets: FRONTEND_MODEL_CANDIDATES.map(
      ({ provider, upstreamModel }) => ({
        provider,
        upstreamModel,
      }),
    ),
    desiredLabel: "Qwen 3.8 Max",
  },
  engineer: {
    binding: "engineer",
    label: "General engineer",
    targetFamily: "xAI",
    preferredProvider: "grok-oauth",
    preferredUpstreamModel: "grok-4.6",
    candidateModelIds: ["grok-oauth/grok-4.6", "grok-api/grok-4.6"],
    desiredLabel: "Grok 4.6",
  },
};

function resolveCatalogTarget(target: FrontendModelTarget, catalog: Model[]) {
  return (
    catalog.find(
      (model) =>
        model.available &&
        model.providerId === target.provider &&
        model.upstreamModel === target.upstreamModel,
    ) ??
    catalog.find(
      (model) =>
        model.available &&
        model.providerId === target.provider &&
        model.id === `${target.provider}/${target.upstreamModel}`,
    )
  );
}

export function resolveFrontendModelStrategy(
  strategy: FrontendModelStrategy = DEFAULT_FRONTEND_STRATEGY,
  catalog: Model[] = [],
) {
  const candidateResolutions = FRONTEND_MODEL_CANDIDATES.map((candidate) => {
    const model = resolveCatalogTarget(candidate, catalog);
    return { candidate, model, resolved: Boolean(model) };
  });
  const ready = candidateResolutions.filter((entry) => entry.resolved);
  const pinned = strategy.mode === "pinned" ? strategy.pinnedModel : undefined;
  const selected =
    strategy.mode === "auto"
      ? ready[0]
      : candidateResolutions.find(
          (entry) =>
            entry.candidate.provider === pinned?.provider &&
            entry.candidate.upstreamModel === pinned?.upstreamModel,
        );
  const selectedModel = selected?.model;
  const status =
    strategy.mode === "pinned" && pinned && !selectedModel
      ? "missing"
      : ready.length === FRONTEND_MODEL_CANDIDATES.length
        ? "healthy"
        : ready.length === 1
          ? "degraded"
          : "missing";

  return {
    strategy,
    candidates: candidateResolutions,
    selectedCandidate: selected?.candidate,
    selectedModel,
    resolved: Boolean(selectedModel),
    status,
  } as const;
}

export function frontendStrategyForKey(
  key: "auto" | "qwen" | "kimi",
): FrontendModelStrategy {
  if (key === "auto") return { mode: "auto" };
  const candidate = FRONTEND_MODEL_CANDIDATES.find((item) => item.key === key);
  if (!candidate) return DEFAULT_FRONTEND_STRATEGY;
  return {
    mode: "pinned",
    pinnedModel: {
      provider: candidate.provider,
      upstreamModel: candidate.upstreamModel,
    },
  };
}

export function resolveModelBinding(binding: ModelBinding, catalog: Model[]) {
  const exactMatch = binding.candidateModelIds
    .map((candidate) =>
      catalog.find((model) => model.id === candidate && model.available),
    )
    .find(Boolean);
  const targetMatch = (binding.candidateTargets ?? [])
    .map((target) => resolveCatalogTarget(target, catalog))
    .find(Boolean);
  const preferredMatch = resolveCatalogTarget(
    {
      provider: binding.preferredProvider,
      upstreamModel: binding.preferredUpstreamModel,
    },
    catalog,
  );
  const match = exactMatch ?? targetMatch ?? preferredMatch;
  return {
    binding: binding.binding,
    desiredLabel: binding.desiredLabel,
    preferredProvider: binding.preferredProvider,
    preferredUpstreamModel: binding.preferredUpstreamModel,
    resolvedModelId: match?.id,
    model: match,
    resolved: Boolean(match),
    needsCuration:
      binding.binding === "engineer" &&
      !catalog.some((model) =>
        ["grok-oauth/grok-4.6", "grok-api/grok-4.6"].includes(model.id),
      ),
  };
}

export function looksLikeRouterConnectionFailure(text: string) {
  const lower = text.toLowerCase();
  return (
    lower.includes("10061") ||
    lower.includes("econnrefused") ||
    lower.includes("connection refused") ||
    lower.includes("os error 10061") ||
    /reconnecting\s+5\s*\/\s*5/.test(lower)
  );
}

export function routerIssueFromText(
  text: string,
): import("./types").RouterConnectionIssue | undefined {
  if (looksLikeRouterConnectionFailure(text)) return "connection-refused";
  return undefined;
}

export function redactSecrets(input: string) {
  return input
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*["']?)[^\s"',}]+/gi,
      "$1[REDACTED]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_KEY]")
    .replace(/(capability(?:_|-)url\s*[:=]\s*)[^\s"']+/gi, "$1[REDACTED_URL]");
}

export function renderAgentToml(agent: AgentDefinition, modelId: string) {
  const instructions =
    agent.role === "frontend"
      ? "Complete only the bounded frontend task delegated by the root. This logical frontend role owns React, TypeScript, components, client state, API wiring, responsive behavior and ordinary frontend implementation regardless of its current model binding. Work autonomously with Codex tools inside the assigned files. Do not call another primary worker. If you need another role, report the exact blocker and requested information to the root; cross-role routing always returns through the root. Respect root contracts and report changed files, checks and risks."
      : "Complete only the bounded engineering task delegated by the root. This logical engineer role owns backend, architecture implementation, debugging, tests, integrations and general engineering regardless of its current model binding. Work autonomously with Codex tools inside the assigned files. Do not call another primary worker. If you need another role, report the exact blocker and requested information to the root; cross-role routing always returns through the root. Follow root contracts and report changed files, checks and risks.";
  return `name = "${agent.name}"\ndescription = "${agent.description}"\n\nmodel_provider = "codex-router"\nmodel = "${modelId}"\nmodel_reasoning_effort = "${agent.reasoningEffort}"\nsandbox_mode = "workspace-write"\n\ndeveloper_instructions = """\n${instructions}\n"""\n`;
}

export function renderVisualAgentToml(
  modelId = "opencode-go/kimi-k3",
  reasoningEffort = "max",
) {
  return `name = "orchestra_visual"
description = "Selective visual/UI specialist for delegated design and UX work."

model_provider = "codex-router"
model = "${modelId}"
model_reasoning_effort = "${reasoningEffort}"
sandbox_mode = "workspace-write"

developer_instructions = """
Complete only the visual/UI task delegated by GPT-5.6 Sol. Kimi K3 is reserved for visual direction, UX, screenshots, design-system polish, composition and interaction review. Use it selectively to preserve allowance. Do not delegate. If implementation needs backend, frontend-general or engineering work, report the exact requirement to Sol; Sol alone routes cross-role work. Stay inside assigned files and report changed files, visual evidence and remaining risks.
"""
`;
}

export function renderRoutingSkill() {
  return [
    "---",
    "name: orchestra-routing",
    "description: Route substantial coding work to Orchestra configured specialist subagents.",
    "---",
    "",
    "# Orchestra routing policy",
    "",
    "GPT-5.6 Sol is Root / Tech Lead. Sol decomposes substantial tasks before delegation, chooses the role and model binding, defines file ownership, decides whether scopes can run in parallel, integrates all work and performs the final review.",
    "",
    "Roles are logical bindings, not permanently coupled implementation details. Initial bindings are: Root = GPT-5.6 Sol; Engineer = Grok 4.6; Frontend general = Qwen 3.8 Max through the Alibaba/Qwen Token Plan; Visual/UI specialist = Kimi K3 through OpenCode Go.",
    "",
    "Qwen owns normal React/TypeScript, components, client state, API integration and responsive frontend work. Grok owns backend, architecture implementation, debugging, tests, integration and general engineering. Kimi is selective: visual direction, UX, screenshots, composition, design-system polish and interaction review. Kimi does not delegate.",
    "",
    "Cross-role delegation always passes through Sol. A worker never calls another primary worker: Qwen, Grok and Kimi report the exact missing input or blocker to their parent; Sol asks the other specialist and gives the relevant result back. Do not create trees such as Qwen → Grok → Kimi.",
    "",
    "For full-stack work:",
    "1. Inspect the repository and define shared contracts first.",
    "2. Give each worker an explicit objective, allowed files and handoff format.",
    "3. Delegate in parallel only when write scopes are disjoint; never let two workers write the same or shared file at once.",
    "4. Otherwise delegate sequentially and pass the completed handoff through Sol.",
    "5. Sol owns shared files, final integration, review and verification.",
    "",
    "Do not delegate trivial changes merely to use an agent. Retry a failed worker at most once. Never expose credentials to a subagent prompt.",
    "",
  ].join("\n");
}

export function renderSubagentConfig() {
  return "[agents]\nenabled = true\nmax_concurrent_threads_per_session = 2\nmax_depth = 1\n";
}

export function renderManagedBlock(
  agents: AgentDefinition[],
  managedPaths: string[],
) {
  const roleLines = agents
    .map(
      (agent) =>
        `- ${agent.role}: ${agent.ownershipPaths.join(", ") || "configure in Orchestra"}`,
    )
    .join("\n");
  return `<!-- BEGIN CODEX-ORCHESTRA MANAGED -->\nFor substantial engineering work, load the orchestra-routing skill.\n\nDelegation policy:\n- The configured root alone routes cross-role work and owns shared files, integration and final validation.\n- Frontend, engineer and visual are logical roles whose current model bindings come from Orchestra.\n- Workers report blockers to root instead of calling another primary worker; the visual role never delegates.\n\nProject ownership:\n${roleLines}\n- shared/root-owned: ${managedPaths.join(", ")}\n\nParallel write delegation is allowed only for disjoint scopes. Never write overlapping files concurrently.\n<!-- END CODEX-ORCHESTRA MANAGED -->`;
}

export function mergeManagedBlock(existing: string, block: string) {
  const begin = "<!-- BEGIN CODEX-ORCHESTRA MANAGED -->";
  const end = "<!-- END CODEX-ORCHESTRA MANAGED -->";
  const managed = `${begin}\n${block.replace(begin, "").replace(end, "").trim()}\n${end}`;
  const start = existing.indexOf(begin);
  const finish = existing.indexOf(end);
  if (start !== -1 && finish > start)
    return `${existing.slice(0, start)}${managed}${existing.slice(finish + end.length)}`;
  return `${existing.trimEnd()}\n\n${managed}\n`;
}

function normalisePath(value: string) {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function pathsOverlap(left: string, right: string) {
  const a = normalisePath(left);
  const b = normalisePath(right);
  const aBase = a.endsWith("/**") ? a.slice(0, -3) : a;
  const bBase = b.endsWith("/**") ? b.slice(0, -3) : b;
  return (
    a === b ||
    a.startsWith(`${b}/`) ||
    b.startsWith(`${a}/`) ||
    a === "*" ||
    b === "*" ||
    (a.endsWith("/**") && (b === aBase || b.startsWith(`${aBase}/`))) ||
    (b.endsWith("/**") && (a === bBase || a.startsWith(`${bBase}/`)))
  );
}

export function planScopes(
  assignments: Record<AgentRole, string[]>,
  sharedPaths: string[] = [],
): ScopePlan {
  const conflicts: string[] = [];
  const roles: AgentRole[] = ["frontend", "engineer"];
  for (const shared of sharedPaths) {
    if (
      roles.some((role) =>
        assignments[role].some((path) => pathsOverlap(path, shared)),
      )
    )
      conflicts.push(`shared: ${shared}`);
  }
  for (const left of roles) {
    for (const right of roles) {
      if (left >= right) continue;
      for (const path of assignments[left]) {
        for (const other of assignments[right])
          if (pathsOverlap(path, other))
            conflicts.push(`${left}:${path} ↔ ${right}:${other}`);
      }
    }
  }
  return {
    parallel: conflicts.length === 0,
    reason: conflicts.length
      ? "Overlapping or shared write scope requires sequential execution."
      : "Write scopes are disjoint.",
    assignments,
    conflicts: [...new Set(conflicts)],
    worktreeRecommended: conflicts.length > 0,
  };
}

export const DEFAULT_PRICING_RULES: PricingRule[] = [
  {
    provider: "qwen-plan",
    model: "qwen-plan/qwen3.8-max",
    currency: "USD",
    inputPerMillion: 0,
    cachedInputPerMillion: 0,
    outputPerMillion: 0,
    effectiveFrom: "2026-01-01T00:00:00Z",
    version: "qwen-token-plan-allowance",
    billingType: "subscription",
    sourceLabel:
      "Provider-owned Qwen Token Plan allowance; verify in provider dashboard",
    sourceUrl:
      "https://www.alibabacloud.com/help/en/model-studio/developer-reference/compatibility-of-openai-with-dashscope",
  },
  {
    provider: "opencode-go",
    model: "opencode-go/kimi-k3",
    currency: "USD",
    inputPerMillion: 0,
    cachedInputPerMillion: 0,
    outputPerMillion: 0,
    effectiveFrom: "2026-01-01T00:00:00Z",
    version: "opencode-go-allowance",
    billingType: "subscription",
    sourceLabel:
      "Provider-owned OpenCode Go allowance; verify in provider dashboard",
    sourceUrl: "https://opencode.ai/docs/es/go/",
  },
  {
    provider: "kimi-api",
    model: "kimi-api/kimi-k3",
    currency: "USD",
    inputPerMillion: 3,
    cachedInputPerMillion: 0.3,
    outputPerMillion: 15,
    effectiveFrom: "2026-08-01T00:00:00Z",
    version: "kimi-k3-2026-08",
    billingType: "payg",
    sourceLabel: "Moonshot AI official pricing documentation",
    sourceUrl: "https://platform.moonshot.ai/docs/pricing",
  },
  {
    provider: "grok-api",
    model: "grok-api/grok-4.6",
    currency: "USD",
    inputPerMillion: 2,
    cachedInputPerMillion: 0.5,
    outputPerMillion: 6,
    effectiveFrom: "2026-08-01T00:00:00Z",
    version: "grok-4.6-2026-08",
    billingType: "payg",
    sourceLabel: "xAI official model documentation",
    sourceUrl: "https://docs.x.ai/docs/models",
  },
];

function pricingFor(event: UsageEvent, rules: PricingRule[]) {
  const exact = rules
    .filter(
      (rule) =>
        rule.model === event.model &&
        rule.provider === event.provider &&
        rule.effectiveFrom <= event.timestamp,
    )
    .sort((left, right) =>
      right.effectiveFrom.localeCompare(left.effectiveFrom),
    )[0];
  return (
    exact ??
    rules
      .filter(
        (rule) =>
          rule.model === event.model && rule.effectiveFrom <= event.timestamp,
      )
      .sort((left, right) =>
        right.effectiveFrom.localeCompare(left.effectiveFrom),
      )[0]
  );
}

export function calculateEstimate(
  event: UsageEvent,
  rules: PricingRule[] = DEFAULT_PRICING_RULES,
) {
  const price = pricingFor(event, rules) ?? {
    inputPerMillion: 0,
    cachedInputPerMillion: 0,
    outputPerMillion: 0,
  };
  const input = Math.max(
    0,
    (event.inputTokens ?? 0) - (event.cachedInputTokens ?? 0),
  );
  return (
    (input * price.inputPerMillion +
      (event.cachedInputTokens ?? 0) * price.cachedInputPerMillion +
      (event.outputTokens ?? 0) * price.outputPerMillion) /
    1_000_000
  );
}

export function aggregateUsage(
  events: UsageEvent[],
  rules: PricingRule[] = DEFAULT_PRICING_RULES,
): CostBreakdown {
  let providerReported = 0;
  let routerReported = 0;
  let estimated = 0;
  for (const event of events) {
    if (event.source === "provider")
      providerReported += event.providerCost ?? calculateEstimate(event, rules);
    else if (event.source === "router")
      routerReported +=
        event.providerCost ??
        event.estimatedCost ??
        calculateEstimate(event, rules);
    else estimated += event.estimatedCost ?? calculateEstimate(event, rules);
  }
  const totalDisplay = providerReported + routerReported + estimated;
  const label =
    providerReported && estimated
      ? "mixed"
      : providerReported
        ? "provider-reported"
        : routerReported
          ? "router-reported"
          : "estimated";
  return {
    currency: "USD",
    providerReported,
    routerReported,
    estimated,
    totalDisplay,
    label,
  };
}

export function detectStackFromFiles(files: string[]) {
  const lower = files.map((file) => file.toLowerCase());
  const stack: string[] = [];
  if (lower.some((file) => file.endsWith("package.json")))
    stack.push("Node.js");
  if (
    lower.some(
      (file) =>
        file.endsWith("next.config.js") || file.endsWith("next.config.ts"),
    )
  )
    stack.push("Next.js");
  if (
    lower.some(
      (file) =>
        file.endsWith("vite.config.ts") || file.endsWith("vite.config.js"),
    )
  )
    stack.push("Vite");
  if (
    lower.some(
      (file) =>
        file.endsWith("pyproject.toml") || file.endsWith("requirements.txt"),
    )
  )
    stack.push("Python");
  if (lower.some((file) => file.endsWith("cargo.toml"))) stack.push("Rust");
  if (lower.some((file) => file.includes("tailwind"))) stack.push("Tailwind");
  if (
    lower.some(
      (file) => file.endsWith("app.config.js") || file.endsWith("app.json"),
    )
  )
    stack.push("Expo/React Native");
  return stack.length ? stack : ["Unknown"];
}

function stableHash(input: string) {
  let hash = 2166136261;
  for (const character of input) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function managedConfigPreview(
  path: string,
  existing: string,
  block: string,
): ManagedConfig & { file: PreviewFile } {
  const next = mergeManagedBlock(existing, block);
  const action =
    next === existing
      ? "unchanged"
      : existing.includes("BEGIN CODEX-ORCHESTRA MANAGED")
        ? "update"
        : "create";
  return {
    path,
    managedSection: block,
    currentHash: stableHash(existing),
    previewHash: stableHash(next),
    hasForeignContent: existing.replace(block, "").trim().length > 0,
    file: {
      path,
      action,
      diff: `${action}: managed block only`,
      currentHash: stableHash(existing),
      contentPreview: block,
      safe: true,
    },
  };
}
