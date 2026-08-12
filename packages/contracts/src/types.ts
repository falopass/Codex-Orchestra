export type HealthStatus =
  "healthy" | "degraded" | "missing" | "unhealthy" | "unknown";
export type CredentialStatus =
  "configured" | "missing" | "invalid" | "expired" | "unknown";
export type AgentRole = "root" | "frontend" | "engineer";
export type UsageSource = "provider" | "router" | "estimate";
export type RouterOperation =
  | "doctor"
  | "status"
  | "providers"
  | "models"
  | "refresh-catalog"
  | "update-check"
  | "update"
  | "rollback"
  | "support-bundle";

export interface CodexInstall {
  detected: boolean;
  executable?: string;
  version?: string;
  home?: string;
  login: CredentialStatus;
  nativeModelsAvailable: boolean;
  source: "path" | "windows-app" | "fixture" | "unknown";
}

export interface RouterInstall {
  detected: boolean;
  root?: string;
  version?: string;
  pinnedRef?: string;
  health: HealthStatus;
  ports: number[];
  service: "running" | "stopped" | "unknown";
}

export interface Provider {
  id: string;
  name: string;
  family: "kimi" | "xai" | "openai" | "other";
  credential: CredentialStatus;
  enabled: boolean;
  billingNote: string;
  lastChecked?: string;
}

export interface Model {
  id: string;
  label: string;
  providerId: string;
  available: boolean;
  supportsStreaming: boolean;
  supportsTools: boolean;
  supportsSubagents: boolean;
  reasoningEfforts: string[];
  source: "registry" | "curated" | "native" | "fixture";
  contextWindow?: number;
}

export interface ModelBinding {
  binding: "root" | "frontend" | "engineer";
  label: string;
  targetFamily: string;
  preferredProvider: string;
  candidateModelIds: string[];
  desiredLabel: string;
}

export interface AgentDefinition {
  id: string;
  name: string;
  role: AgentRole;
  description: string;
  providerId: string;
  modelId?: string;
  reasoningEffort: string;
  permissions: string[];
  routingHints: string[];
  retryLimit: number;
  ownershipPaths: string[];
  sharedPaths: string[];
  health: HealthStatus;
  lastTest?: string;
  estimatedCostPerMillion?: number;
}

export interface ProjectProfile {
  id: string;
  name: string;
  path: string;
  stack: string[];
  codexHome?: string;
  activeTeam: string;
  ownership: Record<AgentRole, string[]>;
  sharedPaths: string[];
  routingPolicy: string;
  knownTests: string[];
  lintScript?: string;
  typecheckScript?: string;
  status: HealthStatus;
  usageEventCount: number;
}

export interface RoutingPolicy {
  id: string;
  name: string;
  directTrivialTasks: boolean;
  retryLimit: number;
  sequentialOnOverlap: boolean;
  worktreesEnabled: boolean;
  rootOwnsShared: boolean;
}

export interface HealthCheck {
  id: string;
  label: string;
  status: HealthStatus;
  detail: string;
  remediation?: string;
  checkedAt: string;
  sensitive: boolean;
}

export interface HealthReport {
  id: string;
  status: HealthStatus;
  startedAt: string;
  completedAt?: string;
  checks: HealthCheck[];
  redacted: boolean;
}

export interface UsageEvent {
  id: string;
  timestamp: string;
  projectId?: string;
  provider: string;
  model: string;
  role?: AgentRole;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  providerCost?: number;
  estimatedCost?: number;
  source: UsageSource;
  runId?: string;
}

export interface PricingRule {
  provider: string;
  model: string;
  currency: "USD" | "CLP";
  inputPerMillion: number;
  cachedInputPerMillion: number;
  outputPerMillion: number;
  effectiveFrom: string;
  version: string;
  sourceUrl?: string;
}

export interface CostBreakdown {
  currency: "USD" | "CLP";
  providerReported: number;
  routerReported: number;
  estimated: number;
  totalDisplay: number;
  label: "provider-reported" | "router-reported" | "estimated" | "mixed";
}

export interface Budget {
  monthlyLimit: number;
  warningAtPercent: number;
  criticalAtPercent: number;
  currency: "USD" | "CLP";
}

export interface Backup {
  id: string;
  target: string;
  createdAt: string;
  reason: "before-write" | "before-update" | "manual" | "rollback";
  restorable: boolean;
  redacted: boolean;
}

export interface ManagedConfig {
  path: string;
  managedSection: string;
  currentHash?: string;
  previewHash?: string;
  hasForeignContent: boolean;
  lastAppliedAt?: string;
}

export interface UpdatePlan {
  currentRef?: string;
  targetRef: string;
  targetVersion?: string;
  requiresBackup: boolean;
  healthGate: boolean;
  rollbackRef?: string;
  status: "available" | "current" | "blocked" | "unknown";
  notes: string[];
}

export interface DiagnosticItem {
  id: string;
  category:
    | "codex"
    | "router"
    | "provider"
    | "model"
    | "agent"
    | "process"
    | "config"
    | "network";
  label: string;
  status: HealthStatus;
  value: string;
  detail: string;
  redacted: boolean;
}

export interface ScopePlan {
  parallel: boolean;
  reason: string;
  assignments: Record<AgentRole, string[]>;
  conflicts: string[];
  worktreeRecommended: boolean;
}

export interface PreviewFile {
  path: string;
  action: "create" | "update" | "unchanged";
  diff: string;
  safe: boolean;
}

export interface LiveCheckPreview {
  provider: string;
  model: string;
  test: "basic" | "streaming" | "tool-use" | "agent-behavior";
  estimatedCostNote: string;
  requiresConfirmation: true;
}

export interface OrchestraSnapshot {
  appVersion: string;
  codex: CodexInstall;
  router: RouterInstall;
  providers: Provider[];
  models: Model[];
  agents: AgentDefinition[];
  projects: ProjectProfile[];
  health?: HealthReport;
  usage: UsageEvent[];
  budget: Budget;
  backups: Backup[];
  update: UpdatePlan;
  diagnostics: DiagnosticItem[];
}
