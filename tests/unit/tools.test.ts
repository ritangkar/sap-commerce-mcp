import { describe, expect, it } from "vitest";
import { validateReadOnlyFlexibleSearch } from "../../src/core/validation/flexsearch-validator.js";
import { APPROVED_TOOL_NAMES } from "../../src/core/tools/allowlist.js";
import { mockHac, table, tmpLog, toolsetWith } from "../fixtures/helpers.js";

const data = (r: Awaited<ReturnType<ReturnType<typeof toolsetWith>["execute"]>>) => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.data as Record<string, any>;
};

describe("tool registry", () => {
  it("exposes exactly the approved read-only tools", () => {
    const tools = toolsetWith(mockHac()).list();
    expect(tools.map((t) => t.name).sort()).toEqual([...APPROVED_TOOL_NAMES].sort());
    expect(tools.every((t) => t.readOnly)).toBe(true);
  });

  it("publishes JSON schemas without $schema", () => {
    for (const t of toolsetWith(mockHac()).list()) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.inputSchema).not.toHaveProperty("$schema");
    }
  });

  it.each(["groovy", "impex", "sql", "exec", "shell", "http_request", "cronjob_run", "cronjob_abort", "beans_info", "monitoring_info", "__proto__", "constructor", "toString", ""])(
    "rejects unknown tool %j",
    async (name) => {
      const r = await toolsetWith(mockHac()).execute(name, {});
      expect(r).toMatchObject({ ok: false, error: { code: "UNKNOWN_TOOL" } });
    }
  );

  it("rejects non-string tool names", async () => {
    expect(await toolsetWith(mockHac()).execute({ toString: 1 } as never, {})).toMatchObject({ ok: false, error: { code: "UNKNOWN_TOOL" } });
  });

  it("rejects unknown and badly typed arguments", async () => {
    const ts = toolsetWith(mockHac());
    expect(await ts.execute("flexible_search", { query: "SELECT {pk} FROM {Product}", commit: true })).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENTS" } });
    expect(await ts.execute("flexible_search", { query: 5 })).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENTS" } });
    expect(await ts.execute("flexible_search", { query: "SELECT {pk} FROM {Product}", maxCount: 201 })).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENTS" } });
    expect(await ts.execute("flexible_search", { query: "x".repeat(4001) })).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENTS" } });
    expect(await ts.execute("logs_tail", { lines: 2001 })).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENTS" } });
    expect(await ts.execute("cronjob", { action: "trigger", code: "x" })).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENTS" } });
    expect(await ts.execute("cronjob", { action: "abort", code: "x" })).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENTS" } });
    expect(await ts.execute("cronjob", { action: "status" })).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENTS" } });
    expect(await ts.execute("type_info", { type: "Product'; DROP" })).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENTS" } });
    expect(await ts.execute("cronjob", { action: "status", code: "a' OR '1'='1" })).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENTS" } });
  });
});

describe("flexible_search tool", () => {
  it("passes the query and row cap to HAC", async () => {
    const hac = mockHac();
    const r = await toolsetWith(hac).execute("flexible_search", { query: "SELECT {pk} FROM {Product}", maxCount: 5 });
    expect(data(r).rows).toEqual([{ PK: "1" }]);
    expect(hac.queries).toEqual(["SELECT {pk} FROM {Product}"]);
  });

  it("translates without executing", async () => {
    const hac = mockHac();
    const r = await toolsetWith(hac).execute("flexible_search", { query: "SELECT {pk} FROM {Product}", translate: true });
    expect(data(r)).toEqual({ sql: "SELECT 1" });
    expect(hac.queries).toHaveLength(0);
  });

  it("masks secret-looking columns and values", async () => {
    const hac = mockHac({ flexibleSearch: async () => table(["uid", "encodedPassword"], [["a@b.test", "$2a$10$abcdef"]]) });
    const r = data(await toolsetWith(hac).execute("flexible_search", { query: "SELECT {uid},{encodedPassword} FROM {User}" }));
    expect(r.rows[0]).toEqual({ uid: "a@b.test", encodedPassword: "****" });
    expect(r.maskedColumns).toEqual(["encodedPassword"]);
  });

  it("returns HAC errors as tool errors", async () => {
    const hac = mockHac({ flexibleSearch: async () => { throw new Error("boom"); } });
    expect(await toolsetWith(hac).execute("flexible_search", { query: "SELECT {pk} FROM {Product}" })).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
  });

  it("applies the result size limit and flags truncation", async () => {
    const rows = Array.from({ length: 200 }, (_, i) => [`row-${i}-${"x".repeat(100)}`]);
    const hac = mockHac({ flexibleSearch: async () => table(["c"], rows) });
    const r = await toolsetWith(hac, undefined, [], 5000).execute("flexible_search", { query: "SELECT {pk} FROM {Product}" });
    expect(r.ok && r.truncated).toBe(true);
    expect(JSON.stringify(data(r)).length).toBeLessThanOrEqual(5000);
  });
});

