import { useState } from "react";
import type {
  HealthReport,
  OrchestraSnapshot,
} from "@codex-orchestra/contracts";
import {
  DEFAULT_PRICING_RULES,
  aggregateUsage,
  orchestraReadiness,
} from "@codex-orchestra/contracts";
import {
  ArrowRight,
  Boxes,
  FolderPlus,
  Gauge,
  PlugZap,
  Rocket,
  Unplug,
  Users,
} from "lucide-react";
import { invokeCommand } from "../core/invoke";
import type { ViewContext } from "./types";
import { useRouterRecovery } from "./useRouterRecovery";
import {
  BrandMark,
  Callout,
  Chip,
  ConfirmModal,
  EmptyState,
  PageHead,
  StatusDot,
  Surface,
  providerBrand,
  statusTone,
} from "../ui/primitives";
import {
  credentialLabel,
  formatCurrency,
  formatLocalTimestamp,
  relativeTime,
  statusLabel,
} from "../ui/format";

function nextStepIcon(id: string) {
  switch (id) {
    case "router":
      return <Boxes size={16} aria-hidden />;
    case "providers":
      return <PlugZap size={16} aria-hidden />;
    case "project":
      return <FolderPlus size={16} aria-hidden />;
    default:
      return <Rocket size={16} aria-hidden />;
  }
}

