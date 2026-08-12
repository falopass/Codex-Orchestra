import type {
  AgentDefinition,
  AgentRole,
  CostBreakdown,
  ManagedConfig,
  Model,
  ModelBinding,
  PreviewFile,
  ProjectProfile,
  ScopePlan,
  UsageEvent,
} from "./types";

export * from "./types";

export const ROUTER_REPOSITORY =
  "https://github.com/duolahypercho/codex-router";
export const ROUTER_OBSERVED_VERSION = "0.4.0-beta.2";

export const DEFAULT_BINDINGS: Record<AgentRole, ModelBinding> = {
  root: {
    binding: "root",
    label: "Root / Tech Lead",
    targetFamily: "OpenAI native",
    preferredProvider: "openai",
    candidateModelIds: ["gpt-5.6-sol", "gpt-5.6"],
    desiredLabel: "GPT-5.6 Sol",
  },
  frontend: {
    binding: "frontend",
    label: "Frontend specialist",
    targetFamily: "Kimi",
    preferredProvider: "kimi-api",
    candidateModelIds: ["kimi-api/kimi-k3", "kimi-oauth/k3"],
    desiredLabel: "Kimi K3",
  },
  engineer: {
    binding: "engineer",
    label: "General engineer",
    targetFamily: "xAI",
    preferredProvider: "grok-api",
    candidateModelIds: ["grok-api/grok-4.6", "grok-api/grok-4.5"],
    desiredLabel: "Grok 4.6",
  },
};

export function resolveModelBinding(binding: ModelBinding, catalog: Model[]) {
  const match = binding.candidateModelIds
    .map((candidate) =>
      catalog.find((model) => model.id === candidate && model.available),
    )
    .find(Boolean);
  return {
    binding: binding.binding,
    desiredLabel: binding.desiredLabel,
    model: match,
    resolved: Boolean(match),
    needsCuration:
      binding.binding === "engineer" &&
      !catalog.some((model) => model.id === "grok-api/grok-4.6"),
  };
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
      ? "Complete only the delegated frontend/UI task. Own hierarchy, responsive behavior, accessibility, interaction quality and frontend verification. Respect root contracts and report changed files, checks and risks."
      : "Complete only the bounded engineering task. Own backend, APIs, data, integrations, debugging and tests. Follow root contracts and report changed files, checks and risks.";
  return `name = "${agent.name}"\ndescription = "${agent.description}"\n\nmodel_provider = "codex-router"\nmodel = "${modelId}"\nmodel_reasoning_effort = "${agent.reasoningEffort}"\nsandbox_mode = "workspace-write"\n\ndeveloper_instructions = """\n${instructions}\n"""\n`;
}

export function renderRoutingSkill() {
  return `---\nname: orchestra-routing\ndescription: Route substantial coding work to Orchestra configured specialist subagents.\n---\n\n# Orchestra routing policy\n\nThe current Codex thread is the root technical lead.\n\nUse the frontend agent for substantial visual or client-side work.\nUse the engineer agent for substantial backend, data, integration, testing, refactoring or general implementation work.\n\nFor full-stack work:\n1. Inspect the repository and define shared contracts first.\n2. Determine write scopes.\n3. Delegate in parallel only when scopes are disjoint.\n4. Otherwise delegate sequentially.\n5. Wait for results before integration.\n6. Root owns shared files, final review and final verification.\n\nDo not delegate trivial changes merely to use an agent. Retry a failed worker at most once. Never expose credentials to a subagent prompt.\n`;
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
  return `<!-- BEGIN CODEX-ORCHESTRA MANAGED -->\nFor substantial engineering work, load the orchestra-routing skill.\n\nProject ownership:\n${roleLines}\n- shared/root-owned: ${managedPaths.join(", ")}\n\nParallel write delegation is allowed only for disjoint scopes. The root thread owns final integration and validation.\n<!-- END CODEX-ORCHESTRA MANAGED -->`;
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

const PRICING: Record<
  string,
  { input: number; cached: number; output: number }
> = {
  "kimi-api/kimi-k3": { input: 1.2, cached: 0.2, output: 4.8 },
  "grok-api/grok-4.6": { input: 5, cached: 1, output: 15 },
  "grok-api/grok-4.5": { input: 5, cached: 1, output: 15 },
};

export function calculateEstimate(event: UsageEvent) {
  const price = PRICING[event.model] ?? { input: 0, cached: 0, output: 0 };
  const input = Math.max(
    0,
    (event.inputTokens ?? 0) - (event.cachedInputTokens ?? 0),
  );
  return (
    (input * price.input +
      (event.cachedInputTokens ?? 0) * price.cached +
      (event.outputTokens ?? 0) * price.output) /
    1_000_000
  );
}

export function aggregateUsage(events: UsageEvent[]): CostBreakdown {
  let providerReported = 0;
  let routerReported = 0;
  let estimated = 0;
  for (const event of events) {
    if (event.source === "provider")
      providerReported += event.providerCost ?? calculateEstimate(event);
    else if (event.source === "router")
      routerReported +=
        event.providerCost ?? event.estimatedCost ?? calculateEstimate(event);
    else estimated += event.estimatedCost ?? calculateEstimate(event);
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
    hasForeignContent: existing.replace(block, "").trim().length > 0,
    file: { path, action, diff: `${action}: managed block only`, safe: true },
  };
}
