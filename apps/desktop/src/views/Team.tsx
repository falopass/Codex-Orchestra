import { useEffect, useState } from "react";
import type {
  AgentDefinition,
  FrontendModelStrategy,
  LiveCheckPreview,
} from "@codex-orchestra/contracts";
import {
  DEFAULT_FRONTEND_STRATEGY,
  FRONTEND_MODEL_CANDIDATES,
  MODEL_REASONING_EFFORTS,
  frontendStrategyForKey,
  resolveFrontendModelStrategy,
} from "@codex-orchestra/contracts";
import { FlaskConical, Save } from "lucide-react";
import { invokeCommand } from "../core/invoke";
import { routerEngine } from "../core/routerEngine";
import type { ViewContext } from "./types";
import {
  BrandMark,
  Callout,
  Chip,
  ConfirmModal,
  PageHead,
  StatusDot,
  Surface,
  statusTone,
} from "../ui/primitives";
import { describeError, statusLabel } from "../ui/format";

function candidateHealth(
  snapshot: ViewContext["snapshot"],
  candidate: ReturnType<
    typeof resolveFrontendModelStrategy
  >["candidates"][number],
) {
  const provider = snapshot.providers.find(
    (item) => item.id === candidate.candidate.provider,
  );
  if (!candidate.model || provider?.enabled === false) return "missing";
  if (provider?.credential === "invalid" || provider?.credential === "expired")
    return "unhealthy";
  if (provider?.credential === "configured") return "healthy";
  return "unknown";
}

