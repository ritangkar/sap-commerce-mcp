import { useCallback, useEffect, useState } from "react";
import { api, type AppStatus } from "./api";
import { ErrorBox, Loading } from "./components/common";
import { useStored } from "./hooks";
import { Assistant } from "./views/Assistant";
import { Config } from "./views/Config";
import { Cron } from "./views/Cron";
import { Logs } from "./views/Logs";
import { Overview } from "./views/Overview";
import { Search } from "./views/Search";
import { Types } from "./views/Types";

const ROUTES = [
  { id: "overview", label: "Overview" },
  { id: "search", label: "FlexibleSearch" },
  { id: "types", label: "Type system" },
  { id: "config", label: "Configuration" },
  { id: "logs", label: "Console log" },
  { id: "cron", label: "CronJobs" },
  { id: "assistant", label: "AI assistant" }
] as const;
type RouteId = (typeof ROUTES)[number]["id"];

function currentRoute(): RouteId {
  const id = window.location.hash.replace(/^#\/?/, "");
  return (ROUTES.find((r) => r.id === id)?.id ?? "overview") as RouteId;
}

export function App() {
  const [route, setRoute] = useState<RouteId>(currentRoute);
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [provider, setProvider] = useStored("workbench.provider", "");
  const [modelByProvider, setModelByProvider] = useStored("workbench.models", "{}");

  const load = useCallback(() => {
    api.status().then(setStatus).catch((e) => setError({ code: e.code ?? "ERROR", message: e.message }));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    const onHash = () => setRoute(currentRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => { document.title = `${ROUTES.find((r) => r.id === route)?.label ?? ""} · Commerce Workbench`; }, [route]);

  if (error) return <main className="boot"><ErrorBox error={error} hint="Reload the page. If this persists, restart the local server." /></main>;
  if (!status) return <main className="boot"><Loading label="Connecting to the local server…" /></main>;

  const models: Record<string, string> = (() => { try { return JSON.parse(modelByProvider) as Record<string, string>; } catch { return {}; } })();
  const activeProvider = status.providers.find((p) => p.id === provider) ?? status.providers.find((p) => p.id === status.defaultProvider) ?? status.providers[0]!;
  const activeModel = activeProvider.models.includes(models[activeProvider.id] ?? "") ? (models[activeProvider.id] as string) : activeProvider.defaultModel;
  const select = (p: string, m: string) => { setProvider(p); setModelByProvider(JSON.stringify({ ...models, [p]: m })); };

  return (
    <div className="shell">
      <a className="skip" href="#main">Skip to content</a>
      <aside className="sidebar">
        <div className="brand"><span className="logo" aria-hidden="true" />Commerce Workbench</div>
        <nav aria-label="Main">
          <ul>
            {ROUTES.map((r) => (
              <li key={r.id}><a href={`#/${r.id}`} aria-current={route === r.id ? "page" : undefined}>{r.label}</a></li>
            ))}
          </ul>
        </nav>
        <div className="side-foot">
          <p><strong>Local development only.</strong> Strictly read-only. Not for production administration.</p>
        </div>
      </aside>
      <div className="main-col">
        <div className="topbar">
          <span className="badge badge-ro">READ-ONLY</span>
          <span className={`pill ${status.hac.configured ? "" : "pill-warn"}`} title={status.hac.problem ?? status.hac.url ?? ""}>
            HAC: {status.hac.configured ? "configured (test on Overview)" : "not configured"}
          </span>
          <span className={`pill ${activeProvider.configured ? "" : "pill-warn"}`}>
            AI: {activeProvider.label} · {activeModel}{activeProvider.configured ? "" : " (no key)"}
          </span>
        </div>
        <main id="main" tabIndex={-1}>
          {route === "overview" && <Overview status={status} models={models} setSelection={select} />}
          {route === "search" && <Search />}
          {route === "types" && <Types />}
          {route === "config" && <Config />}
          {route === "logs" && <Logs configured={status.hac.logConfigured} />}
          {route === "cron" && <Cron />}
          {route === "assistant" && <Assistant status={status} provider={activeProvider.id} model={activeModel} onChange={select} />}
        </main>
      </div>
    </div>
  );
}
