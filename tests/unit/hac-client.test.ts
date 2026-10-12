import { afterEach, describe, expect, it } from "vitest";
import { HacClient } from "../../src/commerce/hac-client.js";
import { ToolError } from "../../src/core/errors.js";
import { startFakeHac, type FakeHac } from "../fixtures/fake-hac.js";

let hac: FakeHac | undefined;
afterEach(async () => { await hac?.close(); hac = undefined; });

const client = (url: string, over: Partial<{ user: string; pass: string; timeoutMs: number }> = {}) =>
  new HacClient({ config: { baseUrl: new URL(`${url}/`), user: "admin", pass: "nimda", timeoutMs: 5000, insecureTls: false, ...over } });

describe("HacClient", () => {
  it("logs in, sends the post-login CSRF token and parses a JSON result", async () => {
    hac = await startFakeHac({ flex: () => ({ headers: ["PK", "code"], resultList: [["1", "a"], ["2", "b"]], resultCount: 2 }) });
    const r = await client(hac.url).flexibleSearch("SELECT {pk},{code} FROM {Product}");
    expect(r).toEqual({ columns: ["PK", "code"], rows: [{ PK: "1", code: "a" }, { PK: "2", code: "b" }], rowCount: 2, truncated: false });
    expect(hac.logins).toBe(1);
  });

  it("reuses the session for subsequent calls", async () => {
    hac = await startFakeHac();
    const c = client(hac.url);
    await c.flexibleSearch("SELECT {pk} FROM {Product}");
    await c.flexibleSearch("SELECT {pk} FROM {Product}");
    expect(hac.logins).toBe(1);
  });

  it("logs in only once for concurrent first calls", async () => {
    hac = await startFakeHac();
    const c = client(hac.url);
    await Promise.all([1, 2, 3].map(() => c.flexibleSearch("SELECT {pk} FROM {Product}")));
    expect(hac.logins).toBe(1);
  });

  it("re-authenticates once when HAC answers 405 (stale CSRF)", async () => {
    hac = await startFakeHac({ staleCsrfOnce: true });
    await client(hac.url).flexibleSearch("SELECT {pk} FROM {Product}");
    expect(hac.logins).toBe(2);
  });

  it("reports bad credentials as HAC_AUTH without echoing the password", async () => {
    hac = await startFakeHac();
    const err = await client(hac.url, { pass: "wrong-pass-123" }).flexibleSearch("SELECT {pk} FROM {Product}").catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(err.code).toBe("HAC_AUTH");
    expect(err.message).not.toContain("wrong-pass-123");
  });

  it("maps HAC query exceptions to HAC_QUERY_ERROR", async () => {
    hac = await startFakeHac({ flex: () => ({ exception: { message: "Unknown type Foo" } }) });
    const err = await client(hac.url).flexibleSearch("SELECT {pk} FROM {Foo}").catch((e) => e);
    expect(err.code).toBe("HAC_QUERY_ERROR");
    expect(err.message).toContain("Unknown type Foo");
  });

  it("never sends a rejected query to HAC", async () => {
    hac = await startFakeHac();
    const c = client(hac.url);
    for (const q of ["DELETE FROM {Product}", "SELECT {pk} FROM {Product}; DROP TABLE x", "UPDATE {Product} SET {name}='x'"]) {
      await expect(c.flexibleSearch(q)).rejects.toMatchObject({ code: "QUERY_REJECTED" });
      await expect(c.translateFlexibleSearch(q)).rejects.toMatchObject({ code: "QUERY_REJECTED" });
    }
    expect(hac.requests).toHaveLength(0);
  });

  it("only talks to the allow-listed HAC endpoints", async () => {
    hac = await startFakeHac();
    const c = client(hac.url);
    await c.flexibleSearch("SELECT {pk} FROM {Product}");
    await c.translateFlexibleSearch("SELECT {pk} FROM {Product}");
    await c.getConfigEntries();
    const allowed = new Set([
      "GET /hac/login", "POST /hac/j_spring_security_check", "GET /hac/", "GET /hac/platform/config",
      "POST /hac/console/flexsearch/execute", "POST /hac/console/flexsearch/translate"
    ]);
    for (const r of hac.requests) expect(allowed.has(`${r.method} ${r.path}`), `${r.method} ${r.path}`).toBe(true);
    expect(hac.requests.some((r) => /scripting|impex|cronjob|monitoring/i.test(r.path))).toBe(false);
  });

  it("translates a query", async () => {
    hac = await startFakeHac();
    expect(await client(hac.url).translateFlexibleSearch("SELECT {pk} FROM {Product}")).toEqual({ sql: "SELECT t0.PK FROM products t0" });
  });

  it("reads configuration entries from the config page", async () => {
    hac = await startFakeHac();
    const entries = await client(hac.url).getConfigEntries();
    expect(entries).toContainEqual({ key: "build.version", value: "6.7.0.1" });
    expect(entries).toContainEqual({ key: "db.password", value: "hunter2-db" });
  });

  it("times out", async () => {
    hac = await startFakeHac({ delayMs: 400 });
    await expect(client(hac.url, { timeoutMs: 100 }).flexibleSearch("SELECT {pk} FROM {Product}")).rejects.toMatchObject({ code: "HAC_TIMEOUT" });
  });

  it("reports an unreachable HAC", async () => {
    const c = client("http://127.0.0.1:1/hac");
    await expect(c.flexibleSearch("SELECT {pk} FROM {Product}")).rejects.toMatchObject({ code: "HAC_UNREACHABLE" });
  });

  it("checkConnection runs a trivial read-only query", async () => {
    hac = await startFakeHac();
    expect(await client(hac.url).checkConnection()).toMatchObject({ ok: true, user: "admin" });
    expect(hac.queries).toEqual(["SELECT {pk} FROM {Language}"]);
  });
});
