import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { test } from "node:test";
import {
  detectStackFromFiles,
  frontendStrategyForKey,
  managedConfigPreview,
  mergeManagedBlock,
  planScopes,
  redactSecrets,
  renderAgentToml,
  renderManagedBlock,
  renderRoutingSkill,
  renderSubagentConfig,
  resolveModelBinding,
  DEFAULT_BINDINGS,
  DEFAULT_PRICING_RULES,
} from "../src/index";
import { mockInvoke } from "../../../apps/desktop/src/core/mockBackend";

test("offline fixture roundtrip covers Windows paths, Router catalog and managed files", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-orchestra-fixture-"));
  const previousCodexHome = process.env.CODEX_HOME;
  const previousRouterRoot = process.env.CODEX_ORCHESTRA_ROUTER_ROOT;
  try {
    const project = join(root, "Códigos", "fixture-project");
    const codexHome = join(root, ".codex");
    const routerRoot = join(root, "router");
    await mkdir(join(project, "src", "app"), { recursive: true });
    await mkdir(join(codexHome, "agents"), { recursive: true });
    await mkdir(routerRoot, { recursive: true });

    await writeFile(
      join(project, "package.json"),
      JSON.stringify({ scripts: { test: "vitest", typecheck: "tsc" } }),
    );
    await writeFile(join(project, "next.config.ts"), "export default {};\n");
    await writeFile(join(project, "tailwind.css"), "@tailwind base;\n");
    await writeFile(
      join(routerRoot, "merged-models.json"),
      JSON.stringify([
        {
          id: "opencode-go/kimi-k3",
          providerId: "opencode-go",
          available: true,
          contextWindow: 256000,
          autoCompactionThreshold: 230000,
        },
      ]),
    );
    await writeFile(
      join(codexHome, "config.toml"),
      "[agents]\nenabled = false\ncustom = true\n",
    );
    process.env.CODEX_HOME = codexHome;
    process.env.CODEX_ORCHESTRA_ROUTER_ROOT = routerRoot;

    const catalog = JSON.parse(
      await readFile(join(routerRoot, "merged-models.json"), "utf8"),
    ) as Array<{ id: string; available: boolean }>;
    assert.equal(catalog[0]?.id, "opencode-go/kimi-k3");
    assert.deepEqual(
      detectStackFromFiles([
        win32.join("C:\\Códigos", "fixture-project", "package.json"),
        "next.config.ts",
        "tailwind.css",
      ]),
      ["Node.js", "Next.js", "Tailwind"],
    );

    const binding = resolveModelBinding(DEFAULT_BINDINGS.frontend, [
      {
        id: "opencode-go/kimi-k3",
        label: "Kimi K3",
        providerId: "opencode-go",
        available: true,
        supportsStreaming: true,
        supportsTools: true,
        supportsSubagents: true,
        reasoningEfforts: ["max"],
        source: "fixture",
      },
    ]);
    assert.equal(binding.resolved, true);
    assert.match(
      renderAgentToml(
        {
          id: "frontend",
          name: "Orchestra Frontend",
          role: "frontend",
          description: "Fixture frontend worker",
          providerId: "kimi-api",
          reasoningEffort: "max",
          permissions: ["workspace-write"],
          routingHints: ["a11y"],
          retryLimit: 1,
          ownershipPaths: ["src/**"],
          sharedPaths: [],
          health: "unknown",
        },
        binding.model?.id ?? "opencode-go/kimi-k3",
      ),
      /codex-router/,
    );

    const managed = renderManagedBlock(
      [
        {
          id: "frontend",
          name: "Orchestra Frontend",
          role: "frontend",
          description: "Fixture frontend worker",
          providerId: "kimi-api",
          reasoningEffort: "max",
          permissions: ["workspace-write"],
          routingHints: ["a11y"],
          retryLimit: 1,
          ownershipPaths: ["src/**"],
          sharedPaths: [],
          health: "unknown",
        },
      ],
      ["package.json"],
    );
    const mergedAgents = mergeManagedBlock("# User rules\n\n", managed);
    assert.match(mergedAgents, /# User rules/);
    assert.match(mergedAgents, /orchestra-routing/);
    assert.match(renderRoutingSkill(), /Never expose credentials/);
    assert.match(renderSubagentConfig(), /max_depth = 1/);

    const preview = managedConfigPreview(
      "AGENTS.md",
      "# User rules\n\n<!-- BEGIN CODEX-ORCHESTRA MANAGED -->\nold\n<!-- END CODEX-ORCHESTRA MANAGED -->\n",
      managed,
    );
    assert.equal(preview.file.safe, true);
    assert.equal(preview.file.action, "update");

    const scopes = planScopes(
      {
        root: ["package.json"],
        frontend: ["src/**"],
        engineer: ["src/api/**"],
      },
      ["package.json"],
    );
    assert.equal(scopes.parallel, false);
    assert.equal(scopes.worktreeRecommended, true);

    const fixturePreview = await mockInvoke<
      Array<{ path: string; safe: boolean; currentHash?: string }>
    >("managed_preview", {
      path: join(project, "AGENTS.md"),
      existing: "# Project\n",
    });
    assert.ok(
      fixturePreview.some((file) => file.path === ".codex/config.toml"),
    );
    assert.ok(fixturePreview.every((file) => file.safe));
    assert.match(
      fixturePreview.find((file) => file.path.endsWith("AGENTS.md"))
        ?.currentHash ?? "",
      /^[a-f0-9]{8}$/,
    );
    await assert.rejects(
      mockInvoke("apply_managed_changes", { confirm: true }),
      /Review the current managed preview/,
    );
    const reviewedHash = fixturePreview.find((file) =>
      file.path.endsWith("AGENTS.md"),
    )?.currentHash;
    const reviewedApply = await mockInvoke<{ ok: boolean }>(
      "apply_managed_changes",
      { confirm: true, expectedCurrentHash: reviewedHash },
    );
    assert.equal(reviewedApply.ok, true);
    assert.doesNotMatch(
      redactSecrets("api_key=fixture-secret"),
      /fixture-secret/,
    );

    const profile = await mockInvoke<{
      id: string;
      path: string;
      ownership: Record<string, string[]>;
    }>("add_project", { path: project });
    assert.equal(profile.path, project);
    const updatedProfile = await mockInvoke<{
      ownership: Record<string, string[]>;
      sharedPaths: string[];
      activeTeam: string;
      routingPolicy: string;
      knownTests: string[];
      lintScript?: string;
      typecheckScript?: string;
    }>("update_project_profile", {
      projectId: profile.id,
      ownership: {
        root: ["package.json"],
        frontend: ["src/**"],
        engineer: ["tests/**"],
      },
      sharedPaths: ["package.json"],
      activeTeam: "local-squad",
      routingPolicy: "safe-disjoint-only",
      knownTests: ["npm test", "npm run check"],
      lintScript: "npm run lint:ci",
      typecheckScript: "npm run typecheck",
    });
    assert.deepEqual(updatedProfile.ownership.frontend, ["src/**"]);
    assert.deepEqual(updatedProfile.sharedPaths, ["package.json"]);
    assert.equal(updatedProfile.activeTeam, "local-squad");
    assert.equal(updatedProfile.routingPolicy, "safe-disjoint-only");
    assert.deepEqual(updatedProfile.knownTests, ["npm test", "npm run check"]);
    assert.equal(updatedProfile.lintScript, "npm run lint:ci");

    const beforeAgentSave = await mockInvoke<{
      frontendStrategy?: {
        mode: "auto" | "pinned";
        pinnedModel?: { provider: string; upstreamModel: string };
      };
      agents: Array<{
        id: string;
        role: "root" | "frontend" | "engineer";
        providerId: string;
        modelId?: string;
        reasoningEffort: string;
        permissions: string[];
        routingHints: string[];
        retryLimit: number;
        ownershipPaths: string[];
        sharedPaths: string[];
        health: "healthy" | "degraded" | "missing" | "unhealthy" | "unknown";
        name: string;
        description: string;
      }>;
    }>("get_snapshot");
    const frontend = beforeAgentSave.agents.find(
      (agent) => agent.role === "frontend",
    );
    assert.ok(frontend);
    assert.deepEqual(beforeAgentSave.frontendStrategy, {
      mode: "pinned",
      pinnedModel: { provider: "qwen-plan", upstreamModel: "qwen3.8-max" },
    });
    const savedKimi = await mockInvoke<{
      providerId: string;
      modelId?: string;
      modelTarget?: { provider: string; upstreamModel: string };
    }>("save_frontend_strategy", {
      strategy: frontendStrategyForKey("kimi"),
    });
    assert.equal(savedKimi.providerId, "opencode-go");
    assert.equal(savedKimi.modelId, "opencode-go/kimi-k3");
    assert.deepEqual(savedKimi.modelTarget, {
      provider: "opencode-go",
      upstreamModel: "kimi-k3",
    });
    await assert.rejects(
      mockInvoke("save_frontend_strategy", {
        strategy: {
          mode: "pinned",
          pinnedModel: { provider: "opencode-go", upstreamModel: "missing" },
        },
      }),
      /no fallback was applied/,
    );
    const savedAuto = await mockInvoke<{
      providerId: string;
      modelId?: string;
    }>("save_frontend_strategy", {
      strategy: frontendStrategyForKey("auto"),
    });
    assert.equal(savedAuto.providerId, "qwen-plan");
    assert.equal(savedAuto.modelId, "qwen-plan/qwen3.8-max");
    const savedAgent = await mockInvoke<{ name: string; retryLimit: number }>(
      "update_agent_definition",
      {
        agent: {
          ...frontend,
          name: "Orchestra Frontend",
          retryLimit: 0,
        },
      },
    );
    assert.equal(savedAgent.name, "Orchestra Frontend");
    assert.equal(savedAgent.retryLimit, 0);

    const worktreePreview = await mockInvoke<{
      requiresConfirmation: boolean;
      experimental: boolean;
    }>("worktree_preview", {
      projectPath: project,
      role: "frontend",
      slug: "fixture-task",
    });
    assert.equal(worktreePreview.requiresConfirmation, true);
    assert.equal(worktreePreview.experimental, true);
    await mockInvoke("save_feature_flags", {
      confirm: true,
      flags: { appServer: true, mcp: false, experimentalWorktrees: true },
    });
    const worktree = await mockInvoke<{ ok: boolean; detached: boolean }>(
      "create_worktree",
      {
        projectPath: project,
        role: "frontend",
        slug: "fixture-task",
        confirm: true,
      },
    );
    assert.equal(worktree.ok, true);
    assert.equal(worktree.detached, true);

    const livePreview = await mockInvoke<{
      requiresConfirmation: boolean;
      test: string;
      coveredChecks: string[];
      billingType: string;
      billingSource: string;
    }>("live_check_preview", {
      provider: "opencode-go",
      model: "opencode-go/kimi-k3",
      test: "compatibility",
    });
    assert.equal(livePreview.requiresConfirmation, true);
    assert.equal(livePreview.test, "compatibility");
    assert.equal(livePreview.billingType, "subscription");
    assert.equal(
      livePreview.billingSource,
      "OpenCode Go subscription allowance",
    );
    assert.deepEqual(livePreview.coveredChecks, [
      "basic response",
      "streaming",
      "tool calling",
      "compaction",
    ]);
    const liveRun = await mockInvoke<{
      requestedTest: string;
      executedTest: string;
    }>("run_live_check", {
      provider: "opencode-go",
      model: "opencode-go/kimi-k3",
      test: "agent-behavior",
      confirm: true,
    });
    assert.equal(liveRun.requestedTest, "agent-behavior");
    assert.equal(liveRun.executedTest, "fixture-native-agent-capability");
    const postLiveSnapshot = await mockInvoke<{
      agents: Array<{ role: string; lastTest?: string }>;
    }>("get_snapshot");
    assert.match(
      postLiveSnapshot.agents.find((agent) => agent.role === "frontend")
        ?.lastTest ?? "",
      /agent-behavior passed/,
    );
    const appServer = await mockInvoke<{
      handshake: string;
      redacted: boolean;
    }>("app_server_probe", { confirm: true });
    assert.equal(appServer.handshake, "initialized");
    assert.equal(appServer.redacted, true);
    const routerHealth = await mockInvoke<{
      healthy: boolean;
      redacted: boolean;
      message: string;
    }>("router_runtime_health");
    assert.equal(routerHealth.healthy, true);
    assert.equal(routerHealth.redacted, true);
    const repaired = await mockInvoke<{
      ok: boolean;
      message: string;
      phase: string;
    }>("router_runtime_restart", { confirm: true });
    assert.equal(repaired.ok, true);
    assert.equal(repaired.message, "Router restarted successfully");
    const logs = await mockInvoke<{
      redacted: boolean;
      lines: Array<{ text: string }>;
    }>("router_runtime_logs");
    assert.equal(logs.redacted, true);
    assert.equal(JSON.stringify(logs).includes("sk-"), false);
    await mockInvoke("run_health_check");
    const postHealthSnapshot = await mockInvoke<{
      healthHistory?: Array<{ id: string }>;
    }>("get_snapshot_fast");
    assert.equal(postHealthSnapshot.healthHistory?.length, 1);
    const supportBundle = await mockInvoke<{
      schemaVersion: number;
      codex: Record<string, unknown>;
      counts: { projects: number };
    }>("export_support_bundle");
    assert.equal(supportBundle.schemaVersion, 3);
    assert.equal(supportBundle.counts.projects, 1);
    assert.equal("executable" in supportBundle.codex, false);
    assert.equal(JSON.stringify(supportBundle).includes(root), false);
    const pricingPreview = await mockInvoke<{
      token: string;
      count: number;
      writesCredentialValues: boolean;
    }>("preview_pricing_rules", { rules: DEFAULT_PRICING_RULES });
    assert.equal(pricingPreview.count, DEFAULT_PRICING_RULES.length);
    assert.equal(pricingPreview.writesCredentialValues, false);
    const pricingSave = await mockInvoke<{ ok: boolean; count: number }>(
      "save_pricing_rules",
      {
        rules: DEFAULT_PRICING_RULES,
        previewToken: pricingPreview.token,
        confirm: true,
      },
    );
    assert.equal(pricingSave.ok, true);
    assert.equal(pricingSave.count, DEFAULT_PRICING_RULES.length);
    const exported = await mockInvoke<{
      projects: unknown[];
      featureFlags: { experimentalWorktrees: boolean };
    }>("export_profile");
    assert.equal(exported.projects.length, 1);
    assert.equal(exported.featureFlags.experimentalWorktrees, true);
    const imported = await mockInvoke<{
      ok: boolean;
      importedProjects: number;
      skippedProjects: number;
    }>("import_profile", { payload: exported, confirm: true });
    assert.equal(imported.ok, true);
    assert.equal(imported.importedProjects, 1);
    assert.equal(imported.skippedProjects, 0);
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousRouterRoot === undefined)
      delete process.env.CODEX_ORCHESTRA_ROUTER_ROOT;
    else process.env.CODEX_ORCHESTRA_ROUTER_ROOT = previousRouterRoot;
    await rm(root, { recursive: true, force: true });
  }
});
