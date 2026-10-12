import Anthropic from "@anthropic-ai/sdk";
import type { ContentBlock, MessageParam, Tool } from "@anthropic-ai/sdk/resources/messages";
import { classifyProviderError, ProviderError, type GenerateRequest, type GenerateResult, type ModelToolCall, type ProviderAdapter, type Turn } from "../types.js";

export interface AnthropicAdapterOptions {
  apiKey: string | undefined;
  redact?: (text: string) => string;
  client?: Pick<Anthropic, "messages" | "models">;
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly id = "anthropic" as const;
  readonly label = "Anthropic Claude";
  private client: Pick<Anthropic, "messages" | "models"> | undefined;
  private readonly redact: (t: string) => string;

  constructor(private readonly options: AnthropicAdapterOptions) {
    this.redact = options.redact ?? ((t) => t);
    this.client = options.client;
  }

  isConfigured(): boolean {
    return !!this.options.apiKey || !!this.options.client;
  }

  private sdk() {
    if (!this.isConfigured()) throw new ProviderError("not_configured", "ANTHROPIC_API_KEY is not set.");
    this.client ??= new Anthropic({ apiKey: this.options.apiKey, maxRetries: 1 });
    return this.client;
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    try {
      const tools: Tool[] = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Tool["input_schema"]
      }));
      const response = await this.sdk().messages.create(
        {
          model: req.model,
          max_tokens: req.maxOutputTokens,
          system: req.system,
          messages: toMessages(req.turns),
          ...(tools.length > 0 ? { tools } : {})
        },
        { signal: req.signal }
      );
      const toolCalls: ModelToolCall[] = [];
      let text = "";
      for (const block of response.content) {
        if (block.type === "text") text += block.text;
        else if (block.type === "tool_use") toolCalls.push({ id: block.id, name: block.name, args: block.input });
      }
      return {
        text,
        toolCalls,
        // Echo the full content (incl. any thinking blocks) back unchanged on the next request.
        providerData: response.content,
        stopReason:
          response.stop_reason === "tool_use" ? "tool_use" : response.stop_reason === "max_tokens" ? "max_tokens" : response.stop_reason === "end_turn" ? "end" : "other",
        usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens }
      };
    } catch (error) {
      throw classifyProviderError(error, this.label, this.redact);
    }
  }

  async testConnection(model: string, signal: AbortSignal): Promise<void> {
    try {
      await this.sdk().models.retrieve(model, undefined, { signal });
    } catch (error) {
      throw classifyProviderError(error, this.label, this.redact);
    }
  }
}

function toMessages(turns: Turn[]): MessageParam[] {
  const out: MessageParam[] = [];
  for (const turn of turns) {
    if (turn.role === "user") out.push({ role: "user", content: turn.text });
    else if (turn.role === "assistant") {
      const content = Array.isArray(turn.providerData)
        ? (turn.providerData as ContentBlock[])
        : [
            ...(turn.text ? [{ type: "text" as const, text: turn.text }] : []),
            ...turn.toolCalls.map((c) => ({ type: "tool_use" as const, id: c.id, name: c.name, input: (c.args ?? {}) as Record<string, unknown> }))
          ];
      out.push({ role: "assistant", content: content as MessageParam["content"] });
    } else {
      // All results of one assistant turn go back in a single user message.
      out.push({
        role: "user",
        content: turn.results.map((r) => ({ type: "tool_result" as const, tool_use_id: r.callId, content: r.content, ...(r.isError ? { is_error: true } : {}) }))
      });
    }
  }
  return out;
}
