import { useState } from "react";
import type {
  DiagnosticItem,
  LiveCheckPreview,
} from "@codex-orchestra/contracts";
import {
  FlaskConical,
  HeartPulse,
  RotateCcw,
  ScrollText,
  Stethoscope,
} from "lucide-react";
import { invokeCommand } from "../core/invoke";
import { routerEngine } from "../core/routerEngine";
import type { ViewContext } from "./types";
import { useRouterRecovery } from "./useRouterRecovery";
import {
  Callout,
  ConfirmModal,
  EmptyState,
  Modal,
  PageHead,
  StatusDot,
  Surface,
} from "../ui/primitives";
import { describeError, formatLocalTimestamp, statusLabel } from "../ui/format";

const categories: { id: DiagnosticItem["category"]; label: string }[] = [
  { id: "codex", label: "Codex" },
  { id: "router", label: "Router" },
  { id: "provider", label: "Proveedores" },
  { id: "model", label: "Modelos" },
  { id: "agent", label: "Agentes" },
  { id: "network", label: "Red" },
];

function DiagnosticRow({ item }: { item: DiagnosticItem }) {
  return (
    <div className="diagnostic-row">
      <StatusDot status={item.status} />
      <div className="body">
        <strong>{item.label}</strong>
        <span>{item.detail}</span>
      </div>
      <code>{item.value}</code>
    </div>
  );
}

