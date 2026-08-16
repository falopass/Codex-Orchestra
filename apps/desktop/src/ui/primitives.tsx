import { useEffect, useRef, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import { statusLabel } from "./format";

export type Tone = "neutral" | "ok" | "warn" | "bad";

export function StatusDot({
  status,
  pulse,
}: {
  status: string;
  pulse?: boolean;
}) {
  return (
    <span
      className={`status-dot status-${status}${pulse ? " pulse" : ""}`}
      role="img"
      aria-label={statusLabel(status)}
    />
  );
}

export function Chip({
  tone = "neutral",
  children,
}: {
  tone?: Tone;
  children: ReactNode;
}) {
  return <span className={`chip chip-${tone}`}>{children}</span>;
}

export function statusTone(status: string): Tone {
  switch (status) {
    case "healthy":
      return "ok";
    case "degraded":
    case "unknown":
      return "warn";
    case "unhealthy":
      return "bad";
    default:
      return "neutral";
  }
}

export function Callout({
  tone = "neutral",
  children,
}: {
  tone?: Tone;
  children: ReactNode;
}) {
  const icon =
    tone === "ok" ? (
      <CheckCircle2 size={15} aria-hidden />
    ) : tone === "warn" ? (
      <AlertTriangle size={15} aria-hidden />
    ) : tone === "bad" ? (
      <AlertTriangle size={15} aria-hidden />
    ) : (
      <Info size={15} aria-hidden />
    );
  const className = tone === "neutral" ? "callout" : `callout callout-${tone}`;
  return (
    <div className={className} role={tone === "bad" ? "alert" : undefined}>
      {icon}
      <div>{children}</div>
    </div>
  );
}

export function PageHead({
  title,
  lede,
  actions,
}: {
  title: string;
  lede?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {lede && <p className="lede">{lede}</p>}
      </div>
      {actions && <div className="page-head-actions">{actions}</div>}
    </div>
  );
}

export function Surface({
  title,
  hint,
  action,
  children,
  flush,
}: {
  title?: string;
  hint?: string;
  action?: ReactNode;
  children: ReactNode;
  flush?: boolean;
}) {
  return (
    <section className="surface">
      {(title || action) && (
        <div className="surface-head">
          <div>
            {title && <h2>{title}</h2>}
            {hint && <span className="hint">{hint}</span>}
          </div>
          {action}
        </div>
      )}
      <div className={`surface-body${flush ? " flush" : ""}`}>{children}</div>
    </section>
  );
}

export function EmptyState({
  icon,
  title,
  detail,
  action,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      {icon}
      <h3>{title}</h3>
      <p>{detail}</p>
      {action}
    </div>
  );
}

export function Modal({
  title,
  badge,
  onClose,
  wide,
  children,
  footer,
}: {
  title: string;
  badge?: ReactNode;
  onClose: () => void;
  wide?: boolean;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    ref.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={`modal${wide ? " modal-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
      >
        <div className="modal-head">
          <h3>{title}</h3>
          {badge}
          <button className="button-text" onClick={onClose} aria-label="Cerrar">
            <X size={16} aria-hidden />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmModal({
  title,
  body,
  confirmLabel = "Confirmar",
  danger,
  busy,
  onConfirm,
  onClose,
}: {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="button button-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button
            className={`button ${danger ? "button-danger" : "button-primary"}`}
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? "Trabajando…" : confirmLabel}
          </button>
        </>
      }
    >
      <div style={{ fontSize: 13.5, color: "var(--ink-2)" }}>{body}</div>
    </Modal>
  );
}

export function BrandMark({
  brand,
  size,
}: {
  brand: BrandName;
  size?: "small" | "large" | "topbar" | "boot";
}) {
  return (
    <span
      className={`brand-mark brand-mark--${brandTone[brand]}${size ? ` ${size}` : ""}`}
      data-brand={brand}
      aria-hidden="true"
    >
      <img className="brand-mark__image" src={brandAssets[brand]} alt="" />
    </span>
  );
}

export type BrandName =
  | "orchestra"
  | "frontend"
  | "engineer"
  | "provider"
  | "openai"
  | "router"
  | "qwen"
  | "kimi"
  | "opencode"
  | "grok";

export const brandLabels: Record<BrandName, string> = {
  orchestra: "Codex Orchestra",
  frontend: "Agente Frontend",
  engineer: "Agente Engineer",
  provider: "Proveedor",
  openai: "OpenAI",
  router: "Codex Router",
  qwen: "Qwen",
  kimi: "Kimi",
  opencode: "OpenCode",
  grok: "Grok",
};

const brandAssets: Record<BrandName, string> = {
  orchestra: "/brand/codex-orchestra-light-v2.png",
  frontend: "/brand/role-frontend-light-v2.png",
  engineer: "/brand/role-engineer-light-v2.png",
  provider: "/brand/provider-generic-light-v2.png",
  openai: "/brand/openai.svg",
  router: "/brand/codex-router.svg",
  qwen: "/brand/qwen.svg",
  kimi: "/brand/kimi.png",
  opencode: "/brand/opencode.svg",
  grok: "/brand/grok.png",
};

// Container per brand: light = light plate, dark = ink plate for light glyphs,
// tile = the asset brings its own tile (no border or padding).
const brandTone: Record<BrandName, "light" | "dark" | "tile"> = {
  orchestra: "light",
  frontend: "light",
  engineer: "light",
  provider: "light",
  openai: "light",
  router: "tile",
  qwen: "light",
  kimi: "dark",
  opencode: "dark",
  grok: "dark",
};

export function providerBrand(family: string, id: string): BrandName {
  if (id === "qwen-plan") return "qwen";
  if (id === "opencode-go") return "opencode";
  if (family === "kimi") return "kimi";
  if (family === "xai") return "grok";
  if (family === "openai") return "openai";
  return "provider";
}
