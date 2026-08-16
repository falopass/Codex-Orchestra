import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  ORCHESTRA_GENERATED_PATHS,
  ORCHESTRA_PLUGIN_NAME,
  PLUGIN_FEATURE_MAP,
  planScopes,
  renderManagedBlock,
} from "../src/index";

test("plugin surface names stay stable and OSS-safe", () => {
  assert.equal(ORCHESTRA_PLUGIN_NAME, "codex-orchestra");
  assert.ok(
    ORCHESTRA_GENERATED_PATHS.every((path) => path.startsWith(".codex/")),
  );
  assert.ok(PLUGIN_FEATURE_MAP.some((feature) => feature.id === "threads"));
  assert.ok(
    PLUGIN_FEATURE_MAP.every(
      (feature) =>
        !feature.note.toLowerCase().includes("lenov") &&
        !feature.note.includes("D:\\"),
    ),
  );
});

test("core still plans sequential work on overlapping scopes", () => {
  const plan = planScopes(
    {
      root: [],
      frontend: ["src/**"],
      engineer: ["src/api.ts"],
    },
    ["package.json"],
  );
  assert.equal(plan.parallel, false);
  assert.ok(plan.conflicts.length > 0);
});

test("managed block stays marker-bounded", () => {
  const block = renderManagedBlock(
    [
      {
        id: "frontend",
        name: "Frontend",
        role: "frontend",
        description: "UI",
        providerId: "qwen-plan",
        reasoningEffort: "high",
        permissions: [],
        routingHints: [],
        retryLimit: 1,
        ownershipPaths: ["app/**"],
        sharedPaths: [],
        health: "unknown",
      },
      {
        id: "engineer",
        name: "Engineer",
        role: "engineer",
        description: "Backend",
        providerId: "grok-oauth",
        reasoningEffort: "high",
        permissions: [],
        routingHints: [],
        retryLimit: 1,
        ownershipPaths: ["server/**"],
        sharedPaths: [],
        health: "unknown",
      },
    ],
    ["package.json"],
  );
  assert.match(block, /BEGIN CODEX-ORCHESTRA MANAGED/);
  assert.match(block, /END CODEX-ORCHESTRA MANAGED/);
});
