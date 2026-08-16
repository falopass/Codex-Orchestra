import type { OrchestraSnapshot } from "@codex-orchestra/contracts";

export type View =
  | "overview"
  | "setup"
  | "team"
  | "projects"
  | "run"
  | "diagnostics"
  | "usage"
  | "system";

export interface ViewContext {
  snapshot: OrchestraSnapshot;
  setSnapshot: (snapshot: OrchestraSnapshot) => void;
  navigate: (view: View) => void;
  notice: (message: string) => void;
}
