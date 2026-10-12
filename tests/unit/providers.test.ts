import { describe, expect, it, vi } from "vitest";
import { AnthropicAdapter } from "../../src/ai/providers/anthropic.js";
import { GeminiAdapter } from "../../src/ai/providers/gemini.js";
import { OpenAiAdapter } from "../../src/ai/providers/openai.js";
import { classifyProviderError, ProviderError, type GenerateRequest } from "../../src/ai/types.js";

const req = (over: Partial<GenerateRequest> = {}): GenerateRequest => ({
  model: "model-x",
  system: "sys",
  turns: [{ role: "user", text: "q" }],
  tools: [{ name: "flexible_search", description: "d", inputSchema: { type: "object", properties: { query: { type: "string" } } } }],
  maxOutputTokens: 100,
  signal: new AbortController().signal,
  ...over
});
const history: GenerateRequest["turns"] = [
  { role: "user", text: "q" },
  { role: "assistant", text: "", toolCalls: [{ id: "call-1", name: "flexible_search", args: { query: "Q" } }] },
  { role: "tool", results: [{ callId: "call-1", name: "flexible_search", content: '{"rows":[]}', isError: false }] }
];

describe("OpenAI adapter", () => {
  const make = (create: unknown, models: unknown = { retrieve: vi.fn() }) => new OpenAiAdapter({ apiKey: "k", client: { chat: { completions: { create } }, models } as never });

  it("maps tools, tool calls and tool results", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "flexible_search", arguments: '{"query":"Q"}' } }] } }],
      usage: { prompt_tokens: 5, completion_tokens: 2 }
    });
    const r = await make(create).generate(req({ turns: history }));
    expect(r).toMatchObject({ stopReason: "tool_use", toolCalls: [{ id: "c1", name: "flexible_search", args: { query: "Q" } }], usage: { inputTokens: 5, outputTokens: 2 } });
    const body = create.mock.calls[0]![0];
    expect(body.tools[0]).toEqual({ type: "function", function: { name: "flexible_search", description: "d", parameters: expect.any(Object) } });
    expect(body.messages.map((m: any) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(body.messages[3]).toMatchObject({ tool_call_id: "call-1" });
  });
  it("omits tools when none are offered and maps plain answers", async () => {
    const create = vi.fn().mockResolvedValue({ choices: [{ finish_reason: "stop", message: { content: "hi" } }] });
    const r = await make(create).generate(req({ tools: [] }));
    expect(r).toMatchObject({ text: "hi", stopReason: "end" });
    expect(create.mock.calls[0]![0]).not.toHaveProperty("tools");
  });
  it("turns malformed argument JSON into a marker (rejected later by schema validation)", async () => {
    const create = vi.fn().mockResolvedValue({ choices: [{ message: { tool_calls: [{ id: "c", type: "function", function: { name: "x", arguments: "{oops" } }] } }] });
    expect((await make(create).generate(req())).toolCalls[0]!.args).toEqual({ __invalidJson: true });
  });
  it("tests the connection by retrieving the model (no generation)", async () => {
    const retrieve = vi.fn().mockResolvedValue({});
    const create = vi.fn();
    await make(create, { retrieve }).testConnection("m", new AbortController().signal);
    expect(retrieve).toHaveBeenCalledWith("m", expect.anything());
    expect(create).not.toHaveBeenCalled();
  });
  it("reports missing credentials", async () => {
    const a = new OpenAiAdapter({ apiKey: undefined });
    expect(a.isConfigured()).toBe(false);
    await expect(a.generate(req())).rejects.toMatchObject({ kind: "not_configured" });
  });
});

describe("Anthropic adapter", () => {
  const make = (create: unknown, models: unknown = { retrieve: vi.fn() }) => new AnthropicAdapter({ apiKey: "k", client: { messages: { create }, models } as never });

  it("maps tools, tool_use blocks and replays provider content unchanged", async () => {
    const content = [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: "look" }, { type: "tool_use", id: "tu1", name: "flexible_search", input: { query: "Q" } }];
    const create = vi.fn().mockResolvedValue({ content, stop_reason: "tool_use", usage: { input_tokens: 3, output_tokens: 4 } });
    const a = make(create);
    const r = await a.generate(req());
    expect(r).toMatchObject({ text: "look", stopReason: "tool_use", toolCalls: [{ id: "tu1", name: "flexible_search", args: { query: "Q" } }] });
    expect(create.mock.calls[0]![0]).toMatchObject({ model: "model-x", system: "sys", tools: [{ name: "flexible_search", input_schema: expect.any(Object) }] });
    await a.generate(req({ turns: [{ role: "user", text: "q" }, { role: "assistant", text: "look", toolCalls: r.toolCalls, providerData: r.providerData }, { role: "tool", results: [{ callId: "tu1", name: "flexible_search", content: "{}", isError: true }] }] }));
    const msgs = create.mock.calls[1]![0].messages;
    expect(msgs[1].content).toBe(content);
    expect(msgs[2]).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "{}", is_error: true }] });
  });
  it("tests the connection via the models endpoint", async () => {
    const retrieve = vi.fn().mockResolvedValue({});
    await make(vi.fn(), { retrieve }).testConnection("m", new AbortController().signal);
    expect(retrieve).toHaveBeenCalledWith("m", undefined, expect.anything());
  });
  it("maps stop reasons", async () => {
    const create = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "x" }], stop_reason: "max_tokens", usage: { input_tokens: 1, output_tokens: 1 } });
    expect((await make(create).generate(req())).stopReason).toBe("max_tokens");
  });
});

