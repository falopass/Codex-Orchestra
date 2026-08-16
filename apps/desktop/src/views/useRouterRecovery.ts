import { useMemo, useState } from "react";
import type {
  OrchestraSnapshot,
  RouterHealthResult,
  RouterLogsResult,
  RouterRestartPhase,
  RouterRestartResult,
} from "@codex-orchestra/contracts";
import { looksLikeRouterConnectionFailure } from "@codex-orchestra/contracts";
import { invokeCommand } from "../core/invoke";
import { routerEngine } from "../core/routerEngine";
import { describeError } from "../ui/format";

const PHASE_COPY: Record<RouterRestartPhase, string> = {
  checking: "Checking localhost service...",
  starting: "Starting Router...",
  waiting: "Checking localhost service...",
  healthy: "Router healthy",
  restored: "Connection restored",
  failed: "Router process recovery failed",
};

function runtimeLooksDown(snapshot: OrchestraSnapshot) {
  const runtime = snapshot.router.runtime;
  if (runtime) {
    return (
      !runtime.healthy ||
      runtime.issue === "offline" ||
      runtime.issue === "connection-refused" ||
      runtime.issue === "unhealthy" ||
      runtime.issue === "missing-runtime"
    );
  }
  return (
    snapshot.router.service === "stopped" ||
    snapshot.router.health === "unhealthy" ||
    (snapshot.router.detected && snapshot.router.ports.length === 0)
  );
}

function snapshotMentionsConnectionFailure(snapshot: OrchestraSnapshot) {
  const texts = [
    snapshot.router.runtime?.message,
    snapshot.health?.status,
    ...(snapshot.health?.checks ?? []).flatMap((check) => [
      check.detail,
      check.remediation,
      check.label,
    ]),
    ...(snapshot.diagnostics ?? []).flatMap((item) => [
      item.detail,
      item.value,
    ]),
    ...(snapshot.logs ?? []).map((item) => item.message),
  ].filter((value): value is string => Boolean(value));
  return texts.some((text) => looksLikeRouterConnectionFailure(text));
}

export function useRouterRecovery(
  snapshot: OrchestraSnapshot,
  setSnapshot: (snapshot: OrchestraSnapshot) => void,
  notice: (message: string) => void,
) {
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<RouterRestartPhase | null>(null);
  const [logs, setLogs] = useState<RouterLogsResult | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const down = useMemo(
    () =>
      runtimeLooksDown(snapshot) || snapshotMentionsConnectionFailure(snapshot),
    [snapshot],
  );
  const runtime = snapshot.router.runtime;
  const needsConfirm = Boolean(
    runtime?.requiresConfirmation || runtime?.activeExecution,
  );

  async function refreshSnapshot() {
    setSnapshot(await invokeCommand<OrchestraSnapshot>("get_snapshot_fast"));
  }

  async function runRepair(confirm = true) {
    setBusy(true);
    setError(null);
    setPhase("starting");
    try {
      const result: RouterRestartResult = await routerEngine.restart(confirm);
      setPhase(result.phase === "failed" ? "failed" : "checking");
      if (result.ok && result.health.healthy) {
        setPhase("healthy");
        await refreshSnapshot();
        setPhase("restored");
        notice(result.message || "Router restarted successfully");
        return result;
      }
      const message =
        result.message ||
        result.health.message ||
        "Router process recovery failed.";
      setError(message);
      setPhase("failed");
      notice(message);
      return result;
    } catch (cause) {
      const message = describeError(cause, "Router process recovery failed.");
      setError(message);
      setPhase("failed");
      notice(message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function requestRepair() {
    if (needsConfirm) {
      setConfirmOpen(true);
      return null;
    }
    return runRepair(true);
  }

  async function confirmRepair() {
    setConfirmOpen(false);
    return runRepair(true);
  }

  async function loadLogs() {
    try {
      const result = await routerEngine.logs();
      setLogs(result);
      if (!result.available) {
        notice(result.message || "No Router process log lines were available.");
      }
      return result;
    } catch (cause) {
      const message = describeError(cause, "Router logs could not be read.");
      setError(message);
      notice(message);
      return null;
    }
  }

  async function probeHealth(): Promise<RouterHealthResult | null> {
    try {
      return await routerEngine.health();
    } catch (cause) {
      notice(describeError(cause, "Router health could not be read."));
      return null;
    }
  }

  return {
    busy,
    phase,
    phaseLabel: phase ? PHASE_COPY[phase] : null,
    logs,
    setLogs,
    confirmOpen,
    setConfirmOpen,
    error,
    down,
    runtime,
    needsConfirm,
    requestRepair,
    confirmRepair,
    loadLogs,
    probeHealth,
    refreshSnapshot,
  };
}