describe("type_info tool", () => {
  it("builds queries from read-only FlexibleSearch only and assembles the result", async () => {
    const hac = mockHac({
      flexibleSearch: async (q) => {
        hac.queries.push(q);
        if (q.includes("{c:abstract}")) return table(["c", "s", "a"], [["Product", "GenericItem", "false"]]);
        if (q.includes("FROM {AttributeDescriptor")) return table(["a", "b", "c", "d", "e", "f"], [["code", "java.lang.String", "false", "false", "true", "false"]]);
        if (q.includes("{s:code} = 'Product'")) return table(["code"], [["ApparelProduct"]]);
        if (q.includes("{s:code} = 'ApparelProduct'")) return table(["code"], [["ApparelStyleVariantProduct"]]);
        if (q.includes("{s:code}")) return table(["code"], []);
        return table(["c", "s", "a"], [["Product", "GenericItem", "false"]]);
      }
    });
    const r = data(await toolsetWith(hac).execute("type_info", { type: "Product" }));
    expect(r).toMatchObject({ code: "Product", superType: "GenericItem", abstract: false, subtypes: ["ApparelProduct", "ApparelStyleVariantProduct"] });
    expect(r.attributes[0]).toMatchObject({ qualifier: "code", type: "java.lang.String", unique: true, optional: false });
    expect(hac.queries.length).toBeGreaterThan(3);
    expect(hac.queries.every((q) => validateReadOnlyFlexibleSearch(q).ok)).toBe(true);
  });

  it("returns NOT_FOUND for an unknown type", async () => {
    const hac = mockHac({ flexibleSearch: async () => table(["c"], []) });
    expect(await toolsetWith(hac).execute("type_info", { type: "Nope" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });
});

describe("cronjob tool", () => {
  const hac = (rows: string[][]) => mockHac({ flexibleSearch: async (q) => { void q; return table(["c", "s", "r", "st", "et"], rows); } });

  it("lists cronjobs", async () => {
    const r = data(await toolsetWith(hac([["syncJob", "FINISHED", "SUCCESS", "2026-01-01", "2026-01-02"]])).execute("cronjob", {}));
    expect(r.cronjobs).toEqual([{ code: "syncJob", status: "FINISHED", result: "SUCCESS", startTime: "2026-01-01", endTime: "2026-01-02" }]);
  });

  it("reads one status and 404s unknown codes", async () => {
    expect(data(await toolsetWith(hac([["syncJob", "RUNNING", "UNKNOWN", "", ""]])).execute("cronjob", { action: "status", code: "syncJob" }))).toMatchObject({ code: "syncJob", status: "RUNNING" });
    expect(await toolsetWith(hac([])).execute("cronjob", { action: "status", code: "nope" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("only ever issues SELECT queries", async () => {
    const h = mockHac();
    await toolsetWith(h).execute("cronjob", {});
    await toolsetWith(h).execute("cronjob", { action: "status", code: "x" });
    expect(h.queries.length).toBe(2);
    expect(h.queries.every((q) => validateReadOnlyFlexibleSearch(q).ok)).toBe(true);
  });
});

describe("config_get tool", () => {
  const entries = [
    { key: "build.version", value: "6.7" },
    { key: "db.password", value: "hunter2" },
    { key: "media.secret.key", value: "abc" },
    { key: "db.url", value: "jdbc:mysql://u:pw@localhost/db" }
  ];
  const hac = mockHac({ getConfigEntries: async () => entries });

  it("reads one key and masks secrets", async () => {
    expect(data(await toolsetWith(hac).execute("config_get", { key: "build.version" }))).toEqual({ key: "build.version", value: "6.7" });
    expect(data(await toolsetWith(hac).execute("config_get", { key: "db.password" }))).toEqual({ key: "db.password", value: "****" });
  });
  it("filters and masks", async () => {
    const r = data(await toolsetWith(hac).execute("config_get", { filter: "DB." }));
    expect(r.entries).toEqual([{ key: "db.password", value: "****" }, { key: "db.url", value: "jdbc:mysql://u:****@localhost/db" }]);
  });
  it("404s unknown keys", async () => {
    expect(await toolsetWith(hac).execute("config_get", { key: "nope" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });
});

describe("logs_tail tool", () => {
  it("tails and filters with a plain-text (non-regex) filter and redacts", async () => {
    const file = tmpLog(["INFO start", "ERROR failed password=hunter2", "INFO a+b", "ERROR second"].join("\n"));
    const ts = toolsetWith(mockHac(), file);
    expect(data(await ts.execute("logs_tail", { lines: 2 })).lines).toEqual(["INFO a+b", "ERROR second"]);
    const errs = data(await ts.execute("logs_tail", { grep: "error" }));
    expect(errs.lines).toEqual(["ERROR failed password=****", "ERROR second"]);
    expect(data(await ts.execute("logs_tail", { grep: "a+b" })).lines).toEqual(["INFO a+b"]);
    expect(data(await ts.execute("logs_tail", { grep: ".*" })).lines).toEqual([]);
  });
  it("fails clearly when no log is configured or the file is missing", async () => {
    expect(await toolsetWith(mockHac()).execute("logs_tail", {})).toMatchObject({ ok: false, error: { code: "LOG_UNAVAILABLE" } });
    expect(await toolsetWith(mockHac(), "/nonexistent/console.log").execute("logs_tail", {})).toMatchObject({ ok: false, error: { code: "LOG_UNAVAILABLE" } });
  });
});
