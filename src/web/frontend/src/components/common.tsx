import { useState, type ReactNode } from "react";

export function ReadOnlyBadge({ label = "Read-only" }: { label?: string }) {
  return (
    <span className="badge badge-ro" title="This operation only reads data. It cannot modify SAP Commerce.">
      <svg aria-hidden="true" viewBox="0 0 16 16" width="12" height="12"><path d="M8 1.5 2.5 4v4c0 3.2 2.3 5.6 5.5 6.5 3.2-.9 5.5-3.3 5.5-6.5V4L8 1.5Z" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
      {label}
    </span>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      <div className="page-actions">{actions}</div>
    </header>
  );
}

export function ErrorBox({ error, hint }: { error: { code: string; message: string }; hint?: ReactNode }) {
  return (
    <div className="alert alert-error" role="alert">
      <strong>{error.code}</strong>
      <p>{error.message}</p>
      {hint && <p className="muted">{hint}</p>}
    </div>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" /> {label}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children && <p className="muted">{children}</p>}
    </div>
  );
}

export function CopyButton({ text, label = "Copy", disabled }: { text: string | (() => string); label?: string; disabled?: boolean }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(typeof text === "function" ? text() : text);
      setState("done");
    } catch {
      setState("failed");
    }
    window.setTimeout(() => setState("idle"), 1800);
  };
  return (
    <button type="button" className="btn btn-ghost btn-sm" onClick={copy} disabled={disabled}>
      {state === "done" ? "Copied" : state === "failed" ? "Copy failed" : label}
    </button>
  );
}

export function Field({ label, htmlFor, children, hint }: { label: string; htmlFor: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && <small className="muted">{hint}</small>}
    </div>
  );
}

export function Note({ children, kind = "info" }: { children: ReactNode; kind?: "info" | "warn" }) {
  return <div className={`alert alert-${kind}`}>{children}</div>;
}

/** Visually and semantically separates AI-generated prose from data that was actually fetched. */
export function SourceLabel({ kind }: { kind: "fetched" | "generated" }) {
  return kind === "fetched" ? (
    <span className="badge badge-fetched">Fetched from SAP Commerce</span>
  ) : (
    <span className="badge badge-generated">AI-generated explanation</span>
  );
}
