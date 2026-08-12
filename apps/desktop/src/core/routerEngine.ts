import type {
  RouterOperation,
  RouterInstall,
  Provider,
  Model,
  UpdatePlan,
} from "@codex-orchestra/contracts";
import { invokeCommand } from "./invoke";

export interface RouterEngine {
  getInstall(): Promise<RouterInstall>;
  run(operation: RouterOperation): Promise<unknown>;
  checkUpdate(): Promise<UpdatePlan>;
  listProviders(): Promise<Provider[]>;
  listModels(): Promise<Model[]>;
  previewLiveCheck(provider: string, model: string): Promise<unknown>;
}

/**
 * The renderer knows this boundary, not router command names or shell syntax.
 * Native Tauri maps the same operations to allow-listed Rust commands.
 */
export const routerEngine: RouterEngine = {
  async getInstall() {
    const snapshot = await invokeCommand<{ router: RouterInstall }>(
      "get_snapshot",
    );
    return snapshot.router;
  },
  run(operation) {
    return invokeCommand("router_operation", { operation });
  },
  async checkUpdate() {
    return invokeCommand<UpdatePlan>("router_operation", {
      operation: "update-check",
    });
  },
  async listProviders() {
    const snapshot = await invokeCommand<{ providers: Provider[] }>(
      "get_snapshot",
    );
    return snapshot.providers;
  },
  async listModels() {
    const snapshot = await invokeCommand<{ models: Model[] }>("get_snapshot");
    return snapshot.models;
  },
  previewLiveCheck(provider, model) {
    return invokeCommand("live_check_preview", {
      provider,
      model,
      test: "tool-use",
    });
  },
};
