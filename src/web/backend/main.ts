#!/usr/bin/env node
/** Entry point of the standalone local web application. Independent of the MCP server. */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdapters } from "../../ai/providers/index.js";
import { loadConfig, loadDotEnv } from "../../config/env.js";
import { createCommerceRuntime } from "../../core/create-context.js";
import { createLocalToken } from "./security.js";
import { createWebServer } from "./server.js";

loadDotEnv();
const config = loadConfig();
const runtime = createCommerceRuntime(config);
const adapters = createAdapters(config, runtime.redact);
const here = dirname(fileURLToPath(import.meta.url));
// Built UI: dist/web/static (next to the compiled backend, or reached from src/ when running via tsx).
const staticDir = [resolve(here, "../static"), resolve(here, "../../../dist/web/static")].find((d) => existsSync(resolve(d, "index.html"))) ?? resolve(here, "../static");

const server = createWebServer({ config, runtime, adapters, token: createLocalToken(), staticDir });
server.listen(config.web.port, config.web.host, () => {
  console.error(`SAP Commerce read-only workbench: http://localhost:${config.web.port}  (bound to ${config.web.host} only)`);
  if (!config.hac) console.error(`HAC not configured: ${config.hacProblem}`);
  const ready = Object.entries(adapters).filter(([, a]) => a.isConfigured()).map(([id]) => id);
  console.error(`AI providers configured: ${ready.length ? ready.join(", ") : "none (the AI assistant is disabled until an API key is set)"}`);
});
server.on("error", (error: NodeJS.ErrnoException) => {
  console.error(error.code === "EADDRINUSE" ? `Port ${config.web.port} is already in use. Set WEB_PORT to another value.` : String(error));
  process.exit(1);
});
