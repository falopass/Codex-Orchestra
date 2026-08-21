#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OVERLAY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const FILES = ["src/user-providers.mjs", "src/model-registry.mjs"];

export function applyRouterOverlay(checkoutRoot) {
  if (!checkoutRoot || !path.isAbsolute(checkoutRoot)) {
    throw new Error("applyRouterOverlay requires an absolute managed checkout path");
  }
  const srcDir = path.join(checkoutRoot, "src");
  if (!existsSync(srcDir)) {
    throw new Error(`Managed checkout is missing src/: ${checkoutRoot}`);
  }
  const applied = [];
  for (const relative of FILES) {
    const from = path.join(OVERLAY_ROOT, relative);
    const to = path.join(checkoutRoot, relative);
    if (!existsSync(from)) {
      throw new Error(`Overlay source missing: ${from}`);
    }
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(from, to);
    applied.push(relative);
  }
  writeFileSync(
    path.join(checkoutRoot, ".orchestra-overlay.json"),
    `${JSON.stringify(
      {
        version: 1,
        name: "user-providers",
        files: applied,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { ok: true, checkoutRoot, files: applied };
}

const invokedDirectly =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (invokedDirectly) {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: node plugins/codex-orchestra/scripts/router-overlay/apply.mjs <absolute-managed-checkout>");
    process.exit(2);
  }
  const result = applyRouterOverlay(path.resolve(target));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
