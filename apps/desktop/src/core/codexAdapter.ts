import type {
  CodexInstall,
  HealthReport,
  PreviewFile,
} from "@codex-orchestra/contracts";
import { invokeCommand } from "./invoke";

export interface CodexAdapter {
  detect(): Promise<CodexInstall>;
  runHealth(): Promise<HealthReport>;
  previewManagedChanges(path: string, existing: string): Promise<PreviewFile[]>;
}

export const codexAdapter: CodexAdapter = {
  async detect() {
    const snapshot = await invokeCommand<{ codex: CodexInstall }>(
      "get_snapshot",
    );
    return snapshot.codex;
  },
  runHealth() {
    return invokeCommand<HealthReport>("run_health_check");
  },
  previewManagedChanges(path, existing) {
    return invokeCommand<PreviewFile[]>("managed_preview", { path, existing });
  },
};