describe("Gemini adapter", () => {
  const make = (generateContent: unknown, get: unknown = vi.fn()) => new GeminiAdapter({ apiKey: "k", client: { models: { generateContent, get } } as never });

  it("maps function declarations, calls and replays model content", async () => {
    const modelContent = { role: "model", parts: [{ functionCall: { name: "flexible_search", args: { query: "Q" } }, thoughtSignature: "sig" }] };
    const generateContent = vi.fn().mockResolvedValue({
      candidates: [{ content: modelContent, finishReason: "STOP" }],
      functionCalls: [{ name: "flexible_search", args: { query: "Q" } }],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 1 }
    });
    const a = make(generateContent);
    const r = await a.generate(req());
    expect(r.stopReason).toBe("tool_use");
    expect(r.toolCalls[0]).toMatchObject({ name: "flexible_search", args: { query: "Q" } });
    const cfg = generateContent.mock.calls[0]![0].config;
    expect(cfg.tools[0].functionDeclarations[0]).toMatchObject({ name: "flexible_search", parametersJsonSchema: expect.any(Object) });
    expect(cfg.automaticFunctionCalling).toEqual({ disable: true });
    await a.generate(req({ turns: [{ role: "user", text: "q" }, { role: "assistant", text: "", toolCalls: r.toolCalls, providerData: r.providerData }, { role: "tool", results: [{ callId: r.toolCalls[0]!.id, name: "flexible_search", content: "{}", isError: false }] }] }));
    const contents = generateContent.mock.calls[1]![0].contents;
    expect(contents[1].parts).toBe(modelContent.parts);
    expect(contents[2].parts[0].functionResponse).toMatchObject({ name: "flexible_search", response: { output: "{}" } });
  });
  it("extracts plain text and ignores thought parts", async () => {
    const generateContent = vi.fn().mockResolvedValue({ candidates: [{ content: { parts: [{ text: "hmm", thought: true }, { text: "answer" }] }, finishReason: "STOP" }] });
    expect(await make(generateContent).generate(req({ tools: [] }))).toMatchObject({ text: "answer", stopReason: "end" });
    expect(generateContent.mock.calls[0]![0].config).not.toHaveProperty("tools");
  });
  it("tests the connection by fetching the model", async () => {
    const get = vi.fn().mockResolvedValue({});
    await make(vi.fn(), get).testConnection("gem", new AbortController().signal);
    expect(get).toHaveBeenCalledWith({ model: "gem" });
  });
});

describe("provider error classification", () => {
  const redact = (t: string) => t.replace(/sk-secret/g, "****");
  it.each([
    [{ status: 401, message: "bad key" }, "auth"],
    [{ status: 403, message: "x" }, "auth"],
    [{ status: 404, message: "no model" }, "model"],
    [{ status: 429, message: "Rate limit" }, "rate_limit"],
    [{ status: 429, message: "You exceeded your current quota, check billing" }, "quota"],
    [{ status: 402, message: "x" }, "quota"],
    [{ status: 400, message: "bad" }, "bad_request"],
    [{ status: 503, message: "x" }, "unavailable"],
    [{ name: "AbortError", message: "aborted" }, "timeout"],
    [{ message: "weird" }, "unknown"]
  ])("%j -> %s", (err, kind) => expect(classifyProviderError(err, "P", redact).kind).toBe(kind));

  it("never leaks secrets from upstream messages", () => {
    const e = classifyProviderError({ status: 400, message: "invalid key sk-secret" }, "P", redact);
    expect(e.message).not.toContain("sk-secret");
  });
  it("passes ProviderErrors through and maps SDK failures inside adapters", async () => {
    const e = new ProviderError("auth", "x");
    expect(classifyProviderError(e, "P", redact)).toBe(e);
    const a = new OpenAiAdapter({ apiKey: "k", redact, client: { chat: { completions: { create: vi.fn().mockRejectedValue({ status: 401, message: "Incorrect API key sk-secret" }) } }, models: {} } as never });
    const err = await a.generate(req()).catch((x) => x);
    expect(err.kind).toBe("auth");
    expect(err.message).not.toContain("sk-secret");
  });
});
