export type HealthStatus =
  "healthy" | "degraded" | "missing" | "unhealthy" | "unknown";
export type CredentialStatus =
  "configured" | "missing" | "invalid" | "expired" | "unknown";
export type AgentRole = "root" | "frontend" | "engineer";
export type FrontendStrategyMode = "auto" | "pinned";
export type UsageSource = "provider" | "router" | "estimate";
export type BillingType = "subscription" | "payg" | "native" | "unknown";
export type RouterOperation =
  | "doctor"
  | "status"
  | "providers"
  | "models"
  | "refresh-catalog"
  | "update-check"
  | "update"
  | "rollback"
  | "support-bundle"
  | "connect-provider"
  | "disconnect-provider"
  | "upsert-user-provider"
  | "list-providers"
  | "enable-provider"
  | "disable-provider"
  | "upsert-user-models"
  | "set-model-visible"
  | "curate-models"
  | "set-flag";

export interface CodexInstall {
  detected: boolean;
  executable?: string;
  version?: string;
  home?: string;
  configPath?: string;
  configDetected: boolean;
  configHealth: HealthStatus;
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
  /** Observed loopback process/runtime, never a user or home path. */
  runtime?: RouterRuntimeStatus;
}

export type RouterConnectionIssue =
  | "offline"
  | "connection-refused"
  | "unhealthy"
  | "missing-runtime"
  | "active-execution";

export interface RouterRuntimeStatus {
  detected: boolean;
  healthy: boolean;
  service: "running" | "stopped" | "unknown";
  ports: number[];
  identityOk: boolean;
  issue?: RouterConnectionIssue;
  message: string;
  canRestart: boolean;
  requiresConfirmation: boolean;
  activeExecution: boolean;
}

export interface RouterHealthResult {
  ok: boolean;
  healthy: boolean;
  service: "running" | "stopped" | "unknown";
  ports: number[];
  identityOk: boolean;
  issue?: RouterConnectionIssue;
  message: string;
  canRestart: boolean;
  requiresConfirmation: boolean;
  activeExecution: boolean;
  redacted: true;
}

export type RouterRestartPhase =
  "checking" | "starting" | "waiting" | "healthy" | "restored" | "failed";

export interface RouterRestartResult {
  ok: boolean;
  restarted: boolean;
  phase: RouterRestartPhase;
  message: string;
  health: RouterHealthResult;
  logsAvailable: boolean;
  redacted: true;
}

export interface RouterLogLine {
  source: "router.err" | "router.out";
  text: string;
}

export interface RouterLogsResult {
  ok: boolean;
  available: boolean;
  lines: RouterLogLine[];
  message: string;
  redacted: true;
}

export interface Provider {
  id: string;
  name: string;
  family: "kimi" | "xai" | "openai" | "other";
  credential: CredentialStatus;
  enabled: boolean;
  billingType: BillingType;
  billingNote: string;
  baseUrl?: string;
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
  autoCompactionThreshold?: number;
  upstreamModel?: string;
}

export type UserProviderProtocol = "openai" | "anthropic" | "openai-responses";

// Credential descriptors only. The filename and environment variable names
// point at where the Router resolves a key; secret values never travel here.
export interface UserProviderCredential {
  file: string;
  environment: string[];
}

export interface UserProviderRemoteEntry {
  id: string;
  displayName: string;
  kind: "openai-compatible";
  ownedBy: string;
  baseUrl: string;
  protocol?: UserProviderProtocol;
  keyless?: false;
  credential: UserProviderCredential;
}

export interface UserProviderKeylessEntry {
  id: string;
  displayName: string;
  kind: "openai-compatible";
  ownedBy: string;
  baseUrl: string;
  protocol?: UserProviderProtocol;
  keyless: true;
}

export type UserProviderEntry =
  UserProviderRemoteEntry | UserProviderKeylessEntry;

export interface UserModelEntry {
  slug: string;
  upstreamModel?: string;
  displayName?: string;
  contextWindow?: number;
  inputModalities?: string[];
  // Router request profile name. A string, never an object.
  requestProfile?: string;
}

export interface FrontendModelTarget {
  provider: string;
  upstreamModel: string;
}

export interface FrontendModelStrategy {
  mode: FrontendStrategyMode;
  pinnedModel?: FrontendModelTarget;
}

