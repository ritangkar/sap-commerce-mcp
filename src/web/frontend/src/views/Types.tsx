import { useCallback, useState } from "react";
import { api } from "../api";
import { DataTable } from "../components/DataTable";
import { ErrorBox, Field, Loading, Note, PageHeader, ReadOnlyBadge } from "../components/common";
import { useRun } from "../hooks";

interface TypeData {
  code: string;
  superType: string | null;
  abstract: boolean | null;
  superTypeChain?: string[];
  attributes: Array<{ qualifier: string; type: string | null; localized: boolean | null; optional: boolean | null; unique: boolean | null; partOf: boolean | null; declaredIn: string }>;
  subtypes: string[];
  subtypesTruncated?: boolean;
  notes: string[];
}

export function Types() {
  const [type, setType] = useState("Product");
  const [inherited, setInherited] = useState(false);
  const load = useCallback(() => api.runTool<TypeData>("type_info", { type: type.trim(), includeInherited: inherited }), [type, inherited]);
  const [state, run] = useRun(load);
  const fmt = (v: boolean | null) => (v === null ? "" : v ? "yes" : "no");

  return (
    <>
      <PageHeader title="Type system" subtitle="Inspect a composed type: super type, attributes and sub types." actions={<ReadOnlyBadge />} />
      <form className="card row" onSubmit={(e) => { e.preventDefault(); void run(); }}>
        <Field label="Type code" htmlFor="type-code" hint="e.g. Product, Order, CronJob">
          <input id="type-code" value={type} onChange={(e) => setType(e.target.value)} spellCheck={false} autoComplete="off" />
        </Field>
        <label className="check"><input type="checkbox" checked={inherited} onChange={(e) => setInherited(e.target.checked)} /> Include inherited attributes</label>
        <span className="spacer" />
        <button className="btn" type="submit" disabled={!type.trim() || state.status === "loading"}>Inspect type</button>
      </form>
      {state.status === "idle" && <p className="muted">Enter a type code to inspect.</p>}
      {state.status === "loading" && <Loading label="Reading type system…" />}
      {state.status === "error" && <ErrorBox error={state.error} />}
      {state.status === "success" && (
        <>
          <section className="card">
            <h2>{state.data.data.code}</h2>
            <dl className="kv">
              <dt>Super type</dt><dd>{state.data.data.superType ?? "—"}</dd>
              <dt>Abstract</dt><dd>{fmt(state.data.data.abstract) || "—"}</dd>
              {state.data.data.superTypeChain && <><dt>Super type chain</dt><dd>{state.data.data.superTypeChain.join(" → ") || "—"}</dd></>}
            </dl>
            {state.data.data.notes.map((n) => <p key={n} className="muted">{n}</p>)}
          </section>
          <section aria-labelledby="attr-h">
            <h2 id="attr-h">Attributes ({state.data.data.attributes.length})</h2>
            <DataTable
              caption={`Attributes of ${state.data.data.code}`}
              filterPlaceholder="Filter attributes…"
              columns={[
                { key: "qualifier", label: "Qualifier" }, { key: "type", label: "Type" }, { key: "localized", label: "Localized" },
                { key: "optional", label: "Optional" }, { key: "unique", label: "Unique" }, { key: "partOf", label: "Part of" }, { key: "declaredIn", label: "Declared in" }
              ]}
              rows={state.data.data.attributes.map((a) => ({ ...a, localized: fmt(a.localized), optional: fmt(a.optional), unique: fmt(a.unique), partOf: fmt(a.partOf) }))}
              emptyTitle="No declared attributes."
            />
          </section>
          <section aria-labelledby="sub-h">
            <h2 id="sub-h">Sub types ({state.data.data.subtypes.length})</h2>
            {state.data.data.subtypesTruncated && <Note kind="warn">Sub type list truncated at 300 entries.</Note>}
            <DataTable caption="Sub types" columns={[{ key: "code", label: "Type code" }]} rows={state.data.data.subtypes.map((code) => ({ code }))} emptyTitle="No sub types." />
          </section>
        </>
      )}
    </>
  );
}
