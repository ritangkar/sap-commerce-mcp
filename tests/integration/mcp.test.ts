import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import { createCommerceRuntime } from "../../src/core/create-context.js";
import { APPROVED_TOOL_NAMES } from "../../src/core/tools/allowlist.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { startFakeHac, type FakeHac } from "../fixtures/fake-hac.js";

let hac: FakeHac | undefined;
afterEach(async () => { await hac?.close(); hac = undefined; });

async function connect() {
  hac = await startFakeHac({ flex: () => ({ headers: ["PK", "code"], resultList: [["1", "p1"]], resultCount: 1 }) });
  const config = loadConfig({ HAC_URL: hac.url, HAC_USER: "admin", HAC_PASS: "nimda" });
  const server = createMcpServer(createCommerceRuntime(config).toolset);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

describe("MCP server (in-memory transport)", () => {
  it("discovers exactly the approved read-only tools", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...APPROVED_TOOL_NAMES].sort());
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "flexible_search")?.inputSchema.required).toContain("query");
  });

  it("invokes a tool through the shared core", async () => {
    const client = await connect();
    const res = await client.callTool({ name: "flexible_search", arguments: { query: "SELECT {pk},{code} FROM {Product}" } });
    expect(res.isError).toBeFalsy();
    const text = (res.content as Array<{ text: string }>)[0]!.text;
    expect(JSON.parse(text).rows).toEqual([{ PK: "1", code: "p1" }]);
    expect(hac!.queries).toEqual(["SELECT {pk},{code} FROM {Product}"]);
  });

  it("reports rejected queries as tool errors and never forwards them", async () => {
    const client = await connect();
    const res = await client.callTool({ name: "flexible_search", arguments: { query: "DELETE FROM {Product}" } });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0]!.text).toMatch(/QUERY_REJECTED/);
    expect(hac!.queries).toHaveLength(0);
  });

  it("rejects invalid arguments and unknown / write-capable tool names", async () => {
    const client = await connect();
    const bad = await client.callTool({ name: "flexible_search", arguments: { query: 42 } }).catch((e) => e);
    expect(bad instanceof Error || (bad as { isError?: boolean }).isError).toBeTruthy();
    for (const name of ["groovy_execute", "cronjob_start", "impex_import", "http_request"]) {
      const r = await client.callTool({ name, arguments: {} }).catch((e) => e);
      expect(r instanceof Error || (r as { isError?: boolean }).isError, name).toBeTruthy();
    }
    const cron = await client.callTool({ name: "cronjob", arguments: { action: "abort", code: "x" } }).catch((e) => e);
    expect(cron instanceof Error || (cron as { isError?: boolean }).isError).toBeTruthy();
  });
});

describe("MCP server process (stdio, built entry point)", () => {
  it("starts as a separate process without the web UI, lists tools and answers a call", async () => {
    hac = await startFakeHac();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/mcp/main.ts"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "", HAC_URL: hac.url, HAC_USER: "admin", HAC_PASS: "nimda" },
      stderr: "pipe"
    });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(APPROVED_TOOL_NAMES.length);
      const res = await client.callTool({ name: "flexible_search", arguments: { query: "SELECT {pk} FROM {Product}" } });
      expect(res.isError).toBeFalsy();
    } finally {
      await client.close();
    }
  }, 30000);

  it("exits with an actionable message when HAC credentials are missing", async () => {
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync(process.execPath, ["--import", "tsx", "src/mcp/main.ts"], {
      env: { PATH: process.env.PATH ?? "", SAP_COMMERCE_MCP_NO_DOTENV: "1" },
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 20000
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/HAC_USER and HAC_PASS/);
    expect(r.stdout).toBe("");
  });
});
