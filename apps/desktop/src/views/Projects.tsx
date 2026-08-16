import { useEffect, useState } from "react";
import type {
  ProjectProfile,
  ScopePlan,
  WorktreePreview,
  WorktreeStatus,
} from "@codex-orchestra/contracts";
import {
  FolderGit2,
  FolderPlus,
  GitBranch,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { invokeCommand } from "../core/invoke";
import { routerEngine } from "../core/routerEngine";
import type { ViewContext } from "./types";
import {
  Callout,
  Chip,
  ConfirmModal,
  EmptyState,
  Modal,
  PageHead,
  StatusDot,
  Surface,
  statusTone,
} from "../ui/primitives";
import { describeError, statusLabel } from "../ui/format";

type PendingAction =
  | { kind: "create-worktree"; preview: WorktreePreview }
  | { kind: "remove-worktree"; worktree: WorktreeStatus };

export function Projects({ snapshot, setSnapshot, notice }: ViewContext) {
  const [path, setPath] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ProjectProfile | null>(null);
  const [scopePlan, setScopePlan] = useState<ScopePlan | null>(null);
  const [worktreeProjectId, setWorktreeProjectId] = useState(
    snapshot.projects[0]?.id ?? "",
  );
  const [worktreeRole, setWorktreeRole] = useState<"frontend" | "engineer">(
    "frontend",
  );
  const [worktreeSlug, setWorktreeSlug] = useState("");
  const [worktreePreview, setWorktreePreview] =
    useState<WorktreePreview | null>(null);
  const [worktrees, setWorktrees] = useState<WorktreeStatus[]>([]);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const activeProject =
    snapshot.projects.find((project) => project.id === worktreeProjectId) ??
    snapshot.projects[0];

  async function refresh() {
    setSnapshot(
      await invokeCommand<ViewContext["snapshot"]>("get_snapshot_fast"),
    );
  }

  async function addProject() {
    if (!path.trim()) {
      notice("Escribe primero la ruta de un repo local existente.");
      return;
    }
    setAdding(true);
    try {
      await invokeCommand<ProjectProfile>("add_project", {
        path: path.trim(),
      });
      setPath("");
      await refresh();
      notice("Proyecto registrado con ownership editable.");
    } catch (cause) {
      notice(describeError(cause, "No se pudo registrar el proyecto."));
    } finally {
      setAdding(false);
    }
  }

  async function inspectScopes() {
    try {
      const plan = await invokeCommand<ScopePlan>("scope_plan", {
        assignments: {
          root: ["package.json"],
          frontend: ["src/**", "components/**"],
          engineer: ["server/**", "tests/**"],
        },
        sharedPaths: ["package.json", "types/**"],
      });
      setScopePlan(plan);
    } catch (cause) {
      notice(describeError(cause, "El plan de scopes falló."));
    }
  }

  async function loadWorktrees(project = activeProject) {
    if (!project || !snapshot.featureFlags?.experimentalWorktrees) {
      setWorktrees([]);
      return;
    }
    setBusy(true);
    try {
      setWorktrees(await routerEngine.listWorktrees(project.path));
    } catch (cause) {
      notice(describeError(cause, "No se pudieron leer los worktrees."));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void loadWorktrees();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject?.id, snapshot.featureFlags?.experimentalWorktrees]);

  async function previewWorktree() {
    if (!activeProject || !worktreeSlug.trim()) {
      notice("Elige un proyecto y escribe un slug corto para la tarea.");
      return;
    }
    setBusy(true);
    try {
      setWorktreePreview(
        await routerEngine.worktreePreview(
          activeProject.path,
          worktreeRole,
          worktreeSlug.trim(),
        ),
      );
    } catch (cause) {
      notice(describeError(cause, "La vista previa del worktree falló."));
    } finally {
      setBusy(false);
    }
  }

  async function createWorktree(preview: WorktreePreview) {
    if (!activeProject) return;
    setBusy(true);
    try {
      await routerEngine.createWorktree(
        activeProject.path,
        preview.role,
        preview.slug,
        true,
      );
      setPending(null);
      setWorktreePreview(null);
      setWorktreeSlug("");
      await loadWorktrees(activeProject);
      notice(
        "Worktree aislado creado. El merge sigue siendo manual y del root.",
      );
    } catch (cause) {
      notice(describeError(cause, "La creación del worktree falló."));
    } finally {
      setBusy(false);
    }
  }

  async function cleanupWorktree(worktree: WorktreeStatus) {
    if (!activeProject) return;
    const needsRecovery = worktree.requiresManualMerge;
    setBusy(true);
    try {
      const result = await routerEngine.removeWorktree(
        activeProject.path,
        worktree.role,
        worktree.slug,
        needsRecovery,
        true,
      );
      setPending(null);
      await loadWorktrees(activeProject);
      notice(
        result.recoveryPath
          ? `Worktree eliminado. Recuperación guardada en ${result.recoveryPath}`
          : "Worktree limpio eliminado.",
      );
    } catch (cause) {
      notice(describeError(cause, "La limpieza del worktree falló."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="view">
      <PageHead
        title="Proyectos"
        lede="Cada repo local recibe un perfil con stack, ownership y comandos. El ownership es una pista hasta que el perfil lo confirma; los archivos compartidos siempre son del root."
      />
      <Surface title="Registrar repo" hint="detección de solo lectura">
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <label className="field" style={{ flex: 1, minWidth: 260 }}>
            <span>Ruta local</span>
            <input
              placeholder="C:\Users\<you>\projects\my-app"
              value={path}
              spellCheck={false}
              onChange={(event) => setPath(event.target.value)}
            />
          </label>
          <button
            className="button button-primary"
            style={{ alignSelf: "flex-end" }}
            disabled={adding}
            onClick={() => void addProject()}
          >
            <FolderPlus size={15} aria-hidden />
            {adding ? "Registrando…" : "Registrar"}
          </button>
        </div>
        <p className="field-help" style={{ marginTop: 8 }}>
          La detección lee nombres de archivo y manifiestos; no asume `src/app`,
          `server` ni `db`.
        </p>
      </Surface>
      {snapshot.projects.length === 0 ? (
        <Surface>
          <EmptyState
            icon={<FolderGit2 size={22} aria-hidden />}
            title="Sin proyectos locales"
            detail="Registra un repo para inspeccionar stack, tests, ownership y correlacionar uso."
          />
        </Surface>
      ) : (
        <div className="grid-3">
          {snapshot.projects.map((project) => (
            <article className="project-card" key={project.id}>
              <div className="top">
                <div className="body">
                  <h3>{project.name}</h3>
                  <span className="path">{project.path}</span>
                </div>
                <StatusDot status={project.status} />
              </div>
              <div className="tag-row">
                {project.stack.map((item) => (
                  <Chip key={item}>{item}</Chip>
                ))}
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
                  {project.knownTests.join(" · ") || "sin tests declarados"}
                </span>
                <button
                  className="button-text"
                  onClick={() => setEditing(project)}
                >
                  <Pencil size={13} aria-hidden />
                  Editar perfil
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
      <div className="grid-2">
        <Surface
          title="Planner de scopes"
          hint="paralelismo seguro"
          action={
            <button
              className="button button-ghost"
              onClick={() => void inspectScopes()}
            >
              <ShieldCheck size={15} aria-hidden />
              Evaluar fixture
            </button>
          }
        >
          {scopePlan ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div
                className={`scope-verdict ${scopePlan.parallel ? "good" : "warn"}`}
              >
                <StatusDot
                  status={scopePlan.parallel ? "healthy" : "degraded"}
                />
                <div>
                  <strong>
                    {scopePlan.parallel
                      ? "El paralelismo es seguro"
                      : "Ejecutar en secuencia"}
                  </strong>
                  <div style={{ color: "var(--ink-2)" }}>
                    {scopePlan.reason}
                  </div>
                </div>
              </div>
              <div className="field-row">
                {Object.entries(scopePlan.assignments).map(([role, paths]) => (
                  <div className="detail-section" key={role}>
                    <span className="label">{role}</span>
                    <div className="path-chips">
                      {paths.map((item) => (
                        <code key={item}>{item}</code>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              {scopePlan.conflicts.length > 0 && (
                <Callout tone="warn">
                  Conflictos: {scopePlan.conflicts.join(", ")}
                </Callout>
              )}
            </div>
          ) : (
            <p style={{ color: "var(--ink-2)", fontSize: 13 }}>
              Ejecuta una evaluación para ver si los scopes de frontend y
              engineer se traslapan.
            </p>
          )}
        </Surface>
        <Surface
          title="Worktrees gestionados"
          hint="aislamiento experimental"
          action={
            <Chip
              tone={
                snapshot.featureFlags?.experimentalWorktrees ? "ok" : "neutral"
              }
            >
              {snapshot.featureFlags?.experimentalWorktrees
                ? "habilitado"
                : "deshabilitado"}
            </Chip>
          }
        >
          {!snapshot.featureFlags?.experimentalWorktrees ? (
            <p style={{ color: "var(--ink-2)", fontSize: 13 }}>
              Habilita la ejecución con worktrees en Sistema para aislar tareas
              frontend y engineer con muchas escrituras. Orchestra nunca hace
              merge automático.
            </p>
          ) : snapshot.projects.length === 0 ? (
            <p style={{ color: "var(--ink-2)", fontSize: 13 }}>
              Registra primero un proyecto Git.
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div className="field-row">
                <label className="field">
                  <span>Proyecto</span>
                  <select
                    value={activeProject?.id ?? ""}
                    onChange={(event) => {
                      setWorktreeProjectId(event.target.value);
                      setWorktreePreview(null);
                    }}
                  >
                    {snapshot.projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Dueño</span>
                  <select
                    value={worktreeRole}
                    onChange={(event) => {
                      setWorktreeRole(
                        event.target.value as "frontend" | "engineer",
                      );
                      setWorktreePreview(null);
                    }}
                  >
                    <option value="frontend">Frontend</option>
                    <option value="engineer">Engineer</option>
                  </select>
                </label>
                <label className="field">
                  <span>Slug de la tarea</span>
                  <input
                    value={worktreeSlug}
                    spellCheck={false}
                    placeholder="settings-redesign"
                    onChange={(event) => {
                      setWorktreeSlug(event.target.value);
                      setWorktreePreview(null);
                    }}
                  />
                </label>
              </div>
              <div className="button-row">
                <button
                  className="button button-ghost"
                  disabled={busy}
                  onClick={() => void previewWorktree()}
                >
                  Vista previa
                </button>
                {worktreePreview && (
                  <button
                    className="button button-primary"
                    onClick={() =>
                      setPending({
                        kind: "create-worktree",
                        preview: worktreePreview,
                      })
                    }
                  >
                    <GitBranch size={15} aria-hidden />
                    Crear worktree aislado
                  </button>
                )}
              </div>
              {worktreePreview && (
                <p className="mono" style={{ color: "var(--ink-2)" }}>
                  {worktreePreview.target}
                </p>
              )}
              {worktrees.length > 0 && (
                <div
                  style={{
                    borderTop: "1px solid var(--line)",
                    margin: "0 -18px",
                  }}
                >
                  {worktrees.map((worktree) => (
                    <div className="worktree-row" key={worktree.target}>
                      <div className="body">
                        <strong>
                          {worktree.role} / {worktree.slug}
                        </strong>
                        <span>
                          {worktree.state === "missing"
                            ? "la ruta registrada no existe"
                            : `${worktree.changedFiles.length} archivos · ${worktree.commitsAhead} commits`}
                          {worktree.baseDrifted ? " · el root avanzó" : ""}
                        </span>
                      </div>
                      <Chip tone={worktree.requiresManualMerge ? "warn" : "ok"}>
                        {worktree.requiresManualMerge ? "revisión" : "limpio"}
                      </Chip>
                      <button
                        className="button-text danger"
                        disabled={busy}
                        onClick={() =>
                          setPending({
                            kind: "remove-worktree",
                            worktree,
                          })
                        }
                      >
                        <Trash2 size={13} aria-hidden />
                        {worktree.requiresManualMerge
                          ? "Recuperar y eliminar"
                          : "Eliminar"}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </Surface>
      </div>
      {editing && (
        <ProfileEditor
          project={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await refresh();
          }}
          notice={notice}
        />
      )}
      {pending?.kind === "create-worktree" && (
        <ConfirmModal
          title="Crear worktree aislado"
          busy={busy}
          confirmLabel="Crear"
          onClose={() => setPending(null)}
          onConfirm={() => void createWorktree(pending.preview)}
          body={
            <p>
              Se creará el worktree{" "}
              <strong>
                {pending.preview.role} / {pending.preview.slug}
              </strong>{" "}
              en <code>{pending.preview.target}</code>. El merge queda pendiente
              de revisión manual del root.
            </p>
          }
        />
      )}
      {pending?.kind === "remove-worktree" && (
        <ConfirmModal
          title={
            pending.worktree.requiresManualMerge
              ? "Recuperar cambios y eliminar"
              : "Eliminar worktree"
          }
          danger
          busy={busy}
          confirmLabel={
            pending.worktree.requiresManualMerge
              ? "Recuperar y eliminar"
              : "Eliminar"
          }
          onClose={() => setPending(null)}
          onConfirm={() => void cleanupWorktree(pending.worktree)}
          body={
            pending.worktree.requiresManualMerge ? (
              <p>
                Este worktree tiene {pending.worktree.changedFiles.length}{" "}
                archivo(s) con cambios o commits. Se generará un parche de
                recuperación antes de eliminarlo; Orchestra no hace merge
                automático.
              </p>
            ) : (
              <p>Este worktree está limpio y se eliminará sin dejar rastro.</p>
            )
          }
        />
      )}
    </div>
  );
}

function ProfileEditor({
  project,
  onClose,
  onSaved,
  notice,
}: {
  project: ProjectProfile;
  onClose: () => void;
  onSaved: () => Promise<void>;
  notice: (message: string) => void;
}) {
  const [ownershipText, setOwnershipText] = useState(
    JSON.stringify(project.ownership, null, 2),
  );
  const [sharedPaths, setSharedPaths] = useState(
    project.sharedPaths.join("\n"),
  );
  const [activeTeam, setActiveTeam] = useState(project.activeTeam);
  const [routingPolicy, setRoutingPolicy] = useState(project.routingPolicy);
  const [knownTests, setKnownTests] = useState(project.knownTests.join("\n"));
  const [lintScript, setLintScript] = useState(project.lintScript ?? "");
  const [typecheckScript, setTypecheckScript] = useState(
    project.typecheckScript ?? "",
  );
  const [saving, setSaving] = useState(false);

  function parseList(value: string): string[] {
    return value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  async function save() {
    let ownership: unknown;
    try {
      ownership = JSON.parse(ownershipText);
    } catch {
      notice("El ownership debe ser JSON válido con root/frontend/engineer.");
      return;
    }
    setSaving(true);
    try {
      await invokeCommand("update_project_profile", {
        projectId: project.id,
        ownership,
        sharedPaths: parseList(sharedPaths),
        activeTeam,
        routingPolicy,
        knownTests: parseList(knownTests),
        lintScript: lintScript.trim() || null,
        typecheckScript: typecheckScript.trim() || null,
      });
      notice("Perfil actualizado localmente.");
      await onSaved();
    } catch (cause) {
      notice(describeError(cause, "El perfil no se pudo guardar."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title={`Perfil · ${project.name}`}
      badge={<Chip>{statusLabel(project.status)}</Chip>}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="button button-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button
            className="button button-primary"
            disabled={saving}
            onClick={() => void save()}
          >
            <Plus size={15} aria-hidden style={{ display: "none" }} />
            {saving ? "Guardando…" : "Guardar perfil"}
          </button>
        </>
      }
    >
      <div className="field-row">
        <label className="field">
          <span>Equipo activo</span>
          <input
            value={activeTeam}
            onChange={(event) => setActiveTeam(event.target.value)}
          />
        </label>
        <label className="field">
          <span>Política de ruteo</span>
          <select
            value={routingPolicy}
            onChange={(event) => setRoutingPolicy(event.target.value)}
          >
            <option value="safe-disjoint-only">
              safe-disjoint-only · paralelismo si no hay traslape
            </option>
            <option value="sequential-on-overlap">
              sequential-on-overlap · siempre secuencial si hay duda
            </option>
          </select>
        </label>
      </div>
      <label className="field">
        <span>Ownership por rol (JSON: root / frontend / engineer)</span>
        <textarea
          className="mono"
          rows={6}
          spellCheck={false}
          value={ownershipText}
          onChange={(event) => setOwnershipText(event.target.value)}
        />
        <span className="field-help">
          Rutas o globs por rol, por ejemplo `src/**`. Los compartidos van
          aparte y siempre los maneja el root.
        </span>
      </label>
      <div className="field-row">
        <label className="field">
          <span>Rutas compartidas (una por línea)</span>
          <textarea
            rows={4}
            spellCheck={false}
            value={sharedPaths}
            onChange={(event) => setSharedPaths(event.target.value)}
          />
        </label>
        <label className="field">
          <span>Tests conocidos (uno por línea)</span>
          <textarea
            rows={4}
            spellCheck={false}
            value={knownTests}
            onChange={(event) => setKnownTests(event.target.value)}
          />
        </label>
      </div>
      <div className="field-row">
        <label className="field">
          <span>Comando de lint (opcional)</span>
          <input
            value={lintScript}
            spellCheck={false}
            placeholder="npm run lint"
            onChange={(event) => setLintScript(event.target.value)}
          />
        </label>
        <label className="field">
          <span>Comando de typecheck (opcional)</span>
          <input
            value={typecheckScript}
            spellCheck={false}
            placeholder="npm run typecheck"
            onChange={(event) => setTypecheckScript(event.target.value)}
          />
        </label>
      </div>
    </Modal>
  );
}
