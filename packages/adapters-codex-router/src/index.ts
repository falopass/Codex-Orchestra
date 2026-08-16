import type { RouterOperation } from "@codex-orchestra/contracts";

export const ROUTER_ENGINE_NAME = "codex-router";
export const ROUTER_PINNED_TAG = "v0.4.0-beta.3";
export const ROUTER_PINNED_COMMIT = "a1be46aa02426d87a9e24e114ce8c22619c63c7a";

export const ROUTER_READ_OPERATIONS = [
  "doctor",
  "status",
  "providers",
  "models",
  "update-check",
] as const satisfies readonly RouterOperation[];

export const ROUTER_MUTATING_OPERATIONS = [
  "refresh-catalog",
  "update",
  "rollback",
  "support-bundle",
] as const satisfies readonly RouterOperation[];

export interface RouterAdapterContract {
  engine: typeof ROUTER_ENGINE_NAME;
  ownsTranslation: false;
  transport: "local-process";
  bindAddress: "127.0.0.1";
  confirmMutations: true;
}

export const ROUTER_ADAPTER_CONTRACT: RouterAdapterContract = {
  engine: ROUTER_ENGINE_NAME,
  ownsTranslation: false,
  transport: "local-process",
  bindAddress: "127.0.0.1",
  confirmMutations: true,
};

export function routerArgs(operation: RouterOperation, targetWrapper: boolean) {
  const namespaced: Record<string, string[]> = {
    doctor: ["codex", "doctor"],
    status: ["codex", "status"],
    providers: ["codex", "providers"],
    "refresh-catalog": ["codex", "refresh-catalog"],
    "support-bundle": ["codex", "support-bundle"],
    models: [],
    "update-check": [],
    update: [],
    rollback: [],
  };
  const args = namespaced[operation] ?? [];
  return targetWrapper ? args : args.slice(1);
}