export function Diagnostics({ snapshot, setSnapshot, notice }: ViewContext) {
  const [running, setRunning] = useState(false);
  const [liveProvider, setLiveProvider] = useState("qwen-plan");
  const [liveModel, setLiveModel] = useState(
    () =>
      snapshot.models.find((model) => model.providerId === "qwen-plan")?.id ??
      "",
  );
  const [liveTest, setLiveTest] =
    useState<LiveCheckPreview["test"]>("compatibility");
  const [livePreview, setLivePreview] = useState<LiveCheckPreview | null>(null);
  const [liveBusy, setLiveBusy] = useState(false);
  const healthHistory =
    snapshot.healthHistory ?? (snapshot.health ? [snapshot.health] : []);
  const recovery = useRouterRecovery(snapshot, setSnapshot, notice);

  async function runHealth() {
    setRunning(true);
    try {
      await invokeCommand("run_health_check");
      setSnapshot(
        await invokeCommand<ViewContext["snapshot"]>("get_snapshot_fast"),
      );
      notice("Chequeo completado. Salida redactada por defecto.");
    } catch (cause) {
      notice(describeError(cause, "El chequeo falló."));
    } finally {
      setRunning(false);
    }
  }

  async function previewLive() {
    if (!liveModel) {
      notice("El proveedor elegido no tiene modelo en el catálogo actual.");
      return;
    }
    try {
      const preview = await routerEngine.previewLiveCheck(
        liveProvider,
        liveModel,
        liveTest,
      );
      setLivePreview(preview as LiveCheckPreview);
    } catch (cause) {
      const message = describeError(
        cause,
        "La vista previa del live check falló.",
      );
      notice(message);
      if (
        message.toLowerCase().includes("10061") ||
        message.toLowerCase().includes("connection refused")
      ) {
        notice("Router offline — Codex model requests may fail.");
      }
    }
  }

  async function executeLive() {
    if (!livePreview) return;
    setLiveBusy(true);
    try {
      await routerEngine.runLiveCheck(
        livePreview.provider,
        livePreview.model,
        livePreview.test,
      );
      setLivePreview(null);
      setSnapshot(
        await invokeCommand<ViewContext["snapshot"]>("get_snapshot_fast"),
      );
      notice("Live check completado.");
    } catch (cause) {
      notice(describeError(cause, "El live check falló."));
    } finally {
      setLiveBusy(false);
    }
  }

  return (
    <div className="view">
      <PageHead
        title="Diagnóstico"
        lede="Evidencia antes que confianza: una fila de catálogo no prueba que un agente funcione. El chequeo local es redactado y los live checks siempre son opt-in."
        actions={
          <button
            className="button button-primary"
            disabled={running}
            onClick={() => void runHealth()}
          >
            <Stethoscope size={15} aria-hidden />
            {running ? "Chequeando…" : "Ejecutar chequeo local"}
          </button>
        }
      />
      <div className="diag-summary">
        <div>
          <span className="label">Estado local</span>
          <strong>
            <StatusDot status={snapshot.health?.status ?? "missing"} />
            {snapshot.health
              ? statusLabel(snapshot.health.status)
              : "Sin chequeos aún"}
          </strong>
          <span>
            {snapshot.health
              ? formatLocalTimestamp(
                  snapshot.health.completedAt ?? snapshot.health.startedAt,
                )
              : "corre el primer chequeo para tener base"}
          </span>
        </div>
        <div>
          <span className="label">Items</span>
          <strong className="num">{snapshot.diagnostics.length}</strong>
          <span>chequeos individuales</span>
        </div>
        <div>
          <span className="label">Privacidad</span>
          <strong>Redactado</strong>
          <span>sin rutas ni credenciales</span>
        </div>
      </div>
      {(recovery.down || recovery.error) && (
        <Callout tone="bad">
          Router offline — Codex model requests may fail.
        </Callout>
      )}
      <Surface
        title="Router"
        hint="proceso local"
        action={
          <div className="router-diag-actions">
            <button
              className="button button-ghost"
              disabled={recovery.busy}
              onClick={() => void recovery.requestRepair()}
            >
              <RotateCcw size={15} aria-hidden />
              {recovery.busy ? "Restarting…" : "Restart Router"}
            </button>
            <button
              className="button button-ghost"
              onClick={() => void recovery.loadLogs()}
            >
              <ScrollText size={15} aria-hidden />
              View logs
            </button>
          </div>
        }
      >
        <div className="router-diag-body">
          <div className="router-diag-status">
            <StatusDot
              status={
                recovery.down
                  ? "unhealthy"
                  : snapshot.router.detected
                    ? snapshot.router.health
                    : "missing"
              }
            />
            <div>
              <strong>
                {recovery.down
                  ? "Offline"
                  : snapshot.router.service === "running"
                    ? "Running"
                    : snapshot.router.detected
                      ? "Detected"
                      : "Missing"}
              </strong>
              <span>
                {recovery.runtime?.message ??
                  (recovery.down
                    ? "Router offline — Codex model requests may fail."
                    : "Loopback process observed through RouterEngine.")}
              </span>
            </div>
          </div>
          {recovery.phaseLabel && (
            <p className="router-diag-phase">{recovery.phaseLabel}</p>
          )}
          {recovery.error && <Callout tone="bad">{recovery.error}</Callout>}
        </div>
      </Surface>
      <div className="diagnostics-grid">
        {categories.map((category) => {
          const items = snapshot.diagnostics.filter(
            (item) => item.category === category.id,
          );
          if (items.length === 0) return null;
          return (
            <Surface
              key={category.id}
              title={category.label}
              hint={`${items.length} items`}
              flush
            >
              <div>
                {items.map((item) => (
                  <DiagnosticRow item={item} key={item.id} />
                ))}
              </div>
            </Surface>
          );
        })}
      </div>
      <div className="grid-2">
        <Surface
          title="Historial de chequeos"
          hint="últimos 20 persistidos"
          flush
        >
          {healthHistory.length === 0 ? (
            <EmptyState
              icon={<HeartPulse size={20} aria-hidden />}
              title="Sin historial"
              detail="Ejecuta el chequeo local para establecer la primera línea base."
            />
          ) : (
            <div>
              {healthHistory.slice(0, 8).map((report) => {
                const attention = report.checks.filter(
                  (check) =>
                    check.status === "missing" ||
                    check.status === "unhealthy" ||
                    check.status === "degraded",
                ).length;
                return (
                  <div className="health-history-row" key={report.id}>
                    <StatusDot status={report.status} />
                    <div>
                      <strong>{statusLabel(report.status)}</strong>
                      <span>
                        {formatLocalTimestamp(
                          report.completedAt ?? report.startedAt,
                        )}
                      </span>
                    </div>
                    <span className="mono num">
                      {report.checks.length} checks · {attention} por atender
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </Surface>
        <Surface title="Live check explícito" hint="prueba con cargo real">
          <p style={{ color: "var(--ink-2)", fontSize: 13, marginBottom: 14 }}>
            La vista previa debe nombrar proveedor, modelo y test antes de que
            pueda correr cualquier petición pagada.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="field-row">
              <label className="field">
                <span>Proveedor</span>
                <select
                  value={liveProvider}
                  onChange={(event) => {
                    const provider = event.target.value;
                    setLiveProvider(provider);
                    setLiveModel(
                      snapshot.models.find(
                        (model) => model.providerId === provider,
                      )?.id ?? "",
                    );
                    setLivePreview(null);
                  }}
                >
                  <option value="qwen-plan">Qwen Token Plan</option>
                  <option value="opencode-go">OpenCode Go / Kimi</option>
                  <option value="grok-oauth">SuperGrok OAuth</option>
                  <option value="grok-api">xAI API</option>
                  <option value="kimi-api">Kimi Platform API</option>
                </select>
              </label>
              <label className="field">
                <span>Test</span>
                <select
                  value={liveTest}
                  onChange={(event) => {
                    setLiveTest(event.target.value as LiveCheckPreview["test"]);
                    setLivePreview(null);
                  }}
                >
                  <option value="compatibility">
                    Suite de compatibilidad del Router
                  </option>
                  <option value="agent-behavior">
                    Comportamiento de agente en Codex
                  </option>
                </select>
              </label>
            </div>
            <label className="field">
              <span>Modelo</span>
              <input className="mono" value={liveModel} readOnly />
            </label>
            {!livePreview ? (
              <button
                className="button button-ghost"
                disabled={!liveModel}
                onClick={() => void previewLive()}
              >
                <FlaskConical size={15} aria-hidden />
                Vista previa del live check
              </button>
            ) : (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                }}
              >
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: 8,
                    fontSize: 13,
                  }}
                >
                  <span style={{ color: "var(--ink-3)" }}>Proveedor</span>
                  <code>{livePreview.provider}</code>
                  <span style={{ color: "var(--ink-3)" }}>Modelo</span>
                  <code>{livePreview.model}</code>
                  <span style={{ color: "var(--ink-3)" }}>Facturación</span>
                  <span>{livePreview.billingSource}</span>
                  <span style={{ color: "var(--ink-3)" }}>Cobertura</span>
                  <span>{livePreview.coveredChecks.join(", ")}</span>
                </div>
                <Callout tone="warn">{livePreview.estimatedCostNote}</Callout>
                <button
                  className="button button-primary"
                  disabled={liveBusy}
                  onClick={() => void executeLive()}
                >
                  {liveBusy ? "Ejecutando…" : "Ejecutar check confirmado"}
                </button>
              </div>
            )}
          </div>
        </Surface>
      </div>
      {recovery.confirmOpen && (
        <ConfirmModal
          title="Reiniciar Router durante una ejecución"
          body="Hay una tarea de Codex en curso. Reiniciar el Router puede interrumpirla. Solo se recupera el proceso; no se cambian proveedores, modelos ni credenciales."
          confirmLabel="Reiniciar de todos modos"
          danger
          busy={recovery.busy}
          onConfirm={() => void recovery.confirmRepair()}
          onClose={() => recovery.setConfirmOpen(false)}
        />
      )}
      {recovery.logs && (
        <Modal title="Router logs" onClose={() => recovery.setLogs(null)}>
          {recovery.logs.lines.length === 0 ? (
            <p>{recovery.logs.message}</p>
          ) : (
            <pre className="router-log-lines">
              {recovery.logs.lines
                .map((line) => `${line.source}: ${line.text}`)
                .join("\n")}
            </pre>
          )}
        </Modal>
      )}
    </div>
  );
}
