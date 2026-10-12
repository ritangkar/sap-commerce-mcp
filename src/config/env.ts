import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ToolError } from "../core/errors.js";
import { assertAllowedHacUrl } from "../commerce/host-guard.js";

export type ProviderId = "openai" | "anthropic" | "gemini";
export const PROVIDER_IDS: readonly ProviderId[] = ["openai", "anthropic", "gemini"];

export interface HacConfig {
  baseUrl: URL;
  user: string;
  pass: string;
  timeoutMs: number;
  insecureTls: boolean;
}

export interface ProviderConfig {
  apiKey: string | undefined;
  /** Model ids offered in the UI; the first entry (or `defaultModel`) is the default. */
  models: string[];
  defaultModel: string;
}

export interface AppConfig {
  hac: HacConfig | undefined;
  /** Human-readable reason why `hac` is undefined. */
  hacProblem: string | undefined;
  logPath: string | undefined;
  maxResultChars: number;
  web: { host: string; port: number };
  ai: {
    providers: Record<ProviderId, ProviderConfig>;
    defaultProvider: ProviderId | undefined;
    maxToolCalls: number;
    maxSteps: number;
    requestTimeoutMs: number;
    /** Max characters of one tool result that is sent back to the model. */
    modelResultChars: number;
  };
  /** Exact secret values of this process; used by the redactor. */
  secrets: string[];
}

export type Env = Record<string, string | undefined>;

/** Default model catalogue. Override per provider with OPENAI_MODELS / ANTHROPIC_MODELS / GEMINI_MODELS. */
export const DEFAULT_MODELS: Record<ProviderId, string[]> = {
  openai: ["gpt-5.5"],
  anthropic: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"],
  gemini: ["gemini-3.1-pro-preview", "gemini-3-flash-preview"]
};

const bool = (v: string | undefined) => v?.trim().toLowerCase() === "true";

function int(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ToolError("CONFIG_MISSING", `${name} must be an integer between ${min} and ${max} (got "${raw}").`);
  }
  return n;
}

function providerConfig(env: Env, id: ProviderId, keyVar: string, modelsVar: string, modelVar: string): ProviderConfig {
  const listed = (env[modelsVar] ?? "").split(",").map((m) => m.trim()).filter(Boolean);
  const models = listed.length > 0 ? listed : [...DEFAULT_MODELS[id]];
  const chosen = env[modelVar]?.trim();
  if (chosen && !models.includes(chosen)) models.unshift(chosen);
  const apiKey = env[keyVar]?.trim() || undefined;
  return { apiKey, models, defaultModel: chosen || (models[0] as string) };
}

const hacEnvSchema = z.object({
  HAC_URL: z.string().url(),
  HAC_USER: z.string().min(1),
  HAC_PASS: z.string().min(1)
});

export function loadConfig(env: Env = process.env): AppConfig {
  const hacTimeoutMs = int(env, "HAC_TIMEOUT_MS", 30000, 1000, 300000);
  let hac: HacConfig | undefined;
  let hacProblem: string | undefined;

  const parsed = hacEnvSchema.safeParse({
    HAC_URL: env.HAC_URL?.trim() || "https://localhost:9002/hac",
    HAC_USER: env.HAC_USER,
    HAC_PASS: env.HAC_PASS
  });
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => String(i.path[0])).join(", ");
    hacProblem = `Missing or invalid HAC settings: ${missing}. Set HAC_USER and HAC_PASS (and optionally HAC_URL) – see .env.example.`;
  } else {
    try {
      const url = new URL(parsed.data.HAC_URL.endsWith("/") ? parsed.data.HAC_URL : `${parsed.data.HAC_URL}/`);
      assertAllowedHacUrl(url);
      hac = {
        baseUrl: url,
        user: parsed.data.HAC_USER,
        pass: parsed.data.HAC_PASS,
        timeoutMs: hacTimeoutMs,
        insecureTls: bool(env.HAC_INSECURE_TLS)
      };
    } catch (error) {
      hacProblem = error instanceof Error ? error.message : String(error);
    }
  }

  const providers: Record<ProviderId, ProviderConfig> = {
    openai: providerConfig(env, "openai", "OPENAI_API_KEY", "OPENAI_MODELS", "OPENAI_MODEL"),
    anthropic: providerConfig(env, "anthropic", "ANTHROPIC_API_KEY", "ANTHROPIC_MODELS", "ANTHROPIC_MODEL"),
    gemini: providerConfig(env, "gemini", "GEMINI_API_KEY", "GEMINI_MODELS", "GEMINI_MODEL")
  };

  const requestedDefault = env.AI_DEFAULT_PROVIDER?.trim().toLowerCase();
  const defaultProvider = (PROVIDER_IDS as readonly string[]).includes(requestedDefault ?? "")
    ? (requestedDefault as ProviderId)
    : PROVIDER_IDS.find((p) => providers[p].apiKey);

  const host = env.WEB_HOST?.trim() || "127.0.0.1";
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new ToolError(
      "CONFIG_MISSING",
      `WEB_HOST must be a loopback address (127.0.0.1, localhost or ::1); got "${host}". This tool must not be exposed to the network.`
    );
  }

  return {
    hac,
    hacProblem,
    logPath: env.HAC_LOG_PATH?.trim() ? resolve(env.HAC_LOG_PATH.trim()) : undefined,
    maxResultChars: int(env, "TOOL_MAX_RESULT_CHARS", 100000, 2000, 1000000),
    web: { host, port: int(env, "WEB_PORT", 3737, 1024, 65535) },
    ai: {
      providers,
      defaultProvider,
      maxToolCalls: int(env, "AI_MAX_TOOL_CALLS", 8, 1, 25),
      maxSteps: int(env, "AI_MAX_STEPS", 10, 1, 30),
      requestTimeoutMs: int(env, "AI_REQUEST_TIMEOUT_MS", 120000, 5000, 600000),
      modelResultChars: int(env, "AI_TOOL_RESULT_CHARS", 24000, 1000, 200000)
    },
    secrets: [hac?.pass, providers.openai.apiKey, providers.anthropic.apiKey, providers.gemini.apiKey].filter(
      (s): s is string => typeof s === "string"
    )
  };
}

/**
 * Load `.env` from the repository root (next to package.json) without overriding variables that are
 * already set, so values passed by an MCP client's `env` block always win.
 */
export function loadDotEnv(): void {
  if (process.env.SAP_COMMERCE_MCP_NO_DOTENV === "1") return;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [resolve(process.cwd(), ".env"), resolve(here, "../../.env"), resolve(here, "../../../.env")]) {
    if (existsSync(candidate)) {
      try {
        process.loadEnvFile(candidate);
      } catch {
        /* an unreadable .env must not crash startup; missing values are reported by loadConfig */
      }
      return;
    }
  }
}
