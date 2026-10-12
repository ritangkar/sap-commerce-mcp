import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdapterMap } from "../../src/ai/providers/index.js";
import type { GenerateRequest, ProviderAdapter } from "../../src/ai/types.js";
import { ProviderError } from "../../src/ai/types.js";
import { loadConfig } from "../../src/config/env.js";
import { createCommerceRuntime } from "../../src/core/create-context.js";
import { createWebServer } from "../../src/web/backend/server.js";
import { startFakeHac, type FakeHac } from "../fixtures/fake-hac.js";

const TOKEN = "test-token-123";
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closers.splice(0).map((c) => c())); });

function fakeAdapter(id: "openai" | "anthropic" | "gemini", behaviour: (req: GenerateRequest, n: number) => Awaited<ReturnType<ProviderAdapter["generate"]>>, configured = true): ProviderAdapter & { calls: GenerateRequest[] } {
  const calls: GenerateRequest[] = [];
  return {
    id, label: id, calls,
    isConfigured: () => configured,
    testConnection: async (model) => { if (model === "bad-model") throw new ProviderError("model", "model not found"); },
    generate: async (req) => { calls.push(req); return behaviour(req, calls.length); }
  };
}

async function boot(opts: { adapters?: Partial<AdapterMap>; hac?: boolean; env?: Record<string, string> } = {}) {
  const hac: FakeHac | undefined = opts.hac === false ? undefined : await startFakeHac({ flex: () => ({ headers: ["PK"], resultList: [["42"]], resultCount: 1 }) });
  const config = loadConfig({ ...(hac ? { HAC_URL: hac.url, HAC_USER: "admin", HAC_PASS: "nimda" } : {}), OPENAI_API_KEY: "sk-openai-secret-value", ...opts.env });
  const runtime = createCommerceRuntime(config);
  const none = fakeAdapter("openai", () => ({ text: "x", toolCalls: [], stopReason: "end" }), false);
  const adapters = { openai: none, anthropic: { ...none, id: "anthropic" }, gemini: { ...none, id: "gemini" }, ...opts.adapters } as AdapterMap;
  const server = createWebServer({ config, runtime, adapters, token: TOKEN, staticDir: resolve("tests/fixtures/static") });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  closers.push(() => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }), async () => { await hac?.close(); });
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string; json: any }>((resolveCall, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = request({ host: "127.0.0.1", port, method, path, headers: { host: `localhost:${port}`, "x-local-token": TOKEN, ...(payload ? { "content-type": "application/json" } : {}), ...headers } }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => { let json: unknown; try { json = JSON.parse(text); } catch { /* html */ } resolveCall({ status: res.statusCode ?? 0, headers: res.headers, text, json }); });
      });
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  return { call, port, hac, runtime, config };
}

describe("web backend: local protections", () => {
  it("serves the frontend with the per-process token injected and security headers", async () => {
    const { call } = await boot();
    const r = await call("GET", "/", undefined, { "x-local-token": "" });
    expect(r.status).toBe(200);
    expect(r.text).toContain(`content="${TOKEN}"`);
    expect(r.headers["content-security-policy"]).toMatch(/default-src 'self'/);
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect((await call("GET", "/assets/app.js")).status).toBe(200);
    expect((await call("GET", "/some/spa/route")).text).toContain(TOKEN);
  });

  it("blocks path traversal", async () => {
    const { call } = await boot();
    for (const p of ["/..%2f..%2fpackage.json", "/%2e%2e/%2e%2e/etc/passwd", "/assets/../../package.json"]) {
      const r = await call("GET", p);
      expect([403, 404, 200]).toContain(r.status);
      expect(r.text).not.toContain('"name": "sap-commerce-mcp"');
    }
  });

  it("requires the token for every API route", async () => {
    const { call } = await boot();
    expect((await call("GET", "/api/status", undefined, { "x-local-token": "wrong" })).status).toBe(401);
    expect((await call("POST", "/api/tools/cronjob", { args: {} }, { "x-local-token": "" })).status).toBe(401);
  });

  it("rejects foreign Host headers (DNS rebinding) and foreign origins", async () => {
    const { call } = await boot();
    expect((await call("GET", "/api/status", undefined, { host: "evil.example.com" })).status).toBe(403);
    expect((await call("GET", "/api/status", undefined, { host: "localhost:1" })).status).toBe(403);
    const o = await call("POST", "/api/tools/cronjob", { args: {} }, { origin: "https://evil.example.com" });
    expect(o.status).toBe(403);
    expect(o.json.error.code).toBe("BAD_ORIGIN");
    expect((await call("GET", "/api/status", undefined, { "sec-fetch-site": "cross-site" })).status).toBe(403);
  });

  it("requires JSON content type and caps body size", async () => {
    const { call } = await boot();
    expect((await call("POST", "/api/tools/cronjob", undefined, { "content-type": "text/plain" })).status).toBe(415);
    const big = await call("POST", "/api/tools/flexible_search", { args: { query: "x".repeat(300 * 1024) } });
    expect(big.status).toBe(413);
  });

  it("does not offer any non-GET route outside /api", async () => {
    const { call } = await boot();
    expect((await call("POST", "/")).status).toBe(405);
    expect((await call("DELETE", "/api/status")).status).toBe(404);
  });
});

