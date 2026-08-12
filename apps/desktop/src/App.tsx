import { useEffect, useMemo, useState } from "react";
import type {
  AgentDefinition,
  DiagnosticItem,
  HealthReport,
  LiveCheckPreview,
  OrchestraSnapshot,
  PreviewFile,
  ProjectProfile,
  ScopePlan,
} from "@codex-orchestra/contracts";
import {
  aggregateUsage,
  calculateEstimate,
  renderAgentToml,
  renderManagedBlock,
  renderRoutingSkill,
  resolveModelBinding,
} from "@codex-orchestra/contracts";
import { invokeCommand } from "./core/invoke";

type View =
  | "dashboard"
  | "setup"
  | "team"
  | "projects"
  | "diagnostics"
  | "usage"
  | "advanced";

const navItems: { id: View; label: string; meta: string }[] = [
  { id: "dashboard", label: "Overview", meta: "01" },
  { id: "setup", label: "Setup", meta: "02" },
  { id: "team", label: "Team builder", meta: "03" },
  { id: "projects", label: "Projects", meta: "04" },
  { id: "diagnostics", label: "Diagnostics", meta: "05" },
  { id: "usage", label: "Usage & cost", meta: "06" },
  { id: "advanced", label: "Advanced", meta: "07" },
];

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function statusLabel(status: string) {
  return status === "healthy"
    ? "Healthy"
    : status === "degraded"
      ? "Needs attention"
      : status === "missing"
        ? "Not configured"
        : status === "unknown"
          ? "Not verified"
          : "Unhealthy";
}

function StatusDot({ status }: { status: string }) {
  return <span className={`status-dot status-${status}`} aria-hidden="true" />;
}

function Badge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "good" | "warn" | "bad";
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

function SectionHeading({
  eyebrow,
  title,
  detail,
  action,
}: {
  eyebrow: string;
  title: string;
  detail: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="section-heading">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="section-detail">{detail}</p>
      </div>
      {action}
    </div>
  );
}

function Metric({
  label,
  value,
  detail,
  tone = "cyan",
}: {
  label: string;
  value: string;
  detail: string;
  tone?: string;
}) {
  return (
    <article className={`metric metric-${tone}`}>
      <p className="eyebrow">{label}</p>
      <strong>{value}</strong>
      <span>{detail}</span>
    </article>
  );
}

function HealthCard({
  label,
  value,
  detail,
  status,
  icon,
}: {
  label: string;
  value: string;
  detail: string;
  status: string;
  icon: string;
}) {
  return (
    <article className="health-card">
      <div className="health-card-top">
        <span className="signal-icon">{icon}</span>
        <StatusDot status={status} />
      </div>
      <p className="eyebrow">{label}</p>
      <h3>{value}</h3>
      <p className="muted">{detail}</p>
      <div className="health-state">
        <StatusDot status={status} /> {statusLabel(status)}
      </div>
    </article>
  );
}