export interface FrontendModelCandidate {
  key: "qwen" | "kimi";
  label: string;
  provider: string;
  providerLabel: string;
  upstreamModel: string;
  purpose: string;
  reasoningEffort: "high" | "max";
}

export interface ModelBinding {
  binding: "root" | "frontend" | "engineer";
  label: string;
  targetFamily: string;
  preferredProvider: string;
  preferredUpstreamModel: string;
  candidateModelIds: string[];
  candidateTargets?: FrontendModelTarget[];
  desiredLabel: string;
}

export interface AgentDefinition {
  id: string;
  name: string;
  role: AgentRole;
  description: string;
  providerId: string;
  modelId?: string;
  modelTarget?: FrontendModelTarget;
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
  billingType?: BillingType;
  sourceLabel?: string;
  sourceUrl?: string;
}

export interface PricingImportPreview {
  token: string;
  count: number;
  providers: string[];
  versions: string[];
  effectiveFrom: string;
  effectiveTo: string;
  subscriptionRules: number;
  paygRules: number;
  writesCredentialValues: false;
}

export interface LogEvent {
  id: string;
  timestamp: string;
  level: "info" | "warn" | "error";
  operation: string;
  message: string;
  redacted: true;
}

export interface FeatureFlags {
  appServer: boolean;
  mcp: boolean;
  experimentalWorktrees: boolean;
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
  backupPath?: string;
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

export interface WorktreeStatus {
  ok: boolean;
  role: "frontend" | "engineer";
  slug: string;
  projectRoot?: string;
  target: string;
  state: "not-created" | "active" | "missing";
  recorded: boolean;
  baseRef?: string;
  worktreeHead?: string;
  projectHead?: string;
  baseDrifted?: boolean;
  dirty: boolean;
  commitsAhead: number;
  changedFiles: string[];
  canRemoveSafely: boolean;
  requiresManualMerge: boolean;
  merge?: string;
  redacted: true;
}

export interface WorktreePreview {
  ok: boolean;
  role: "frontend" | "engineer";
  slug: string;
  projectRoot: string;
  target: string;
  command: string;
  requiresConfirmation: true;
  experimental: true;
  merge: string;
}

export interface PreviewFile {
  path: string;
  action: "create" | "update" | "unchanged";
  diff: string;
  /** Optimistic concurrency token for the reviewed managed file. */
  currentHash?: string;
  /** Generated managed content only; foreign project content is never included. */
  contentPreview?: string;
  safe: boolean;
}

export interface LiveCheckPreview {
  provider: string;
  model: string;
  /**
   * `compatibility` runs Router's full billed suite (basic, streaming, tools
   * and compaction). `agent-behavior` runs the pinned Router's real two-turn
   * `codex exec` capability probe.
   */
  test: "compatibility" | "agent-behavior";
  coveredChecks: string[];
  billingType: "subscription" | "payg";
  billingSource: string;
  estimatedCostNote: string;
  requiresConfirmation: true;
}

export interface DelegationEvidence {
  id: string;
  runId: string;
  occurredAt: string;
  rootModel: string;
  requestedRole: "frontend" | "engineer" | "visual" | "unspecified";
  requestedWorkerModel?: string;
  action:
    "spawn-agent" | "send-message" | "follow-up" | "wait" | "interrupt-agent";
  status: "completed" | "failed" | "interrupted" | "declined" | "unknown";
  childCreated: boolean;
  rootMediated: true;
  source: "codex-app-server";
  redacted: true;
}

export interface OrchestraSnapshot {
  appVersion: string;
  codex: CodexInstall;
  router: RouterInstall;
  providers: Provider[];
  models: Model[];
  frontendStrategy?: FrontendModelStrategy;
  agents: AgentDefinition[];
  projects: ProjectProfile[];
  health?: HealthReport;
  healthHistory?: HealthReport[];
  usage: UsageEvent[];
  budget: Budget;
  backups: Backup[];
  update: UpdatePlan;
  diagnostics: DiagnosticItem[];
  pricingRules?: PricingRule[];
  delegationEvidence?: DelegationEvidence[];
  logs?: LogEvent[];
  featureFlags?: FeatureFlags;
}
