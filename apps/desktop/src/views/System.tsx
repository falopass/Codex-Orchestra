import { useState } from "react";
import type { Backup, FeatureFlags } from "@codex-orchestra/contracts";
import {
  Archive,
  ArrowRight,
  Download,
  History,
  PlugZap,
  RefreshCw,
  Upload,
} from "lucide-react";
import { invokeCommand } from "../core/invoke";
import { routerEngine } from "../core/routerEngine";
import type { ViewContext } from "./types";
import {
  Callout,
  Chip,
  ConfirmModal,
  PageHead,
  Surface,
} from "../ui/primitives";
import { describeError, formatLocalTimestamp } from "../ui/format";

type PendingAction =
  | { kind: "router"; operation: "refresh-catalog" | "update" | "rollback" }
  | { kind: "flags" }
  | { kind: "probe" }
  | { kind: "import-profile" }
  | { kind: "restore"; backup: Backup };

export function System({ snapshot, setSnapshot, notice }: ViewContext) {
  const [bundle, setBundle] = useState<string | null>(null);
  const [profileText, setProfileText] = useState("");
  const [appServerResult, setAppServerResult] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [mcpInfo, setMcpInfo] = useState<Record<string, unknown> | null>(null);
  const [flagsDraft, setFlagsDraft] = useState<FeatureFlags>(
    snapshot.featureFlags ?? {
      appServer: false,
      mcp: false,
      experimentalWorktrees: false,
    },
  );
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setSnapshot(
      await invokeCommand<ViewContext["snapshot"]>("get_snapshot_fast"),
    );
  }

  async function routerOperation(
    operation: "update-check" | "refresh-catalog" | "update" | "rollback",
  ) {
    if (
      operation === "refresh-catalog" ||
      operation === "update" ||
      operation === "rollback"
    ) {
      setPending({ kind: "router", operation });
      return;
    }
    setBusy(true);
    try {
      const result = await invokeCommand<{ message?: string }>(
        "router_operation",
        { operation },
      );
      notice(result.message ?? "Búsqueda de actualización completada.");
      await refresh();
    } catch (cause) {
      notice(describeError(cause, "La operación del Router falló."));
    } finally {
      setBusy(false);
    }
  }

  async function runPendingRouter(operation: string) {
    setBusy(true);
    try {
      const result = await invokeCommand<{ message?: string }>(
        "router_operation",
        { operation, confirm: true },
      );
      notice(result.message ?? `Operación ${operation} completada.`);
      setPending(null);
      await refresh();
    } catch (cause) {
      notice(describeError(cause, `La operación ${operation} falló.`));
    } finally {
      setBusy(false);
    }
  }

  async function saveFeatureFlags() {
    setBusy(true);
    try {
      await routerEngine.saveFeatureFlags(flagsDraft, true);
      setPending(null);
      await refresh();
      notice(
        "Flags guardados localmente. Lo experimental sigue siendo opt-in.",
      );
    } catch (cause) {
      notice(describeError(cause, "Los flags no se guardaron."));
    } finally {
      setBusy(false);
    }
  }

  async function probeAppServer() {
    setBusy(true);
    try {
      const result = await routerEngine.probeAppServer(true);
      setAppServerResult(
        typeof result === "object" && result !== null
          ? (result as Record<string, unknown>)
          : { result },
      );
      setPending(null);
      notice("Handshake App Server completado sin iniciar turno de modelo.");
    } catch (cause) {
      notice(describeError(cause, "La prueba de App Server falló."));
    } finally {
      setBusy(false);
    }
  }

  async function inspectMcpConnection() {
    try {
      const result =
        await invokeCommand<Record<string, unknown>>("mcp_server_info");
      setMcpInfo(result);
      notice(
        result.enabled
          ? "Comando MCP listo. Agrégalo como servidor STDIO local en ChatGPT desktop y reinicia."
          : "Habilita y guarda el flag MCP antes de conectar este servidor STDIO.",
      );
    } catch (cause) {
      notice(describeError(cause, "Los datos MCP no están disponibles."));
    }
  }

  async function exportBundle() {
    const result = await invokeCommand("export_support_bundle");
    setBundle(JSON.stringify(result, null, 2) ?? "{}");
    notice("Bundle redactado en memoria: sin secretos ni prompts.");
  }

  async function exportProfile() {
    const result = await invokeCommand("export_profile");
    setProfileText(JSON.stringify(result, null, 2) ?? "{}");
    notice("Perfil exportado localmente; sin credenciales.");
  }

  async function importProfile() {
    let payload: unknown;
    try {
      payload = JSON.parse(profileText);
    } catch {
      notice("El JSON del perfil es inválido; no se importó nada.");
      return;
    }
    setPending({ kind: "import-profile" });
    void payload;
  }

  async function runImportProfile() {
    let payload: unknown;
    try {
      payload = JSON.parse(profileText);
    } catch {
      notice("El JSON del perfil es inválido; no se importó nada.");
      return;
    }
    setBusy(true);
    try {
      await invokeCommand("import_profile", { payload, confirm: true });
      setPending(null);
      await refresh();
      notice(
        "Perfil importado. Las rutas de proyecto inexistentes se omitieron.",
      );
    } catch (cause) {
      notice(describeError(cause, "El perfil no se pudo importar."));
    } finally {
      setBusy(false);
    }
  }

  async function restoreBackup(backup: Backup) {
    if (!backup.backupPath) {
      notice("Este respaldo no tiene ruta de restauración disponible.");
      return;
    }
    setBusy(true);
    try {
      await invokeCommand("restore_backup", {
        target: backup.target,
        backup: backup.backupPath,
        confirm: true,
      });
      setPending(null);
      notice("Respaldo restaurado de forma atómica; se conservó un rollback.");
      await refresh();
    } catch (cause) {
      notice(describeError(cause, "El respaldo no se pudo restaurar."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="view">
      <PageHead
        title="Sistema"
        lede="Mantenimiento del Router, flags experimentales, respaldos y portabilidad. Todo explícito y reversible."
        actions={<Chip tone="ok">escrituras atómicas</Chip>}
      />
      <div className="settings-grid">
        <Surface
          title="Codex Router"
          hint="motor pinneado"
          action={
            <Chip tone={snapshot.update.status === "current" ? "ok" : "warn"}>
              {snapshot.update.status}
            </Chip>
          }
        >
          <div className="version-line" style={{ marginBottom: 10 }}>
            <code>{snapshot.update.currentRef ?? "sin ref actual"}</code>
            <ArrowRight size={14} aria-hidden />
            <code>{snapshot.update.targetRef}</code>
          </div>
          {snapshot.update.notes[0] && (
            <p
              style={{
                color: "var(--ink-2)",
                fontSize: 12.5,
                marginBottom: 14,
              }}
            >
              {snapshot.update.notes[0]}
            </p>
          )}
          <div className="button-row">
            <button
              className="button button-ghost"
              disabled={busy}
              onClick={() => void routerOperation("update-check")}
            >
              <RefreshCw size={14} aria-hidden />
              Buscar actualización
            </button>
            <button
              className="button button-ghost"
              disabled={busy}
              onClick={() => void routerOperation("refresh-catalog")}
            >
              Refrescar catálogo
            </button>
            <button
              className="button button-primary"
              disabled={busy}
              onClick={() => void routerOperation("update")}
            >
              Preparar update
            </button>
          </div>
          <button
            className="button-text danger"
            style={{ marginTop: 10 }}
            disabled={busy}
            onClick={() => void routerOperation("rollback")}
          >
            Preparar rollback →
          </button>
        </Surface>
        <Surface
          title="Experimental"
          hint="App Server · MCP · worktrees"
          action={<Chip>opt-in</Chip>}
        >
          <p style={{ color: "var(--ink-2)", fontSize: 13, marginBottom: 10 }}>
            Integraciones opcionales por stdio. La configuración base y los
            controles de seguridad no dependen de ellas.
          </p>
          {(
            [
              ["appServer", "App Server stdio (ejecución local)"],
              ["mcp", "Orchestra MCP (solo lectura)"],
              ["experimentalWorktrees", "Ejecución con worktrees"],
            ] as const
          ).map(([key, label]) => (
            <label className="flag-row" key={key}>
              <input
                type="checkbox"
                checked={flagsDraft[key]}
                onChange={(event) =>
                  setFlagsDraft((current) => ({
                    ...current,
                    [key]: event.target.checked,
                  }))
                }
              />
              <span>{label}</span>
            </label>
          ))}
          <div className="button-row" style={{ marginTop: 12 }}>
            <button
              className="button button-primary"
              onClick={() => setPending({ kind: "flags" })}
            >
              Guardar flags
            </button>
            <button
              className="button button-ghost"
              onClick={() => setPending({ kind: "probe" })}
            >
              <PlugZap size={14} aria-hidden />
              Probar App Server
            </button>
            <button
              className="button button-ghost"
              onClick={() => void inspectMcpConnection()}
            >
              Conexión MCP
            </button>
          </div>
          {(appServerResult || mcpInfo) && (
            <pre className="bundle-preview" style={{ marginTop: 12 }}>
              {JSON.stringify(appServerResult ?? mcpInfo, null, 2)}
            </pre>
          )}
        </Surface>
        <Surface
          title="Respaldos"
          hint={`${snapshot.backups.length} disponibles`}
          flush
        >
          {snapshot.backups.length === 0 ? (
            <div className="empty-state">
              <History size={20} aria-hidden />
              <h3>Sin respaldos todavía</h3>
              <p>
                Cada escritura gestionada crea un respaldo automático antes de
                aplicar.
              </p>
            </div>
          ) : (
            <div>
              {snapshot.backups.map((backup) => (
                <div className="backup-row" key={backup.id}>
                  <Archive size={16} aria-hidden />
                  <div className="body">
                    <strong>{backup.target}</strong>
                    <span>
                      {backup.reason} · {formatLocalTimestamp(backup.createdAt)}
                    </span>
                  </div>
                  <Chip tone={backup.restorable ? "ok" : "bad"}>
                    {backup.restorable ? "restaurable" : "no disponible"}
                  </Chip>
                  {backup.restorable && backup.backupPath && (
                    <button
                      className="button-text"
                      onClick={() => setPending({ kind: "restore", backup })}
                    >
                      Restaurar
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </Surface>
        <Surface title="Bundle de soporte" hint="solo estados operativos">
          <p style={{ color: "var(--ink-2)", fontSize: 13, marginBottom: 12 }}>
            Versiones, estados, procesos/puertos y categorías de error. Excluye
            prompts, respuestas, credenciales y rutas locales.
          </p>
          <button
            className="button button-ghost"
            onClick={() => void exportBundle()}
          >
            <Download size={14} aria-hidden />
            Preparar bundle
          </button>
          {bundle && (
            <pre className="bundle-preview" style={{ marginTop: 12 }}>
              {bundle}
            </pre>
          )}
        </Surface>
      </div>
      <Surface
        title="Perfil portable"
        hint="equipo, precios y flags · sin credenciales"
      >
        <label className="field">
          <span>JSON del perfil</span>
          <textarea
            className="mono"
            rows={7}
            spellCheck={false}
            placeholder="El JSON exportado aparece aquí."
            value={profileText}
            onChange={(event) => setProfileText(event.target.value)}
          />
        </label>
        <div className="button-row" style={{ marginTop: 12 }}>
          <button
            className="button button-ghost"
            onClick={() => void exportProfile()}
          >
            <Download size={14} aria-hidden />
            Exportar perfil
          </button>
          <button
            className="button button-primary"
            disabled={!profileText.trim()}
            onClick={() => void importProfile()}
          >
            <Upload size={14} aria-hidden />
            Importar perfil revisado
          </button>
        </div>
      </Surface>
      {pending?.kind === "router" && (
        <ConfirmModal
          title={
            pending.operation === "refresh-catalog"
              ? "Aplicar allowlist del picker"
              : pending.operation === "update"
                ? "Preparar update del Router"
                : "Preparar rollback del Router"
          }
          busy={busy}
          danger={pending.operation === "rollback"}
          confirmLabel="Continuar"
          onClose={() => setPending(null)}
          onConfirm={() => void runPendingRouter(pending.operation)}
          body={
            pending.operation === "refresh-catalog" ? (
              <p>
                Refresca el catálogo fusionado, recorta el picker de Codex al
                allowlist revisado y ejecuta Doctor. No envía ninguna petición
                de modelo. Cierra y reabre Codex para ver el cambio.
              </p>
            ) : pending.operation === "update" ? (
              <p>
                Prepara el update del pin revisado. Se exige respaldo y puerta
                de health antes de aplicar.
              </p>
            ) : (
              <p>
                Prepara el rollback usando la referencia guardada. El estado
                actual se respalda antes.
              </p>
            )
          }
        />
      )}
      {pending?.kind === "flags" && (
        <ConfirmModal
          title="Guardar flags experimentales"
          busy={busy}
          confirmLabel="Guardar"
          onClose={() => setPending(null)}
          onConfirm={() => void saveFeatureFlags()}
          body={
            <p>
              Se guardan localmente. Nada se inicia automáticamente: cada
              integración sigue requiriendo acción explícita.
            </p>
          }
        />
      )}
      {pending?.kind === "probe" && (
        <ConfirmModal
          title="Probar App Server"
          busy={busy}
          confirmLabel="Iniciar handshake"
          onClose={() => setPending(null)}
          onConfirm={() => void probeAppServer()}
          body={
            <p>
              Inicia Codex App Server solo para el handshake `initialize`. No se
              ejecuta ningún turno de modelo.
            </p>
          }
        />
      )}
      {pending?.kind === "import-profile" && (
        <ConfirmModal
          title="Importar perfil local"
          busy={busy}
          confirmLabel="Importar"
          onClose={() => setPending(null)}
          onConfirm={() => void runImportProfile()}
          body={
            <p>
              Se importan configuración local y perfiles de proyecto
              disponibles. Las rutas inexistentes se omiten; no se confía en
              rutas exportadas como instrucciones.
            </p>
          }
        />
      )}
      {pending?.kind === "restore" && (
        <ConfirmModal
          title="Restaurar respaldo"
          busy={busy}
          confirmLabel="Restaurar"
          onClose={() => setPending(null)}
          onConfirm={() => void restoreBackup(pending.backup)}
          body={
            <p>
              Se restaura <code>{pending.backup.target}</code> desde el respaldo
              guardado. La operación es atómica y conserva un rollback
              adicional.
            </p>
          }
        />
      )}
    </div>
  );
}
