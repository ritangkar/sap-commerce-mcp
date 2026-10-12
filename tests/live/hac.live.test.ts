/**
 * OPT-IN live checks against YOUR authorized LOCAL SAP Commerce instance. Run with:
 *   LIVE_HAC=1 npm run test:live
 * Uses the same HAC_* variables as the application (.env is loaded). Every call goes through the
 * shared read-only tool layer; nothing here can modify data. These tests have not been run by the
 * authors against a real instance in this repository's CI – they exist so you can verify your own setup.
 */
import { describe, expect, it } from "vitest";
import { loadConfig, loadDotEnv } from "../../src/config/env.js";
import { createCommerceRuntime } from "../../src/core/create-context.js";

loadDotEnv();
const enabled = process.env.LIVE_HAC === "1";

describe.skipIf(!enabled)("live HAC (read-only)", () => {
  const config = loadConfig();
  const runtime = createCommerceRuntime(config);
  const run = (name: string, args: Record<string, unknown>) => runtime.toolset.execute(name, args);

  it("is configured", () => expect(config.hacProblem).toBeUndefined());
  it("logs in and runs a read-only query", async () => {
    const r = await run("flexible_search", { query: "SELECT {pk}, {isocode} FROM {Language}", maxCount: 5 });
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });
  it("reads type information", async () => {
    const r = await run("type_info", { type: "Product" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });
  it("lists cronjobs", async () => {
    const r = await run("cronjob", { action: "list" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });
  it("reads configuration (page layout depends on the HAC version)", async () => {
    const r = await run("config_get", { filter: "build" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });
  it("still rejects mutations before they reach HAC", async () => {
    const r = await run("flexible_search", { query: "DELETE FROM {Product}" });
    expect(r).toMatchObject({ ok: false, error: { code: "QUERY_REJECTED" } });
  });
});
