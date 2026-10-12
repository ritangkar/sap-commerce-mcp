import { GoogleGenAI, type Content, type GenerateContentResponse } from "@google/genai";
import { classifyProviderError, ProviderError, type GenerateRequest, type GenerateResult, type ModelToolCall, type ProviderAdapter, type Turn } from "../types.js";

type GeminiClient = { models: Pick<GoogleGenAI["models"], "generateContent" | "get"> };

export interface GeminiAdapterOptions {
  apiKey: string | undefined;
  redact?: (text: string) => string;
  client?: GeminiClient;
}

export class GeminiAdapter implements ProviderAdapter {
  readonly id = "gemini" as const;
  readonly label = "Google Gemini";
  private client: GeminiClient | undefined;
  private readonly redact: (t: string) => string;

  constructor(private readonly options: GeminiAdapterOptions) {
    this.redact = options.redact ?? ((t) => t);
    this.client = options.client;
  }

  isConfigured(): boolean {
    return !!this.options.apiKey || !!this.options.client;
  }

  private sdk(): GeminiClient {
    if (!this.isConfigured()) throw new ProviderError("not_configured", "GEMINI_API_KEY is not set.");
    this.client ??= new GoogleGenAI({ apiKey: this.options.apiKey as string });
    return this.client;
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    try {
      const response: GenerateContentResponse = await this.sdk().models.generateContent({
        model: req.model,
        contents: toContents(req.turns),
        config: {
          systemInstruction: req.system,
          maxOutputTokens: req.maxOutputTokens,
          abortSignal: req.signal,
          ...(req.tools.length > 0
            ? {
                tools: [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.inputSchema })) }],
                // We run the tool loop ourselves; the SDK must not execute anything.
                automaticFunctionCalling: { disable: true }
              }
            : {})
        }
      });
      const candidate = response.candidates?.[0];
      const toolCalls: ModelToolCall[] = (response.functionCalls ?? []).map((c, i) => ({
        id: c.id ?? `gemini-call-${Date.now()}-${i}`,
        name: c.name ?? "",
        args: c.args ?? {}
      }));
      const finish = String(candidate?.finishReason ?? "");
      return {
        text: (candidate?.content?.parts ?? []).filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text).join(""),
        toolCalls,
        // Gemini 3 requires the model's parts (incl. thought signatures) to be sent back unchanged.
        providerData: candidate?.content,
        stopReason: toolCalls.length > 0 ? "tool_use" : finish === "MAX_TOKENS" ? "max_tokens" : finish === "STOP" || finish === "" ? "end" : "other",
        ...(response.usageMetadata
          ? { usage: { inputTokens: response.usageMetadata.promptTokenCount ?? 0, outputTokens: response.usageMetadata.candidatesTokenCount ?? 0 } }
          : {})
      };
    } catch (error) {
      throw classifyProviderError(error, this.label, this.redact);
    }
  }

  async testConnection(model: string, _signal: AbortSignal): Promise<void> {
    try {
      await this.sdk().models.get({ model });
    } catch (error) {
      throw classifyProviderError(error, this.label, this.redact);
    }
  }
}

function toContents(turns: Turn[]): Content[] {
  const out: Content[] = [];
  for (const turn of turns) {
    if (turn.role === "user") out.push({ role: "user", parts: [{ text: turn.text }] });
    else if (turn.role === "assistant") {
      const content = turn.providerData as Content | undefined;
      out.push(
        content?.parts
          ? { role: "model", parts: content.parts }
          : {
              role: "model",
              parts: [
                ...(turn.text ? [{ text: turn.text }] : []),
                ...turn.toolCalls.map((c) => ({ functionCall: { id: c.id, name: c.name, args: (c.args ?? {}) as Record<string, unknown> } }))
              ]
            }
      );
    } else {
      out.push({
        role: "user",
        parts: turn.results.map((r) => ({
          functionResponse: { id: r.callId, name: r.name, response: r.isError ? { error: r.content } : { output: r.content } }
        }))
      });
    }
  }
  return out;
}
