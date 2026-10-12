import { useCallback } from "react";
import { api, type AppStatus } from "../api";
import { ErrorBox, Loading, Note, PageHeader, ReadOnlyBadge } from "../components/common";
import { useRun } from "../hooks";

export function Overview({ status, models, setSelection }: { status: AppStatus; models: Record<string, string>; setSelection: (p: string, m: string) => void }) {
  const testHac = useCallback(() => api.testHac(), []);
  const [hacTest, runHacTest] = useRun(testHac);
  const [providerTest, runProviderTest] = useRun(useCallback((id: string, model: string) => api.testProvider(id, model).then(() => id), []));

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle="Connection and provider configuration for this local session."
        actions={<ReadOnlyBadge label="Read-only tool" />}
      />
      <Note kind="warn">
        <strong>Local development tool.</strong> Not intended for production administration. It can read from, but never modify, the SAP Commerce instance you configure here.
      </Note>

      <section className="card" aria-labelledby="hac-h">
        <h2 id="hac-h">SAP Commerce (HAC)</h2>
        {status.hac.configured ? (
          <dl className="kv">
            <dt>HAC URL</dt><dd><code>{status.hac.url}</code></dd>
            <dt>User</dt><dd><code>{status.hac.user}</code></dd>
            <dt>TLS verification</dt>
            <dd>{status.hac.insecureTls ? <span className="badge badge-warn">disabled (HAC_INSECURE_TLS=true)</span> : <span className="badge">enabled</span>}</dd>
            <dt>Console log file</dt><dd>{status.hac.logConfigured ? "configured" : <span className="muted">not configured (Logs view unavailable)</span>}</dd>
          </dl>
        ) : (
          <ErrorBox error={{ code: "CONFIG_MISSING", message: status.hac.problem ?? "HAC is not configured." }} hint="Set HAC_USER and HAC_PASS in .env, then restart `npm run start:web`." />
        )}
        <p className="muted">Configured does not mean reachable. Test the connection to log in and run one trivial read-only query.</p>
        <button type="button" className="btn" onClick={() => runHacTest()} disabled={!status.hac.configured || hacTest.status === "loading"}>
          Test HAC connection
        </button>
        <div className="result-slot">
          {hacTest.status === "loading" && <Loading label="Connecting to HAC…" />}
          {hacTest.status === "success" && (
            <div className="alert alert-ok" role="status">Connected and authenticated as <code>{hacTest.data.user}</code> at {hacTest.at.toLocaleTimeString()}. This reflects the moment of the test only.</div>
          )}
          {hacTest.status === "error" && (
            <ErrorBox error={hacTest.error} hint="See docs/SAP-COMMERCE-CONNECTION.md and docs/TROUBLESHOOTING.md." />
          )}
        </div>
      </section>

      <section className="card" aria-labelledby="prov-h">
        <h2 id="prov-h">AI providers</h2>
        <p className="muted">Used only by the Assistant view. API keys are read from the server environment and are never sent to the browser. Direct API use may incur charges, separate from any chat subscription.</p>
        <div className="provider-grid">
          {status.providers.map((p) => (
            <article key={p.id} className="provider">
              <h3>{p.label}</h3>
              <p>
                {p.configured ? <span className="badge badge-ok">API key present</span> : <span className="badge badge-warn">not configured</span>}
              </p>
              {!p.configured && <p className="muted">Set <code>{p.envVar}</code> in <code>.env</code> and restart the server.</p>}
              <label htmlFor={`m-${p.id}`}>Model</label>
              <select id={`m-${p.id}`} value={models[p.id] ?? p.defaultModel} onChange={(e) => setSelection(p.id, e.target.value)}>
                {p.models.map((m) => <option key={m}>{m}</option>)}
              </select>
              <button type="button" className="btn btn-secondary" disabled={!p.configured} onClick={() => runProviderTest(p.id, models[p.id] ?? p.defaultModel)}>
                Test {p.label}
              </button>
            </article>
          ))}
        </div>
        <div className="result-slot">
          {providerTest.status === "loading" && <Loading label="Checking provider…" />}
          {providerTest.status === "success" && <div className="alert alert-ok" role="status">Provider key and model accepted ({providerTest.data}). No tokens were generated.</div>}
          {providerTest.status === "error" && <ErrorBox error={providerTest.error} />}
        </div>
      </section>

      <section className="card" aria-labelledby="tools-h">
        <h2 id="tools-h">Approved tools</h2>
        <p className="muted">The complete allow-list shared by the MCP server, this UI and every AI provider. Nothing else can be called.</p>
        <ul className="tool-list">
          {status.tools.map((t) => (
            <li key={t.name}><code>{t.name}</code> <ReadOnlyBadge /> <span className="muted">{t.title}</span></li>
          ))}
        </ul>
      </section>
    </>
  );
}
