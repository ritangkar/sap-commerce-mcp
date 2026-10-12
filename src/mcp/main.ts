#!/usr/bin/env node
/**
 * Entry point of the standalone MCP server (stdio transport). It does not start or need the web UI.
 * stdout is reserved for the MCP protocol; all diagnostics go to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, loadDotEnv } from "../config/env.js";
import { createCommerceRuntime } from "../core/create-context.js";
import { createMcpServer } from "./server.js";

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  if (!config.hac) {
    console.error(`sap-commerce-mcp: ${config.hacProblem}`);
    process.exit(1);
  }
  const runtime = createCommerceRuntime(config);
  const server = createMcpServer(runtime.toolset);
  await server.connect(new StdioServerTransport());
  console.error(`sap-commerce-mcp: read-only MCP server ready (HAC ${config.hac.baseUrl.origin}${config.hac.baseUrl.pathname}).`);
}

main().catch((error) => {
  console.error(`sap-commerce-mcp: failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
