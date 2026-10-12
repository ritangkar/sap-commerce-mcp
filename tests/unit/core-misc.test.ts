import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isPrivateHost } from "../../src/commerce/host-guard.js";
import { LogReader } from "../../src/commerce/log-reader.js";
import { extractCsrf, parseConfigPage, parseFlexibleSearchResponse } from "../../src/commerce/html-parse.js";
import { loadConfig } from "../../src/config/env.js";
import { limitResultSize } from "../../src/core/results/limits.js";
import { createRedactor, redactText } from "../../src/core/security/redact.js";

describe("host guard", () => {
  it.each(["localhost", "127.0.0.1", "127.5.5.5", "[::1]", "10.1.2.3", "172.16.0.1", "172.31.255.1", "192.168.1.10", "hac.local", "dev.localhost"])("allows %s", (h) => expect(isPrivateHost(h)).toBe(true));
  it.each(["example.com", "172.32.0.1", "172.15.0.1", "192.169.0.1", "8.8.8.8", "10.evil.com", "localhost.example.com", "300.1.1.1"])("rejects %s", (h) => expect(isPrivateHost(h)).toBe(false));
});

describe("redaction", () => {
  it("masks key=value, bearer tokens, URL credentials, JWTs and vendor keys", () => {
    expect(redactText("password=hunter2 user=bob")).toBe("password=**** user=bob");
    expect(redactText('{"api_key": "abc123"}')).toBe('{"api_key": ****}');
    expect(redactText("Authorization: Bearer abcdef0123456789")).toContain("Bearer ****");
    expect(redactText("jdbc:mysql://root:secret@localhost/x")).toBe("jdbc:mysql://root:****@localhost/x");
    expect(redactText("tok eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk")).toBe("tok ****");
    expect(redactText("sk-ant-api03-abcdefghijklmnopqrstuvwxyz")).toBe("****");
    expect(redactText("AIzaSyA1234567890abcdefghijklmnopqrstuv")).toBe("****");
  });
  it("removes exact known secrets anywhere", () => {
    const r = createRedactor(["s3cr3t-value", undefined, "ab"]);
    expect(r("x s3cr3t-value y ab")).toBe("x **** y ab");
  });
  it("leaves harmless text alone", () => {
    expect(redactText("INFO Started Tomcat on port 9002")).toBe("INFO Started Tomcat on port 9002");
  });
});

describe("result limiting", () => {
  it("keeps small results intact", () => {
    expect(limitResultSize({ rows: [1, 2] }, 1000)).toEqual({ data: { rows: [1, 2] }, truncated: false });
  });
  it("shrinks known arrays", () => {
    const r = limitResultSize({ rows: Array.from({ length: 100 }, (_, i) => ({ i, pad: "x".repeat(50) })) }, 600);
    expect(r.truncated).toBe(true);
    expect(JSON.stringify(r.data).length).toBeLessThanOrEqual(600);
    expect((r.data as any).truncated).toBe(true);
  });
  it("drops unshrinkable oversize values", () => {
    expect(limitResultSize({ blob: "x".repeat(5000) }, 100).truncated).toBe(true);
  });
});

