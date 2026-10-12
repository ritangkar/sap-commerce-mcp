import { useRef, useState } from "react";
import { api, errorText, type AppStatus, type ChatResponse, type ToolActivity } from "../api";
import { DataTable } from "../components/DataTable";
import { CopyButton, ErrorBox, Loading, Note, PageHeader, ReadOnlyBadge, SourceLabel } from "../components/common";

type Entry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; response: ChatResponse }
  | { kind: "error"; error: { code: string; message: string } };

const SUGGESTIONS = [
  "Which CronJobs failed recently?",
  "What attributes does Product have, and which are localized?",
  "Show the 10 most recently modified products.",
  "Show recent ERROR lines from the console log."
];

const STOP_NOTES: Record<ChatResponse["stopReason"], string | null> = {
  completed: null,
  tool_limit: "The tool-call limit was reached; the answer may be incomplete.",
  step_limit: "The step limit was reached; the answer may be incomplete.",
  max_tokens: "The model hit its output limit; the answer may be cut off."
};

export function Assistant({ status, provider, model, onChange }: { status: AppStatus; provider: string; model: string; onChange: (p: string, m: string) => void }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const current = status.providers.find((p) => p.id === provider);
  const ready = !!current?.configured && status.hac.configured;

  const send = async (text: string) => {
    const content = text.trim();
    if (!content || busy || !current) return;
    const history = [...entries, { kind: "user", text: content } as Entry];
    setEntries(history);
    setInput("");
    setBusy(true);
    try {
      const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
      for (const e of history) {
        if (e.kind === "user") messages.push({ role: "user", content: e.text });
        else if (e.kind === "assistant") messages.push({ role: "assistant", content: e.response.answer });
      }
      const response = await api.chat({ provider: current.id, model, messages });
      setEntries([...history, { kind: "assistant", response }]);
    } catch (e) {
      setEntries([...history, { kind: "error", error: errorText(e) }]);
    } finally {
      setBusy(false);
      window.setTimeout(() => endRef.current?.scrollIntoView?.({ behavior: "smooth" }), 50);
    }
  };

  return (
    <>
      <PageHeader title="AI assistant" subtitle="Ask in natural language. The model can only use the approved read-only tools." actions={<ReadOnlyBadge label="Read-only tools" />} />
      <div className="card row assistant-config">
        <div className="field">
          <label htmlFor="as-provider">Provider</label>
          <select id="as-provider" value={provider} onChange={(e) => { const p = status.providers.find((x) => x.id === e.target.value); if (p) onChange(p.id, p.defaultModel); }}>
            {status.providers.map((p) => <option key={p.id} value={p.id}>{p.label}{p.configured ? "" : " (not configured)"}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="as-model">Model</label>
          <select id="as-model" value={model} onChange={(e) => onChange(provider, e.target.value)}>
            {(current?.models ?? []).map((m) => <option key={m}>{m}</option>)}
          </select>
        </div>
        <span className="spacer" />
        <button type="button" className="btn btn-ghost" onClick={() => setEntries([])} disabled={entries.length === 0 || busy}>Clear conversation</button>
      </div>

      {!current?.configured && (
        <Note kind="warn">{current?.label ?? "This provider"} is not configured. Set <code>{current?.envVar}</code> in <code>.env</code> and restart the server, or pick another provider. Direct API use may incur charges separate from a chat subscription.</Note>
      )}
      {!status.hac.configured && <Note kind="warn">HAC is not configured, so tool calls will fail. See the Overview page.</Note>}
      <Note>Tool results are sent to the selected AI provider to produce an answer. Do not use this with data you are not allowed to share with that provider.</Note>

      <section className="chat" aria-label="Conversation" aria-live="polite">
        {entries.length === 0 && (
          <div className="empty">
            <p className="empty-title">Ask about your local instance</p>
            <div className="suggestions">{SUGGESTIONS.map((s) => <button key={s} type="button" className="chip" disabled={!ready || busy} onClick={() => void send(s)}>{s}</button>)}</div>
          </div>
        )}
        {entries.map((e, i) =>
          e.kind === "user" ? (
            <div key={i} className="msg msg-user"><div className="msg-label">You</div><p>{e.text}</p></div>
          ) : e.kind === "error" ? (
            <ErrorBox key={i} error={e.error} />
          ) : (
            <AssistantMessage key={i} response={e.response} />
          )
        )}
        {busy && <Loading label="The model is working and may call tools…" />}
        <div ref={endRef} />
      </section>

      <form className="composer" onSubmit={(e) => { e.preventDefault(); void send(input); }}>
        <label htmlFor="as-input" className="sr-only">Your question</label>
        <textarea id="as-input" rows={2} value={input} placeholder={ready ? "Ask a question…" : "Configure HAC and a provider to start"} disabled={!ready || busy} onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(input); } }} />
        <button className="btn" type="submit" disabled={!ready || busy || !input.trim()}>Send</button>
      </form>
    </>
  );
}

function AssistantMessage({ response }: { response: ChatResponse }) {
  const note = STOP_NOTES[response.stopReason];
  return (
    <div className="msg msg-assistant">
      {response.toolCalls.length > 0 ? (
        <div className="activity">
          <div className="msg-label"><SourceLabel kind="fetched" /> {response.toolCalls.length} tool call{response.toolCalls.length === 1 ? "" : "s"}</div>
          {response.toolCalls.map((t) => <ToolCard key={t.id} activity={t} />)}
        </div>
      ) : (
        <p className="muted small">No tool was called. This answer is not based on data from your instance.</p>
      )}
      <div className="generated">
        <div className="msg-label"><SourceLabel kind="generated" /> <span className="muted">{response.provider} · {response.model}</span></div>
        <div className="answer">{response.answer}</div>
        {note && <Note kind="warn">{note}</Note>}
        <div className="msg-foot"><CopyButton text={response.answer} label="Copy answer" /><span className="muted small">{response.usage.inputTokens + response.usage.outputTokens} tokens</span></div>
      </div>
    </div>
  );
}

function ToolCard({ activity }: { activity: ToolActivity }) {
  const result = activity.result as { rows?: Array<Record<string, string>>; columns?: string[] } | undefined;
  return (
    <details className={`tool-card ${activity.ok ? "" : "tool-failed"}`}>
      <summary>
        <code>{activity.name}</code> {activity.ok ? <span className="badge badge-ok">succeeded</span> : <span className="badge badge-err">failed: {activity.error?.code}</span>}
        <span className="muted small"> {activity.durationMs} ms{activity.truncated ? " · truncated" : ""}{activity.clippedForModel ? " · clipped for the model" : ""}</span>
      </summary>
      <h4>Arguments (as requested by the model)</h4>
      <pre className="code-block">{JSON.stringify(activity.args, null, 2)}</pre>
      {activity.ok && result?.rows && result.columns ? (
        <DataTable caption={`${activity.name} result`} columns={result.columns.map((c) => ({ key: c, label: c }))} rows={result.rows} pageSize={10} />
      ) : activity.ok ? (
        <><h4>Result</h4><pre className="code-block">{JSON.stringify(activity.result, null, 2)}</pre></>
      ) : (
        <ErrorBox error={activity.error ?? { code: "ERROR", message: "Tool failed" }} />
      )}
    </details>
  );
}
