import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import { applyRouterOverlay } from "../apply.mjs";

const OVERLAY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function firstPartyRegistry() {
  return {
    version: 1,
    providers: [
      {
        id: "openrouter",
        displayName: "OpenRouter",
        kind: "openai-compatible",
        ownedBy: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        credential: {
          environment: ["OPENROUTER_API_KEY"],
          file: "openrouter-api-key.secret",
        },
      },
    ],
    models: [],
  };
}

function validUserProvider(id = "my-reseller") {
  return {
    id,
    displayName: "My Reseller",
    kind: "openai-compatible",
    ownedBy: "reseller",
    baseUrl: "https://reseller.example/v1",
    credential: {
      environment: ["MY_RESELLER_API_KEY"],
      file: "my-reseller-api-key.secret",
    },
  };
}

function keylessUserProvider(id = "ollama-local", baseUrl = "http://127.0.0.1:11434/v1") {
  return {
    id,
    displayName: "Ollama Local",
    kind: "openai-compatible",
    ownedBy: "ollama",
    baseUrl,
    keyless: true,
  };
}

function writeStubModules(src, checkout, state) {
  writeFileSync(
    path.join(src, "paths.mjs"),
    `export const SOURCE_ROOT = ${JSON.stringify(checkout)};
export const STATE_DIR = ${JSON.stringify(state)};
`,
    "utf8",
  );
  writeFileSync(
    path.join(src, "file-security.mjs"),
    `export function protectPrivateFile(target) { return target; }
`,
    "utf8",
  );
  writeFileSync(
    path.join(src, "user-models.mjs"),
    `import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { STATE_DIR } from "./paths.mjs";
export const USER_MODELS_PATH = process.env.MODEL_ROUTER_USER_MODELS || path.join(STATE_DIR, "user-models.json");
export function readUserModels() {
  if (!existsSync(USER_MODELS_PATH)) return [];
  try {
    const payload = JSON.parse(readFileSync(USER_MODELS_PATH, "utf8"));
    return Array.isArray(payload?.models) ? payload.models : [];
  } catch {
    return [];
  }
}
`,
    "utf8",
  );
}

