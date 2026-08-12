import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  DEFAULT_BINDINGS,
  aggregateUsage,
  calculateEstimate,
  mergeManagedBlock,
  planScopes,
  redactSecrets,
  renderAgentToml,
  renderRoutingSkill,
  resolveModelBinding,
} from "../src/index";

test("logical model bindings resolve preferred available catalog entries", () => {
  const result = resolveModelBinding(DEFAULT_BINDINGS.engineer, [
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
    },
  ]);
  assert.equal(result.resolved, true);
  assert.equal(result.model?.id, "grok-api/grok-4.5");
  assert.equal(result.needsCuration, true);
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
  assert.match(renderRoutingSkill(), /Never expose credentials/);
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
