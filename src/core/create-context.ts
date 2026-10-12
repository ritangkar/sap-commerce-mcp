import { HacClient } from "../commerce/hac-client.js";
import { LogReader } from "../commerce/log-reader.js";
import type { AppConfig } from "../config/env.js";
import { ToolError } from "./errors.js";
import { createRedactor } from "./security/redact.js";
import { createToolset, type Toolset } from "./tools/registry.js";
import type { ToolContext } from "./tools/types.js";

export interface CommerceRuntime {
  toolset: Toolset;
  redact: (text: string) => string;
  /** Undefined when HAC is not configured. */
  hac: HacClient | undefined;
}

/**
 * Builds the single tool stack used by BOTH the MCP server and the web backend. When HAC is not
 * configured, tools still exist but fail with an actionable CONFIG_MISSING error.
 */
export function createCommerceRuntime(config: AppConfig): CommerceRuntime {
  const redact = createRedactor(config.secrets);
  const hac = config.hac ? new HacClient({ config: config.hac, redact }) : undefined;
  const missing = () => {
    throw new ToolError("CONFIG_MISSING", config.hacProblem ?? "HAC is not configured.");
  };
  const ctx: ToolContext = {
    hac: hac ?? {
      flexibleSearch: async () => missing(),
      translateFlexibleSearch: async () => missing(),
      getConfigEntries: async () => missing()
    },
    logs: new LogReader(config.logPath, redact),
    redact
  };
  return { toolset: createToolset(ctx, { maxResultChars: config.maxResultChars }), redact, hac };
}