export function Overview({
  snapshot,
  setSnapshot,
  navigate,
  notice,
}: ViewContext) {
  const [checking, setChecking] = useState(false);
  const pricingRules =
    snapshot.pricingRules && snapshot.pricingRules.length > 0
      ? snapshot.pricingRules
      : DEFAULT_PRICING_RULES;
  const cost = aggregateUsage(snapshot.usage, pricingRules);
  const configured = snapshot.providers.filter(
    (provider) => provider.credential === "configured",
  ).length;
  const readiness = orchestraReadiness(snapshot);
  const recovery = useRouterRecovery(snapshot, setSnapshot, notice);

  async function runHealth() {
    setChecking(true);
    try {
      const report = await invokeCommand<HealthReport>("run_health_check");
      setSnapshot({ ...snapshot, health: report });
      notice("Chequeo local completado. La salida se redacta por defecto.");
    } catch {
      notice("El chequeo local no pudo ejecutarse.");
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="view">
      <PageHead
        title="Codex Orchestra"
        lede={readiness.summary}
        actions={
          <>
            <button
              className="button button-ghost"
              onClick={() => void runHealth()}
              disabled={checking}
            >
              <Gauge size={15} aria-hidden />
              {checking ? "Chequeando…" : "Chequeo local"}
            </button>
            <button
              className="button button-primary"
              onClick={() => navigate(readiness.next.view)}
            >
              {readiness.next.label}
              <ArrowRight size={15} aria-hidden />
            </button>
          </>
        }
      />
      <div
        className="posture-band"
        role="group"
        aria-label="Estado del sistema"
      >
        <div className="posture-cell">
          <span className="label">Estado</span>
          <strong>{readiness.headline}</strong>
          <div className="posture-detail">
            <StatusDot status={readiness.status} pulse={readiness.routerLive} />
            {readiness.summary}
          </div>
        </div>
        <div className="posture-cell">
          <span className="label">Router</span>
          <strong>
            {readiness.routerLive
              ? "En marcha"
              : snapshot.router.detected
                ? "Parado"
                : "Ausente"}
          </strong>
          <div className="posture-detail">
            <StatusDot
              status={
                readiness.routerLive
                  ? "healthy"
                  : snapshot.router.detected
                    ? "degraded"
                    : "missing"
              }
            />
            {readiness.routerLive
              ? `${snapshot.router.ports.length} puerto(s) · ${snapshot.router.version ?? "local"}`
              : snapshot.router.detected
                ? "instalado, sin servicio en 127.0.0.1"
                : "prepáralo en Configuración"}
          </div>
        </div>
        <div className="posture-cell">
          <span className="label">Proveedores</span>
          <strong>
            {configured}/{snapshot.providers.length}
          </strong>
          <div className="posture-detail">
            <StatusDot status={configured ? "healthy" : "missing"} />
            con credencial configurada
          </div>
        </div>
        <div className="posture-cell">
          <span className="label">Gasto del mes</span>
          <strong>{formatCurrency(cost.totalDisplay)}</strong>
          <div className="posture-detail">
            <StatusDot
              status={cost.label === "estimated" ? "unknown" : "healthy"}
            />
            {cost.label === "estimated" ? "estimado" : "reportado"} ·{" "}
            {snapshot.usage.length} eventos
          </div>
        </div>
        <div className="posture-cell">
          <span className="label">Proyectos</span>
          <strong>{snapshot.projects.length}</strong>
          <div className="posture-detail">
            <StatusDot
              status={snapshot.projects.length ? "healthy" : "missing"}
            />
            perfiles locales registrados
          </div>
        </div>
      </div>
      {recovery.down && (
        <section className="router-recovery" aria-live="polite">
          <div className="router-recovery-copy">
            <span className="label">Router</span>
            <strong>Offline</strong>
            <p>Codex requests cannot reach the local router.</p>
            {recovery.phaseLabel && (
              <ol className="router-recovery-steps">
                <li className={recovery.phase === "starting" ? "current" : ""}>
                  Starting Router...
                </li>
                <li
                  className={
                    recovery.phase === "checking" ||
                    recovery.phase === "waiting"
                      ? "current"
                      : ""
                  }
                >
                  Checking localhost service...
                </li>
                <li className={recovery.phase === "healthy" ? "current" : ""}>
                  Router healthy
                </li>
                <li className={recovery.phase === "restored" ? "current" : ""}>
                  Connection restored
                </li>
              </ol>
            )}
            {recovery.error && <Callout tone="bad">{recovery.error}</Callout>}
          </div>
          <div className="router-recovery-actions">
            <button
              className="button button-primary"
              disabled={recovery.busy}
              onClick={() => void recovery.requestRepair()}
            >
              <Unplug size={15} aria-hidden />
              {recovery.busy ? "Repairing…" : "Repair connection"}
            </button>
            <button
              className="button button-ghost"
              onClick={() => navigate("diagnostics")}
            >
              View logs
            </button>
          </div>
        </section>
      )}
      <Surface
        title="Qué falta"
        hint={
          readiness.level === "ready"
            ? "nada bloquea una tarea"
            : "un solo siguiente movimiento"
        }
      >
        <div className="next-steps">
          <button
            className="next-step"
            onClick={() => navigate(readiness.next.view)}
            style={{
              border: "none",
              background: "none",
              width: "100%",
              textAlign: "left",
              cursor: "pointer",
            }}
          >
            <span className="step-icon">
              {nextStepIcon(readiness.blockingId ?? "run")}
            </span>
            <span className="step-copy">
              <strong>{readiness.next.label}</strong>
              <span>{readiness.summary}</span>
            </span>
            <ArrowRight
              size={15}
              aria-hidden
              style={{ color: "var(--ink-3)" }}
            />
          </button>
        </div>
      </Surface>
      <div className="grid-2">
        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          <Surface
            title="Cadena de ejecución"
            hint="así viaja el trabajo"
            action={
              <button
                className="button-text"
                onClick={() => navigate("diagnostics")}
              >
                Diagnóstico
              </button>
            }
          >
            <div className="chain">
              <div className="chain-node">
                <BrandMark brand="openai" />
                <div className="node-body">
                  <strong>Codex Desktop · GPT-5.6 Sol</strong>
                  <span>
                    {snapshot.codex.detected
                      ? `${snapshot.codex.version ?? "detectado"} · superficie de ejecución`
                      : "ejecutable no detectado"}
                  </span>
                </div>
                <StatusDot
                  status={snapshot.codex.detected ? "healthy" : "missing"}
                />
              </div>
              <div className="chain-link">delega vía App Server (opt-in)</div>
              <div className="chain-node">
                <BrandMark brand="router" />
                <div className="node-body">
                  <strong>Codex Router</strong>
                  <span>
                    {snapshot.router.detected
                      ? `${snapshot.router.ports.length} servicio(s) loopback · pin ${snapshot.router.pinnedRef?.slice(0, 7) ?? "—"}`
                      : "checkout gestionado sin preparar"}
                  </span>
                </div>
                <StatusDot status={snapshot.router.health} />
              </div>
              <div className="chain-link">enruta modelos según catálogo</div>
              {snapshot.providers
                .filter((provider) => provider.id !== "openai")
                .slice(0, 4)
                .map((provider) => (
                  <div className="chain-node" key={provider.id}>
                    <BrandMark
                      brand={providerBrand(provider.family, provider.id)}
                    />
                    <div className="node-body">
                      <strong>{provider.name}</strong>
                      <span>
                        {provider.billingNote ||
                          credentialLabel(provider.credential)}
                      </span>
                    </div>
                    <StatusDot
                      status={
                        provider.credential === "configured"
                          ? "healthy"
                          : "missing"
                      }
                    />
                  </div>
                ))}
            </div>
          </Surface>
          <Surface
            title="Equipo delegado"
            hint={`${snapshot.agents.length} roles`}
            action={
              <button className="button-text" onClick={() => navigate("team")}>
                Administrar
              </button>
            }
          >
            <div style={{ display: "flex", flexDirection: "column" }}>
              {snapshot.agents.map((agent) => (
                <div className="ledger-row" key={agent.id}>
                  <StatusDot status={agent.health} />
                  <div className="row-body">
                    <strong>{agent.name}</strong>
                    <span className="mono">
                      {agent.modelId ?? "Codex nativo"}
                    </span>
                  </div>
                  <Chip tone={statusTone(agent.health)}>
                    {statusLabel(agent.health)}
                  </Chip>
                </div>
              ))}
            </div>
          </Surface>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          <Surface
            title="Proveedores"
            hint={`${configured}/${snapshot.providers.length} listos`}
            action={
              <button className="button-text" onClick={() => navigate("setup")}>
                Configurar
              </button>
            }
          >
            <div style={{ display: "flex", flexDirection: "column" }}>
              {snapshot.providers.map((provider) => (
                <div className="ledger-row" key={provider.id}>
                  <BrandMark
                    brand={providerBrand(provider.family, provider.id)}
                  />
                  <div className="row-body">
                    <strong>{provider.name}</strong>
                    <span className="mono">{provider.id}</span>
                  </div>
                  <Chip
                    tone={provider.credential === "configured" ? "ok" : "warn"}
                  >
                    {credentialLabel(provider.credential)}
                  </Chip>
                </div>
              ))}
            </div>
          </Surface>
          <Surface
            title="Proyectos"
            hint={`${snapshot.projects.length} registrados`}
            action={
              <button
                className="button-text"
                onClick={() => navigate("projects")}
              >
                Ver todos
              </button>
            }
          >
            {snapshot.projects.length === 0 ? (
              <EmptyState
                icon={<Users size={20} aria-hidden />}
                title="Sin proyectos aún"
                detail="Registra un repo para dar a cada rol un mapa de ownership antes de delegar."
              />
            ) : (
              <div style={{ display: "flex", flexDirection: "column" }}>
                {snapshot.projects.slice(0, 4).map((project) => (
                  <div className="ledger-row" key={project.id}>
                    <StatusDot status={project.status} />
                    <div className="row-body">
                      <strong>{project.name}</strong>
                      <span className="mono">{project.path}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Surface>
          <Surface
            title="Actividad reciente"
            hint={`${snapshot.usage.length} eventos medidos`}
            action={
              <button className="button-text" onClick={() => navigate("usage")}>
                Uso completo
              </button>
            }
          >
            {snapshot.usage.length === 0 ? (
              <EmptyState
                icon={<Gauge size={20} aria-hidden />}
                title="Sin actividad registrada"
                detail="Los eventos de uso observados por el Router aparecerán aquí cuando el equipo ejecute trabajo delegado."
              />
            ) : (
              <div style={{ display: "flex", flexDirection: "column" }}>
                {snapshot.usage.slice(0, 6).map((event) => (
                  <div className="activity-row" key={event.id}>
                    <span className="time num">
                      {formatLocalTimestamp(event.timestamp, "time")}
                    </span>
                    <span className={`role-tag tag-${event.role ?? "root"}`}>
                      {event.role?.slice(0, 3) ?? "run"}
                    </span>
                    <span
                      style={{
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {event.model}
                    </span>
                    <span className="mono num">
                      {event.providerCost !== undefined
                        ? `${formatCurrency(event.providerCost)} reportado`
                        : formatCurrency(event.estimatedCost ?? 0)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Surface>
        </div>
      </div>
      {snapshot.health && snapshot.health.status !== "healthy" && (
        <Callout tone="warn">
          <strong>
            El último chequeo marcó{" "}
            {statusLabel(snapshot.health.status).toLowerCase()}.
          </strong>{" "}
          Revisa Diagnostics para ver los hallazgos y su remediación (
          {relativeTime(
            snapshot.health.completedAt ?? snapshot.health.startedAt,
          )}
          ).
        </Callout>
      )}
      {recovery.confirmOpen && (
        <ConfirmModal
          title="Reiniciar Router durante una ejecución"
          body="Hay una tarea de Codex en curso. Reiniciar el Router puede interrumpirla. El proceso del Router se recupera; no se cambian proveedores, modelos ni credenciales."
          confirmLabel="Reiniciar de todos modos"
          danger
          busy={recovery.busy}
          onConfirm={() => void recovery.confirmRepair()}
          onClose={() => recovery.setConfirmOpen(false)}
        />
      )}
    </div>
  );
}
