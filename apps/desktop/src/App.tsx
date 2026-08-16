import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
} from "react";
import type { OrchestraSnapshot } from "@codex-orchestra/contracts";
import { orchestraReadiness } from "@codex-orchestra/contracts";
import { listen } from "@tauri-apps/api/event";
import {
  BarChart3,
  CircleAlert,
  FolderGit2,
  LayoutDashboard,
  Play,
  Rocket,
  SlidersHorizontal,
  Stethoscope,
  Users,
  X,
} from "lucide-react";
import { invokeCommand } from "./core/invoke";
import type { View, ViewContext } from "./views/types";
import { Overview } from "./views/Overview";
import { Setup } from "./views/Setup";
import { Team } from "./views/Team";
import { Projects } from "./views/Projects";
import { Run } from "./views/Run";
import { Diagnostics } from "./views/Diagnostics";
import { Usage } from "./views/Usage";
import { System } from "./views/System";
import { BrandMark, StatusDot } from "./ui/primitives";

const NAV: Array<{
  view: View;
  label: string;
  icon: ComponentType<{ size?: number }>;
}> = [
  { view: "overview", label: "Resumen", icon: LayoutDashboard },
  { view: "setup", label: "Configuración", icon: Rocket },
  { view: "team", label: "Equipo", icon: Users },
  { view: "projects", label: "Proyectos", icon: FolderGit2 },
  { view: "run", label: "Ejecutar", icon: Play },
  { view: "diagnostics", label: "Diagnóstico", icon: Stethoscope },
  { view: "usage", label: "Uso", icon: BarChart3 },
  { view: "system", label: "Sistema", icon: SlidersHorizontal },
];

const VIEW_COMPONENTS: Record<View, ComponentType<ViewContext>> = {
  overview: Overview,
  setup: Setup,
  team: Team,
  projects: Projects,
  run: Run,
  diagnostics: Diagnostics,
  usage: Usage,
  system: System,
};

export default function App() {
  const [snapshot, setSnapshot] = useState<OrchestraSnapshot | null>(null);
  const [view, setView] = useState<View>("overview");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);

  const notice = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 5200);
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const next =
          await invokeCommand<OrchestraSnapshot>("get_snapshot_fast");
        if (active) {
          setSnapshot(next);
          setLoadError(null);
        }
        const needsLivePulse =
          !next.codex.detected ||
          (next.router.detected &&
            (next.router.service !== "running" ||
              next.router.runtime?.healthy !== true));
        if (needsLivePulse) {
          const refreshed =
            await invokeCommand<OrchestraSnapshot>("get_snapshot");
          if (active) setSnapshot(refreshed);
        }
      } catch (cause) {
        if (active)
          setLoadError(
            cause instanceof Error
              ? cause.message
              : "No se pudo cargar el estado local.",
          );
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (
      !(window as Window & { __TAURI_INTERNALS__?: unknown })
        .__TAURI_INTERNALS__
    ) {
      return;
    }
    let dispose: (() => void) | undefined;
    void listen("orchestra-open-usage", () => {
      setView("usage");
      void invokeCommand<OrchestraSnapshot>("get_snapshot_fast").then(
        setSnapshot,
      );
    }).then((unlisten) => {
      dispose = unlisten;
    });
    return () => dispose?.();
  }, []);

  if (!snapshot) {
    if (loadError) {
      return (
        <div className="boot">
          <div className="boot-error">
            <CircleAlert size={30} aria-hidden />
            <h1>No se pudo iniciar Codex Orchestra</h1>
            <p>{loadError}</p>
            <button
              className="button button-primary"
              onClick={() => window.location.reload()}
            >
              Reintentar
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="boot" role="status">
        <BrandMark brand="orchestra" size="boot" />
        <strong>Codex Orchestra</strong>
        <p>Leyendo el estado local…</p>
        <div className="boot-bar">
          <span />
        </div>
      </div>
    );
  }

  const readiness = orchestraReadiness(snapshot);
  const attention = snapshot.diagnostics.filter(
    (item) => item.status === "missing" || item.status === "unhealthy",
  ).length;
  const ActiveView = VIEW_COMPONENTS[view];
  const context: ViewContext = {
    snapshot,
    setSnapshot,
    navigate: setView,
    notice,
  };

  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-brand">
          <BrandMark brand="orchestra" size="topbar" />
          <strong>Codex Orchestra</strong>
          <span className="mono">v{snapshot.appVersion}</span>
        </div>
        <nav className="topbar-nav" aria-label="Secciones">
          {NAV.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.view}
                className="nav-tab"
                title={item.label}
                aria-label={item.label}
                aria-current={view === item.view ? "page" : undefined}
                onClick={() => setView(item.view)}
              >
                <Icon size={15} aria-hidden />
                <span className="nav-label">{item.label}</span>
                {item.view === "diagnostics" && attention > 0 && (
                  <span
                    className="nav-alert"
                    role="img"
                    aria-label={`${attention} elementos requieren atención`}
                  />
                )}
              </button>
            );
          })}
        </nav>
        <div className="topbar-status">
          <div className="topbar-stat">
            <StatusDot status={readiness.status} pulse={readiness.routerLive} />
            {readiness.headline}
          </div>
          <div className="topbar-stat">
            Router
            <span className="mono">
              {readiness.routerLive
                ? "en marcha"
                : snapshot.router.detected
                  ? snapshot.router.service
                  : "ausente"}
            </span>
          </div>
          <div className="topbar-stat">
            Proveedores
            <span className="mono">
              {readiness.configuredProviders}/{readiness.providerCount}
            </span>
          </div>
          <span className="topbar-privacy">local · sin telemetría</span>
        </div>
      </header>
      <main className="view-scroll">
        <ActiveView key={view} {...context} />
      </main>
      {toast && (
        <div className="toast" role="status">
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4" />
            <path d="M12 16h.01" />
          </svg>
          <span>{toast}</span>
          <button onClick={() => setToast(null)} aria-label="Cerrar aviso">
            <X size={14} aria-hidden />
          </button>
        </div>
      )}
    </div>
  );
}
