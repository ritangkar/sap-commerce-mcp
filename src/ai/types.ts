import type { ProviderId } from "../config/env.js";

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the tool arguments. */
  inputSchema: Record<string, unknown>;
}

export interface ModelToolCall {
  id: string;
  name: string;
  /** Untrusted, model-generated arguments. */
  args: unknown;
}

export interface ToolResultForModel {
  callId: string;
  name: string;
  content: string;
  isError: boolean;
}

export type Turn =
  | { role: "user"; text: string }
  | {
      role: "assistant";
      text: string;
      toolCalls: ModelToolCall[];
      /** Opaque provider payload that must be replayed unchanged (e.g. Anthropic thinking blocks, Gemini thought signatures). */
      providerData?: unknown;
    }
  | { role: "tool"; results: ToolResultForModel[] };

export interface GenerateRequest {
  model: string;
  system: string;
  turns: Turn[];
  /** Empty array = tools disabled for this request. */
  tools: ToolSpec[];
  maxOutputTokens: number;
  signal: AbortSignal;
}

export interface GenerateResult {
  text: string;
  toolCalls: ModelToolCall[];
  providerData?: unknown;
  stopReason: "end" | "tool_use" | "max_tokens" | "other";
  usage?: { inputTokens: number; outputTokens: number };
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly label: string;
  isConfigured(): boolean;
  generate(request: GenerateRequest): Promise<GenerateResult>;
  /** Cheap, side-effect free credential + model check (no tokens generated). */
  testConnection(model: string, signal: AbortSignal): Promise<void>;
}

export type ProviderErrorKind = "not_configured" | "auth" | "quota" | "rate_limit" | "model" | "timeout" | "bad_request" | "unavailable" | "unknown";

export class ProviderError extends Error {
  constructor(public readonly kind: ProviderErrorKind, message: string, public readonly status?: number) {
    super(message);
    this.name = "ProviderError";
  }
}

/** Map an SDK error to a ProviderError with a user-actionable message (never includes the API key). */
export function classifyProviderError(error: unknown, providerLabel: string, redact: (t: string) => string): ProviderError {
  if (error instanceof ProviderError) return error;
  const e = error as { status?: number; name?: string; message?: string; code?: string };
  const status = typeof e.status === "number" ? e.status : undefined;
  const raw = redact(String(e.message ?? error)).slice(0, 400);
  if (e.name === "AbortError" || /abort|timed? ?out/i.test(e.name ?? "") || /timed? ?out|aborted/i.test(raw) || e.code === "ETIMEDOUT") {
    return new ProviderError("timeout", `${providerLabel} request timed out or was cancelled.`, status);
  }
  switch (status) {
    case 401:
    case 403:
      return new ProviderError("auth", `${providerLabel} rejected the API key (HTTP ${status}). Check the key in your environment.`, status);
    case 404:
      return new ProviderError("model", `${providerLabel} could not find the selected model (HTTP 404). Choose another model or update the model list.`, status);
    case 402:
      return new ProviderError("quota", `${providerLabel} reports insufficient credit or quota (HTTP 402). API usage is billed separately from chat subscriptions.`, status);
    case 429:
      return /quota|billing|credit|insufficient/i.test(raw)
        ? new ProviderError("quota", `${providerLabel} quota or billing limit reached (HTTP 429). API usage is billed separately from chat subscriptions.`, status)
        : new ProviderError("rate_limit", `${providerLabel} rate limit reached (HTTP 429). Wait a moment and retry.`, status);
    case 400:
    case 422:
      return new ProviderError("bad_request", `${providerLabel} rejected the request (HTTP ${status}): ${raw}`, status);
    default:
      if (status !== undefined && status >= 500) {
        return new ProviderError("unavailable", `${providerLabel} is temporarily unavailable (HTTP ${status}).`, status);
      }
      return new ProviderError("unknown", `${providerLabel} request failed: ${raw}`, status);
  }
}
