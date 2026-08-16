import type { HealthStatus, OrchestraSnapshot } from "./types";

export type OrchestraView =
  | "overview"
  | "setup"
  | "team"
  | "projects"
  | "run"
  | "diagnostics"
  | "usage"
  | "system";

export type ReadinessLevel = "ready" | "partial" | "blocked" | "unknown";

export interface ReadinessAction {
  view: OrchestraView;
  label: string;
}

export interface ReadinessItem {
  id: "codex" | "router" | "providers" | "project" | "run";
  label: string;
  status: HealthStatus;
  headline: string;
  detail: string;
}

export interface OrchestraReadiness {
  level: ReadinessLevel;
  status: HealthStatus;
  headline: string;
  summary: string;
  next: ReadinessAction;
  blockingId?: ReadinessItem["id"];
  items: ReadinessItem[];
  configuredProviders: number;
  providerCount: number;
  routerLive: boolean;
}

function externalProviders(snapshot: OrchestraSnapshot) {
  return snapshot.providers.filter((provider) => provider.id !== "openai");
}

export function routerIsLive(snapshot: OrchestraSnapshot) {
  const runtime = snapshot.router.runtime;
  if (runtime) return runtime.healthy && runtime.service === "running";
  return snapshot.router.detected && snapshot.router.service === "running";
}

export function routerNeedsPulse(snapshot: OrchestraSnapshot) {
  if (!snapshot.router.detected) return false;
  if (snapshot.router.runtime) return false;
  return snapshot.router.service === "unknown";
}

