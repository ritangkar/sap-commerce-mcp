import { useCallback, useState } from "react";
import { api } from "../api";
import { DataTable } from "../components/DataTable";
import { CopyButton, ErrorBox, Field, Loading, Note, PageHeader, ReadOnlyBadge } from "../components/common";
import { useRun } from "../hooks";

interface SearchData { columns: string[]; rows: Array<Record<string, string>>; rowCount: number; truncated: boolean; maskedColumns?: string[]; sql?: string }

const EXAMPLE = "SELECT {p:pk}, {p:code}\nFROM {Product AS p}\nORDER BY {p:modifiedtime} DESC";

export function Search() {
  const [query, setQuery] = useState(EXAMPLE);
  const [maxCount, setMaxCount] = useState("50");
  const [history, setHistory] = useState<string[]>([]);
  const exec = useCallback(async (translate: boolean) => {
    const r = await api.runTool<SearchData>("flexible_search", { query, maxCount: Number(maxCount), translate });
    setHistory((h) => [query, ...h.filter((x) => x !== query)].slice(0, 8));
    return { ...r, translate };
  }, [query, maxCount]);
  const [state, run] = useRun(exec);

  return (
    <>
      <PageHeader title="FlexibleSearch" subtitle="Run read-only FlexibleSearch queries against HAC." actions={<ReadOnlyBadge label="Read-only query" />} />
      <form className="card" onSubmit={(e) => { e.preventDefault(); void run(false); }}>
        <Field label="Query" htmlFor="fs-query" hint="Only a strict SELECT subset is accepted: no comments, ';', ?parameters, LIMIT or raw SQL. Ctrl/⌘+Enter runs the query.">
          <textarea
            id="fs-query"
            className="code-input"
            spellCheck={false}
            rows={8}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); void run(false); } }}
          />
        </Field>
        <div className="row">
          <Field label="Max rows" htmlFor="fs-max">
            <select id="fs-max" value={maxCount} onChange={(e) => setMaxCount(e.target.value)}>
              {["10", "25", "50", "100", "200"].map((n) => <option key={n}>{n}</option>)}
            </select>
          </Field>
          <span className="spacer" />
          <CopyButton label="Copy query" text={query} />
          <button type="button" className="btn btn-secondary" onClick={() => void run(true)} disabled={state.status === "loading"}>Translate to SQL</button>
          <button type="submit" className="btn" disabled={state.status === "loading" || !query.trim()}>Run query</button>
        </div>
        {history.length > 0 && (
          <details className="history">
            <summary>Recent queries (this session only)</summary>
            <ul>{history.map((h) => <li key={h}><button type="button" className="link" onClick={() => setQuery(h)}>{h.replace(/\s+/g, " ").slice(0, 110)}</button></li>)}</ul>
          </details>
        )}
      </form>

      <section aria-live="polite" aria-label="Query result">
        {state.status === "idle" && <p className="muted">Results appear here. Nothing has been run yet.</p>}
        {state.status === "loading" && <Loading label="Running query…" />}
        {state.status === "error" && <ErrorBox error={state.error} hint={state.error.code === "QUERY_REJECTED" ? "The read-only validator did not accept this query. It was not sent to HAC." : undefined} />}
        {state.status === "success" && state.data.data.sql !== undefined && (
          <div className="card"><h2>Generated SQL</h2><pre className="code-block">{state.data.data.sql}</pre><CopyButton text={state.data.data.sql} /></div>
        )}
        {state.status === "success" && state.data.data.sql === undefined && (
          <>
            {(state.data.data.truncated || state.data.truncated) && <Note kind="warn">Result is truncated (row cap or size limit reached). Narrow the query to see everything.</Note>}
            {state.data.data.maskedColumns && <Note>Columns masked as secrets: {state.data.data.maskedColumns.join(", ")}</Note>}
            <DataTable
              caption="FlexibleSearch result"
              columns={state.data.data.columns.map((c) => ({ key: c, label: c }))}
              rows={state.data.data.rows}
              emptyTitle="The query returned no rows."
            />
          </>
        )}
      </section>
    </>
  );
}
