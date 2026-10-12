import type { AppConfig, ProviderId } from "../../config/env.js";
import { PROVIDER_IDS } from "../../config/env.js";
import type { ProviderAdapter } from "../types.js";
import { AnthropicAdapter } from "./anthropic.js";
import { GeminiAdapter } from "./gemini.js";
import { OpenAiAdapter } from "./openai.js";

export type AdapterMap = Record<ProviderId, ProviderAdapter>;

/** The only place that knows how to construct provider adapters; swap entries here in tests. */
export function createAdapters(config: AppConfig, redact: (t: string) => string): AdapterMap {
  return {
    openai: new OpenAiAdapter({ apiKey: config.ai.providers.openai.apiKey, redact }),
    anthropic: new AnthropicAdapter({ apiKey: config.ai.providers.anthropic.apiKey, redact }),
    gemini: new GeminiAdapter({ apiKey: config.ai.providers.gemini.apiKey, redact })
  };
}

export interface ProviderStatus {
  id: ProviderId;
  label: string;
  configured: boolean;
  envVar: string;
  models: string[];
  defaultModel: string;
}

const ENV_VARS: Record<ProviderId, string> = { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", gemini: "GEMINI_API_KEY" };

/** Safe to send to the browser: contains no key material. */
export function providerStatuses(config: AppConfig, adapters: AdapterMap): ProviderStatus[] {
  return PROVIDER_IDS.map((id) => ({
    id,
    label: adapters[id].label,
    configured: adapters[id].isConfigured(),
    envVar: ENV_VARS[id],
    models: config.ai.providers[id].models,
    defaultModel: config.ai.providers[id].defaultModel
  }));
}
