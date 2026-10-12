import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodObject, ZodRawShape } from "zod";
import type { Toolset } from "../core/tools/registry.js";

export const MCP_SERVER_NAME = "sap-commerce-mcp";
export const MCP_SERVER_VERSION = "0.1.0";

/**
 * Adapter: registers every tool of the shared toolset on an MCP server. The handler delegates to
 * `toolset.execute`, so MCP clients get exactly the same validation, read-only enforcement, limits
 * and redaction as the web application.
 */
export function createMcpServer(toolset: Toolset): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });

  for (const summary of toolset.list()) {
    const tool = toolset.get(summary.name);
    if (!tool) continue;
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: (tool.inputSchema as ZodObject).shape as ZodRawShape,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      },
      async (args: Record<string, unknown>) => {
        const result = await toolset.execute(tool.name, args);
        if (!result.ok) {
          return { isError: true, content: [{ type: "text" as const, text: `${result.error.code}: ${result.error.message}` }] };
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }] };
      }
    );
  }
  return server;
}