function App() {
  const [view, setView] = useState<View>("dashboard");
  const [snapshot, setSnapshot] = useState<OrchestraSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  async function loadSnapshot() {
    setLoading(true);
    setError(null);
    try {
      const next = await invokeCommand<OrchestraSnapshot>("get_snapshot");
      setSnapshot(next);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "No fue posible leer el estado local.",
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadSnapshot();
  }, []);

  function navigate(next: View) {
    setView(next);
    setSidebarOpen(false);
    setNotice(null);
  }

  if (loading)
    return (
      <div className="app-loading">
        <div className="loading-mark">CO</div>
        <p>
          Reading local control plane<span className="loading-dots">...</span>
        </p>
      </div>
    );
  if (error || !snapshot)
    return (
      <div className="app-loading">
        <div className="loading-mark loading-error">!</div>
        <h1>Control plane unavailable</h1>
        <p>{error ?? "No snapshot returned."}</p>
        <button
          className="button button-primary"
          onClick={() => void loadSnapshot()}
        >
          Try again
        </button>
      </div>
    );

  const content = (
    <>
      {notice && (
        <div className="toast" role="status">
          <StatusDot status="healthy" />
          {notice}
          <button
            className="icon-button"
            aria-label="Cerrar aviso"
            onClick={() => setNotice(null)}
          >
            ×
          </button>
        </div>
      )}
      {view === "dashboard" && (
        <Dashboard
          snapshot={snapshot}
          onNavigate={navigate}
          onHealth={async () => {
            const report =
              await invokeCommand<HealthReport>("run_health_check");
            setSnapshot((current) =>
              current ? { ...current, health: report } : current,
            );
            setNotice(
              "Health check finished. Results are redacted by default.",
            );
          }}
        />
      )}
      {view === "setup" && (
        <Setup
          snapshot={snapshot}
          onSnapshot={setSnapshot}
          onNavigate={navigate}
          onNotice={setNotice}
        />
      )}
      {view === "team" && (
        <TeamBuilder snapshot={snapshot} onNotice={setNotice} />
      )}
      {view === "projects" && (
        <Projects
          snapshot={snapshot}
          onSnapshot={setSnapshot}
          onNotice={setNotice}
        />
      )}
      {view === "diagnostics" && (
        <Diagnostics
          snapshot={snapshot}
          onSnapshot={setSnapshot}
          onNotice={setNotice}
        />
      )}
      {view === "usage" && <Usage snapshot={snapshot} />}
      {view === "advanced" && (
        <Advanced snapshot={snapshot} onNotice={setNotice} />
      )}
    </>
  );

  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
        <div className="brand">
          <div className="brand-mark">CO</div>
          <div>
            <strong>
              Codex
              <br />
              Orchestra
            </strong>
            <span>Control plane / 0.1.0</span>
          </div>
        </div>
        <div className="sidebar-label">Workspace</div>
        <nav aria-label="Primary navigation">
          {navItems.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${view === item.id ? "nav-active" : ""}`}
              onClick={() => navigate(item.id)}
            >
              <span className="nav-meta">{item.meta}</span>
              <span>{item.label}</span>
              {item.id === "diagnostics" &&
                snapshot.diagnostics.some(
                  (item) => item.status === "missing",
                ) && <i className="nav-alert" aria-label="Needs attention" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-label">Current team</div>
          <div className="team-mini">
            <div className="avatar avatar-sol">S</div>
            <div>
              <strong>Sol / Root</strong>
              <span>native lead</span>
            </div>
            <StatusDot status="healthy" />
          </div>
          <div className="team-mini">
            <div className="avatar avatar-kimi">K</div>
            <div>
              <strong>Kimi / Frontend</strong>
              <span>kimi-api/kimi-k3</span>
            </div>
            <StatusDot status="degraded" />
          </div>
          <div className="team-mini">
            <div className="avatar avatar-grok">G</div>
            <div>
              <strong>Grok / Engineer</strong>
              <span>curation pending</span>
            </div>
            <StatusDot status="missing" />
          </div>
        </div>
        <div className="sidebar-footer">
          <span className="local-lock">⌁</span>
          <span>Local only · no telemetry</span>
        </div>
      </aside>
      <button
        className="mobile-menu"
        aria-label="Abrir navegación"
        onClick={() => setSidebarOpen((open) => !open)}
      >
        ☰
      </button>
      <main className="main-content">
        <header className="topbar">
          <div>
            <span className="topbar-context">
              ORCHESTRA / {view.toUpperCase()}
            </span>
            <span className="topbar-caption">
              Codex remains your execution surface
            </span>
          </div>
          <div className="topbar-actions">
            <Badge tone="good">
              <StatusDot status="healthy" /> Local control plane
            </Badge>
            <button className="avatar-user" aria-label="Perfil local">
              DB
            </button>
          </div>
        </header>
        {content}
      </main>
    </div>
  );
}

function Dashboard({
  snapshot,
  onNavigate,
  onHealth,
}: {
  snapshot: OrchestraSnapshot;
  onNavigate: (view: View) => void;
  onHealth: () => Promise<void>;
}) {
  const cost = aggregateUsage(snapshot.usage);
  const configuredProviders = snapshot.providers.filter(
    (provider) => provider.credential === "configured",
  ).length;
  const attention = snapshot.diagnostics.filter(
    (item) => item.status === "missing" || item.status === "unhealthy",
  ).length;
  return (
    <div className="view-stack">
      <SectionHeading
        eyebrow="Operational overview · 12 Aug 2026"
        title="Keep the orchestra in tune."
        detail="A quiet control plane for Codex Desktop, its router and the team around Sol."
        action={
          <button
            className="button button-primary"
            onClick={() => void onHealth()}
          >
            <span>↗</span> Run full health check
          </button>
        }
      />
      <div className="metrics-grid">
        <Metric
          label="System posture"
          value={
            attention
              ? `${attention} item${attention === 1 ? "" : "s"}`
              : "All clear"
          }
          detail={attention ? "requires local action" : "last run passed"}
          tone={attention ? "amber" : "green"}
        />
        <Metric
          label="This month"
          value={formatCurrency(cost.totalDisplay)}
          detail={`${cost.label} · ${snapshot.usage.length} events`}
        />
        <Metric
          label="Router engine"
          value={snapshot.router.version ?? "Unknown"}
          detail={`pinned · ${snapshot.router.service}`}
          tone="violet"
        />
        <Metric
          label="Projects"
          value={String(snapshot.projects.length).padStart(2, "0")}
          detail="local profiles"
          tone="slate"
        />
      </div>
      <section className="dashboard-grid">
        <div className="panel hero-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Control plane status</p>
              <h2>Native where it matters.</h2>
            </div>
            <span className="panel-index">A / 01</span>
          </div>
          <div className="system-line">
            <div className="system-node node-codex">
              <span className="node-symbol">C</span>
              <div>
                <strong>Codex Desktop</strong>
                <span>
                  {snapshot.codex.detected
                    ? "Detected · native surface"
                    : "Not detected"}
                </span>
              </div>
              <StatusDot
                status={snapshot.codex.detected ? "healthy" : "missing"}
              />
            </div>
            <div className="connector">
              <span>execution</span>
            </div>
            <div className="system-node node-router">
              <span className="node-symbol">R</span>
              <div>
                <strong>Codex Router</strong>
                <span>
                  {snapshot.router.ports.length} loopback services ·{" "}
                  {snapshot.router.pinnedRef}
                </span>
              </div>
              <StatusDot status={snapshot.router.health} />
            </div>
          </div>
          <div className="hero-rule" />
          <div className="hero-footer">
            <span>
              <StatusDot status="healthy" /> GPT native stays untouched
            </span>
            <span>
              <StatusDot status={configuredProviders ? "healthy" : "missing"} />{" "}
              {configuredProviders}/2 external providers ready
            </span>
            <button
              className="text-button"
              onClick={() => onNavigate("diagnostics")}
            >
              Inspect diagnostics →
            </button>
          </div>
        </div>
        <div className="panel health-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Provider health</p>
              <h2>Connections</h2>
            </div>
            <button
              className="icon-button"
              aria-label="Open diagnostics"
              onClick={() => onNavigate("diagnostics")}
            >
              ↗
            </button>
          </div>
          <div className="health-list">
            {snapshot.providers.map((provider) => (
              <div className="health-row" key={provider.id}>
                <div className={`provider-icon provider-${provider.family}`}>
                  {provider.family === "kimi"
                    ? "K"
                    : provider.family === "xai"
                      ? "X"
                      : "C"}
                </div>
                <div>
                  <strong>{provider.name}</strong>
                  <span>{provider.id}</span>
                </div>
                <Badge
                  tone={
                    provider.credential === "configured"
                      ? "good"
                      : provider.credential === "missing"
                        ? "warn"
                        : "neutral"
                  }
                >
                  {provider.credential}
                </Badge>
              </div>
            ))}
          </div>
          <div className="panel-cta">
            <button className="text-button" onClick={() => onNavigate("setup")}>
              Open setup →
            </button>
          </div>
        </div>
        <div className="panel wide-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Team signal</p>
              <h2>Sol → specialists</h2>
            </div>
            <Badge tone="warn">2 live checks pending</Badge>
          </div>
          <div className="agent-columns">
            {snapshot.agents.map((agent) => (
              <div className="agent-column" key={agent.id}>
                <div className={`agent-avatar avatar-${agent.role}`}>
                  {agent.role === "root"
                    ? "S"
                    : agent.role === "frontend"
                      ? "K"
                      : "G"}
                </div>
                <div className="agent-copy">
                  <div className="agent-title">
                    <strong>{agent.name}</strong>
                    <StatusDot status={agent.health} />
                  </div>
                  <span>
                    {agent.role === "root" ? "GPT-5.6 Sol" : agent.modelId}
                  </span>
                  <p>{agent.description}</p>
                </div>
                <button
                  className="text-button"
                  onClick={() => onNavigate("team")}
                >
                  Configure →
                </button>
              </div>
            ))}
          </div>
        </div>
        <div className="panel activity-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Recent activity</p>
              <h2>Signal, not noise.</h2>
            </div>
            <button className="text-button" onClick={() => onNavigate("usage")}>
              View usage →
            </button>
          </div>
          {snapshot.usage.slice(0, 3).map((event) => (
            <div className="activity-row" key={event.id}>
              <span className="activity-time">
                {new Date(event.timestamp).toLocaleTimeString("en-US", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
              <span className={`activity-tag tag-${event.role}`}>
                {event.role ?? "run"}
              </span>
              <div>
                <strong>{event.model}</strong>
                <span>
                  {event.source} · {event.inputTokens?.toLocaleString() ?? "—"}{" "}
                  input tokens
                </span>
              </div>
              <span className="activity-cost">
                {event.providerCost !== undefined
                  ? "reported"
                  : formatCurrency(
                      event.estimatedCost ?? calculateEstimate(event),
                    )}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function Setup({
  snapshot,
  onSnapshot,
  onNavigate,
  onNotice,
}: {
  snapshot: OrchestraSnapshot;
  onSnapshot: (snapshot: OrchestraSnapshot) => void;
  onNavigate: (view: View) => void;
  onNotice: (notice: string) => void;
}) {
  const [step, setStep] = useState(1);
  const [projectPath, setProjectPath] = useState(
    snapshot.projects[0]?.path ?? "",
  );
  const [preview, setPreview] = useState<PreviewFile[] | null>(null);
  const [applying, setApplying] = useState(false);
  const steps = [
    { label: "Detect", detail: "Codex + Router" },
    { label: "Providers", detail: "Kimi + xAI" },
    { label: "Team", detail: "Bindings" },
    { label: "Review", detail: "Preview only" },
  ];
  return (
    <div className="view-stack">
      <SectionHeading
        eyebrow="Guided setup · read before write"
        title="Set the stage."
        detail="Prepare the control plane without touching your real Codex home until you explicitly approve a change."
        action={
          <Badge tone="neutral">
            <span className="lock-symbol">⌁</span> No secrets in Orchestra
          </Badge>
        }
      />
      <section className="setup-layout">
        <div className="panel setup-nav">
          {steps.map((item, index) => (
            <button
              className={`setup-step ${step === index + 1 ? "setup-step-active" : ""} ${step > index + 1 ? "setup-step-done" : ""}`}
              key={item.label}
              onClick={() => setStep(index + 1)}
            >
              <span className="step-number">
                {step > index + 1 ? "✓" : `0${index + 1}`}
              </span>
              <span>
                <strong>{item.label}</strong>
                <small>{item.detail}</small>
              </span>
            </button>
          ))}
        </div>
        <div className="panel setup-content">
          {step === 1 && (
            <>
              <p className="eyebrow">01 / Detect</p>
              <h2>Start with a read-only inventory.</h2>
              <p className="lead-copy">
                Orchestra can see the shape of your local installation without
                opening credentials or changing configuration.
              </p>
              <div className="inventory">
                <div>
                  <span>Codex executable</span>
                  <strong>
                    {snapshot.codex.detected ? "Detected" : "Missing"}
                  </strong>
                  <small>
                    {snapshot.codex.version} · {snapshot.codex.source}
                  </small>
                </div>
                <div>
                  <span>CODEX_HOME</span>
                  <strong>Resolved</strong>
                  <small>{snapshot.codex.home}</small>
                </div>
                <div>
                  <span>Router checkout</span>
                  <strong>
                    {snapshot.router.detected ? "Detected" : "Not found"}
                  </strong>
                  <small>
                    {snapshot.router.pinnedRef} · {snapshot.router.service}
                  </small>
                </div>
              </div>
              <div className="callout callout-blue">
                <strong>Safe by default.</strong> Setup never edits the real
                installation during diagnosis.
              </div>
            </>
          )}
          {step === 2 && (
            <>
              <p className="eyebrow">02 / Providers</p>
              <h2>Connect only through the Router.</h2>
              <p className="lead-copy">
                API keys stay in the Router or OS secure store. Orchestra only
                receives a status.
              </p>
              <div className="provider-setup-list">
                {snapshot.providers
                  .filter((provider) => provider.id !== "openai")
                  .map((provider) => (
                    <div className="provider-setup-row" key={provider.id}>
                      <div
                        className={`provider-icon provider-${provider.family}`}
                      >
                        {provider.family === "kimi" ? "K" : "X"}
                      </div>
                      <div>
                        <strong>{provider.name}</strong>
                        <span>{provider.billingNote}</span>
                      </div>
                      <Badge
                        tone={
                          provider.credential === "configured" ? "good" : "warn"
                        }
                      >
                        {provider.credential}
                      </Badge>
                      <button
                        className="button button-quiet"
                        onClick={() =>
                          onNotice(
                            `Credential setup for ${provider.name} opens the local Router helper.`,
                          )
                        }
                      >
                        Open helper
                      </button>
                    </div>
                  ))}
              </div>
              <div className="callout callout-amber">
                <strong>Live checks cost money.</strong> They are never part of
                normal tests and always show provider, model and test before
                confirmation.
              </div>
            </>
          )}
          {step === 3 && (
            <>
              <p className="eyebrow">03 / Team</p>
              <h2>Make ownership explicit.</h2>
              <p className="lead-copy">
                Bindings resolve against the current catalog so a stale model
                slug never silently becomes the product contract.
              </p>
              <div className="binding-list">
                {snapshot.agents.map((agent) => (
                  <div className="binding-row" key={agent.id}>
                    <span className={`agent-avatar small avatar-${agent.role}`}>
                      {agent.role === "root"
                        ? "S"
                        : agent.role === "frontend"
                          ? "K"
                          : "G"}
                    </span>
                    <div>
                      <strong>{agent.name}</strong>
                      <span>{agent.modelId ?? "native"}</span>
                    </div>
                    <span className="binding-arrow">→</span>
                    <Badge tone={agent.health === "healthy" ? "good" : "warn"}>
                      {statusLabel(agent.health)}
                    </Badge>
                  </div>
                ))}
              </div>
            </>
          )}
          {step === 4 && (
            <>
              <p className="eyebrow">04 / Review</p>
              <h2>Preview before applying.</h2>
              <p className="lead-copy">
                Choose the local repo, inspect the exact files and then approve
                one atomic write. Credentials never enter this flow.
              </p>
              <label className="field-wide">
                Project root
                <input
                  value={projectPath}
                  onChange={(event) => setProjectPath(event.target.value)}
                  placeholder="D:\\Códigos\\mi-proyecto"
                  spellCheck={false}
                />
              </label>
              <div className="preview-lines">
                {(
                  preview ?? [
                    {
                      path: "AGENTS.md",
                      action: "update" as const,
                      diff: "managed block only",
                      safe: true,
                    },
                    {
                      path: ".codex/agents/orchestra_frontend.toml",
                      action: "create" as const,
                      diff: "generated frontend agent",
                      safe: true,
                    },
                    {
                      path: ".codex/agents/orchestra_engineer.toml",
                      action: "create" as const,
                      diff: "generated engineer agent",
                      safe: true,
                    },
                    {
                      path: ".codex/skills/orchestra-routing/SKILL.md",
                      action: "create" as const,
                      diff: "generated routing skill",
                      safe: true,
                    },
                  ]
                ).map((file) => (
                  <span key={file.path}>
                    <i>{file.action.toUpperCase()}</i> {file.path}{" "}
                    <em>{file.diff}</em>
                  </span>
                ))}
              </div>
              <div className="callout callout-blue">
                <strong>Human action required.</strong> Preview is read-only;
                applying asks for explicit confirmation and creates backups for
                files that already exist.
              </div>
            </>
          )}
          <div className="setup-footer">
            <span>{step}/4 · preview mode</span>
            <div>
              <button
                className="button button-quiet"
                disabled={step === 1}
                onClick={() => setStep((value) => value - 1)}
              >
                Back
              </button>
              {step < 4 ? (
                <button
                  className="button button-primary"
                  onClick={() => setStep((value) => value + 1)}
                >
                  Continue <span>→</span>
                </button>
              ) : (
                <button
                  className="button button-primary"
                  disabled={applying || !projectPath.trim()}
                  onClick={() => {
                    void (async () => {
                      setApplying(true);
                      try {
                        const root = projectPath.trim();
                        const agents = snapshot.agents.filter(
                          (agent) => agent.role !== "root",
                        );
                        const block = renderManagedBlock(agents, [
                          "package.json",
                          "types/**",
                          "schemas/**",
                          "migrations/**",
                        ]);
                        const existing = root + "\\AGENTS.md";
                        const nextPreview = await invokeCommand<PreviewFile[]>(
                          "managed_preview",
                          {
                            path: existing,
                            existing: "# Project rules\n",
                            block,
                          },
                        );
                        setPreview(nextPreview);
                        if (
                          !window.confirm(
                            "Apply the reviewed Orchestra files to this project? Existing files will be backed up.",
                          )
                        ) {
                          onNotice(
                            "Preview kept; no project files were changed.",
                          );
                          return;
                        }
                        const files = agents.map((agent) => ({
                          path:
                            agent.role === "frontend"
                              ? ".codex/agents/orchestra_frontend.toml"
                              : ".codex/agents/orchestra_engineer.toml",
                          content: renderAgentToml(agent, agent.modelId ?? ""),
                        }));
                        files.push({
                          path: ".codex/skills/orchestra-routing/SKILL.md",
                          content: renderRoutingSkill(),
                        });
                        const result = await invokeCommand<{
                          backups?: Array<{
                            target: string;
                            backupPath?: string;
                          }>;
                        }>("apply_managed_changes", {
                          path: existing,
                          block,
                          files,
                          confirm: true,
                        });
                        onSnapshot({
                          ...snapshot,
                          backups: [
                            ...(result.backups ?? []).map((backup, index) => ({
                              id: `backup-${Date.now()}-${index}`,
                              target: backup.target,
                              backupPath: backup.backupPath,
                              createdAt: new Date().toISOString(),
                              reason: "before-write" as const,
                              restorable: true,
                              redacted: true,
                            })),
                            ...snapshot.backups,
                          ],
                        });
                        onNotice("Team files applied atomically with backups.");
                        onNavigate("diagnostics");
                      } catch (cause) {
                        onNotice(
                          cause instanceof Error
                            ? cause.message
                            : "The managed write was not applied.",
                        );
                      } finally {
                        setApplying(false);
                      }
                    })();
                  }}
                >
                  {applying ? "Applying…" : "Apply reviewed files"}{" "}
                  <span>→</span>
                </button>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function TeamBuilder({
  snapshot,
  onNotice,
}: {
  snapshot: OrchestraSnapshot;
  onNotice: (notice: string) => void;
}) {
  const [selected, setSelected] = useState<AgentDefinition>(snapshot.agents[1]);
  return (
    <div className="view-stack">
      <SectionHeading
        eyebrow="Team builder · model bindings"
        title="Three roles. One owner."
        detail="Configure the team Sol can delegate to, without hiding the health state of each binding."
        action={
          <button
            className="button button-primary"
            onClick={() =>
              onNotice(
                "Team preview generated. Apply remains behind the native Tauri safety gate.",
              )
            }
          >
            Preview team files <span>↗</span>
          </button>
        }
      />
      <div className="team-builder-layout">
        <div className="role-list">
          {snapshot.agents.map((agent) => (
            <button
              className={`role-card ${selected.id === agent.id ? "role-card-selected" : ""}`}
              key={agent.id}
              onClick={() => setSelected(agent)}
            >
              <div className={`agent-avatar avatar-${agent.role}`}>
                {agent.role === "root"
                  ? "S"
                  : agent.role === "frontend"
                    ? "K"
                    : "G"}
              </div>
              <div className="role-card-copy">
                <p className="eyebrow">{agent.role}</p>
                <h3>{agent.name}</h3>
                <span>{agent.modelId ?? "Native Codex"}</span>
                <p>{agent.description}</p>
              </div>
              <StatusDot status={agent.health} />
            </button>
          ))}
        </div>
        <div className="panel role-detail">
          <div className="role-detail-header">
            <div className={`agent-avatar large avatar-${selected.role}`}>
              {selected.role === "root"
                ? "S"
                : selected.role === "frontend"
                  ? "K"
                  : "G"}
            </div>
            <div>
              <p className="eyebrow">{selected.role} role</p>
              <h2>{selected.name}</h2>
              <p className="muted">{selected.modelId ?? "GPT native"}</p>
            </div>
            <Badge tone={selected.health === "healthy" ? "good" : "warn"}>
              {statusLabel(selected.health)}
            </Badge>
          </div>
          <div className="detail-grid">
            <label>
              Model binding
              <input value={selected.modelId ?? "native Codex"} readOnly />
            </label>
            <label>
              Reasoning effort
              <select defaultValue={selected.reasoningEffort}>
                <option>max</option>
                <option>high</option>
                <option>medium</option>
              </select>
            </label>
            <label>
              Retry policy
              <input
                value={`${selected.retryLimit} retry · then root`}
                readOnly
              />
            </label>
            <label>
              Permission
              <input value={selected.permissions.join(" · ")} readOnly />
            </label>
          </div>
          <div className="detail-section">
            <p className="eyebrow">Ownership paths</p>
            <div className="path-chips">
              {selected.ownershipPaths.map((path) => (
                <code key={path}>{path}</code>
              ))}
            </div>
          </div>
          <div className="detail-section">
            <p className="eyebrow">Routing hints</p>
            <div className="hint-list">
              {selected.routingHints.map((hint) => (
                <span key={hint}>↳ {hint}</span>
              ))}
            </div>
          </div>
          <div className="role-detail-footer">
            <span>
              <StatusDot status={selected.health} /> Last test:{" "}
              {selected.lastTest}
            </span>
            <button
              className="text-button"
              onClick={() =>
                onNotice(
                  "A live test must show provider, model and test before it can run.",
                )
              }
            >
              Test capability →
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Projects({
  snapshot,
  onSnapshot,
  onNotice,
}: {
  snapshot: OrchestraSnapshot;
  onSnapshot: (snapshot: OrchestraSnapshot) => void;
  onNotice: (notice: string) => void;
}) {
  const [path, setPath] = useState("");
  const [scopePlan, setScopePlan] = useState<ScopePlan | null>(null);
  async function addProject() {
    const profile = await invokeCommand<ProjectProfile>("add_project", {
      path: path || "C:\\Workspace\\sample-project",
    });
    onSnapshot({
      ...snapshot,
      projects: [
        ...snapshot.projects.filter((item) => item.path !== profile.path),
        profile,
      ],
    });
    setPath("");
    onNotice("Project profile added with editable ownership hints.");
  }
  async function inspectScopes() {
    const plan = await invokeCommand<ScopePlan>("scope_plan", {
      assignments: {
        root: ["package.json"],
        frontend: ["src/**", "components/**"],
        engineer: ["server/**", "tests/**"],
      },
      sharedPaths: ["package.json", "types/**"],
    });
    setScopePlan(plan);
  }
  return (
    <div className="view-stack">
      <SectionHeading
        eyebrow="Projects · local profiles"
        title="Give each repo a safe map."
        detail="Ownership is a hint until the project profile confirms it. Shared files remain root-owned."
        action={
          <button
            className="button button-primary"
            onClick={() => void addProject()}
          >
            Add local project <span>+</span>
          </button>
        }
      />
      <section className="projects-layout">
        <div className="panel project-add">
          <p className="eyebrow">New profile</p>
          <h2>Register a repository.</h2>
          <p className="muted">
            Detection reads filenames and manifests only. It does not assume
            `src/app`, `server` or `db`.
          </p>
          <label className="wide-label">
            Local path
            <input
              placeholder="D:\\Códigos\\proyecto"
              value={path}
              onChange={(event) => setPath(event.target.value)}
            />
          </label>
          <div className="detected-stack">
            <span>Detected stack</span>
            <Badge tone="neutral">Node.js</Badge>
            <Badge tone="neutral">React</Badge>
            <Badge tone="neutral">editable</Badge>
          </div>
          <button
            className="button button-primary full-button"
            onClick={() => void addProject()}
          >
            Create profile <span>→</span>
          </button>
        </div>
        <div className="project-list">
          {snapshot.projects.length === 0 ? (
            <div className="panel empty-state">
              <span className="empty-glyph">⌂</span>
              <h3>No local projects yet.</h3>
              <p>
                Add one to inspect stack, tests, ownership and usage
                correlation.
              </p>
            </div>
          ) : (
            snapshot.projects.map((project) => (
              <article className="panel project-card" key={project.id}>
                <div className="project-card-top">
                  <div>
                    <p className="eyebrow">{project.name}</p>
                    <h3>{project.path}</h3>
                  </div>
                  <StatusDot status={project.status} />
                </div>
                <div className="project-tags">
                  {project.stack.map((item) => (
                    <Badge key={item}>{item}</Badge>
                  ))}
                </div>
                <div className="project-card-footer">
                  <span>{project.knownTests.join(" · ")}</span>
                  <button
                    className="text-button"
                    onClick={() =>
                      onNotice(
                        `Profile ${project.name} is ready for manual ownership edits.`,
                      )
                    }
                  >
                    Edit profile →
                  </button>
                </div>
              </article>
            ))
          )}
        </div>
      </section>
      <section className="panel scope-panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Safe parallelism</p>
            <h2>Scope planner</h2>
          </div>
          <button
            className="button button-quiet"
            onClick={() => void inspectScopes()}
          >
            Check fixture scopes
          </button>
        </div>
        {scopePlan ? (
          <div className="scope-result">
            <div
              className={`scope-verdict ${scopePlan.parallel ? "scope-good" : "scope-warn"}`}
            >
              <strong>
                {scopePlan.parallel ? "Parallel is safe" : "Run sequentially"}
              </strong>
              <span>{scopePlan.reason}</span>
            </div>
            <div className="scope-assignments">
              {Object.entries(scopePlan.assignments).map(([role, paths]) => (
                <div key={role}>
                  <span className="eyebrow">{role}</span>
                  {paths.map((item) => (
                    <code key={item}>{item}</code>
                  ))}
                </div>
              ))}
            </div>
            {scopePlan.conflicts.length > 0 && (
              <div className="conflict-list">
                {scopePlan.conflicts.map((conflict) => (
                  <span key={conflict}>⚠ {conflict}</span>
                ))}
              </div>
            )}
          </div>
        ) : (
          <p className="muted">
            Run a plan to see whether the frontend and engineer scopes overlap.
          </p>
        )}
      </section>
    </div>
  );
}

function Diagnostics({
  snapshot,
  onSnapshot,
  onNotice,
}: {
  snapshot: OrchestraSnapshot;
  onSnapshot: (snapshot: OrchestraSnapshot) => void;
  onNotice: (notice: string) => void;
}) {
  const [running, setRunning] = useState(false);
  const [livePreview, setLivePreview] = useState<LiveCheckPreview | null>(null);
  async function runHealth() {
    setRunning(true);
    const report = await invokeCommand<HealthReport>("run_health_check");
    onSnapshot({ ...snapshot, health: report });
    setRunning(false);
    onNotice(`Health run ${report.status}. Redacted output only.`);
  }
  async function previewLive() {
    const preview = await invokeCommand<LiveCheckPreview>(
      "live_check_preview",
      { provider: "kimi-api", model: "kimi-api/kimi-k3", test: "tool-use" },
    );
    setLivePreview(preview);
  }
  const categories = [
    "codex",
    "router",
    "provider",
    "model",
    "agent",
    "network",
  ];
  return (
    <div className="view-stack">
      <SectionHeading
        eyebrow="Diagnostics · evidence over confidence"
        title="Know before Sol delegates."
        detail="A catalog row is not an agent capability check. Local health is redacted and live checks are always opt-in."
        action={
          <button
            className="button button-primary"
            onClick={() => void runHealth()}
            disabled={running}
          >
            {running ? "Running…" : "Run health check"} <span>↗</span>
          </button>
        }
      />
      <div className="diagnostics-summary">
        <div>
          <StatusDot status={snapshot.health?.status ?? "unknown"} />
          <strong>
            {snapshot.health
              ? statusLabel(snapshot.health.status)
              : "No health run yet"}
          </strong>
          <span>
            {snapshot.health
              ? new Date(
                  snapshot.health.completedAt ?? snapshot.health.startedAt,
                ).toLocaleString("es-CL")
              : "Run the first local check"}
          </span>
        </div>
        <div>
          <span className="eyebrow">Checks</span>
          <strong>{snapshot.diagnostics.length}</strong>
        </div>
        <div>
          <span className="eyebrow">Privacy</span>
          <strong>Redacted</strong>
        </div>
      </div>
      <div className="diagnostics-grid">
        {categories.map((category) => (
          <section className="panel diagnostics-group" key={category}>
            <div className="panel-header">
              <div>
                <p className="eyebrow">{category}</p>
                <h2>
                  {category === "router"
                    ? "Router engine"
                    : category === "agent"
                      ? "Agent capability"
                      : category === "provider"
                        ? "Providers"
                        : category}
                </h2>
              </div>
              <span className="panel-index">
                {String(
                  snapshot.diagnostics.filter(
                    (item) => item.category === category,
                  ).length,
                ).padStart(2, "0")}
              </span>
            </div>
            {snapshot.diagnostics
              .filter((item) => item.category === category)
              .map((item) => (
                <DiagnosticRow item={item} key={item.id} />
              ))}
          </section>
        ))}
      </div>
      <section className="panel live-check-panel">
        <div>
          <p className="eyebrow">Explicit live eval</p>
          <h2>Test a tool-driven handoff.</h2>
          <p className="muted">
            The preview must name the provider, model and test before any paid
            request can run.
          </p>
        </div>
        {livePreview ? (
          <div className="live-preview">
            <div>
              <span>Provider</span>
              <strong>{livePreview.provider}</strong>
            </div>
            <div>
              <span>Model</span>
              <strong>{livePreview.model}</strong>
            </div>
            <div>
              <span>Test</span>
              <strong>{livePreview.test}</strong>
            </div>
            <p>{livePreview.estimatedCostNote}</p>
            <button
              className="button button-quiet"
              onClick={() =>
                onNotice(
                  "Confirmation gate is ready; live execution remains disabled in fixture mode.",
                )
              }
            >
              Confirm locally
            </button>
          </div>
        ) : (
          <button
            className="button button-quiet"
            onClick={() => void previewLive()}
          >
            Preview live check →
          </button>
        )}
      </section>
    </div>
  );
}

function DiagnosticRow({ item }: { item: DiagnosticItem }) {
  return (
    <div className="diagnostic-row">
      <StatusDot status={item.status} />
      <div>
        <strong>{item.label}</strong>
        <span>{item.detail}</span>
      </div>
      <code>{item.value}</code>
    </div>
  );
}

function Usage({ snapshot }: { snapshot: OrchestraSnapshot }) {
  const cost = aggregateUsage(snapshot.usage);
  const max = Math.max(
    ...snapshot.usage.map((event) => event.outputTokens ?? 0),
    1,
  );
  const byRole = ["root", "frontend", "engineer"].map((role) => ({
    role,
    events: snapshot.usage.filter((event) => event.role === role),
    total: snapshot.usage
      .filter((event) => event.role === role)
      .reduce(
        (sum, event) =>
          sum +
          (event.providerCost ??
            event.estimatedCost ??
            calculateEstimate(event)),
        0,
      ),
  }));
  return (
    <div className="view-stack">
      <SectionHeading
        eyebrow="Usage · reported vs estimated"
        title="Make spend legible."
        detail="Router-reported, provider-reported and locally estimated values stay visibly separate."
        action={
          <Badge tone={cost.label === "estimated" ? "warn" : "neutral"}>
            {cost.label}
          </Badge>
        }
      />
      <div className="metrics-grid usage-metrics">
        <Metric
          label="Total display"
          value={formatCurrency(cost.totalDisplay)}
          detail="mixed sources"
        />
        <Metric
          label="Provider reported"
          value={formatCurrency(cost.providerReported)}
          detail="upstream value"
          tone="green"
        />
        <Metric
          label="Router reported"
          value={formatCurrency(cost.routerReported)}
          detail="router metering"
          tone="violet"
        />
        <Metric
          label="Estimated"
          value={formatCurrency(cost.estimated)}
          detail="pricing rules v1"
          tone="amber"
        />
      </div>
      <div className="usage-layout">
        <section className="panel usage-chart">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Output volume</p>
              <h2>Daily signal</h2>
            </div>
            <span className="panel-index">UTC / 12 AUG</span>
          </div>
          <div className="bar-chart">
            {snapshot.usage.map((event) => (
              <div className="bar-group" key={event.id}>
                <div className="bar-track">
                  <div
                    className={`bar bar-${event.role}`}
                    style={{
                      height: `${Math.max(8, ((event.outputTokens ?? 0) / max) * 100)}%`,
                    }}
                    title={`${event.outputTokens ?? 0} output tokens`}
                  />
                </div>
                <span>{event.role?.slice(0, 3) ?? "run"}</span>
              </div>
            ))}
          </div>
          <div className="chart-legend">
            <span>
              <i className="legend-dot legend-root" />
              root
            </span>
            <span>
              <i className="legend-dot legend-frontend" />
              frontend
            </span>
            <span>
              <i className="legend-dot legend-engineer" />
              engineer
            </span>
          </div>
        </section>
        <section className="panel budget-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Monthly budget</p>
              <h2>{formatCurrency(snapshot.budget.monthlyLimit)}</h2>
            </div>
            <span className="budget-percent">
              {Math.round(
                (cost.totalDisplay / snapshot.budget.monthlyLimit) * 100,
              )}
              %
            </span>
          </div>
          <div className="budget-track">
            <span
              style={{
                width: `${Math.min(100, (cost.totalDisplay / snapshot.budget.monthlyLimit) * 100)}%`,
              }}
            />
          </div>
          <p className="muted">
            Warnings at {snapshot.budget.warningAtPercent}% and{" "}
            {snapshot.budget.criticalAtPercent}%. MVP never blocks a task
            automatically.
          </p>
          <div className="budget-footer">
            <span>Current display</span>
            <strong>{formatCurrency(cost.totalDisplay)}</strong>
          </div>
        </section>
      </div>
      <section className="panel usage-table">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Usage events</p>
            <h2>Recent metering</h2>
          </div>
          <span className="muted">{snapshot.usage.length} events</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Role</th>
                <th>Model</th>
                <th>Tokens</th>
                <th>Source</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.usage.map((event) => (
                <tr key={event.id}>
                  <td>
                    {new Date(event.timestamp).toLocaleTimeString("en-US", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </td>
                  <td>
                    <span className={`activity-tag tag-${event.role}`}>
                      {event.role}
                    </span>
                  </td>
                  <td>
                    <code>{event.model}</code>
                  </td>
                  <td>
                    {(
                      (event.inputTokens ?? 0) + (event.outputTokens ?? 0)
                    ).toLocaleString()}
                  </td>
                  <td>
                    <Badge
                      tone={event.source === "estimate" ? "warn" : "neutral"}
                    >
                      {event.source}
                    </Badge>
                  </td>
                  <td>
                    {event.providerCost !== undefined
                      ? "reported"
                      : formatCurrency(
                          event.estimatedCost ?? calculateEstimate(event),
                        )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Advanced({
  snapshot,
  onNotice,
}: {
  snapshot: OrchestraSnapshot;
  onNotice: (notice: string) => void;
}) {
  const [bundle, setBundle] = useState<string | null>(null);
  async function operation(operation: "update-check" | "update" | "rollback") {
    if (
      (operation === "update" || operation === "rollback") &&
      !window.confirm(
        operation === "update"
          ? "Stage the pinned Router update? A backup and health gate are required."
          : "Prepare Router rollback using the stored rollback reference?",
      )
    ) {
      onNotice("Operation cancelled; no Router state was changed.");
      return;
    }
    try {
      const result = await invokeCommand<{
        message?: string;
        status?: string;
        ok?: boolean;
        phase?: string;
      }>("router_operation", {
        operation,
        confirm: operation === "update" || operation === "rollback",
      });
      onNotice(
        result.message ??
          (result.ok === false
            ? `Router operation ${operation} stopped during ${result.phase ?? "validation"}.`
            : `Router operation ${operation} completed.`),
      );
    } catch (cause) {
      onNotice(
        cause instanceof Error
          ? cause.message
          : `Router operation ${operation} failed.`,
      );
    }
  }
  async function exportBundle() {
    const result = await invokeCommand("export_support_bundle");
    setBundle(JSON.stringify(result, null, 2) ?? "{}");
    onNotice(
      "Redacted support bundle prepared in memory; no secrets or prompts included.",
    );
  }
  async function restoreBackup(backup: OrchestraSnapshot["backups"][number]) {
    if (!backup.backupPath) {
      onNotice("This backup has no local restore path available.");
      return;
    }
    if (
      !window.confirm(
        `Restore ${backup.target} from its stored Orchestra backup?`,
      )
    ) {
      onNotice("Restore cancelled; no files were changed.");
      return;
    }
    try {
      await invokeCommand("restore_backup", {
        target: backup.target,
        backup: backup.backupPath,
        confirm: true,
      });
      onNotice("Backup restored atomically; a rollback backup was retained.");
    } catch (cause) {
      onNotice(
        cause instanceof Error
          ? cause.message
          : "The backup could not be restored.",
      );
    }
  }
  return (
    <div className="view-stack">
      <SectionHeading
        eyebrow="Advanced · deliberate controls"
        title="Backups before ambition."
        detail="Every mutable surface has an explicit preview, backup and rollback story."
        action={
          <Badge tone="neutral">
            <span className="lock-symbol">⌁</span> Atomic writes
          </Badge>
        }
      />
      <div className="advanced-grid">
        <section className="panel advanced-card">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Engine pin</p>
              <h2>Codex Router</h2>
            </div>
            <Badge tone="good">{snapshot.update.status}</Badge>
          </div>
          <div className="version-line">
            <code>{snapshot.update.currentRef}</code>
            <span>→</span>
            <code>{snapshot.update.targetRef}</code>
          </div>
          <p className="muted">{snapshot.update.notes[0]}</p>
          <div className="button-row">
            <button
              className="button button-quiet"
              onClick={() => void operation("update-check")}
            >
              Check update
            </button>
            <button
              className="button button-primary"
              onClick={() => void operation("update")}
            >
              Stage update
            </button>
          </div>
          <button
            className="text-button danger-button"
            onClick={() => void operation("rollback")}
          >
            Prepare rollback →
          </button>
        </section>
        <section className="panel advanced-card">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Recovery</p>
              <h2>Backups</h2>
            </div>
            <span className="panel-index">
              {String(snapshot.backups.length).padStart(2, "0")}
            </span>
          </div>
          {snapshot.backups.map((backup) => (
            <div className="backup-row" key={backup.id}>
              <span className="backup-icon">↺</span>
              <div>
                <strong>{backup.target}</strong>
                <span>
                  {backup.reason} ·{" "}
                  {new Date(backup.createdAt).toLocaleString("es-CL")}
                </span>
              </div>
              <Badge tone={backup.restorable ? "good" : "bad"}>
                {backup.restorable ? "restorable" : "unavailable"}
              </Badge>
              {backup.restorable && backup.backupPath && (
                <button
                  className="text-button danger-button"
                  onClick={() => void restoreBackup(backup)}
                >
                  Restore
                </button>
              )}
            </div>
          ))}
        </section>
        <section className="panel advanced-card">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Support</p>
              <h2>Redacted bundle</h2>
            </div>
            <span className="panel-index">SAFE</span>
          </div>
          <p className="muted">
            Versions, statuses, process/port state and recent redacted errors.
            Prompts, responses and credential values are excluded by default.
          </p>
          <button
            className="button button-quiet"
            onClick={() => void exportBundle()}
          >
            Prepare bundle →
          </button>
          {bundle && <pre className="bundle-preview">{bundle}</pre>}
        </section>
        <section className="panel advanced-card feature-card">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Experimental boundary</p>
              <h2>App Server / MCP</h2>
            </div>
            <Badge>off</Badge>
          </div>
          <p className="muted">
            Optional stdio integration for activity and read-only health. Core
            setup and safety controls do not depend on experimental transports.
          </p>
          <div className="feature-list">
            <span>○ App Server stdio</span>
            <span>○ Orchestra MCP</span>
            <span>○ Worktree execution</span>
          </div>
        </section>
      </div>
    </div>
  );
}

export default App;
