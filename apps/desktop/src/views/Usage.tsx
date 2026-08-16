import { useEffect, useState } from "react";
import type {
  PricingImportPreview,
  PricingRule,
} from "@codex-orchestra/contracts";
import {
  DEFAULT_PRICING_RULES,
  aggregateUsage,
  calculateEstimate,
} from "@codex-orchestra/contracts";
import { BarChart3, Wallet } from "lucide-react";
import { invokeCommand } from "../core/invoke";
import type { ViewContext } from "./types";
import {
  Callout,
  Chip,
  ConfirmModal,
  EmptyState,
  PageHead,
  Surface,
} from "../ui/primitives";
import {
  describeError,
  formatCurrency,
  formatLocalTimestamp,
  formatTokens,
} from "../ui/format";

function usageTimestamp(value: string) {
  if (value.startsWith("unix:")) return Number(value.slice(5)) * 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function Usage({ snapshot, setSnapshot, notice }: ViewContext) {
  const pricingRules =
    snapshot.pricingRules && snapshot.pricingRules.length > 0
      ? snapshot.pricingRules
      : DEFAULT_PRICING_RULES;
  const [pricingDraft, setPricingDraft] = useState(() =>
    JSON.stringify(pricingRules, null, 2),
  );
  const [pricingPreview, setPricingPreview] =
    useState<PricingImportPreview | null>(null);
  const [pricingBusy, setPricingBusy] = useState(false);
  const [confirmApply, setConfirmApply] = useState(false);
  const cost = aggregateUsage(snapshot.usage, pricingRules);
  const maxOutput = Math.max(
    ...snapshot.usage.map((event) => event.outputTokens ?? 0),
    1,
  );
  const budgetPercent =
    snapshot.budget.monthlyLimit > 0
      ? Math.round((cost.totalDisplay / snapshot.budget.monthlyLimit) * 100)
      : 0;
  const modelUsage = (() => {
    const rows = new Map<
      string,
      {
        provider: string;
        model: string;
        input: number;
        cached: number;
        output: number;
        events: number;
        lastSeen?: string;
        sources: Set<string>;
      }
    >();
    for (const model of snapshot.models) {
      rows.set(`${model.providerId}/${model.id}`, {
        provider: model.providerId,
        model: model.id,
        input: 0,
        cached: 0,
        output: 0,
        events: 0,
        sources: new Set(),
      });
    }
    for (const event of snapshot.usage) {
      const key = `${event.provider}/${event.model}`;
      const row = rows.get(key) ?? {
        provider: event.provider,
        model: event.model,
        input: 0,
        cached: 0,
        output: 0,
        events: 0,
        sources: new Set<string>(),
      };
      row.input += event.inputTokens ?? 0;
      row.cached += event.cachedInputTokens ?? 0;
      row.output += event.outputTokens ?? 0;
      row.events += 1;
      row.sources.add(event.source);
      if (
        !row.lastSeen ||
        usageTimestamp(event.timestamp) > usageTimestamp(row.lastSeen)
      ) {
        row.lastSeen = event.timestamp;
      }
      rows.set(key, row);
    }
    return [...rows.values()].sort(
      (a, b) =>
        b.input + b.output - (a.input + a.output) ||
        a.model.localeCompare(b.model),
    );
  })();

  useEffect(() => {
    setPricingDraft(JSON.stringify(pricingRules, null, 2));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.pricingRules]);

  function parsedPricingDraft(): PricingRule[] | null {
    try {
      const parsed: unknown = JSON.parse(pricingDraft);
      return Array.isArray(parsed) ? (parsed as PricingRule[]) : null;
    } catch {
      return null;
    }
  }

  async function previewPricingImport() {
    const rules = parsedPricingDraft();
    if (!rules) {
      setPricingPreview(null);
      notice("El JSON de precios debe ser un array de reglas.");
      return;
    }
    setPricingBusy(true);
    try {
      const preview = await invokeCommand<PricingImportPreview>(
        "preview_pricing_rules",
        { rules },
      );
      setPricingPreview(preview);
      notice(
        `${preview.count} regla(s) validadas. Revísalas antes de aplicar.`,
      );
    } catch (cause) {
      setPricingPreview(null);
      notice(describeError(cause, "Las reglas de precio no se validaron."));
    } finally {
      setPricingBusy(false);
    }
  }

  async function applyPricingImport() {
    const rules = parsedPricingDraft();
    if (!rules || !pricingPreview) {
      notice("Valida el JSON de precios antes de aplicar.");
      return;
    }
    setPricingBusy(true);
    try {
      await invokeCommand("save_pricing_rules", {
        rules,
        previewToken: pricingPreview.token,
        confirm: true,
      });
      setSnapshot(
        await invokeCommand<ViewContext["snapshot"]>("get_snapshot_fast"),
      );
      setPricingPreview(null);
      setConfirmApply(false);
      notice("Reglas de precio versionadas guardadas localmente.");
    } catch (cause) {
      notice(describeError(cause, "Las reglas de precio no se guardaron."));
    } finally {
      setPricingBusy(false);
    }
  }

  return (
    <div className="view">
      <PageHead
        title="Uso"
        lede="El gasto se lee por separado: reportado por el proveedor, reportado por el Router y estimado localmente. Nunca se mezclan como si fueran lo mismo."
        actions={
          <Chip tone={cost.label === "estimated" ? "warn" : "ok"}>
            {cost.label === "estimated" ? "estimado" : cost.label}
          </Chip>
        }
      />
      <div className="metrics-grid">
        <div className="metric">
          <span className="label">Total del mes</span>
          <strong>{formatCurrency(cost.totalDisplay)}</strong>
          <span>fuentes mixtas</span>
        </div>
        <div className="metric">
          <span className="label">Reportado por proveedor</span>
          <strong>{formatCurrency(cost.providerReported)}</strong>
          <span>valor upstream</span>
        </div>
        <div className="metric">
          <span className="label">Reportado por Router</span>
          <strong>{formatCurrency(cost.routerReported)}</strong>
          <span>medición del Router</span>
        </div>
        <div className="metric">
          <span className="label">Estimado</span>
          <strong>{formatCurrency(cost.estimated)}</strong>
          <span>reglas de precio locales</span>
        </div>
      </div>
      <Surface
        title="Uso por modelo"
        hint={`${modelUsage.length} modelo(s) configurados u observados`}
      >
        <div className="model-usage-grid">
          {modelUsage.map((row) => {
            const total = row.input + row.output;
            return (
              <article
                className="model-usage-card"
                key={`${row.provider}/${row.model}`}
              >
                <div className="model-usage-head">
                  <div>
                    <strong>{row.model}</strong>
                    <span>{row.provider}</span>
                  </div>
                  <Chip tone={row.events > 0 ? "ok" : "neutral"}>
                    {row.events > 0
                      ? `${row.events} evento(s)`
                      : "sin datos observados"}
                  </Chip>
                </div>
                <dl>
                  <div>
                    <dt>Total</dt>
                    <dd>{formatTokens(total)}</dd>
                  </div>
                  <div>
                    <dt>Entrada</dt>
                    <dd>{formatTokens(row.input)}</dd>
                  </div>
                  <div>
                    <dt>Cache</dt>
                    <dd>{formatTokens(row.cached)}</dd>
                  </div>
                  <div>
                    <dt>Salida</dt>
                    <dd>{formatTokens(row.output)}</dd>
                  </div>
                </dl>
                <p>
                  {row.lastSeen
                    ? `Último uso ${formatLocalTimestamp(row.lastSeen, "time")} · ${[...row.sources].join(" / ")}`
                    : "Orchestra aún no recibió telemetría segura para este modelo."}
                </p>
              </article>
            );
          })}
        </div>
      </Surface>
      <div className="grid-2-1">
        <Surface title="Volumen de salida" hint="tokens de salida por evento">
          {snapshot.usage.length === 0 ? (
            <EmptyState
              icon={<BarChart3 size={20} aria-hidden />}
              title="Sin eventos"
              detail="Cuando el equipo ejecute trabajo delegado, el volumen aparecerá aquí por rol."
            />
          ) : (
            <>
              <div
                className="bar-chart"
                role="img"
                aria-label="Tokens de salida por evento"
              >
                {snapshot.usage.map((event) => (
                  <div className="bar-group" key={event.id}>
                    <div className="bar-track">
                      <div
                        className={`bar bar-${event.role ?? "root"}`}
                        style={{
                          height: `${Math.max(8, ((event.outputTokens ?? 0) / maxOutput) * 100)}%`,
                        }}
                        title={`${event.outputTokens ?? 0} tokens de salida`}
                      />
                    </div>
                    <span>{event.role ?? "run"}</span>
                  </div>
                ))}
              </div>
              <div className="chart-legend">
                <span>
                  <i className="legend-dot legend-root" />
                  root
                </span>
                <span>
                  <i className="legend-dot legend-frontend" />
                  frontend
                </span>
                <span>
                  <i className="legend-dot legend-engineer" />
                  engineer
                </span>
              </div>
            </>
          )}
        </Surface>
        <Surface title="Presupuesto mensual" hint="alerta, nunca bloqueo">
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 10,
              marginBottom: 10,
            }}
          >
            <strong style={{ fontSize: 22, letterSpacing: "-0.01em" }}>
              {formatCurrency(snapshot.budget.monthlyLimit)}
            </strong>
            <span
              className="num"
              style={{ color: "var(--ink-2)", fontSize: 13 }}
            >
              {snapshot.budget.monthlyLimit > 0
                ? `${budgetPercent}% usado`
                : "sin tope"}
            </span>
          </div>
          <div className={`budget-track${budgetPercent >= 100 ? " over" : ""}`}>
            <span
              style={{
                width: `${Math.min(100, budgetPercent)}%`,
              }}
            />
          </div>
          <p className="field-help" style={{ marginTop: 10 }}>
            Avisos al {snapshot.budget.warningAtPercent}% y{" "}
            {snapshot.budget.criticalAtPercent}%. Orchestra nunca bloquea una
            tarea automáticamente.
          </p>
          <Callout tone="warn">
            <strong>OpenCode Go es por suscripción:</strong> su uso se observa
            cuando el Router lo reporta, pero Orchestra no lo convierte en un
            cargo por token inventado ni usa Zen/PAYG como fallback silencioso.
          </Callout>
        </Surface>
      </div>
      <Surface
        title="Eventos de uso"
        hint={`${snapshot.usage.length} registrados`}
        flush
      >
        {snapshot.usage.length === 0 ? (
          <EmptyState
            icon={<Wallet size={20} aria-hidden />}
            title="Sin eventos aún"
            detail="Los eventos medidos por el Router aparecerán aquí con su fuente y costo."
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Hora</th>
                  <th>Rol</th>
                  <th>Modelo</th>
                  <th>Tokens</th>
                  <th>Fuente</th>
                  <th>Costo</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.usage.map((event) => (
                  <tr key={event.id}>
                    <td className="num">
                      {formatLocalTimestamp(event.timestamp, "time")}
                    </td>
                    <td>
                      <span className={`role-tag tag-${event.role ?? "root"}`}>
                        {event.role ?? "run"}
                      </span>
                    </td>
                    <td>
                      <code>{event.model}</code>
                    </td>
                    <td className="num">
                      {(
                        (event.inputTokens ?? 0) + (event.outputTokens ?? 0)
                      ).toLocaleString()}
                    </td>
                    <td>
                      <Chip
                        tone={event.source === "estimate" ? "warn" : "neutral"}
                      >
                        {event.source}
                      </Chip>
                    </td>
                    <td className="num">
                      {event.providerCost !== undefined
                        ? `${formatCurrency(event.providerCost)} reportado`
                        : formatCurrency(
                            event.estimatedCost ??
                              calculateEstimate(event, pricingRules),
                          )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Surface>
      <Surface
        title="Reglas de precio"
        hint={`${pricingRules.length} versión(es) activa(s)`}
      >
        <p style={{ color: "var(--ink-2)", fontSize: 13, marginBottom: 12 }}>
          Importa un array JSON. Orchestra solo acepta proveedores soportados,
          fechas efectivas UTC exactas y fuentes oficiales HTTPS. Las rutas por
          suscripción deben mantener costo cero por token. Si ya hay reglas
          guardadas, esas filas ganan: una instalación existente conserva las
          tarifas viejas hasta reimportar.
        </p>
        <label className="field">
          <span>JSON de reglas versionadas</span>
          <textarea
            className="mono"
            rows={10}
            spellCheck={false}
            aria-label="Reglas de precio versionadas (JSON)"
            value={pricingDraft}
            onChange={(event) => {
              setPricingDraft(event.target.value);
              setPricingPreview(null);
            }}
          />
        </label>
        {pricingPreview && (
          <div
            className="callout callout-ok"
            style={{ marginTop: 12 }}
            role="status"
          >
            <div>
              <strong>{pricingPreview.count} reglas validadas.</strong>{" "}
              {pricingPreview.providers.join(" · ")} ·{" "}
              {pricingPreview.effectiveFrom} → {pricingPreview.effectiveTo} ·{" "}
              {pricingPreview.subscriptionRules} suscripción /{" "}
              {pricingPreview.paygRules} PAYG
            </div>
          </div>
        )}
        <div className="button-row" style={{ marginTop: 14 }}>
          <button
            className="button button-ghost"
            disabled={pricingBusy}
            onClick={() => void previewPricingImport()}
          >
            {pricingBusy ? "Validando…" : "Validar import"}
          </button>
          <button
            className="button button-primary"
            disabled={pricingBusy || !pricingPreview}
            onClick={() => setConfirmApply(true)}
          >
            Aplicar reglas revisadas
          </button>
        </div>
      </Surface>
      {confirmApply && pricingPreview && (
        <ConfirmModal
          title="Aplicar reglas de precio"
          busy={pricingBusy}
          confirmLabel="Aplicar"
          onClose={() => setConfirmApply(false)}
          onConfirm={() => void applyPricingImport()}
          body={
            <p>
              Se aplicarán {pricingPreview.count} reglas validadas. Las
              versiones anteriores se conservan para trazabilidad.
            </p>
          }
        />
      )}
    </div>
  );
}