describe("web backend: status never exposes secrets", () => {
  it("reports configuration without key material or passwords", async () => {
    const { call } = await boot();
    const r = await call("GET", "/api/status");
    expect(r.status).toBe(200);
    expect(r.json.readOnly).toBe(true);
    expect(r.json.providers.find((p: any) => p.id === "anthropic")).toMatchObject({ configured: false, envVar: "ANTHROPIC_API_KEY" });
    expect(r.text).not.toContain("sk-openai-secret-value");
    expect(r.text).not.toContain("nimda");
    expect(r.json.tools.map((t: any) => t.name).sort()).toEqual(["config_get", "cronjob", "flexible_search", "logs_tail", "type_info"]);
  });

  it("starts without HAC configuration and reports it", async () => {
    const { call } = await boot({ hac: false });
    const s = await call("GET", "/api/status");
    expect(s.json.hac.configured).toBe(false);
    const t = await call("POST", "/api/tools/flexible_search", { args: { query: "SELECT {pk} FROM {Product}" } });
    expect(t.status).toBe(503);
    expect(t.json.error.code).toBe("CONFIG_MISSING");
    expect((await call("POST", "/api/hac/test", {})).status).toBe(503);
  });
});

describe("web backend: tools run through the shared core", () => {
  it("executes a read-only query against HAC", async () => {
    const { call, hac } = await boot();
    const r = await call("POST", "/api/tools/flexible_search", { args: { query: "SELECT {pk} FROM {Product}" } });
    expect(r.status).toBe(200);
    expect(r.json.data.rows).toEqual([{ PK: "42" }]);
    expect(hac!.queries).toEqual(["SELECT {pk} FROM {Product}"]);
  });

  it.each([
    ["flexible_search", { query: "DELETE FROM {Product}" }, 400, "QUERY_REJECTED"],
    ["flexible_search", { query: "SELECT {pk} FROM {Product}; DROP TABLE x" }, 400, "QUERY_REJECTED"],
    ["flexible_search", { query: "UPDATE {Product} SET {name}='x'" }, 400, "QUERY_REJECTED"],
    ["flexible_search", { query: "SELECT {pk} FROM {Product}", maxCount: 5000 }, 400, "INVALID_ARGUMENTS"],
    ["cronjob", { action: "start", code: "x" }, 400, "INVALID_ARGUMENTS"],
    ["cronjob", { action: "abort", code: "x" }, 400, "INVALID_ARGUMENTS"],
    ["groovy", { script: "1" }, 404, "UNKNOWN_TOOL"],
    ["impex_import", {}, 404, "UNKNOWN_TOOL"],
    ["__proto__", {}, 404, "UNKNOWN_TOOL"]
  ])("rejects %s %j", async (name, args, status, code) => {
    const { call, hac } = await boot();
    const r = await call("POST", `/api/tools/${name}`, { args });
    expect(r.status).toBe(status);
    expect(r.json.error.code).toBe(code);
    expect(hac!.queries).toHaveLength(0);
  });

  it("tests the HAC connection with a read-only query", async () => {
    const { call, hac } = await boot();
    const r = await call("POST", "/api/hac/test", {});
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, user: "admin" });
    expect(hac!.queries).toEqual(["SELECT {pk} FROM {Language}"]);
  });
});

