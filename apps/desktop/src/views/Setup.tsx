import { useState } from "react";
import type {
  OrchestraSnapshot,
  PreviewFile,
} from "@codex-orchestra/contracts";
import {
  orchestraReadiness,
  readinessTone,
  renderAgentToml,
  renderManagedBlock,
  renderRoutingSkill,
  renderSubagentConfig,
  renderVisualAgentToml,
} from "@codex-orchestra/contracts";
import { Check, RefreshCw, Unplug } from "lucide-react";
import { invokeCommand } from "../core/invoke";
import { routerEngine } from "../core/routerEngine";
import type { ViewContext } from "./types";
import { useRouterRecovery } from "./useRouterRecovery";
import {
  BrandMark,
  Callout,
  Chip,
  ConfirmModal,
  PageHead,
  StatusDot,
  Surface,
  providerBrand,
  statusTone,
} from "../ui/primitives";
import { credentialLabel, describeError, statusLabel } from "../ui/format";

const STEPS = [
  { label: "Router", detail: "Pulso local" },
  { label: "Proveedores", detail: "Conectar helpers" },
  { label: "Equipo", detail: "Bindings" },
  { label: "Archivos", detail: "Vista previa y escritura" },
];

const MANAGED_SHARED_PATHS = [
  "package.json",
  "types/**",
  "schemas/**",
  "migrations/**",
];

