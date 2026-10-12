import { useCallback, useMemo, useState } from "react";
import { api } from "../api";
import { CopyButton, ErrorBox, Field, Loading, Note, PageHeader, ReadOnlyBadge } from "../components/common";
import { useRun } from "../hooks";

interface LogData { path: string; lines: string[]; matched: number; scannedBytes: number; fileBytes: number }
const kib = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(0)} KiB`);
const LEVELS = ["ALL", "ERROR", "WARN", "INFO", "DEBUG"] as const;

export function Logs({ configured }: { configured: boolean }) {
  const [lines, setLines] = useState("200");
  const [grep, setGrep] = useState("");
  const [level, setLevel] = useState<(typeof LEVELS)[number]>("ALL");
  const load = useCallback(() => api.runTool<LogData>("logs_tail", { lines: Number(lines), ...(grep.trim() ? { grep: grep.trim() } : {}) }), [lines, grep]);
  const [state, run] = useRun(load);
  const shown = useMemo(
    () => (state.status === "success" ? state.data.data.lines.filter((l) => level === "ALL" || new RegExp(`\\b${level}\\b`).test(l)) : []),
    [state, level]
  );

  return (
    <>
      <PageHeader title="Console log" subtitle="Tail the local console log file (read-only)." actions={<ReadOnlyBadge />} />
      {!configured && <Note kind="warn">No log file configured. Set <code>HAC_LOG_PATH</code> in <code>.env</code> and restart the server.</Note>}
      <form className="card row" onSubmit={(e) => { e.preventDefault(); void run(); }}>
        <Field label="Lines" htmlFor="log-lines">
          <select id="log-lines" value={lines} onChange={(e) => setLines(e.target.value)}>{["100", "200", "500", "1000", "2000"].map((n) => <option key={n}>{n}</option>)}</select>
        </Field>
        <Field label="Contains (plain text)" htmlFor="log-grep"><input id="log-grep" value={grep} onChange={(e) => setGrep(e.target.value)} placeholder="e.g. Exception" spellCheck={false} /></Field>
        <Field label="Level (client filter)" htmlFor="log-level">
          <select id="log-level" value={level} onChange={(e) => setLevel(e.target.value as (typeof LEVELS)[number])}>{LEVELS.map((l) => <option key={l}>{l}</option>)}</select>
        </Field>
        <span className="spacer" />
        <button className="btn" type="submit" disabled={state.status === "loading"}>{state.status === "success" ? "Refresh" : "Load log"}</button>
      </form>
      {state.status === "idle" && <p className="muted">Nothing loaded yet.</p>}
      {state.status === "loading" && <Loading label="Reading log…" />}
      {state.status === "error" && <ErrorBox error={state.error} />}
      {state.status === "success" && (
        <section aria-label="Log lines">
          <div className="table-toolbar">
            <span className="muted">{shown.length} lines shown · {state.data.data.matched} matched · scanned {kib(state.data.data.scannedBytes)} of {kib(state.data.data.fileBytes)}</span>
            <span className="spacer" />
            <CopyButton label="Copy lines" text={() => shown.join("\n")} disabled={shown.length === 0} />
          </div>
          <Note>Secret-like values are masked on a best-effort basis. Logs can still contain sensitive data.</Note>
          {shown.length === 0 ? <p className="muted">No log lines match.</p> : (
            <pre className="log" tabIndex={0}>
              {shown.map((l, i) => <div key={i} className={/\bERROR\b/.test(l) ? "log-error" : /\bWARN\b/.test(l) ? "log-warn" : undefined}>{l}</div>)}
            </pre>
          )}
        </section>
      )}
    </>
  );
}