export function orchestraReadiness(
  snapshot: OrchestraSnapshot,
): OrchestraReadiness {
  const providers = externalProviders(snapshot);
  const configuredProviders = providers.filter(
    (provider) => provider.credential === "configured",
  ).length;
  const providerCount = providers.length;
  const invalidProvider = providers.some(
    (provider) =>
      provider.credential === "invalid" || provider.credential === "expired",
  );
  const routerDetected = snapshot.router.detected;
  const routerLive = routerIsLive(snapshot);
  const routerUnknown = routerNeedsPulse(snapshot);

  const items: ReadinessItem[] = [
    snapshot.codex.detected
      ? {
          id: "codex",
          label: "Codex",
          status: "healthy",
          headline: snapshot.codex.version ?? "Detectado",
          detail: "El ejecutable local está visible.",
        }
      : {
          id: "codex",
          label: "Codex",
          status: "missing",
          headline: "No detectado",
          detail: "Sin Codex, Orchestra no puede iniciar tareas.",
        },
    !routerDetected
      ? {
          id: "router",
          label: "Router",
          status: "missing",
          headline: "Sin checkout",
          detail: "Todavía no hay un Router gestionado que conectar.",
        }
      : routerLive
        ? {
            id: "router",
            label: "Router",
            status: "healthy",
            headline: "En marcha",
            detail: `${snapshot.router.ports.length} puerto(s) en 127.0.0.1 · ${snapshot.router.version ?? "versión local"}`,
          }
        : routerUnknown
          ? {
              id: "router",
              label: "Router",
              status: "unknown",
              headline: "Sin pulso aún",
              detail:
                "El checkout existe, pero todavía no se comprobó si el servicio responde.",
            }
          : {
              id: "router",
              label: "Router",
              status: "degraded",
              headline: "Parado",
              detail:
                "El checkout está en disco, pero no hay servicio en 127.0.0.1. Detectado no significa en marcha.",
            },
    invalidProvider
      ? {
          id: "providers",
          label: "Proveedores",
          status: "unhealthy",
          headline: "Credencial inválida",
          detail: "El Router reporta una credencial vencida o inválida.",
        }
      : configuredProviders === 0
        ? {
            id: "providers",
            label: "Proveedores",
            status: routerDetected ? "missing" : "unknown",
            headline: "Ninguno conectado",
            detail:
              "Las claves viven en el Router; Orchestra solo lee el estado.",
          }
        : {
            id: "providers",
            label: "Proveedores",
            status:
              configuredProviders === providerCount ? "healthy" : "degraded",
            headline: `${configuredProviders}/${providerCount} conectados`,
            detail:
              configuredProviders === providerCount
                ? "Los proveedores externos tienen credencial."
                : "Hay al menos un proveedor listo; el resto puede esperar.",
          },
    snapshot.projects.length === 0
      ? {
          id: "project",
          label: "Proyecto",
          status: "missing",
          headline: "Sin repo",
          detail:
            "Registra un proyecto local antes de generar archivos o ejecutar.",
        }
      : {
          id: "project",
          label: "Proyecto",
          status: "healthy",
          headline: `${snapshot.projects.length} registrado${
            snapshot.projects.length === 1 ? "" : "s"
          }`,
          detail:
            "Puedes aplicar el bloque gestionado o ejecutar sobre un repo.",
        },
    snapshot.featureFlags?.appServer
      ? {
          id: "run",
          label: "Ejecución",
          status: "healthy",
          headline: "Codex local activo",
          detail: "Ya puedes delegar una tarea desde Ejecutar.",
        }
      : {
          id: "run",
          label: "Ejecución",
          status: "missing",
          headline: "App Server apagado",
          detail:
            "Un clic en Ejecutar habilita la conexión local. No toca config.toml.",
        },
  ];

  if (!snapshot.codex.detected) {
    return finish(items, {
      level: "blocked",
      status: "missing",
      headline: "Codex no está instalado",
      summary:
        "Orchestra observa Codex; sin el ejecutable no hay plano de control.",
      next: { view: "setup", label: "Revisar detección" },
      blockingId: "codex",
      configuredProviders,
      providerCount,
      routerLive,
    });
  }
  if (!routerDetected) {
    return finish(items, {
      level: "blocked",
      status: "missing",
      headline: "Falta el Router",
      summary: "Prepara el checkout gestionado antes de conectar proveedores.",
      next: { view: "setup", label: "Preparar Router" },
      blockingId: "router",
      configuredProviders,
      providerCount,
      routerLive,
    });
  }
  if (routerUnknown) {
    return finish(items, {
      level: "unknown",
      status: "unknown",
      headline: "Aún no sabemos si está vivo",
      summary:
        "El Router está en disco, pero el pulso del servicio no se comprobó.",
      next: { view: "setup", label: "Comprobar pulso" },
      blockingId: "router",
      configuredProviders,
      providerCount,
      routerLive,
    });
  }
  if (!routerLive) {
    return finish(items, {
      level: "blocked",
      status: "degraded",
      headline: "Router parado",
      summary:
        "Instalado no es lo mismo que en marcha. Ábrelo o repara la conexión.",
      next: { view: "setup", label: "Abrir el Router" },
      blockingId: "router",
      configuredProviders,
      providerCount,
      routerLive,
    });
  }
  if (invalidProvider) {
    return finish(items, {
      level: "blocked",
      status: "unhealthy",
      headline: "Hay una credencial inválida",
      summary:
        "Reabre el helper del proveedor afectado; Orchestra no guarda la clave.",
      next: { view: "setup", label: "Revisar proveedores" },
      blockingId: "providers",
      configuredProviders,
      providerCount,
      routerLive,
    });
  }
  if (configuredProviders === 0) {
    return finish(items, {
      level: "partial",
      status: "missing",
      headline: "Router en marcha, sin proveedores",
      summary:
        "Conecta Qwen, OpenCode Go o Grok desde el helper local del Router.",
      next: { view: "setup", label: "Conectar un proveedor" },
      blockingId: "providers",
      configuredProviders,
      providerCount,
      routerLive,
    });
  }
  if (snapshot.projects.length === 0) {
    return finish(items, {
      level: "partial",
      status: "degraded",
      headline: "Falta un proyecto",
      summary:
        "El plano está vivo. Registra un repo para aplicar el equipo o ejecutar.",
      next: { view: "projects", label: "Registrar proyecto" },
      blockingId: "project",
      configuredProviders,
      providerCount,
      routerLive,
    });
  }
  if (!snapshot.featureFlags?.appServer) {
    return finish(items, {
      level: "partial",
      status: "degraded",
      headline: "Listo para activar Codex",
      summary:
        "Router y proveedores responden. Activa la conexión local para ejecutar.",
      next: { view: "run", label: "Activar Codex local" },
      blockingId: "run",
      configuredProviders,
      providerCount,
      routerLive,
    });
  }
  return finish(items, {
    level: "ready",
    status: "healthy",
    headline: "En marcha",
    summary:
      "Router vivo, al menos un proveedor conectado y un proyecto listo.",
    next: { view: "run", label: "Ejecutar una tarea" },
    configuredProviders,
    providerCount,
    routerLive,
  });
}

function finish(
  items: ReadinessItem[],
  rest: Omit<OrchestraReadiness, "items">,
): OrchestraReadiness {
  return { items, ...rest };
}

export function readinessTone(level: ReadinessLevel) {
  switch (level) {
    case "ready":
      return "ok" as const;
    case "partial":
    case "unknown":
      return "warn" as const;
    default:
      return "bad" as const;
  }
}