export function Setup({
  snapshot,
  setSnapshot,
  navigate,
  notice,
}: ViewContext) {
  const [step, setStep] = useState(1);
  const [installConfirm, setInstallConfirm] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [toggleConfirm, setToggleConfirm] = useState<string | null>(null);
  const [catalogConfirm, setCatalogConfirm] = useState(false);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [projectPath, setProjectPath] = useState(
    snapshot.projects[0]?.path ?? "",
  );
  const [preview, setPreview] = useState<PreviewFile[] | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [applyConfirm, setApplyConfirm] = useState(false);
  const [applying, setApplying] = useState(false);

  const readiness = orchestraReadiness(snapshot);
  const routerInstalled = snapshot.router.detected;
  const routerLive = readiness.routerLive;
  const recovery = useRouterRecovery(snapshot, setSnapshot, notice);
  const providers = snapshot.providers.filter(
    (provider) => provider.id !== "openai",
  );
  const previewCurrentHash = preview?.[0]?.currentHash;
  const previewStale = preview !== null && previewPath !== projectPath.trim();
  const canApply =
    preview !== null && !previewStale && Boolean(previewCurrentHash);

  async function refreshSnapshot() {
    setSnapshot(await invokeCommand<OrchestraSnapshot>("get_snapshot"));
  }

  function buildManagedPayload(root: string) {
    const agents = snapshot.agents.filter((agent) => agent.role !== "root");
    const block = renderManagedBlock(agents, MANAGED_SHARED_PATHS);
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
    const visualModel =
      snapshot.models.find(
        (model) =>
          model.providerId === "opencode-go" &&
          model.upstreamModel === "kimi-k3",
      )?.id ?? "opencode-go/kimi-k3";
    files.push({
      path: ".codex/agents/orchestra_visual.toml",
      content: renderVisualAgentToml(visualModel, "max"),
    });
    files.push({
      path: ".codex/config.toml",
      content: renderSubagentConfig(),
    });
    return { path: root + "\\AGENTS.md", block, files };
  }

  async function generatePreview() {
    const root = projectPath.trim();
    if (!root) {
      notice(
        "Indica la ruta absoluta del proyecto antes de generar la vista previa.",
      );
      return;
    }
    setPreviewing(true);
    try {
      const payload = buildManagedPayload(root);
      const nextPreview = await invokeCommand<PreviewFile[]>(
        "managed_preview",
        {
          path: payload.path,
          existing: "# Project rules\n",
          block: payload.block,
        },
      );
      setPreview(nextPreview);
      setPreviewPath(root);
      notice(
        "Vista previa lista. Revisa el bloque gestionado antes de aplicarlo.",
      );
    } catch (cause) {
      notice(
        describeError(cause, "No se pudo generar la vista previa gestionada."),
      );
    } finally {
      setPreviewing(false);
    }
  }

  async function applyManagedChanges() {
    const root = projectPath.trim();
    setApplying(true);
    try {
      const payload = buildManagedPayload(root);
      const nextPreview = await invokeCommand<PreviewFile[]>(
        "managed_preview",
        {
          path: payload.path,
          existing: "# Project rules\n",
          block: payload.block,
        },
      );
      setPreview(nextPreview);
      const result = await invokeCommand<{
        backups?: Array<{ target: string; backupPath?: string }>;
      }>("apply_managed_changes", {
        path: payload.path,
        block: payload.block,
        files: payload.files,
        confirm: true,
        expectedCurrentHash: previewCurrentHash,
      });
      setSnapshot({
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
      notice("Archivos de equipo aplicados de forma atómica y con respaldos.");
      navigate("diagnostics");
    } catch (cause) {
      notice(describeError(cause, "La operación falló. Nada se escribió."));
    } finally {
      setApplying(false);
    }
  }

  async function refreshRouterCatalog() {
    setCatalogBusy(true);
    try {
      await routerEngine.run("refresh-catalog", true);
      setSnapshot(await invokeCommand<OrchestraSnapshot>("get_snapshot"));
      notice(
        "Catálogo recortado al allowlist: GPT nativos, Kimi K3 (OpenCode Go), Grok 4.6 OAuth y Qwen3.8 Max (Plan y OpenCode Go). Cierra y reabre Codex para ver el picker.",
      );
    } catch (cause) {
      notice(describeError(cause, "El refresco del catálogo falló."));
    } finally {
      setCatalogBusy(false);
    }
  }

  async function installRouter() {
    setInstalling(true);
    try {
      const result = (await routerEngine.install(true)) as {
        status?: string;
        next?: string;
      };
      notice(
        result.next ??
          (result.status === "already-detected"
            ? "El checkout gestionado del Router ya estaba presente."
            : "Checkout gestionado del Router preparado."),
      );
      await refreshSnapshot();
    } catch (cause) {
      notice(describeError(cause, "No se pudo preparar el Router."));
    } finally {
      setInstalling(false);
      setInstallConfirm(false);
    }
  }

  async function toggleProvider(providerId: string, enabled: boolean) {
    const provider = snapshot.providers.find((item) => item.id === providerId);
    if (!provider) return;
    try {
      const result = (await routerEngine.setProviderEnabled(
        providerId,
        enabled,
        true,
      )) as { ok?: boolean };
      notice(
        result.ok === false
          ? `El Router no pudo ${enabled ? "habilitar" : "deshabilitar"} ${provider.name}.`
          : `${provider.name} ${enabled ? "habilitado" : "deshabilitado"} en el Router.`,
      );
      await refreshSnapshot();
    } catch (cause) {
      notice(
        describeError(cause, "No se pudo cambiar el estado del proveedor."),
      );
    } finally {
      setToggleConfirm(null);
    }
  }

  async function openHelper(providerId: string, name: string) {
    try {
      await routerEngine.openProviderHelper(providerId);
      notice(
        providerId === "grok-oauth"
          ? "Se abrió el login OAuth de Grok. Termínalo en la terminal y luego pulsa Refrescar catálogo + Doctor; Orchestra nunca recibe la credencial."
          : providerId === "opencode-go"
            ? "Se abrió la conexión de OpenCode Go. Ingresa la clave en el prompt local oculto del Router y luego pulsa Refrescar catálogo + Doctor; Orchestra nunca la recibe."
            : providerId === "qwen-plan"
              ? "Se abrió la conexión de Qwen Token Plan. Ingresa la credencial en el prompt local oculto del Router y luego pulsa Refrescar catálogo + Doctor; Orchestra nunca la recibe."
              : `Se abrió el helper local del Router para ${name}. Orchestra nunca recibe el valor de la credencial.`,
      );
    } catch (cause) {
      notice(
        describeError(cause, "No se pudo abrir el helper local del Router."),
      );
    }
  }

  async function openCuration(providerId: string, name: string) {
    try {
      await routerEngine.openModelCuration(providerId);
      notice(
        `Se abrió la curación de modelos para ${name}. Revisa el descubrimiento del Router antes de aplicarlo.`,
      );
    } catch (cause) {
      notice(describeError(cause, "No se pudo abrir la curación del Router."));
    }
  }

  return (
    <div className="view">
      <PageHead
        title="Configuración"
        lede={readiness.summary}
        actions={
          <Chip tone={readinessTone(readiness.level)}>
            {readiness.headline}
          </Chip>
        }
      />
      <section className="readiness-board" aria-label="Estado de Orchestra">
        {readiness.items.map((item) => (
          <button
            key={item.id}
            className={`readiness-cell${
              readiness.blockingId === item.id ? " current" : ""
            }`}
            onClick={() => {
              if (item.id === "project") navigate("projects");
              else if (item.id === "run") navigate("run");
              else
                setStep(
                  item.id === "providers"
                    ? 2
                    : item.id === "codex" || item.id === "router"
                      ? 1
                      : 3,
                );
            }}
          >
            <span className="label">{item.label}</span>
            <strong>
              <StatusDot status={item.status} />
              {item.headline}
            </strong>
            <small>{item.detail}</small>
          </button>
        ))}
      </section>
      <div className="setup-layout">
        <nav className="setup-nav" aria-label="Pasos de la configuración">
          {STEPS.map((item, index) => {
            const done = step > index + 1;
            return (
              <button
                key={item.label}
                className={`setup-step${done ? " done" : ""}`}
                aria-current={step === index + 1 ? "step" : undefined}
                onClick={() => setStep(index + 1)}
              >
                <span className="step-number">
                  {done ? <Check size={13} aria-hidden /> : `0${index + 1}`}
                </span>
                <span className="setup-step-copy">
                  <strong>{item.label}</strong>
                  <small>{item.detail}</small>
                </span>
              </button>
            );
          })}
        </nav>
        <div className="setup-content">
          {step === 1 && (
            <>
              <Surface
                title="Router"
                hint={
                  routerLive
                    ? "servicio respondiendo en 127.0.0.1"
                    : routerInstalled
                      ? "instalado, todavía no en marcha"
                      : "todavía no hay checkout gestionado"
                }
              >
                <div className="inventory-grid">
                  <div className="inventory-cell">
                    <span>Codex</span>
                    <strong>
                      <StatusDot
                        status={snapshot.codex.detected ? "healthy" : "missing"}
                      />
                      {snapshot.codex.detected
                        ? (snapshot.codex.version ?? "Detectado")
                        : "Ausente"}
                    </strong>
                    <small>
                      {snapshot.codex.source}
                      {snapshot.codex.configDetected
                        ? " · config presente"
                        : ""}
                    </small>
                  </div>
                  <div className="inventory-cell">
                    <span>Servicio</span>
                    <strong>
                      <StatusDot
                        status={
                          routerLive
                            ? "healthy"
                            : routerInstalled
                              ? "degraded"
                              : "missing"
                        }
                        pulse={routerLive}
                      />
                      {routerLive
                        ? "En marcha"
                        : routerInstalled
                          ? "Parado"
                          : "Sin preparar"}
                    </strong>
                    <small>
                      {snapshot.router.ports.length
                        ? `${snapshot.router.ports.length} puerto(s) locales`
                        : "sin respuesta en loopback"}
                      {snapshot.router.version
                        ? ` · ${snapshot.router.version}`
                        : ""}
                    </small>
                  </div>
                </div>
                {!routerLive && routerInstalled && (
                  <Callout tone="warn">
                    Detectado no significa en marcha. El checkout está en disco,
                    pero Orchestra no ve el servicio local.
                  </Callout>
                )}
              </Surface>
              <div className="button-row">
                {!routerInstalled ? (
                  <button
                    className="button button-primary"
                    onClick={() => setInstallConfirm(true)}
                  >
                    Preparar Router
                  </button>
                ) : !routerLive ? (
                  <button
                    className="button button-primary"
                    disabled={recovery.busy}
                    onClick={() => void recovery.requestRepair()}
                  >
                    <Unplug size={15} aria-hidden />
                    {recovery.busy ? "Arrancando…" : "Arrancar Router"}
                  </button>
                ) : (
                  <button className="button button-primary" disabled>
                    Router en marcha
                  </button>
                )}
                <button
                  className="button button-ghost"
                  disabled={!routerInstalled}
                  onClick={() => {
                    void (async () => {
                      try {
                        await routerEngine.openGuidedSetup();
                        notice(
                          "Se abrió el setup del Router. Las credenciales quedan fuera de Orchestra.",
                        );
                      } catch (cause) {
                        notice(
                          describeError(
                            cause,
                            "No se pudo abrir el setup del Router.",
                          ),
                        );
                      }
                    })();
                  }}
                >
                  Abrir setup del Router
                </button>
              </div>
              {recovery.error && <Callout tone="bad">{recovery.error}</Callout>}
            </>
          )}
          {step === 2 && (
            <>
              <Surface
                title="02 · Proveedores"
                hint="Conecta solo a través del Router. Las claves viven en el Router o en el almacén seguro del SO."
                flush
              >
                {!routerInstalled && (
                  <div className="setup-pad">
                    <Callout>
                      Prepara primero el Router. Los helpers de API y la
                      curación del catálogo necesitan el checkout gestionado; el
                      OAuth de Grok abre su CLI oficial por separado.{" "}
                      <button
                        className="button-text"
                        onClick={() => setStep(1)}
                      >
                        Ir al paso 1 →
                      </button>
                    </Callout>
                  </div>
                )}
                <div className="provider-list">
                  {providers.map((provider) => {
                    const noCatalog =
                      provider.id === "opencode-go" ||
                      provider.id === "qwen-plan" ||
                      provider.id === "grok-oauth";
                    return (
                      <div className="provider-row" key={provider.id}>
                        <BrandMark
                          brand={providerBrand(provider.family, provider.id)}
                        />
                        <div className="body">
                          <strong>{provider.name}</strong>
                          <span>{provider.billingNote}</span>
                        </div>
                        <Chip
                          tone={
                            provider.credential === "configured" ? "ok" : "warn"
                          }
                        >
                          {credentialLabel(provider.credential)}
                        </Chip>
                        <div className="actions">
                          <button
                            className="button button-ghost"
                            disabled={!routerInstalled}
                            onClick={() => setToggleConfirm(provider.id)}
                          >
                            {provider.enabled ? "Deshabilitar" : "Habilitar"}
                          </button>
                          <button
                            className="button button-ghost"
                            disabled={
                              provider.id !== "grok-oauth" && !routerInstalled
                            }
                            onClick={() =>
                              void openHelper(provider.id, provider.name)
                            }
                          >
                            {provider.id === "grok-oauth"
                              ? "Login con OAuth"
                              : provider.id === "opencode-go"
                                ? "Conectar OpenCode Go"
                                : provider.id === "qwen-plan"
                                  ? "Conectar Qwen Token Plan"
                                  : routerInstalled
                                    ? "Abrir helper"
                                    : "Prepara el Router"}
                          </button>
                          {noCatalog ? (
                            <Chip tone="neutral">Router catalog</Chip>
                          ) : (
                            <button
                              className="button button-ghost"
                              disabled={!routerInstalled}
                              onClick={() =>
                                void openCuration(provider.id, provider.name)
                              }
                            >
                              Curar catálogo
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Surface>
              <Callout tone="warn">
                Los live checks consumen allowance. Nunca forman parte del flujo
                normal y siempre muestran proveedor, modelo y fuente de
                facturación antes de confirmar. OpenCode Go se mantiene en su
                ruta de suscripción; Zen/PAYG no es fallback.
              </Callout>
              <div className="button-row">
                <button
                  className="button button-ghost"
                  disabled={!routerInstalled || catalogBusy}
                  onClick={() => {
                    if (catalogConfirm) return;
                    setCatalogConfirm(true);
                  }}
                >
                  <RefreshCw size={14} aria-hidden />
                  {catalogBusy
                    ? "Aplicando allowlist…"
                    : "Aplicar allowlist del picker"}
                </button>
                <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>
                  Refresco de metadatos seguro; no ejecuta ninguna solicitud de
                  modelo.
                </span>
              </div>
            </>
          )}
          {step === 3 && (
            <Surface
              title="03 · Equipo"
              hint="Los bindings resuelven contra el catálogo actual: un slug obsoleto nunca se convierte en contrato."
              flush
            >
              {snapshot.agents.map((agent) => (
                <div className="provider-row" key={agent.id}>
                  <BrandMark
                    brand={
                      agent.role === "frontend"
                        ? "frontend"
                        : agent.role === "engineer"
                          ? "engineer"
                          : "orchestra"
                    }
                  />
                  <div className="body">
                    <strong>{agent.name}</strong>
                    <span className="mono">{agent.modelId ?? "native"}</span>
                  </div>
                  <Chip tone={statusTone(agent.health)}>
                    {statusLabel(agent.health)}
                  </Chip>
                </div>
              ))}
            </Surface>
          )}
          {step === 4 && (
            <>
              <Surface
                title="04 · Revisar"
                hint="Elige el repo local, inspecciona los archivos exactos y aprueba una sola escritura atómica."
              >
                <label className="field">
                  Ruta del proyecto
                  <input
                    value={projectPath}
                    onChange={(event) => {
                      setProjectPath(event.target.value);
                      setPreview(null);
                      setPreviewPath(null);
                    }}
                    placeholder="C:\Users\<you>\projects\my-app"
                    spellCheck={false}
                    className="mono"
                  />
                  <span className="field-help">
                    Debe ser una ruta absoluta existente. Los archivos
                    existentes se respaldan antes de escribir.
                  </span>
                </label>
                <div className="button-row">
                  <button
                    className="button button-primary"
                    disabled={previewing || !projectPath.trim()}
                    onClick={() => void generatePreview()}
                  >
                    {previewing
                      ? "Generando vista previa…"
                      : "Generar vista previa"}
                  </button>
                </div>
                {previewStale && preview !== null && (
                  <Callout tone="warn">
                    La vista previa corresponde a otra ruta. Genera una nueva
                    antes de aplicar.
                  </Callout>
                )}
                {preview && (
                  <div className="preview-list">
                    {preview.map((file) => (
                      <div className="preview-file" key={file.path}>
                        <div className="preview-file-head">
                          <span
                            className={`preview-action${
                              file.action === "update" ? " update" : ""
                            }`}
                          >
                            {file.action === "update"
                              ? "ACTUALIZAR"
                              : file.action === "create"
                                ? "CREAR"
                                : "SIN CAMBIOS"}
                          </span>
                          <span className="preview-file-path">{file.path}</span>
                          <span className="preview-file-diff">{file.diff}</span>
                        </div>
                        {file.contentPreview && (
                          <pre className="bundle-preview">
                            {file.contentPreview}
                          </pre>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </Surface>
              <div className="button-row">
                <button
                  className="button button-primary"
                  disabled={!canApply || applying || previewing}
                  onClick={() => setApplyConfirm(true)}
                >
                  Aplicar archivos gestionados
                </button>
                <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>
                  {canApply
                    ? "Una escritura atómica, con respaldos previos."
                    : "Genera una vista previa válida para habilitar la aplicación."}
                </span>
              </div>
            </>
          )}
        </div>
      </div>
      <div className="setup-footer">
        <span>{readiness.summary}</span>
        <div className="button-row">
          {readiness.blockingId === "router" &&
          routerInstalled &&
          !routerLive ? (
            <button
              className="button button-primary"
              disabled={recovery.busy}
              onClick={() => void recovery.requestRepair()}
            >
              {recovery.busy ? "Arrancando…" : readiness.next.label}
            </button>
          ) : readiness.blockingId === "router" && !routerInstalled ? (
            <button
              className="button button-primary"
              onClick={() => setInstallConfirm(true)}
            >
              {readiness.next.label}
            </button>
          ) : readiness.blockingId === "providers" ? (
            <button
              className="button button-primary"
              onClick={() => setStep(2)}
            >
              {readiness.next.label}
            </button>
          ) : readiness.next.view !== "setup" ? (
            <button
              className="button button-primary"
              onClick={() => navigate(readiness.next.view)}
            >
              {readiness.next.label}
            </button>
          ) : (
            <button
              className="button button-primary"
              disabled={!canApply}
              onClick={() => setApplyConfirm(true)}
            >
              Aplicar archivos
            </button>
          )}
        </div>
      </div>

      {recovery.confirmOpen && (
        <ConfirmModal
          title="Reiniciar Router durante una ejecución"
          body="Hay una tarea de Codex en curso. Reiniciar el Router puede interrumpirla."
          confirmLabel="Reiniciar de todos modos"
          danger
          busy={recovery.busy}
          onConfirm={() => void recovery.confirmRepair()}
          onClose={() => recovery.setConfirmOpen(false)}
        />
      )}
      {installConfirm && (
        <ConfirmModal
          title="Preparar Router gestionado"
          body={
            <>
              Se preparará el checkout gestionado de Codex Router en el
              directorio local de datos de Orchestra. Tu instalación real de
              Codex no se modifica.
            </>
          }
          confirmLabel="Preparar"
          busy={installing}
          onConfirm={() => void installRouter()}
          onClose={() => setInstallConfirm(false)}
        />
      )}
      {toggleConfirm &&
        (() => {
          const provider = snapshot.providers.find(
            (item) => item.id === toggleConfirm,
          );
          if (!provider) return null;
          const next = !provider.enabled;
          return (
            <ConfirmModal
              title={`${next ? "Habilitar" : "Deshabilitar"} ${provider.name}`}
              body={
                <>
                  Se {next ? "habilitará" : "deshabilitará"} {provider.name} en
                  el Router gestionado. Esta acción solo cambia la configuración
                  local del Router.
                </>
              }
              confirmLabel={next ? "Habilitar" : "Deshabilitar"}
              onConfirm={() => void toggleProvider(provider.id, next)}
              onClose={() => setToggleConfirm(null)}
            />
          );
        })()}
      {catalogConfirm && (
        <ConfirmModal
          title="Refrescar catálogo + Doctor"
          body={
            <>
              Se refrescará el catálogo local del Router y se ejecutará Doctor.
              No se envía ninguna solicitud de modelo.
            </>
          }
          confirmLabel="Refrescar"
          busy={catalogBusy}
          onConfirm={() => {
            setCatalogConfirm(false);
            void refreshRouterCatalog();
          }}
          onClose={() => setCatalogConfirm(false)}
        />
      )}
      {applyConfirm && (
        <ConfirmModal
          title="Aplicar archivos de Orchestra"
          body={
            <>
              Se escribirán el bloque gestionado de AGENTS.md y los archivos de
              equipo en {previewPath ?? projectPath.trim()}. Los archivos
              existentes se respaldan antes de escribir. Las credenciales no
              entran en este flujo.
            </>
          }
          confirmLabel="Aplicar"
          busy={applying}
          onConfirm={() => {
            setApplyConfirm(false);
            void applyManagedChanges();
          }}
          onClose={() => setApplyConfirm(false)}
        />
      )}
    </div>
  );
}
