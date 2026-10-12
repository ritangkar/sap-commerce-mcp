// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/web/frontend/src/App";
import { DataTable } from "../../src/web/frontend/src/components/DataTable";
import type { AppStatus } from "../../src/web/frontend/src/api";

const TOOLS = ["flexible_search", "type_info", "config_get", "logs_tail", "cronjob"].map((name) => ({ name, title: name, description: name, readOnly: true as const, inputSchema: {} }));
const status = (over: Partial<AppStatus> = {}): AppStatus & { ok: true } => ({
  ok: true, readOnly: true,
  hac: { configured: true, problem: null, url: "http://localhost:9002/hac/", user: "admin", insecureTls: false, logConfigured: true },
  providers: [
    { id: "openai", label: "OpenAI", configured: false, envVar: "OPENAI_API_KEY", models: ["gpt-x"], defaultModel: "gpt-x" },
    { id: "anthropic", label: "Anthropic Claude", configured: true, envVar: "ANTHROPIC_API_KEY", models: ["claude-a", "claude-b"], defaultModel: "claude-a" },
    { id: "gemini", label: "Google Gemini", configured: false, envVar: "GEMINI_API_KEY", models: ["gem-1"], defaultModel: "gem-1" }
  ],
  defaultProvider: "anthropic", limits: { maxToolCalls: 8, maxSteps: 10, maxResultChars: 100000 }, tools: TOOLS, ...over
});

type Handler = (body: any, init: RequestInit) => { status?: number; json: unknown };
let routes: Record<string, Handler>;
let calls: Array<{ path: string; init: RequestInit; body: any }>;

beforeEach(() => {
  window.location.hash = "";
  document.head.innerHTML = '<meta name="local-api-token" content="tok-1">';
  routes = { "GET /api/status": () => ({ json: status() }) };
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, init, body });
    const key = `${init.method ?? "GET"} ${path.replace(/^\/api\/tools\/.*/, "/api/tools/*")}`;
    const handler = routes[key];
    if (!handler) return new Response(JSON.stringify({ ok: false, error: { code: "NOT_FOUND", message: `no mock for ${key}` } }), { status: 404 });
    const r = handler(body, init);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
  }));
  Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.localStorage.clear(); });

const open = async (hash: string) => { window.location.hash = hash; render(<App />); await screen.findByRole("navigation", { name: "Main" }); };

describe("shell", () => {
  it("renders navigation, read-only indicator and the local-development warning", async () => {
    await open("#/overview");
    const nav = screen.getByRole("navigation", { name: "Main" });
    for (const label of ["Overview", "FlexibleSearch", "Type system", "Configuration", "Console log", "CronJobs", "AI assistant"]) {
      expect(within(nav).getByRole("link", { name: label })).toBeInTheDocument();
    }
    expect(screen.getByText("READ-ONLY")).toBeInTheDocument();
    expect(screen.getAllByText(/Local development/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Anthropic Claude · claude-a/)).toBeInTheDocument();
    expect(screen.getByText(/configured \(test on Overview\)/)).toBeInTheDocument();
  });

  it("sends the local API token on every call", async () => {
    await open("#/overview");
    expect((calls[0]!.init.headers as Record<string, string>)["x-local-token"]).toBe("tok-1");
  });

  it("shows an error when the local server cannot be reached", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/Cannot reach the local server/);
  });

  it("navigates with the keyboard-accessible links", async () => {
    await open("#/overview");
    await userEvent.click(screen.getByRole("link", { name: "CronJobs" }));
    expect(await screen.findByRole("heading", { name: "CronJobs" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "CronJobs" })).toHaveAttribute("aria-current", "page");
  });

  it("offers no write, import, trigger or delete controls anywhere", async () => {
    routes["POST /api/tools/*"] = () => ({ json: { ok: true, data: { cronjobs: [], truncated: false }, truncated: false } });
    for (const hash of ["#/overview", "#/search", "#/types", "#/config", "#/logs", "#/cron", "#/assistant"]) {
      cleanup();
      await open(hash);
      const controls = [...screen.queryAllByRole("button"), ...screen.queryAllByRole("link")].map((el) => el.textContent ?? "");
      for (const text of controls) expect(text, `${hash}: ${text}`).not.toMatch(/\b(delete|remove|update|insert|import|upload|trigger|abort|stop job|start job|run job|execute script|groovy|reindex|clear cache|save changes)\b/i);
    }
  });
});

