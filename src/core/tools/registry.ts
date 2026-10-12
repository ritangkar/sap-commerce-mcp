import { z } from "zod";
import { ToolError, normalizeError } from "../errors.js";
import { limitResultSize } from "../results/limits.js";
import { APPROVED_TOOL_NAMES } from "./allowlist.js";
import { ALL_TOOLS } from "./definitions.js";
import type { ToolContext, ToolDefinition, ToolResult, ToolSummary } from "./types.js";

export interface Toolset {
  list(): ToolSummary[];
  get(name: string): ToolDefinition | undefined;
  /** Validates the tool name and arguments, runs the tool, caps and normalizes the outcome. Never throws. */
  execute(name: string, rawArgs: unknown): Promise<ToolResult>;
}

export interface ToolsetOptions {
  maxResultChars: number;
}

/** JSON Schema (draft 2020-12) of a tool's input, in the form model providers and MCP clients expect. */
export function toolJsonSchema(tool: ToolDefinition): Record<string, unknown> {
  const schema = z.toJSONSchema(tool.inputSchema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

export function createToolset(ctx: ToolContext, options: ToolsetOptions): Toolset {
  const registry = new Map<string, ToolDefinition>();
  for (const tool of ALL_TOOLS as unknown as ToolDefinition[]) registry.set(tool.name, tool);

  // Fail at construction time if the registry and the audited allow-list ever diverge.
  const registered = [...registry.keys()].sort().join(",");
  if (registered !== [...APPROVED_TOOL_NAMES].sort().join(",")) {
    throw new Error(`Tool registry (${registered}) does not match the approved allow-list.`);
  }

  return {
    list() {
      return [...registry.values()].map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        readOnly: true as const,
        inputSchema: toolJsonSchema(t)
      }));
    },
    get: (name) => registry.get(name),
    async execute(name, rawArgs) {
      const fail = (e: unknown): ToolResult => ({ ok: false, error: normalizeError(e, ctx.redact) });
      // Own-key lookup in a Map: "__proto__", "constructor" etc. can never resolve to a tool.
      const tool = typeof name === "string" ? registry.get(name) : undefined;
      if (!tool) return fail(new ToolError("UNKNOWN_TOOL", `Unknown tool "${typeof name === "string" ? name.slice(0, 80) : typeof name}". Approved tools: ${APPROVED_TOOL_NAMES.join(", ")}.`));

      const parsed = tool.inputSchema.safeParse(rawArgs ?? {});
      if (!parsed.success) {
        const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
        return fail(new ToolError("INVALID_ARGUMENTS", `Invalid arguments for ${tool.name}: ${detail}`));
      }

      try {
        const data = await tool.run(parsed.data as never, ctx);
        const limited = limitResultSize(data, options.maxResultChars);
        return { ok: true, data: limited.data, truncated: limited.truncated };
      } catch (error) {
        return fail(error);
      }
    }
  };
}
