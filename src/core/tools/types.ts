import type { z } from "zod";
import type { HacPort } from "../../commerce/hac-client.js";
import type { LogPort } from "../../commerce/log-reader.js";

export interface ToolContext {
  hac: HacPort;
  logs: LogPort;
  /** Applied to every string that leaves a tool. */
  redact: (text: string) => string;
}

/** Every tool is read-only by construction: the type admits no other value. */
export interface ToolDefinition<S extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  description: string;
  readOnly: true;
  inputSchema: S;
  run(args: z.infer<S>, ctx: ToolContext): Promise<unknown>;
}

export interface ToolSummary {
  name: string;
  title: string;
  description: string;
  readOnly: true;
  inputSchema: Record<string, unknown>;
}

export type ToolResult =
  | { ok: true; data: unknown; truncated: boolean }
  | { ok: false; error: { code: string; message: string } };
