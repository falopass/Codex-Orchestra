export function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatTokens(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

export function parseLocalTimestamp(value?: string): Date | null {
  if (!value) return null;
  if (value.startsWith("unix:")) {
    const seconds = Number(value.slice(5));
    if (Number.isFinite(seconds)) return new Date(seconds * 1000);
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function formatLocalTimestamp(
  value?: string,
  mode: "dateTime" | "time" | "date" = "dateTime",
) {
  const parsed = parseLocalTimestamp(value);
  if (!parsed) return "sin registro";
  if (mode === "time")
    return parsed.toLocaleTimeString("es-CL", {
      hour: "2-digit",
      minute: "2-digit",
    });
  if (mode === "date")
    return parsed.toLocaleDateString("es-CL", {
      day: "2-digit",
      month: "short",
    });
  return parsed.toLocaleString("es-CL", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function relativeTime(value?: string): string {
  const parsed = parseLocalTimestamp(value);
  if (!parsed) return "sin registro";
  const diffMs = Date.now() - parsed.getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return "recién";
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.round(hours / 24);
  return `hace ${days} d`;
}

export function statusLabel(status: string) {
  switch (status) {
    case "healthy":
      return "Operativo";
    case "degraded":
      return "Requiere atención";
    case "missing":
      return "Sin configurar";
    case "unhealthy":
      return "Con fallas";
    default:
      return "Sin verificar";
  }
}

export function credentialLabel(status: string) {
  switch (status) {
    case "configured":
      return "Conectado";
    case "missing":
      return "Sin credencial";
    case "invalid":
      return "Credencial inválida";
    case "expired":
      return "Credencial vencida";
    default:
      return "Sin verificar";
  }
}

export function describeError(cause: unknown, fallback: string) {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string" && cause.trim()) return cause;
  if (cause && typeof cause === "object") {
    try {
      return JSON.stringify(cause);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

export function shortRef(ref?: string, size = 10) {
  if (!ref) return "—";
  return ref.length > size + 2 ? `${ref.slice(0, size)}…` : ref;
}
