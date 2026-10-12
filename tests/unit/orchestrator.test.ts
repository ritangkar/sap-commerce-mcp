import { describe, expect, it } from "vitest";
import { runChat, type ChatLimits } from "../../src/ai/orchestrator.js";
import type { GenerateRequest, GenerateResult, ProviderAdapter } from "../../src/ai/types.js";
import { mockHac, toolsetWith } from "../fixtures/helpers.js";

const limits: ChatLimits = { maxToolCalls: 3, maxSteps: 5, modelResultChars: 500, maxOutputTokens: 1000 };
const call = (id: string, name: string, args: unknown) => ({ id, name, args });

function scripted(steps: Array<Partial<GenerateResult> | ((req: GenerateRequest) => Partial<GenerateResult>)>, id: "openai" | "anthropic" | "gemini" = "openai") {
  const requests: GenerateRequest[] = [];
  let i = 0;
  const adapter: ProviderAdapter = {
    id, label: id, isConfigured: () => true, testConnection: async () => {},
    async generate(req) {
      requests.push(structuredClone({ ...req, signal: undefined }) as unknown as GenerateRequest);
      const step = steps[Math.min(i++, steps.length - 1)]!;
      const r = typeof step === "function" ? step(req) : step;
      return { text: "", toolCalls: [], stopReason: r.toolCalls?.length ? "tool_use" : "end", ...r };
    }
  };
  return { adapter, requests };
}
const run = (adapter: ProviderAdapter, hac = mockHac(), l = limits) =>
  runChat({ adapter, model: "m", messages: [{ role: "user", content: "hi" }], toolset: toolsetWith(hac), limits: l, signal: new AbortController().signal });

