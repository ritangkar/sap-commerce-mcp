import { useCallback, useState } from "react";
import { api } from "../api";
import { DataTable } from "../components/DataTable";
import { ErrorBox, Loading, Note, PageHeader, ReadOnlyBadge } from "../components/common";
import { useRun } from "../hooks";

interface CronRow { code: string; status: string | null; result: string | null; startTime: string | null; endTime: string | null }

export function Cron() {
  const list = useCallback(() => api.runTool<{ cronjobs: CronRow[]; truncated: boolean }>("cronjob", { action: "list" }), []);
  const [state, run] = useRun(list);
  const detail = useCallback((code: string) => api.runTool<CronRow>("cronjob", { action: "status", code }), []);
  const [one, runOne] = useRun(detail);
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <>
      <PageHeader
        title="CronJobs"
        subtitle="Inspect CronJob status. This view cannot start, abort or modify jobs."
        actions={<><ReadOnlyBadge /><button className="btn" type="button" onClick={() => void run()} disabled={state.status === "loading"}>{state.status === "success" ? "Refresh" : "Load CronJobs"}</button></>}
      />
      {state.status === "idle" && <p className="muted">Nothing loaded yet.</p>}
      {state.status === "loading" && <Loading label="Reading CronJobs…" />}
      {state.status === "error" && <ErrorBox error={state.error} />}
      {state.status === "success" && (
        <>
          {state.data.data.truncated && <Note kind="warn">Only the 100 most recently modified CronJobs are listed.</Note>}
          <DataTable
            caption="CronJobs"
            filterPlaceholder="Filter by code, status, result…"
            columns={[{ key: "code", label: "Code" }, { key: "status", label: "Status" }, { key: "result", label: "Result" }, { key: "startTime", label: "Start" }, { key: "endTime", label: "End" }]}
            rows={state.data.data.cronjobs as unknown as Array<Record<string, unknown>>}
            onRowClick={(r) => { setSelected(String(r.code)); void runOne(String(r.code)); }}
            emptyTitle="No CronJobs found."
          />
          <p className="muted">Select a row to re-read the current status of that CronJob.</p>
        </>
      )}
      {selected && (
        <section className="card" aria-live="polite" aria-label="CronJob status">
          <h2>{selected}</h2>
          {one.status === "loading" && <Loading />}
          {one.status === "error" && <ErrorBox error={one.error} />}
          {one.status === "success" && (
            <dl className="kv">
              <dt>Status</dt><dd>{one.data.data.status ?? "—"}</dd><dt>Result</dt><dd>{one.data.data.result ?? "—"}</dd>
              <dt>Start</dt><dd>{one.data.data.startTime ?? "—"}</dd><dt>End</dt><dd>{one.data.data.endTime ?? "—"}</dd>
              <dt>Read at</dt><dd>{one.at.toLocaleTimeString()}</dd>
            </dl>
          )}
        </section>
      )}
    </>
  );
}
