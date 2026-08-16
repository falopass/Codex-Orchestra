import type {
  RouterOperation,
  RouterInstall,
  RouterHealthResult,
  RouterRestartResult,
  RouterLogsResult,
  Provider,
  Model,
  UpdatePlan,
  LiveCheckPreview,
  FeatureFlags,
  FrontendModelStrategy,
  WorktreePreview,
  WorktreeStatus,
} from "@codex-orchestra/contracts";
import { invokeCommand } from "./invoke";

export interface RouterEngine {
  getInstall(): Promise<RouterInstall>;
  status(): Promise<RouterHealthResult>;
  health(): Promise<RouterHealthResult>;
  start(confirm?: boolean): Promise<RouterRestartResult>;
  restart(confirm?: boolean): Promise<RouterRestartResult>;
  logs(): Promise<RouterLogsResult>;
  install(confirm: boolean): Promise<unknown>;
  openGuidedSetup(): Promise<unknown>;
  openProviderHelper(provider: string): Promise<unknown>;
  openModelCuration(provider: string): Promise<unknown>;
  applyPickerAllowlist(): Promise<unknown>;
  setProviderEnabled(
    provider: string,
    enabled: boolean,
    confirm?: boolean,
  ): Promise<unknown>;
  saveFeatureFlags(flags: FeatureFlags, confirm?: boolean): Promise<unknown>;
  saveFrontendStrategy(strategy: FrontendModelStrategy): Promise<unknown>;
  run(operation: RouterOperation, confirm?: boolean): Promise<unknown>;
  checkUpdate(): Promise<UpdatePlan>;
  listProviders(): Promise<Provider[]>;
  listModels(): Promise<Model[]>;
  previewLiveCheck(
    provider: string,
    model: string,
    test?: LiveCheckPreview["test"],
  ): Promise<unknown>;
  runLiveCheck(
    provider: string,
    model: string,
    test: LiveCheckPreview["test"],
  ): Promise<unknown>;
  probeAppServer(confirm?: boolean): Promise<unknown>;
  worktreePreview(
    projectPath: string,
    role: "frontend" | "engineer",
    slug: string,
  ): Promise<WorktreePreview>;
  createWorktree(
    projectPath: string,
    role: "frontend" | "engineer",
    slug: string,
    confirm?: boolean,
  ): Promise<unknown>;
  listWorktrees(projectPath: string): Promise<WorktreeStatus[]>;
  worktreeStatus(
    projectPath: string,
    role: "frontend" | "engineer",
    slug: string,
  ): Promise<WorktreeStatus>;
  removeWorktree(
    projectPath: string,
    role: "frontend" | "engineer",
    slug: string,
    force?: boolean,
    confirm?: boolean,
  ): Promise<{ ok: boolean; removed: boolean; recoveryPath?: string }>;
}

/**
 * The renderer knows this boundary, not router command names or shell syntax.
 * Native Tauri maps the same operations to allow-listed Rust commands.
 */
export const routerEngine: RouterEngine = {
  async getInstall() {
    const snapshot = await invokeCommand<{ router: RouterInstall }>(
      "get_snapshot_fast",
    );
    return snapshot.router;
  },
  status() {
    return invokeCommand<RouterHealthResult>("router_runtime_status");
  },
  health() {
    return invokeCommand<RouterHealthResult>("router_runtime_health");
  },
  start(confirm = true) {
    return invokeCommand<RouterRestartResult>("router_runtime_start", {
      confirm,
    });
  },
  restart(confirm = true) {
    return invokeCommand<RouterRestartResult>("router_runtime_restart", {
      confirm,
    });
  },
  logs() {
    return invokeCommand<RouterLogsResult>("router_runtime_logs");
  },
  install(confirm) {
    return invokeCommand("install_router", { confirm });
  },
  openGuidedSetup() {
    return invokeCommand("open_router_setup");
  },
  openProviderHelper(provider) {
    return invokeCommand("open_provider_helper", { provider });
  },
  openModelCuration(provider) {
    return invokeCommand("open_model_curation", { provider });
  },
  applyPickerAllowlist() {
    return invokeCommand("apply_codex_picker_allowlist_command");
  },
  setProviderEnabled(provider, enabled, confirm = true) {
    return invokeCommand("set_provider_enabled", {
      provider,
      enabled,
      confirm,
    });
  },
  saveFeatureFlags(flags, confirm = true) {
    return invokeCommand("save_feature_flags", { flags, confirm });
  },
  saveFrontendStrategy(strategy) {
    return invokeCommand("save_frontend_strategy", { strategy });
  },
  run(operation, confirm = false) {
    return invokeCommand("router_operation", { operation, confirm });
  },
  async checkUpdate() {
    return invokeCommand<UpdatePlan>("router_operation", {
      operation: "update-check",
    });
  },
  async listProviders() {
    const snapshot = await invokeCommand<{ providers: Provider[] }>(
      "get_snapshot_fast",
    );
    return snapshot.providers;
  },
  async listModels() {
    const snapshot = await invokeCommand<{ models: Model[] }>(
      "get_snapshot_fast",
    );
    return snapshot.models;
  },
  previewLiveCheck(provider, model, test = "compatibility") {
    return invokeCommand("live_check_preview", {
      provider,
      model,
      test,
    });
  },
  runLiveCheck(provider, model, test) {
    return invokeCommand("run_live_check", {
      provider,
      model,
      test,
      confirm: true,
    });
  },
  probeAppServer(confirm = true) {
    return invokeCommand("app_server_probe", { confirm });
  },
  worktreePreview(projectPath, role, slug) {
    return invokeCommand("worktree_preview", { projectPath, role, slug });
  },
  createWorktree(projectPath, role, slug, confirm = true) {
    return invokeCommand("create_worktree", {
      projectPath,
      role,
      slug,
      confirm,
    });
  },
  listWorktrees(projectPath) {
    return invokeCommand("list_worktrees", { projectPath });
  },
  worktreeStatus(projectPath, role, slug) {
    return invokeCommand("worktree_status", { projectPath, role, slug });
  },
  removeWorktree(projectPath, role, slug, force = false, confirm = true) {
    return invokeCommand("remove_worktree", {
      projectPath,
      role,
      slug,
      force,
      confirm,
    });
  },
};