describe("orchestrator", () => {
  it("answers directly when no tool is needed", async () => {
    const { adapter } = scripted([{ text: "hello" }]);
    const r = await run(adapter);
    expect(r).toMatchObject({ answer: "hello", toolCalls: [], stopReason: "completed" });
  });

  it("executes a requested tool via the shared core and feeds the result back", async () => {
    const hac = mockHac();
    const { adapter, requests } = scripted([
      { toolCalls: [call("c1", "flexible_search", { query: "SELECT {pk} FROM {Product}" })] },
      { text: "There is 1 product." }
    ]);
    const r = await run(adapter, hac);
    expect(hac.queries).toEqual(["SELECT {pk} FROM {Product}"]);
    expect(r.answer).toBe("There is 1 product.");
    expect(r.toolCalls[0]).toMatchObject({ name: "flexible_search", ok: true });
    const second = requests[1]!;
    const last = second.turns.at(-1)!;
    expect(last.role).toBe("tool");
    expect((last as any).results[0]).toMatchObject({ callId: "c1", isError: false });
    expect(requests[0]!.tools.map((t) => t.name).sort()).toEqual(["config_get", "cronjob", "flexible_search", "logs_tail", "type_info"]);
  });

  it("never executes unknown tools or rejected queries, and tells the model", async () => {
    const hac = mockHac();
    const { adapter, requests } = scripted([
      {
        toolCalls: [
          call("a", "run_groovy", { script: "System.exit(1)" }),
          call("b", "flexible_search", { query: "DELETE FROM {Product}" }),
          call("c", "cronjob", { action: "abort", code: "x" })
        ]
      },
      { text: "I could not do that." }
    ]);
    const r = await run(adapter, hac);
    expect(hac.queries).toHaveLength(0);
    expect(r.toolCalls.map((t) => t.ok)).toEqual([false, false, false]);
    expect(r.toolCalls.map((t) => t.error?.code)).toEqual(["UNKNOWN_TOOL", "QUERY_REJECTED", "INVALID_ARGUMENTS"]);
    const fed = (requests[1]!.turns.at(-1) as any).results;
    expect(fed.every((x: any) => x.isError)).toBe(true);
  });

  it("enforces the tool-call limit, disables tools afterwards and never runs extra calls", async () => {
    const hac = mockHac();
    const many = Array.from({ length: 5 }, (_, i) => call(`c${i}`, "flexible_search", { query: `SELECT {pk} FROM {Product} WHERE {code} = 'p${i}'` }));
    const { adapter, requests } = scripted([{ toolCalls: many }, { text: "partial", toolCalls: [call("z", "flexible_search", { query: "SELECT {pk} FROM {Product}" })] }]);
    const r = await run(adapter, hac);
    expect(hac.queries).toHaveLength(3);
    expect(r.stopReason).toBe("tool_limit");
    expect(r.toolCalls.filter((t) => t.error?.code === "TOOL_LIMIT")).toHaveLength(2);
    expect(requests[1]!.tools).toEqual([]);
    expect(r.answer).toBe("partial");
  });

  it("stops an endless tool loop at the step limit", async () => {
    const hac = mockHac();
    let n = 0;
    const { adapter, requests } = scripted([
      () => ({ toolCalls: [call(`c${n}`, "flexible_search", { query: `SELECT {pk} FROM {Product} WHERE {code} = '${n++}'` })] })
    ]);
    const r = await run(adapter, hac, { ...limits, maxToolCalls: 100, maxSteps: 4 });
    expect(r.stopReason).toBe("step_limit");
    expect(hac.queries.length).toBe(4);
    expect(requests.at(-1)!.tools).toEqual([]);
  });

  it("blocks identical repeated calls", async () => {
    const hac = mockHac();
    const same = call("x", "flexible_search", { query: "SELECT {pk} FROM {Product}" });
    const { adapter } = scripted([{ toolCalls: [same] }, { toolCalls: [{ ...same, id: "y" }] }, { toolCalls: [{ ...same, id: "z" }] }, { text: "done" }]);
    const r = await run(adapter, hac, { ...limits, maxToolCalls: 10 });
    expect(hac.queries).toHaveLength(2);
    expect(r.toolCalls.at(-1)?.error?.code).toBe("REPEATED_CALL");
  });

  it("clips large results for the model but keeps them for display", async () => {
    const hac = mockHac({ flexibleSearch: async () => ({ columns: ["c"], rows: [{ c: "x".repeat(3000) }], rowCount: 1, truncated: false }) });
    const { adapter, requests } = scripted([{ toolCalls: [call("c", "flexible_search", { query: "SELECT {pk} FROM {Product}" })] }, { text: "ok" }]);
    const r = await run(adapter, hac);
    const fed = (requests[1]!.turns.at(-1) as any).results[0].content as string;
    expect(fed.length).toBeLessThan(700);
    expect(r.toolCalls[0]!.clippedForModel).toBe(true);
    expect(JSON.stringify(r.toolCalls[0]!.result).length).toBeGreaterThan(3000);
  });

  it("treats invalid-JSON tool arguments as invalid arguments", async () => {
    const hac = mockHac();
    const { adapter } = scripted([{ toolCalls: [call("c", "flexible_search", { __invalidJson: true })] }, { text: "ok" }]);
    const r = await run(adapter, hac);
    expect(r.toolCalls[0]!.error?.code).toBe("INVALID_ARGUMENTS");
  });

  it("works identically for every provider id (same allowlist, same execution layer)", async () => {
    for (const id of ["openai", "anthropic", "gemini"] as const) {
      const hac = mockHac();
      const { adapter } = scripted([{ toolCalls: [call("c", "flexible_search", { query: "SELECT {pk} FROM {Product}" })] }, { text: id }], id);
      const r = await run(adapter, hac);
      expect(r.answer).toBe(id);
      expect(hac.queries).toHaveLength(1);
    }
  });

  it("propagates abort", async () => {
    const ac = new AbortController();
    ac.abort(new Error("cancelled"));
    const { adapter } = scripted([{ text: "x" }]);
    await expect(runChat({ adapter, model: "m", messages: [{ role: "user", content: "x" }], toolset: toolsetWith(mockHac()), limits, signal: ac.signal })).rejects.toThrow("cancelled");
  });

  it("reports max_tokens", async () => {
    const { adapter } = scripted([{ text: "cut", stopReason: "max_tokens" }]);
    expect((await run(adapter)).stopReason).toBe("max_tokens");
  });
});