export function Team({ snapshot, setSnapshot, navigate, notice }: ViewContext) {
  const initialAgent =
    snapshot.agents.find((agent) => agent.role === "frontend") ??
    snapshot.agents[0];
  const [selected, setSelected] = useState<AgentDefinition>(initialAgent);
  const [draft, setDraft] = useState<AgentDefinition>(initialAgent);
  const [strategyDraft, setStrategyDraft] = useState<FrontendModelStrategy>(
    snapshot.frontendStrategy ?? DEFAULT_FRONTEND_STRATEGY,
  );
  const [capabilityCheck, setCapabilityCheck] =
    useState<LiveCheckPreview | null>(null);

  useEffect(() => {
    const current =
      snapshot.agents.find((agent) => agent.id === selected.id) ??
      snapshot.agents[0];
    if (current) {
      setSelected(current);
      setDraft(current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.agents]);

  useEffect(() => {
    setStrategyDraft(snapshot.frontendStrategy ?? DEFAULT_FRONTEND_STRATEGY);
  }, [snapshot.frontendStrategy]);

  const savedResolution = resolveFrontendModelStrategy(
    snapshot.frontendStrategy ?? DEFAULT_FRONTEND_STRATEGY,
    snapshot.models,
  );
  const draftResolution = resolveFrontendModelStrategy(
    strategyDraft,
    snapshot.models,
  );

  const modelChoices = snapshot.models.filter((model) => {
    if (!model.available && model.id !== draft.modelId) return false;
    if (selected.role === "root") return model.providerId === "openai";
    return model.providerId === draft.providerId || model.id === draft.modelId;
  });
  const selectedModel = modelChoices.find(
    (model) => model.id === draft.modelId,
  );
  const reasoningChoices = [
    ...new Set([
      ...(selectedModel?.reasoningEfforts ?? MODEL_REASONING_EFFORTS),
      draft.reasoningEffort,
    ]),
  ];

  async function saveRole() {
    try {
      const saved = await invokeCommand<AgentDefinition>(
        "update_agent_definition",
        { agent: draft },
      );
      setSelected(saved);
      setDraft(saved);
      setSnapshot(
        await invokeCommand<ViewContext["snapshot"]>("get_snapshot_fast"),
      );
      notice(`${saved.name} guardado localmente. No se tocó ningún archivo.`);
    } catch (cause) {
      notice(describeError(cause, "No se pudo guardar la configuración."));
    }
  }

  async function saveStrategy() {
    if (strategyDraft.mode === "pinned" && !draftResolution.selectedModel) {
      notice(
        "El modelo fijado no está en el catálogo actual. Elige otro o actualiza el catálogo; no se cambia de proveedor automáticamente.",
      );
      return;
    }
    try {
      await routerEngine.saveFrontendStrategy(strategyDraft);
      setSnapshot(
        await invokeCommand<ViewContext["snapshot"]>("get_snapshot_fast"),
      );
      notice(
        strategyDraft.mode === "auto"
          ? "Frontend en AUTO: Qwen es la primera opción; Kimi queda reservado para trabajo visual."
          : `Frontend fijado a ${draftResolution.selectedCandidate?.label ?? "la selección indicada"}.`,
      );
    } catch (cause) {
      notice(
        describeError(cause, "La estrategia frontend no se pudo guardar."),
      );
    }
  }

  async function previewCapability() {
    if (selected.role === "root") {
      notice("Root usa Codex nativo. La prueba App Server vive en Sistema.");
      return;
    }
    if (!selected.modelId) {
      notice("Este rol no tiene binding de modelo resuelto.");
      return;
    }
    try {
      const preview = (await routerEngine.previewLiveCheck(
        selected.providerId,
        selected.modelId,
        "agent-behavior",
      )) as LiveCheckPreview;
      setCapabilityCheck(preview);
    } catch (cause) {
      notice(describeError(cause, "No se pudo preparar la prueba."));
    }
  }

  async function runCapability() {
    if (!capabilityCheck) return;
    try {
      await routerEngine.runLiveCheck(
        capabilityCheck.provider,
        capabilityCheck.model,
        capabilityCheck.test,
      );
      setCapabilityCheck(null);
      setSnapshot(
        await invokeCommand<ViewContext["snapshot"]>("get_snapshot_fast"),
      );
      notice(`Prueba de capacidad completada para ${selected.name}.`);
    } catch (cause) {
      notice(describeError(cause, "La prueba de capacidad falló."));
    }
  }

  return (
    <div className="view">
      <PageHead
        title="Equipo"
        lede="Tres roles, un dueño. Sol decide qué delega; los bindings se resuelven contra el catálogo vivo para que un modelo viejo nunca se vuelva contrato."
        actions={
          <button
            className="button button-ghost"
            onClick={() => navigate("setup")}
          >
            Archivos generados
          </button>
        }
      />
      <div className="team-layout">
        <div className="role-list" role="list">
          {snapshot.agents.map((agent) => (
            <button
              className="role-card"
              role="listitem"
              key={agent.id}
              aria-pressed={selected.id === agent.id}
              onClick={() => {
                setSelected(agent);
                setDraft(agent);
              }}
            >
              <BrandMark
                brand={
                  agent.role === "frontend"
                    ? "frontend"
                    : agent.role === "engineer"
                      ? "engineer"
                      : "orchestra"
                }
              />
              <span className="role-copy">
                <span className="kind">{agent.role}</span>
                <h3>{agent.name}</h3>
                <span className="model-line">
                  {agent.role === "frontend"
                    ? (savedResolution.selectedModel?.label ??
                      "binding sin resolver")
                    : (agent.modelId ?? "Codex nativo")}
                </span>
              </span>
              <StatusDot status={agent.health} />
            </button>
          ))}
          <div className="callout" style={{ marginTop: 4 }}>
            <div>
              <strong>Kimi K3 (visual)</strong> es un agente selectivo generado
              por Configuración; no recibe delegación automática.
            </div>
          </div>
        </div>
        <Surface>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              marginBottom: 16,
            }}
          >
            <BrandMark
              brand={
                selected.role === "frontend"
                  ? "frontend"
                  : selected.role === "engineer"
                    ? "engineer"
                    : "orchestra"
              }
              size="large"
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <p className="group-label" style={{ margin: 0 }}>
                rol {selected.role}
              </p>
              <h2 style={{ fontSize: 17 }}>{selected.name}</h2>
            </div>
            <Chip tone={statusTone(selected.health)}>
              {statusLabel(selected.health)}
            </Chip>
          </div>
          {selected.role === "frontend" ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div className="field" style={{ maxWidth: 320 }}>
                <span>Estrategia</span>
                <select
                  value={
                    strategyDraft.mode === "auto"
                      ? "auto"
                      : strategyDraft.pinnedModel?.provider === "opencode-go"
                        ? "kimi"
                        : "qwen"
                  }
                  onChange={(event) =>
                    setStrategyDraft(
                      frontendStrategyForKey(
                        event.target.value as "auto" | "qwen" | "kimi",
                      ),
                    )
                  }
                >
                  <option value="auto">AUTO · Sol decide</option>
                  <option value="qwen">Fijar Qwen 3.8 Max</option>
                  <option value="kimi">Fijar Kimi K3 (visual)</option>
                </select>
                <span className="field-help">
                  Solo se persiste la selección lógica. Las credenciales viven
                  en el Router.
                </span>
              </div>
              <div
                style={{ display: "flex", flexDirection: "column", gap: 10 }}
              >
                {draftResolution.candidates.map((entry) => {
                  const health = candidateHealth(snapshot, entry);
                  const active =
                    strategyDraft.mode === "auto"
                      ? entry.candidate.key ===
                        draftResolution.selectedCandidate?.key
                      : entry.candidate.provider ===
                        strategyDraft.pinnedModel?.provider;
                  return (
                    <div className="candidate-row" key={entry.candidate.key}>
                      <BrandMark
                        brand={
                          entry.candidate.key === "qwen" ? "qwen" : "opencode"
                        }
                      />
                      <div className="candidate-copy">
                        <div className="heading">
                          <strong>{entry.candidate.label}</strong>
                          <StatusDot status={health} />
                          <Chip tone={statusTone(health)}>
                            {statusLabel(health)}
                          </Chip>
                          {active && <Chip tone="ok">ruta activa</Chip>}
                        </div>
                        <span className="sub">
                          {entry.candidate.providerLabel} · razonamiento{" "}
                          {entry.candidate.reasoningEffort}
                        </span>
                        <p>{entry.candidate.purpose}</p>
                        <code>
                          {entry.model?.id ?? "sin resolver en catálogo"}
                        </code>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 13,
                  color: "var(--ink-2)",
                }}
              >
                <StatusDot
                  status={
                    savedResolution.status === "healthy"
                      ? selected.health
                      : savedResolution.status
                  }
                />
                Guardado:{" "}
                {savedResolution.selectedCandidate?.label ??
                  "candidato no disponible"}{" "}
                ·{" "}
                {savedResolution.status === "degraded"
                  ? "AUTO degradado: solo un candidato listo"
                  : savedResolution.status === "missing"
                    ? "ningún candidato listo; configura el proveedor"
                    : "candidato listo"}
              </div>
              <div className="button-row">
                <button
                  className="button button-primary"
                  onClick={() => void saveStrategy()}
                >
                  <Save size={15} aria-hidden />
                  Guardar estrategia
                </button>
                <button
                  className="button button-ghost"
                  onClick={() => setStrategyDraft(DEFAULT_FRONTEND_STRATEGY)}
                >
                  Volver a Qwen por defecto
                </button>
                <button
                  className="button button-ghost"
                  onClick={() => void previewCapability()}
                >
                  <FlaskConical size={15} aria-hidden />
                  Probar agente
                </button>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div className="field-row">
                <label className="field">
                  <span>Proveedor</span>
                  {selected.role === "root" ? (
                    <input value="Codex nativo (OpenAI)" readOnly />
                  ) : (
                    <select
                      value={draft.providerId}
                      onChange={(event) => {
                        const providerId = event.target.value;
                        const nextModel = snapshot.models.find(
                          (model) =>
                            model.providerId === providerId && model.available,
                        );
                        setDraft((current) => ({
                          ...current,
                          providerId,
                          modelId: nextModel?.id ?? current.modelId,
                        }));
                      }}
                    >
                      <option value="grok-oauth">SuperGrok OAuth</option>
                      <option value="grok-api">xAI API</option>
                    </select>
                  )}
                </label>
                <label className="field">
                  <span>Modelo</span>
                  <select
                    value={draft.modelId ?? ""}
                    onChange={(event) =>
                      setDraft((current) => {
                        const nextModel = modelChoices.find(
                          (model) => model.id === event.target.value,
                        );
                        const nextEffort = nextModel?.reasoningEfforts.includes(
                          current.reasoningEffort,
                        )
                          ? current.reasoningEffort
                          : (nextModel?.reasoningEfforts[0] ??
                            current.reasoningEffort);
                        return {
                          ...current,
                          modelId: event.target.value,
                          reasoningEffort: nextEffort,
                        };
                      })
                    }
                  >
                    {modelChoices.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Esfuerzo de razonamiento</span>
                  <select
                    value={draft.reasoningEffort}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        reasoningEffort: event.target.value,
                      }))
                    }
                  >
                    {reasoningChoices.map((effort) => (
                      <option key={effort} value={effort}>
                        {effort}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="field-row">
                <label className="field">
                  <span>Política de reintento</span>
                  <input
                    value={`${selected.retryLimit} reintento · luego vuelve al root`}
                    readOnly
                  />
                </label>
                <label className="field">
                  <span>Permisos</span>
                  <input value={selected.permissions.join(" · ")} readOnly />
                </label>
              </div>
              {selected.role === "engineer" && (
                <div className="button-row">
                  <button
                    className="button button-primary"
                    onClick={() => void saveRole()}
                  >
                    <Save size={15} aria-hidden />
                    Guardar rol
                  </button>
                  <button
                    className="button button-ghost"
                    onClick={() => void previewCapability()}
                  >
                    <FlaskConical size={15} aria-hidden />
                    Probar agente
                  </button>
                </div>
              )}
            </div>
          )}
          <div style={{ marginTop: 20 }}>
            <div className="detail-section">
              <span className="label">Ownership</span>
              <div className="path-chips">
                {selected.ownershipPaths.map((path) => (
                  <code key={path}>{path}</code>
                ))}
              </div>
            </div>
            <div className="detail-section" style={{ marginTop: 12 }}>
              <span className="label">Reglas de ruteo</span>
              <div className="path-chips">
                {selected.routingHints.map((hint) => (
                  <Chip key={hint}>{hint}</Chip>
                ))}
              </div>
            </div>
            <p
              style={{
                marginTop: 14,
                fontSize: 12.5,
                color: "var(--ink-3)",
                display: "flex",
                alignItems: "center",
                gap: 7,
              }}
            >
              <StatusDot status={selected.health} />
              Última prueba: {selected.lastTest ?? "nunca"}
            </p>
          </div>
        </Surface>
      </div>
      {capabilityCheck && (
        <ConfirmModal
          title="Prueba de capacidad con cargo real"
          confirmLabel="Ejecutar prueba"
          onClose={() => setCapabilityCheck(null)}
          onConfirm={() => void runCapability()}
          body={
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <p>
                Esta prueba usa cuota del proveedor. Revisa antes de ejecutar:
              </p>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                <li>
                  Proveedor: <code>{capabilityCheck.provider}</code>
                </li>
                <li>
                  Modelo: <code>{capabilityCheck.model}</code>
                </li>
                <li>Facturación: {capabilityCheck.billingSource}</li>
                <li>Cobertura: {capabilityCheck.coveredChecks.join(", ")}</li>
              </ul>
              <p>{capabilityCheck.estimatedCostNote}</p>
            </div>
          }
        />
      )}
      <Callout>
        <strong>Política de delegación:</strong> todo trabajo cross-role pasa
        por Sol; los workers nunca se llaman entre sí y las escrituras en
        paralelo exigen ownership disjunto.
      </Callout>
    </div>
  );
}
