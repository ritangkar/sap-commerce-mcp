import { useCallback, useState } from "react";
import { api } from "../api";
import { DataTable } from "../components/DataTable";
import { ErrorBox, Field, Loading, Note, PageHeader, ReadOnlyBadge } from "../components/common";
import { useRun } from "../hooks";

interface ConfigData { total: number; truncated: boolean; entries: Array<{ key: string; value: string | null }> }

export function Config() {
  const [filter, setFilter] = useState("");
  const load = useCallback(() => api.runTool<ConfigData>("config_get", filter.trim() ? { filter: filter.trim() } : {}), [filter]);
  const [state, run] = useRun(load);

  return (
    <>
      <PageHeader title="Configuration" subtitle="Read configuration properties from HAC. Secret-like values are masked." actions={<ReadOnlyBadge />} />
      <form className="card row" onSubmit={(e) => { e.preventDefault(); void run(); }}>
        <Field label="Key contains" htmlFor="cfg-filter" hint="Leave empty to load the first 500 properties.">
          <input id="cfg-filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="e.g. solr, media, db." spellCheck={false} />
        </Field>
        <span className="spacer" />
        <button className="btn" type="submit" disabled={state.status === "loading"}>Load properties</button>
      </form>
      {state.status === "idle" && <p className="muted">Nothing loaded yet.</p>}
      {state.status === "loading" && <Loading label="Reading configuration…" />}
      {state.status === "error" && <ErrorBox error={state.error} hint="Config parsing is best effort and depends on the HAC version (see docs)." />}
      {state.status === "success" && (
        <>
          {state.data.data.truncated && <Note kind="warn">Showing {state.data.data.entries.length} of {state.data.data.total} matching properties. Refine the filter.</Note>}
          <DataTable caption="Configuration properties" columns={[{ key: "key", label: "Key" }, { key: "value", label: "Value" }]} rows={state.data.data.entries} emptyTitle="No properties match." />
        </>
      )}
    </>
  );
}