describe("web backend: providers and chat", () => {
  it("tests provider connectivity, unconfigured providers and unknown models", async () => {
    const openai = fakeAdapter("openai", () => ({ text: "", toolCalls: [], stopReason: "end" }));
    const { call, config } = await boot({ adapters: { openai } });
    const model = config.ai.providers.openai.defaultModel;
    expect((await call("POST", "/api/providers/openai/test", { model })).json).toMatchObject({ ok: true });
    const missing = await call("POST", "/api/providers/anthropic/test", { model: config.ai.providers.anthropic.defaultModel });
    expect(missing.status).toBe(400);
    expect(missing.json.error.code).toBe("PROVIDER_NOT_CONFIGURED");
    expect((await call("POST", "/api/providers/openai/test", { model: "not-listed" })).json.error.code).toBe("UNKNOWN_MODEL");
    expect((await call("POST", "/api/providers/nope/test", { model })).status).toBe(404);
  });

  it("runs a real tool-calling loop and returns tool activity", async () => {
    const adapter = fakeAdapter("anthropic", (_req, n) =>
      n === 1
        ? { text: "", toolCalls: [{ id: "t1", name: "flexible_search", args: { query: "SELECT {pk} FROM {Product}" } }], stopReason: "tool_use" }
        : { text: "Found product 42.", toolCalls: [], stopReason: "end" }
    );
    const { call, hac, config } = await boot({ adapters: { anthropic: adapter } });
    const r = await call("POST", "/api/chat", { provider: "anthropic", model: config.ai.providers.anthropic.defaultModel, messages: [{ role: "user", content: "list products" }] });
    expect(r.status).toBe(200);
    expect(r.json.answer).toBe("Found product 42.");
    expect(r.json.toolCalls[0]).toMatchObject({ name: "flexible_search", ok: true, result: { rows: [{ PK: "42" }] } });
    expect(hac!.queries).toEqual(["SELECT {pk} FROM {Product}"]);
  });

  it("returns model-requested writes as failed tool activity without touching HAC", async () => {
    const adapter = fakeAdapter("gemini", (_req, n) =>
      n === 1 ? { text: "", toolCalls: [{ id: "1", name: "flexible_search", args: { query: "DROP TABLE x" } }, { id: "2", name: "run_cronjob", args: {} }], stopReason: "tool_use" } : { text: "Refused.", toolCalls: [], stopReason: "end" }
    );
    const { call, hac, config } = await boot({ adapters: { gemini: adapter } });
    const r = await call("POST", "/api/chat", { provider: "gemini", model: config.ai.providers.gemini.defaultModel, messages: [{ role: "user", content: "drop it" }] });
    expect(r.json.toolCalls.map((t: any) => t.error.code)).toEqual(["QUERY_REJECTED", "UNKNOWN_TOOL"]);
    expect(hac!.queries).toHaveLength(0);
  });

  it("validates chat input and model ids", async () => {
    const adapter = fakeAdapter("openai", () => ({ text: "x", toolCalls: [], stopReason: "end" }));
    const { call, config } = await boot({ adapters: { openai: adapter } });
    const model = config.ai.providers.openai.defaultModel;
    expect((await call("POST", "/api/chat", { provider: "openai", model, messages: [] })).status).toBe(400);
    expect((await call("POST", "/api/chat", { provider: "openai", model, messages: [{ role: "assistant", content: "x" }] })).status).toBe(400);
    expect((await call("POST", "/api/chat", { provider: "openai", model: "../../x", messages: [{ role: "user", content: "x" }] })).json.error.code).toBe("UNKNOWN_MODEL");
    expect((await call("POST", "/api/chat", { provider: "evil", model, messages: [{ role: "user", content: "x" }] })).status).toBe(400);
    expect((await call("POST", "/api/chat", { provider: "openai", model, messages: [{ role: "system", content: "x" }] })).status).toBe(400);
    expect(adapter.calls).toHaveLength(0);
  });

  it("maps provider failures to clear errors without leaking the key", async () => {
    const adapter = fakeAdapter("openai", () => { throw new ProviderError("auth", "OpenAI rejected the API key (HTTP 401). Check the key in your environment."); });
    const { call, config } = await boot({ adapters: { openai: adapter } });
    const r = await call("POST", "/api/chat", { provider: "openai", model: config.ai.providers.openai.defaultModel, messages: [{ role: "user", content: "x" }] });
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe("PROVIDER_AUTH");
    expect(r.text).not.toContain("sk-openai-secret-value");
    const q = fakeAdapter("openai", () => { throw new ProviderError("quota", "quota"); });
    const b = await boot({ adapters: { openai: q } });
    expect((await b.call("POST", "/api/chat", { provider: "openai", model: b.config.ai.providers.openai.defaultModel, messages: [{ role: "user", content: "x" }] })).status).toBe(429);
  });

  it("redacts secrets that a model echoes in its answer", async () => {
    const adapter = fakeAdapter("openai", () => ({ text: "the key is sk-openai-secret-value and the HAC password is nimda", toolCalls: [], stopReason: "end" }));
    const { call, config } = await boot({ adapters: { openai: adapter } });
    const r = await call("POST", "/api/chat", { provider: "openai", model: config.ai.providers.openai.defaultModel, messages: [{ role: "user", content: "x" }] });
    expect(r.json.answer).not.toContain("sk-openai-secret-value");
    expect(r.json.answer).not.toContain("nimda");
  });
});
