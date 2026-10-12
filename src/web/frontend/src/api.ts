export interface ToolSummary {
  name: string;
  title: string;
  description: string;
  readOnly: true;
  inputSchema: Record<string, unknown>;
}

export interface ProviderStatus {
  id: "openai" | "anthropic" | "gemini";
  label: string;
  configured: boolean;
  envVar: string;
  models: string[];
  defaultModel: string;
}

export interface AppStatus {
  readOnly: true;
  hac: { configured: boolean; problem: string | null; url: string | null; user: string | null; insecureTls: boolean; logConfigured: boolean };
  providers: ProviderStatus[];
  defaultProvider: ProviderStatus["id"] | null;
  limits: { maxToolCalls: number; maxSteps: number; maxResultChars: number };
  tools: ToolSummary[];
}

export interface ToolActivity {
  id: string;
  name: string;
  args: unknown;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
  truncated?: boolean;
  clippedForModel?: boolean;
  durationMs: number;
}

export interface ChatResponse {
  provider: string;
  model: string;
  answer: string;
  toolCalls: ToolActivity[];
  stopReason: "completed" | "tool_limit" | "step_limit" | "max_tokens";
  usage: { inputTokens: number; outputTokens: number };
}

export class ApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

function token(): string {
  return document.querySelector('meta[name="local-api-token"]')?.getAttribute("content") ?? "";
}

async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: { "x-local-token": token(), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
  } catch {
    throw new ApiError("NETWORK", "Cannot reach the local server. Is `npm run start:web` still running?", 0);
  }
  const json = (await res.json().catch(() => undefined)) as { ok?: boolean; error?: { code?: string; message?: string } } | undefined;
  if (!res.ok || json?.ok === false) {
    throw new ApiError(json?.error?.code ?? `HTTP_${res.status}`, json?.error?.message ?? res.statusText ?? "Request failed", res.status);
  }
  return json as T;
}

export const api = {
  status: () => request<AppStatus & { ok: true }>("GET", "/api/status"),
  async runTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<{ data: T; truncated: boolean }> {
    const r = await request<{ data: T; truncated: boolean }>("POST", `/api/tools/${encodeURIComponent(name)}`, { args });
    return { data: r.data, truncated: r.truncated };
  },
  testHac: () => request<{ ok: true; user: string; baseUrl: string }>("POST", "/api/hac/test", {}),
  testProvider: (id: string, model: string) => request<{ ok: true }>("POST", `/api/providers/${id}/test`, { model }),
  chat: (payload: { provider: string; model: string; messages: Array<{ role: "user" | "assistant"; content: string }> }) =>
    request<ChatResponse>("POST", "/api/chat", payload)
};

export function errorText(e: unknown): { code: string; message: string } {
  if (e instanceof ApiError) return { code: e.code, message: e.message };
  return { code: "ERROR", message: e instanceof Error ? e.message : String(e) };
}
