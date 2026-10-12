import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import { classifyProviderError, ProviderError, type GenerateRequest, type GenerateResult, type ModelToolCall, type ProviderAdapter, type Turn } from "../types.js";

export interface OpenAiAdapterOptions {
  apiKey: string | undefined;
  redact?: (text: string) => string;
  /** Test seam. */
  client?: Pick<OpenAI, "chat" | "models">;
}

export class OpenAiAdapter implements ProviderAdapter {
  readonly id = "openai" as const;
  readonly label = "OpenAI";
  private client: Pick<OpenAI, "chat" | "models"> | undefined;
  private readonly redact: (t: string) => string;

  constructor(private readonly options: OpenAiAdapterOptions) {
    this.redact = options.redact ?? ((t) => t);
    this.client = options.client;
  }

  isConfigured(): boolean {
    return !!this.options.apiKey || !!this.options.client;
  }

  private sdk() {
    if (!this.isConfigured()) throw new ProviderError("not_configured", "OPENAI_API_KEY is not set.");
    this.client ??= new OpenAI({ apiKey: this.options.apiKey, maxRetries: 1 });
    return this.client;
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    try {
      const tools: ChatCompletionTool[] = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema }
      }));
      const response = await this.sdk().chat.completions.create(
        {
          model: req.model,
          max_completion_tokens: req.maxOutputTokens,
          messages: [{ role: "system", content: req.system }, ...toMessages(req.turns)],
          ...(tools.length > 0 ? { tools, tool_choice: "auto" as const } : {})
        },
        { signal: req.signal }
      );
      const choice = response.choices[0];
      const message = choice?.message;
      const toolCalls: ModelToolCall[] = [];
      for (const call of message?.tool_calls ?? []) {
        if (call.type !== "function") continue;
        toolCalls.push({ id: call.id, name: call.function.name, args: safeJson(call.function.arguments) });
      }
      return {
        text: message?.content ?? "",
        toolCalls,
        stopReason: toolCalls.length > 0 ? "tool_use" : choice?.finish_reason === "length" ? "max_tokens" : choice?.finish_reason === "stop" ? "end" : "other",
        ...(response.usage ? { usage: { inputTokens: response.usage.prompt_tokens, outputTokens: response.usage.completion_tokens } } : {})
      };
    } catch (error) {
      throw classifyProviderError(error, this.label, this.redact);
    }
  }

  async testConnection(model: string, signal: AbortSignal): Promise<void> {
    try {
      await this.sdk().models.retrieve(model, { signal });
    } catch (error) {
      throw classifyProviderError(error, this.label, this.redact);
    }
  }
}

/** Invalid JSON from the model becomes a marker object that fails schema validation downstream. */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return { __invalidJson: true };
  }
}

function toMessages(turns: Turn[]): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [];
  for (const turn of turns) {
    if (turn.role === "user") out.push({ role: "user", content: turn.text });
    else if (turn.role === "assistant") {
      out.push({
        role: "assistant",
        content: turn.text || null,
        ...(turn.toolCalls.length > 0
          ? { tool_calls: turn.toolCalls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })) }
          : {})
      });
    } else {
      for (const r of turn.results) out.push({ role: "tool", tool_call_id: r.callId, content: r.content });
    }
  }
  return out;
}