describe("html parsing", () => {
  it("extracts csrf from input and meta", () => {
    expect(extractCsrf('<input type="hidden" name="_csrf" value="abc-123"/>')).toBe("abc-123");
    expect(extractCsrf('<meta name="_csrf" content="m-1">')).toBe("m-1");
  });
  it("parses HAC JSON with duplicate column names", () => {
    const r = parseFlexibleSearchResponse(JSON.stringify({ headers: ["code", "code"], resultList: [["a", "b"]], resultCount: 1 }), 10);
    expect(r.result?.rows).toEqual([{ code: "a", code_2: "b" }]);
  });
  it("marks truncation using the reported count and the cap", () => {
    expect(parseFlexibleSearchResponse(JSON.stringify({ headers: ["a"], resultList: [["1"], ["2"]], resultCount: 9 }), 10).result?.truncated).toBe(true);
    expect(parseFlexibleSearchResponse(JSON.stringify({ headers: ["a"], resultList: [["1"], ["2"]] }), 1).result?.truncated).toBe(true);
  });
  it("falls back to HTML tables (reference behaviour)", () => {
    const r = parseFlexibleSearchResponse("<table><thead><tr><th>PK</th><th>Code</th></tr></thead><tbody><tr><td>8796</td><td>Product</td></tr></tbody></table>", 10);
    expect(r.result).toEqual({ columns: ["PK", "Code"], rows: [{ PK: "8796", Code: "Product" }], rowCount: 1, truncated: false });
    const t = parseFlexibleSearchResponse("<table><tr><th>count</th></tr><tr><td>1</td></tr><tr><td>2</td></tr></table>", 1);
    expect(t.result?.rows).toEqual([{ count: "1" }]);
    expect(t.result?.truncated).toBe(true);
  });
  it("surfaces exceptions", () => {
    expect(parseFlexibleSearchResponse(JSON.stringify({ exception: "bad query" }), 5).error).toBe("bad query");
  });
  it("parses config tables incl. input values", () => {
    expect(parseConfigPage('<tr><td>a.b</td><td><input value="1"/></td></tr><tr><td>c</td><td>two</td></tr><tr><td>has space</td><td>x</td></tr>')).toEqual([
      { key: "a.b", value: "1" }, { key: "c", value: "two" }
    ]);
  });
});

describe("log reader", () => {
  it("reads only the tail of large files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scm-"));
    const file = join(dir, "big.log");
    writeFileSync(file, `${"old line\n".repeat(700000)}the-last-line\n`);
    const r = await new LogReader(file).tail({ lines: 2 });
    expect(r.lines.at(-1)).toBe("the-last-line");
    expect(r.scannedBytes).toBeLessThan(r.fileBytes);
  });
  it("rejects directories", async () => {
    await expect(new LogReader(tmpdir()).tail({ lines: 1 })).rejects.toMatchObject({ code: "LOG_UNAVAILABLE" });
  });
});

describe("config loading", () => {
  const base = { HAC_USER: "admin", HAC_PASS: "nimda" };
  it("defaults to local HAC and reports missing credentials", () => {
    const ok = loadConfig({ ...base });
    expect(ok.hac?.baseUrl.href).toBe("https://localhost:9002/hac/");
    expect(ok.hac?.insecureTls).toBe(false);
    expect(loadConfig({}).hacProblem).toMatch(/HAC_USER/);
  });
  it("refuses non-private HAC hosts and URL-embedded credentials", () => {
    expect(loadConfig({ ...base, HAC_URL: "https://hac.example.com/hac" }).hacProblem).toMatch(/local\/private/);
    expect(loadConfig({ ...base, HAC_URL: "https://u:p@localhost/hac" }).hacProblem).toMatch(/embedded credentials/);
    expect(loadConfig({ ...base, HAC_URL: "ftp://localhost/hac" }).hacProblem).toMatch(/http/);
  });
  it("only enables insecure TLS when explicitly set to true", () => {
    expect(loadConfig({ ...base, HAC_INSECURE_TLS: "yes" }).hac?.insecureTls).toBe(false);
    expect(loadConfig({ ...base, HAC_INSECURE_TLS: "true" }).hac?.insecureTls).toBe(true);
  });
  it("rejects non-loopback web hosts and bad numbers", () => {
    expect(() => loadConfig({ ...base, WEB_HOST: "0.0.0.0" })).toThrow(/loopback/);
    expect(() => loadConfig({ ...base, WEB_PORT: "80" })).toThrow(/WEB_PORT/);
    expect(() => loadConfig({ ...base, HAC_TIMEOUT_MS: "abc" })).toThrow(/HAC_TIMEOUT_MS/);
  });
  it("collects provider config and secrets for redaction", () => {
    const c = loadConfig({ ...base, OPENAI_API_KEY: "sk-test-1", ANTHROPIC_MODELS: "m1,m2", ANTHROPIC_MODEL: "m3" });
    expect(c.ai.providers.openai.apiKey).toBe("sk-test-1");
    expect(c.ai.providers.anthropic.models).toEqual(["m3", "m1", "m2"]);
    expect(c.ai.defaultProvider).toBe("openai");
    expect(c.secrets).toEqual(expect.arrayContaining(["nimda", "sk-test-1"]));
  });
});