describe("overview", () => {
  it("explains missing HAC configuration and disables the connection test", async () => {
    routes["GET /api/status"] = () => ({ json: status({ hac: { configured: false, problem: "Missing or invalid HAC settings: HAC_USER, HAC_PASS.", url: null, user: null, insecureTls: false, logConfigured: false } }) });
    await open("#/overview");
    expect(screen.getByRole("alert")).toHaveTextContent(/HAC_USER/);
    expect(screen.getByRole("button", { name: "Test HAC connection" })).toBeDisabled();
  });

  it("does not claim connectivity until the test succeeds, then reports it", async () => {
    routes["POST /api/hac/test"] = () => ({ json: { ok: true, user: "admin", baseUrl: "x" } });
    await open("#/overview");
    expect(screen.queryByText(/Connected and authenticated/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Test HAC connection" }));
    expect(await screen.findByText(/Connected and authenticated as/)).toBeInTheDocument();
  });

  it("surfaces HAC connection errors", async () => {
    routes["POST /api/hac/test"] = () => ({ status: 502, json: { ok: false, error: { code: "HAC_UNREACHABLE", message: "Cannot reach HAC at localhost:9002 (ECONNREFUSED)." } } });
    await open("#/overview");
    await userEvent.click(screen.getByRole("button", { name: "Test HAC connection" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/HAC_UNREACHABLE/);
  });

  it("shows provider configuration state, never key material, and tests a provider", async () => {
    routes["POST /api/providers/anthropic/test"] = (b) => ({ json: { ok: true, model: b.model } });
    await open("#/overview");
    expect(screen.getByText("API key present")).toBeInTheDocument();
    expect(screen.getAllByText("not configured")).toHaveLength(2);
    expect(screen.getByRole("button", { name: /Test OpenAI/ })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: /Test Anthropic Claude/ }));
    expect(await screen.findByText(/Provider key and model accepted/)).toBeInTheDocument();
    expect(calls.at(-1)!.body).toEqual({ model: "claude-a" });
  });

  it("reports provider authentication failures", async () => {
    routes["POST /api/providers/anthropic/test"] = () => ({ status: 401, json: { ok: false, error: { code: "PROVIDER_AUTH", message: "Anthropic Claude rejected the API key (HTTP 401). Check the key in your environment." } } });
    await open("#/overview");
    await userEvent.click(screen.getByRole("button", { name: /Test Anthropic Claude/ }));
    expect(await screen.findByText(/rejected the API key/)).toBeInTheDocument();
  });

  it("does not persist anything secret in browser storage", async () => {
    await open("#/overview");
    await userEvent.selectOptions(screen.getByLabelText("Model", { selector: "#m-anthropic" }), "claude-b");
    const dump = JSON.stringify({ ...window.localStorage }) + JSON.stringify({ ...window.sessionStorage });
    expect(dump).toContain("claude-b");
    expect(dump).not.toMatch(/sk-|api[_-]?key|password|token/i);
  });
});

describe("FlexibleSearch", () => {
  it("runs a query and renders a sortable, filterable table", async () => {
    routes["POST /api/tools/*"] = (b) => ({ json: { ok: true, truncated: false, data: { columns: ["PK", "code"], rows: [{ PK: "2", code: "beta" }, { PK: "10", code: "alpha" }], rowCount: 2, truncated: false, _args: b } } });
    await open("#/search");
    expect(screen.getByText("Read-only query")).toBeInTheDocument();
    expect(screen.getByText(/Nothing has been run yet/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Run query" }));
    const table = await screen.findByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(calls.at(-1)!.path).toBe("/api/tools/flexible_search");
    expect(calls.at(-1)!.body.args).toMatchObject({ maxCount: 50, translate: false });
    await userEvent.click(within(table).getByRole("button", { name: /code/ }));
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent("alpha");
    await userEvent.type(screen.getByLabelText(/Filter/), "beta");
    expect(within(table).getAllByRole("row")).toHaveLength(2);
  });

  it("shows validator rejections and says the query was not sent", async () => {
    routes["POST /api/tools/*"] = () => ({ status: 400, json: { ok: false, error: { code: "QUERY_REJECTED", message: "Query rejected by the read-only validator: 'DELETE' is not allowed" } } });
    await open("#/search");
    await userEvent.clear(screen.getByLabelText("Query"));
    await userEvent.type(screen.getByLabelText("Query"), "DELETE FROM {{}Product}");
    await userEvent.click(screen.getByRole("button", { name: "Run query" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("QUERY_REJECTED");
    expect(alert).toHaveTextContent(/not sent to HAC/);
  });

  it("shows empty results and the loading state", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (path: string, init: RequestInit = {}) => {
      if (path === "/api/status") return new Response(JSON.stringify(status()));
      calls.push({ path, init, body: undefined });
      await gate;
      return new Response(JSON.stringify({ ok: true, truncated: false, data: { columns: ["PK"], rows: [], rowCount: 0, truncated: false } }));
    });
    await open("#/search");
    await userEvent.click(screen.getByRole("button", { name: "Run query" }));
    expect(screen.getByRole("status")).toHaveTextContent(/Running query/);
    release();
    expect(await screen.findByText("The query returned no rows.")).toBeInTheDocument();
  });

  it("translates to SQL", async () => {
    routes["POST /api/tools/*"] = () => ({ json: { ok: true, truncated: false, data: { sql: "SELECT t0.PK FROM products t0" } } });
    await open("#/search");
    await userEvent.click(screen.getByRole("button", { name: "Translate to SQL" }));
    expect(await screen.findByText("SELECT t0.PK FROM products t0")).toBeInTheDocument();
    expect(calls.at(-1)!.body.args.translate).toBe(true);
  });
});

describe("CronJobs", () => {
  it("lists jobs and re-reads one status (no trigger controls)", async () => {
    routes["POST /api/tools/*"] = (b) => b.args.action === "list"
      ? ({ json: { ok: true, truncated: false, data: { cronjobs: [{ code: "syncJob", status: "FINISHED", result: "SUCCESS", startTime: null, endTime: null }], truncated: false } } })
      : ({ json: { ok: true, truncated: false, data: { code: "syncJob", status: "RUNNING", result: "UNKNOWN", startTime: "t", endTime: null } } });
    await open("#/cron");
    await userEvent.click(screen.getByRole("button", { name: "Load CronJobs" }));
    await userEvent.click(await screen.findByText("syncJob"));
    expect(await screen.findByText("RUNNING")).toBeInTheDocument();
    expect(calls.at(-1)!.body.args).toEqual({ action: "status", code: "syncJob" });
  });
});

describe("Logs and configuration", () => {
  it("warns when no log file is configured", async () => {
    routes["GET /api/status"] = () => ({ json: status({ hac: { configured: true, problem: null, url: "u", user: "a", insecureTls: false, logConfigured: false } }) });
    await open("#/logs");
    expect(screen.getByText(/HAC_LOG_PATH/)).toBeInTheDocument();
  });
  it("renders masked configuration values distinctly", async () => {
    routes["POST /api/tools/*"] = () => ({ json: { ok: true, truncated: false, data: { total: 2, truncated: false, entries: [{ key: "db.password", value: "****" }, { key: "build.version", value: "6.7" }] } } });
    await open("#/config");
    await userEvent.click(screen.getByRole("button", { name: "Load properties" }));
    expect(await screen.findByText("****")).toHaveClass("masked");
  });
});

describe("AI assistant", () => {
  const chatOk = {
    ok: true, provider: "anthropic", model: "claude-a", stopReason: "completed", usage: { inputTokens: 10, outputTokens: 5 },
    answer: "There is one product: P-1.",
    toolCalls: [{ id: "t1", name: "flexible_search", args: { query: "SELECT {pk} FROM {Product}" }, ok: true, durationMs: 12, result: { columns: ["code"], rows: [{ code: "P-1" }], rowCount: 1, truncated: false } }]
  };

  it("is disabled with guidance when the selected provider has no key", async () => {
    routes["GET /api/status"] = () => ({ json: status({ defaultProvider: "openai" }) });
    await open("#/assistant");
    await userEvent.selectOptions(screen.getByLabelText("Provider"), "openai");
    expect(screen.getByText(/OPENAI_API_KEY/, { selector: "code" })).toBeInTheDocument();
    expect(screen.getByLabelText("Your question")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("separates fetched tool data from the AI-generated explanation", async () => {
    routes["POST /api/chat"] = () => ({ json: chatOk });
    await open("#/assistant");
    await userEvent.type(screen.getByLabelText("Your question"), "list products");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("There is one product: P-1.")).toBeInTheDocument();
    expect(screen.getByText("Fetched from SAP Commerce")).toBeInTheDocument();
    expect(screen.getByText("AI-generated explanation")).toBeInTheDocument();
    expect(screen.getByText("flexible_search", { selector: "summary code" })).toBeInTheDocument();
    expect(calls.at(-1)!.body).toEqual({ provider: "anthropic", model: "claude-a", messages: [{ role: "user", content: "list products" }] });
  });

  it("says plainly when no tool was called", async () => {
    routes["POST /api/chat"] = () => ({ json: { ...chatOk, toolCalls: [], answer: "Hello" } });
    await open("#/assistant");
    await userEvent.click(screen.getByRole("button", { name: /Which CronJobs failed recently/ }));
    expect(await screen.findByText(/No tool was called/)).toBeInTheDocument();
  });

  it("shows failed tool calls (e.g. a rejected query) as failures", async () => {
    routes["POST /api/chat"] = () => ({ json: { ...chatOk, answer: "I can't do that.", toolCalls: [{ id: "x", name: "flexible_search", args: { query: "DROP TABLE x" }, ok: false, durationMs: 1, error: { code: "QUERY_REJECTED", message: "rejected" } }] } });
    await open("#/assistant");
    await userEvent.type(screen.getByLabelText("Your question"), "drop it");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(/failed: QUERY_REJECTED/)).toBeInTheDocument();
  });

  it("shows provider errors without key material and keeps the conversation usable", async () => {
    routes["POST /api/chat"] = () => ({ status: 429, json: { ok: false, error: { code: "PROVIDER_QUOTA", message: "Anthropic Claude quota or billing limit reached (HTTP 429). API usage is billed separately from chat subscriptions." } } });
    await open("#/assistant");
    await userEvent.type(screen.getByLabelText("Your question"), "hi");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/PROVIDER_QUOTA/);
    expect(screen.getByLabelText("Your question")).toBeEnabled();
  });

  it("warns when the tool-call limit stopped the model", async () => {
    routes["POST /api/chat"] = () => ({ json: { ...chatOk, stopReason: "tool_limit" } });
    await open("#/assistant");
    await userEvent.click(screen.getByRole("button", { name: /Which CronJobs failed recently/ }));
    expect(await screen.findByText(/tool-call limit was reached/)).toBeInTheDocument();
  });

  it("reminds that results are sent to the provider and that API use may cost money", async () => {
    await open("#/assistant");
    expect(screen.getByText(/sent to the selected AI provider/)).toBeInTheDocument();
  });
});

describe("DataTable", () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ n: String(i + 1), name: `row-${i + 1}` }));
  const cols = [{ key: "n", label: "N" }, { key: "name", label: "Name" }];

  it("paginates, sorts numerically and copies CSV", async () => {
    render(<DataTable columns={cols} rows={rows} caption="Demo" pageSize={10} />);
    expect(screen.getAllByRole("row")).toHaveLength(11);
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Page 2 of 3")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "N" }));
    await userEvent.click(screen.getByRole("button", { name: "N" }));
    expect(screen.getAllByRole("row")[1]).toHaveTextContent("30");
    await userEvent.click(screen.getByRole("button", { name: "Copy CSV" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining("N,Name\n30,row-30"));
  });

  it("shows an empty state", () => {
    render(<DataTable columns={cols} rows={[]} caption="Empty" emptyTitle="Nothing here" />);
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
  });
});