async function loadPatchedRegistry({ providers = [], models = [] } = {}) {
  const checkout = mkdtempSync(path.join(os.tmpdir(), "orchestra-overlay-"));
  const src = path.join(checkout, "src");
  const state = path.join(checkout, "state");
  mkdirSync(src, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeStubModules(src, checkout, state);
  applyRouterOverlay(checkout);

  const registryFile = path.join(checkout, "registry.json");
  writeFileSync(registryFile, `${JSON.stringify(firstPartyRegistry(), null, 2)}\n`);
  writeFileSync(
    path.join(state, "user-providers.json"),
    `${JSON.stringify({ version: 1, providers }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(state, "user-models.json"),
    `${JSON.stringify({ version: 1, models }, null, 2)}\n`,
  );

  process.env.CODEX_ROUTER_SOURCE_ROOT = checkout;
  process.env.MODEL_ROUTER_REGISTRY = registryFile;
  process.env.MODEL_ROUTER_STATE_DIR = state;
  process.env.MODEL_ROUTER_USER_PROVIDERS = path.join(state, "user-providers.json");
  process.env.MODEL_ROUTER_USER_MODELS = path.join(state, "user-models.json");

  const href = `${pathToFileURL(path.join(src, "model-registry.mjs")).href}?t=${Date.now()}-${Math.random()}`;
  return import(href);
}

test("user provider overlay merges a reseller without touching first-party config", async () => {
  const registry = await loadPatchedRegistry({ providers: [validUserProvider()] });
  assert.equal(registry.PROVIDERS.has("openrouter"), true);
  assert.equal(registry.PROVIDERS.has("my-reseller"), true);
  assert.equal(registry.PROVIDERS.get("my-reseller").baseUrl, "https://reseller.example/v1");
  assert.deepEqual([...registry.USER_PROVIDER_WARNINGS], []);
});

test("first-party provider ids cannot be overridden by the overlay", async () => {
  const override = {
    ...validUserProvider("openrouter"),
    displayName: "Hijacked",
    baseUrl: "https://evil.example/v1",
  };
  const registry = await loadPatchedRegistry({ providers: [override] });
  assert.equal(registry.PROVIDERS.get("openrouter").displayName, "OpenRouter");
  assert.match(registry.USER_PROVIDER_WARNINGS.join("\\n"), /first-party/);
});

test("broken overlay entries degrade with a warning", async () => {
  const broken = { id: "nope", kind: "oauth", displayName: "Nope", ownedBy: "x" };
  const registry = await loadPatchedRegistry({
    providers: [validUserProvider(), broken],
  });
  assert.equal(registry.PROVIDERS.has("my-reseller"), true);
  assert.equal(registry.PROVIDERS.has("nope"), false);
  assert.match(registry.USER_PROVIDER_WARNINGS.join("\\n"), /Skipped user provider/);
});

test("user models can target an overlay provider and requestProfile stays optional", async () => {
  const model = {
    slug: "my-reseller/demo-model",
    gatewayModel: "my-reseller-demo-model",
    upstreamModel: "demo-model",
    provider: "my-reseller",
    listed: true,
    displayName: "Demo",
    description: "User curated demo",
    priority: 10,
    defaultEffort: "high",
    reasoningLevels: [{ effort: "high", description: "Adaptive reasoning" }],
    contextWindow: 131072,
    autoCompact: 110000,
    inputModalities: ["text"],
    compHash: "my-reseller-demo-model-user-v1",
  };
  const registry = await loadPatchedRegistry({
    providers: [validUserProvider()],
    models: [model],
  });
  assert.equal(registry.MODEL_BY_SLUG.has("my-reseller/demo-model"), true);
  assert.equal(registry.MODEL_BY_SLUG.get("my-reseller/demo-model").requestProfile, undefined);
  assert.deepEqual([...registry.USER_MODEL_WARNINGS], []);
});

test("keyless loopback provider merges cleanly without a credential", async () => {
  const registry = await loadPatchedRegistry({ providers: [keylessUserProvider()] });
  assert.equal(registry.PROVIDERS.has("ollama-local"), true);
  assert.equal(registry.PROVIDERS.get("ollama-local").baseUrl, "http://127.0.0.1:11434/v1");
  assert.equal(registry.PROVIDERS.get("ollama-local").credential, undefined);
  assert.deepEqual([...registry.USER_PROVIDER_WARNINGS], []);
});

test("keyless entry carrying a credential is skipped with a warning", async () => {
  const entry = {
    ...keylessUserProvider(),
    credential: { environment: ["OLLAMA_API_KEY"], file: "ollama-key.secret" },
  };
  const registry = await loadPatchedRegistry({ providers: [entry] });
  assert.equal(registry.PROVIDERS.has("ollama-local"), false);
  assert.match(registry.USER_PROVIDER_WARNINGS.join("\n"), /must not declare a credential/);
});

test("keyless entry with a non-loopback baseUrl is skipped with a warning", async () => {
  const entry = keylessUserProvider("ollama-remote", "http://example.com:11434/v1");
  const registry = await loadPatchedRegistry({ providers: [entry] });
  assert.equal(registry.PROVIDERS.has("ollama-remote"), false);
  assert.match(registry.USER_PROVIDER_WARNINGS.join("\n"), /must use a loopback baseUrl/);
});

test("non-keyless entry with an http baseUrl is skipped with a warning", async () => {
  const entry = { ...validUserProvider("acme-http"), baseUrl: "http://api.acme.example/v1" };
  const registry = await loadPatchedRegistry({ providers: [entry] });
  assert.equal(registry.PROVIDERS.has("acme-http"), false);
  assert.match(registry.USER_PROVIDER_WARNINGS.join("\n"), /requires an HTTPS baseUrl/);
});

test("apply helper copies overlay files onto a temp checkout", () => {
  const checkout = mkdtempSync(path.join(os.tmpdir(), "orchestra-apply-"));
  mkdirSync(path.join(checkout, "src"), { recursive: true });
  const result = applyRouterOverlay(checkout);
  assert.equal(result.ok, true);
  assert.equal(
    readFileSync(path.join(checkout, "src", "user-providers.mjs"), "utf8"),
    readFileSync(path.join(OVERLAY_ROOT, "src", "user-providers.mjs"), "utf8"),
  );
});
