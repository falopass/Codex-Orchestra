import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type {
  DelegationEvidence,
  OrchestraSnapshot,
} from "@codex-orchestra/contracts";
import { FRONTEND_MODEL_CANDIDATES } from "@codex-orchestra/contracts";
import { Hand, Play, ShieldAlert, Square, Workflow } from "lucide-react";
import { invokeCommand } from "../core/invoke";
import type { ViewContext } from "./types";
import {
  Callout,
  Chip,
  EmptyState,
  PageHead,
  StatusDot,
  Surface,
} from "../ui/primitives";
import { describeError } from "../ui/format";

type AppServerEvent = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
};

type PendingApproval = {
  id: number;
  method: string;
  detail: string;
};

type RequestedWorkerRole = DelegationEvidence["requestedRole"];

function eventDetail(event: AppServerEvent) {
  const params = event.params ?? {};
  if (typeof params.reason === "string") return params.reason;
  if (typeof params.command === "string") return params.command;
  if (typeof params.message === "string") return params.message;
  const item = params.item as Record<string, unknown> | undefined;
  if (item?.type === "commandExecution") return "Ejecutando un comando local";
  if (item?.type === "fileChange") return "Preparando cambios de archivo";
  return event.method ?? "Evento de Codex";
}

export function Run({ snapshot, setSnapshot, notice, navigate }: ViewContext) {
  const rootAgent = snapshot.agents.find((agent) => agent.role === "root");
  const nativeModels = snapshot.models.filter(
    (model) => model.providerId === "openai" && model.available,
  );
  const [projectPath, setProjectPath] = useState(
    snapshot.projects[0]?.path ?? "",
  );
  const [model, setModel] = useState(
    rootAgent?.modelId ?? nativeModels[0]?.id ?? "gpt-5.6-sol",
  );
  const [effort, setEffort] = useState(rootAgent?.reasoningEffort ?? "high");
  const [requestedRole, setRequestedRole] =
    useState<RequestedWorkerRole>("unspecified");
  const [prompt, setPrompt] = useState("");
  const [answer, setAnswer] = useState("");
  const [events, setEvents] = useState<string[]>([]);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [run, setRun] = useState<{
    threadId: string;
    turnId: string;
    status: "inProgress" | "completed" | "interrupted" | "failed";
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const selectedModel = nativeModels.find((item) => item.id === model);
  const efforts = selectedModel?.reasoningEfforts ?? ["medium", "high", "max"];
  const requestedWorkerModel = (() => {
    if (requestedRole === "engineer") {
      return snapshot.agents.find((agent) => agent.role === "engineer")
        ?.modelId;
    }
    const candidate = FRONTEND_MODEL_CANDIDATES.find((item) =>
      requestedRole === "visual" ? item.key === "kimi" : item.key === "qwen",
    );
    if (!candidate || requestedRole === "unspecified") return undefined;
    return snapshot.models.find(
      (item) =>
        item.available &&
        item.providerId === candidate.provider &&
        (item.upstreamModel === candidate.upstreamModel ||
          item.id === `${candidate.provider}/${candidate.upstreamModel}`),
    )?.id;
  })();
  const delegationEvidence = snapshot.delegationEvidence ?? [];

  useEffect(() => {
    if (snapshot.projects.length && !projectPath) {
      setProjectPath(snapshot.projects[0].path);
    }
  }, [projectPath, snapshot.projects]);

  useEffect(() => {
    if (!efforts.includes(effort)) setEffort(efforts[0] ?? "high");
  }, [effort, efforts]);

  useEffect(() => {
    if (
      !(window as Window & { __TAURI_INTERNALS__?: unknown })
        .__TAURI_INTERNALS__
    ) {
      return;
    }
    let unlisten: (() => void) | undefined;
    void listen<AppServerEvent>("app-server-event", (event) => {
      const payload = event.payload;
      const method = payload.method ?? "";
      const params = payload.params ?? {};
      if (method === "item/agentMessage/delta") {
        const delta = typeof params.delta === "string" ? params.delta : "";
        if (delta) setAnswer((current) => current + delta);
        return;
      }
      if (
        method.includes("/requestApproval") &&
        typeof payload.id === "number"
      ) {
        setApprovals((current) => [
          ...current.filter((item) => item.id !== payload.id),
          { id: payload.id!, method, detail: eventDetail(payload) },
        ]);
      }
      if (
        method === "serverRequest/resolved" &&
        typeof params.requestId === "number"
      ) {
        setApprovals((current) =>
          current.filter((item) => item.id !== params.requestId),
        );
      }
      if (method === "turn/completed") {
        const turn = params.turn as Record<string, unknown> | undefined;
        const status = turn?.status;
        if (
          status === "completed" ||
          status === "interrupted" ||
          status === "failed"
        ) {
          setRun((current) => (current ? { ...current, status } : current));
          void invokeCommand<OrchestraSnapshot>("get_snapshot_fast").then(
            setSnapshot,
          );
        }
      }
      if (method === "orchestra/sessionClosed") {
        setEvents((current) => [
          ...current.slice(-19),
          "Sesión local cerrada.",
        ]);
        return;
      }
      if (method && method !== "item/reasoning/summaryTextDelta") {
        setEvents((current) => [...current.slice(-19), eventDetail(payload)]);
      }
    }).then((dispose) => {
      unlisten = dispose;
    });
    return () => unlisten?.();
  }, [setSnapshot]);

  async function enableIntegration() {
    try {
      await invokeCommand("save_feature_flags", {
        flags: {
          ...(snapshot.featureFlags ?? {}),
          appServer: true,
        },
        confirm: true,
      });
      setSnapshot(await invokeCommand<OrchestraSnapshot>("get_snapshot_fast"));
      notice("Conexión local con Codex activada. No se modificó config.toml.");
    } catch (cause) {
      notice(describeError(cause, "No se pudo activar App Server."));
    }
  }

  async function start() {
    if (!projectPath.trim()) {
      notice("Primero agrega o elige un proyecto local.");
      return;
    }
    if (!prompt.trim()) {
      notice("Escribe la tarea que quieres ejecutar.");
      return;
    }
    setBusy(true);
    setAnswer("");
    setEvents([]);
    setApprovals([]);
    try {
      const result = await invokeCommand<{
        threadId: string;
        turnId: string;
        status: "inProgress";
      }>("start_codex_execution", {
        projectPath,
        model,
        effort,
        prompt,
        requestedRole,
        requestedWorkerModel,
      });
      setRun(result);
      notice(
        "Codex inició la tarea. La respuesta vive solo en memoria mientras esta ventana esté abierta.",
      );
    } catch (cause) {
      notice(describeError(cause, "Codex no pudo iniciar la tarea."));
    } finally {
      setBusy(false);
    }
  }

  async function interrupt() {
    try {
      await invokeCommand("interrupt_codex_execution");
      notice("Se solicitó detener el turno actual.");
    } catch (cause) {
      notice(describeError(cause, "No se pudo detener el turno."));
    }
  }

  async function resolve(
    approval: PendingApproval,
    decision: "accept" | "decline",
  ) {
    try {
      await invokeCommand("resolve_codex_approval", {
        requestId: approval.id,
        decision,
      });
      setApprovals((current) =>
        current.filter((item) => item.id !== approval.id),
      );
    } catch (cause) {
      notice(describeError(cause, "No se pudo responder la aprobación."));
    }
  }

  async function close() {
    try {
      await invokeCommand("close_codex_execution");
      setRun(null);
      setApprovals([]);
      notice("Sesión local de Codex cerrada.");
    } catch (cause) {
      notice(describeError(cause, "No se pudo cerrar la sesión."));
    }
  }

  return (
    <div className="view">
      <PageHead
        title="Ejecutar"
        lede="Orchestra inicia una conversación local de Codex sobre el proyecto elegido. Ni el prompt ni la respuesta se guardan en disco."
        actions={
          <Chip tone={run?.status === "inProgress" ? "ok" : "neutral"}>
            {run?.status === "inProgress"
              ? "en curso"
              : run
                ? run.status === "completed"
                  ? "completado"
                  : run.status === "failed"
                    ? "falló"
                    : "detenido"
                : "listo"}
          </Chip>
        }
      />
      {!snapshot.featureFlags?.appServer ? (
        <Surface>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 12,
              alignItems: "flex-start",
            }}
          >
            <h2 style={{ fontSize: 16 }}>
              Activa la conexión local una sola vez
            </h2>
            <p style={{ color: "var(--ink-2)", fontSize: 13.5, maxWidth: 560 }}>
              Orchestra usa el App Server del Codex que ya tienes instalado: un
              stdio local para iniciar tareas, ver actividad y aprobar acciones.
              No modifica tu configuración nativa ni lee credenciales.
            </p>
            <button
              className="button button-primary"
              onClick={() => void enableIntegration()}
            >
              <Play size={15} aria-hidden />
              Activar Codex local
            </button>
          </div>
        </Surface>
      ) : (
        <div className="run-layout">
          <Surface title="Nueva tarea" hint="delegación al root">
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <label className="field">
                <span>Proyecto</span>
                <select
                  value={projectPath}
                  disabled={!!run}
                  onChange={(event) => setProjectPath(event.target.value)}
                >
                  <option value="">Elige un proyecto…</option>
                  {snapshot.projects.map((project) => (
                    <option key={project.id} value={project.path}>
                      {project.name} · {project.path}
                    </option>
                  ))}
                </select>
              </label>
              <div className="field-row">
                <label className="field">
                  <span>Modelo root</span>
                  <select
                    value={model}
                    disabled={!!run}
                    onChange={(event) => setModel(event.target.value)}
                  >
                    {nativeModels.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Esfuerzo</span>
                  <select
                    value={effort}
                    disabled={!!run}
                    onChange={(event) => setEffort(event.target.value)}
                  >
                    {efforts.map((item) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="field">
                <span>Delegación esperada</span>
                <select
                  value={requestedRole}
                  disabled={!!run}
                  onChange={(event) =>
                    setRequestedRole(event.target.value as RequestedWorkerRole)
                  }
                >
                  <option value="unspecified">Sol decide si delega</option>
                  <option value="engineer">Engineer · Grok 4.6</option>
                  <option value="frontend">Frontend · Qwen 3.8 Max</option>
                  <option value="visual">Visual · Kimi K3</option>
                </select>
                <span className="field-help">
                  {requestedWorkerModel
                    ? `Binding actual: ${requestedWorkerModel}`
                    : "No fija un worker; el root conserva la decisión."}
                </span>
              </label>
              <label className="field">
                <span>Tarea</span>
                <textarea
                  rows={8}
                  value={prompt}
                  disabled={!!run}
                  placeholder="Ej.: revisa el error de build y propón el cambio mínimo."
                  onChange={(event) => setPrompt(event.target.value)}
                />
              </label>
              <div className="button-row">
                {!run ? (
                  <button
                    className="button button-primary"
                    disabled={busy}
                    onClick={() => void start()}
                  >
                    <Play size={15} aria-hidden />
                    {busy ? "Iniciando…" : "Ejecutar con Codex"}
                  </button>
                ) : (
                  <>
                    {run.status === "inProgress" && (
                      <button
                        className="button button-ghost"
                        onClick={() => void interrupt()}
                      >
                        <Square size={13} aria-hidden />
                        Detener turno
                      </button>
                    )}
                    <button
                      className="button button-ghost"
                      onClick={() => void close()}
                    >
                      Cerrar sesión
                    </button>
                  </>
                )}
              </div>
              {run && (
                <p
                  className="mono"
                  style={{ color: "var(--ink-3)", fontSize: 11.5 }}
                >
                  thread {run.threadId} · {run.status}
                </p>
              )}
            </div>
          </Surface>
          <Surface
            title="Actividad en vivo"
            hint="memoria, nunca disco"
            action={
              <StatusDot
                pulse={run?.status === "inProgress"}
                status={
                  run?.status === "failed"
                    ? "unhealthy"
                    : run
                      ? "healthy"
                      : "unknown"
                }
              />
            }
          >
            {approvals.map((approval) => (
              <div className="approval-card" key={approval.id}>
                <strong>
                  <ShieldAlert size={15} aria-hidden />
                  Requiere tu aprobación
                </strong>
                <span>{approval.detail}</span>
                <div className="button-row">
                  <button
                    className="button button-primary"
                    onClick={() => void resolve(approval, "accept")}
                  >
                    <Hand size={14} aria-hidden />
                    Aprobar
                  </button>
                  <button
                    className="button button-ghost"
                    onClick={() => void resolve(approval, "decline")}
                  >
                    Rechazar
                  </button>
                </div>
              </div>
            ))}
            {answer ? (
              <pre className="stream-answer">{answer}</pre>
            ) : (
              <p style={{ color: "var(--ink-2)", fontSize: 13 }}>
                La respuesta y el progreso aparecerán aquí; no se guardan al
                cerrar la sesión.
              </p>
            )}
            {events.length > 0 && (
              <div className="stream-events">
                {events.map((event, index) => (
                  <span key={`${event}-${index}`}>{event}</span>
                ))}
              </div>
            )}
          </Surface>
        </div>
      )}
      {snapshot.featureFlags?.appServer && (
        <Surface
          title="Delegaciones observadas"
          hint="evidencia redactada"
          action={
            <button className="button-text" onClick={() => navigate("usage")}>
              Ver uso
            </button>
          }
        >
          <Callout>
            Solo se conserva modelo raíz, binding solicitado, acción y estado.
            Nunca prompts, respuestas, rutas, argumentos ni IDs de Codex.
          </Callout>
          {delegationEvidence.length === 0 ? (
            <EmptyState
              icon={<Workflow size={20} aria-hidden />}
              title="Sin delegaciones todavía"
              detail="Cuando App Server observe una delegación completada del root, aparecerá aquí."
            />
          ) : (
            <div style={{ marginTop: 4 }}>
              {delegationEvidence.slice(0, 8).map((item) => (
                <div className="evidence-row" key={item.id}>
                  <div className="body">
                    <strong>
                      {item.rootModel} → {item.requestedRole}
                    </strong>
                    <span className="mono">
                      {item.action} · {item.status}
                    </span>
                  </div>
                  <Chip tone={item.status === "completed" ? "ok" : "warn"}>
                    {item.childCreated ? "subhilo creado" : "observado"}
                  </Chip>
                </div>
              ))}
            </div>
          )}
        </Surface>
      )}
    </div>
  );
}
