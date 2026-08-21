import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { protectPrivateFile } from "./file-security.mjs";
import { STATE_DIR } from "./paths.mjs";

// User-registered OpenAI-compatible providers live outside config/ so a
// checkout update never discards them. The file is metadata only: id, base
// URL, credential filenames and environment *names*. Secret values stay in
// the Router helper and are never stored here.

export const USER_PROVIDERS_PATH =
  process.env.MODEL_ROUTER_USER_PROVIDERS || path.join(STATE_DIR, "user-providers.json");

export function readUserProviders() {
  if (!existsSync(USER_PROVIDERS_PATH)) return [];
  try {
    const payload = JSON.parse(readFileSync(USER_PROVIDERS_PATH, "utf8"));
    return Array.isArray(payload?.providers) ? payload.providers : [];
  } catch {
    return [];
  }
}

export function writeUserProviders(providers) {
  mkdirSync(path.dirname(USER_PROVIDERS_PATH), { recursive: true, mode: 0o700 });
  const temporary = `${USER_PROVIDERS_PATH}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify({ version: 1, providers }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    protectPrivateFile(temporary);
    renameSync(temporary, USER_PROVIDERS_PATH);
    protectPrivateFile(USER_PROVIDERS_PATH);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
  return USER_PROVIDERS_PATH;
}
