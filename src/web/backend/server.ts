import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { z } from "zod";
import { runChat } from "../../ai/orchestrator.js";
import { providerStatuses, type AdapterMap } from "../../ai/providers/index.js";
import { classifyProviderError, ProviderError } from "../../ai/types.js";
import type { AppConfig } from "../../config/env.js";
import { PROVIDER_IDS } from "../../config/env.js";
import type { CommerceRuntime } from "../../core/create-context.js";
import { ToolError, normalizeError } from "../../core/errors.js";
import { checkRequestOrigin, setSecurityHeaders, tokenMatches, TOKEN_HEADER } from "./security.js";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_CONCURRENT_CHATS = 2;
const TOKEN_PLACEHOLDER = "__LOCAL_API_TOKEN__";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".map": "application/json"
};

const chatSchema = z
  .object({
    provider: z.enum(PROVIDER_IDS as unknown as [string, ...string[]]),
    model: z.string().min(1).max(200),
    messages: z
      .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(20000) }).strict())
      .min(1)
      .max(40)
  })
  .strict();

const toolBodySchema = z.object({ args: z.unknown().optional() }).strict();
const providerTestSchema = z.object({ model: z.string().min(1).max(200) }).strict();

export interface WebServerOptions {
  config: AppConfig;
  runtime: CommerceRuntime;
  adapters: AdapterMap;
  token: string;
  /** Directory with the built frontend (index.html + assets). Optional for API-only tests. */
  staticDir?: string;
}

class HttpError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

const STATUS_BY_CODE: Record<string, number> = {
  UNKNOWN_TOOL: 404,
  INVALID_ARGUMENTS: 400,
  QUERY_REJECTED: 400,
  NOT_FOUND: 404,
  LOG_UNAVAILABLE: 404,
  CONFIG_MISSING: 503,
  HAC_AUTH: 502,
  HAC_UNREACHABLE: 502,
  HAC_TLS: 502,
  HAC_TIMEOUT: 504,
  HAC_ERROR: 502,
  HAC_QUERY_ERROR: 400
};

export function createWebServer(options: WebServerOptions): Server {
  const { config, runtime, adapters, token } = options;
  let activeChats = 0;
  let indexHtml: string | undefined;

  const send = (res: ServerResponse, status: number, body: unknown) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(text);
  };
  const sendError = (res: ServerResponse, status: number, code: string, message: string) =>
    send(res, status, { ok: false, error: { code, message: runtime.redact(message) } });

  async function readJson(req: IncomingMessage): Promise<unknown> {
    if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
      throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json.");
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) throw new HttpError(413, "BODY_TOO_LARGE", "Request body is too large.");
      chunks.push(chunk as Buffer);
    }
    try {
      return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    } catch {
      throw new HttpError(400, "INVALID_JSON", "Request body is not valid JSON.");
    }
  }

  function status() {
    return {
      readOnly: true,
      hac: {
        configured: !!config.hac,
        problem: config.hacProblem ?? null,
        url: config.hac ? `${config.hac.baseUrl.origin}${config.hac.baseUrl.pathname}` : null,
        user: config.hac?.user ?? null,
        insecureTls: config.hac?.insecureTls ?? false,
        logConfigured: !!config.logPath
      },
      providers: providerStatuses(config, adapters),
      defaultProvider: config.ai.defaultProvider ?? null,
      limits: { maxToolCalls: config.ai.maxToolCalls, maxSteps: config.ai.maxSteps, maxResultChars: config.maxResultChars },
      tools: runtime.toolset.list()
    };
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    if (!tokenMatches(req.headers[TOKEN_HEADER] as string | undefined, token)) {
      throw new HttpError(401, "BAD_TOKEN", "Missing or invalid local API token. Reload the page.");
    }
    const method = req.method ?? "GET";

    if (method === "GET" && path === "/api/status") return send(res, 200, { ok: true, ...status() });

    if (method === "POST" && path.startsWith("/api/tools/")) {
      const name = decodeURIComponent(path.slice("/api/tools/".length));
      const body = toolBodySchema.safeParse(await readJson(req));
      if (!body.success) throw new HttpError(400, "INVALID_ARGUMENTS", "Body must be {\"args\": {...}}.");
      const result = await runtime.toolset.execute(name, body.data.args);
      return send(res, result.ok ? 200 : (STATUS_BY_CODE[result.error.code] ?? 500), result);
    }

    if (method === "POST" && path === "/api/hac/test") {
      await readJson(req);
      if (!runtime.hac) throw new ToolError("CONFIG_MISSING", config.hacProblem ?? "HAC is not configured.");
      const result = await runtime.hac.checkConnection();
      return send(res, 200, result);
    }

    const providerTest = /^\/api\/providers\/([a-z]+)\/test$/.exec(path);
    if (method === "POST" && providerTest) {
      const id = providerTest[1] as string;
      if (!(PROVIDER_IDS as readonly string[]).includes(id)) throw new HttpError(404, "UNKNOWN_PROVIDER", "Unknown provider.");
      const body = providerTestSchema.safeParse(await readJson(req));
      if (!body.success) throw new HttpError(400, "INVALID_ARGUMENTS", "Body must be {\"model\": \"...\"}.");
      const adapter = adapters[id as keyof AdapterMap];
      if (!adapter.isConfigured()) throw new ProviderError("not_configured", `${adapter.label} is not configured. Set its API key in the server environment.`);
      assertModel(id as keyof AppConfig["ai"]["providers"], body.data.model);
      await adapter.testConnection(body.data.model, AbortSignal.timeout(20000));
      return send(res, 200, { ok: true, provider: id, model: body.data.model });
    }

    if (method === "POST" && path === "/api/chat") {
      const body = chatSchema.safeParse(await readJson(req));
      if (!body.success) throw new HttpError(400, "INVALID_ARGUMENTS", `Invalid chat request: ${body.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      const { provider, model, messages } = body.data;
      if (messages[messages.length - 1]?.role !== "user") throw new HttpError(400, "INVALID_ARGUMENTS", "The last message must be from the user.");
      const adapter = adapters[provider as keyof AdapterMap];
      if (!adapter.isConfigured()) throw new ProviderError("not_configured", `${adapter.label} is not configured. Set its API key in the server environment.`);
      assertModel(provider as keyof AppConfig["ai"]["providers"], model);
      if (activeChats >= MAX_CONCURRENT_CHATS) throw new HttpError(429, "BUSY", "Too many chat requests are running. Wait for one to finish.");
      activeChats++;
      try {
        const result = await runChat({
          adapter,
          model,
          messages,
          toolset: runtime.toolset,
          signal: AbortSignal.timeout(config.ai.requestTimeoutMs),
          limits: {
            maxToolCalls: config.ai.maxToolCalls,
            maxSteps: config.ai.maxSteps,
            modelResultChars: config.ai.modelResultChars,
            maxOutputTokens: 8192
          }
        });
        return send(res, 200, { ok: true, provider, model, ...result, answer: runtime.redact(result.answer) });
      } finally {
        activeChats--;
      }
    }

    throw new HttpError(404, "NOT_FOUND", "Unknown API route.");
  }

  function assertModel(provider: keyof AppConfig["ai"]["providers"], model: string): void {
    if (!config.ai.providers[provider].models.includes(model)) {
      throw new HttpError(400, "UNKNOWN_MODEL", `Model "${model}" is not in the configured model list for ${provider}.`);
    }
  }

  async function serveStatic(res: ServerResponse, path: string): Promise<void> {
    const root = options.staticDir ? resolve(options.staticDir) : undefined;
    if (!root) throw new HttpError(404, "NOT_FOUND", "Frontend is not built. Run `npm run build:web`.");
    const rel = normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, "");
    let file = resolve(join(root, rel));
    if (file !== root && !file.startsWith(root + sep)) throw new HttpError(403, "FORBIDDEN", "Forbidden.");
    let isIndex = false;
    try {
      const info = await stat(file);
      if (info.isDirectory()) { file = join(file, "index.html"); isIndex = true; }
    } catch {
      // SPA fallback only for extension-less paths
      if (extname(file)) throw new HttpError(404, "NOT_FOUND", "Not found.");
      file = join(root, "index.html");
      isIndex = true;
    }
    if (file === join(root, "index.html")) isIndex = true;
    const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
    if (isIndex) {
      indexHtml ??= (await readFile(join(root, "index.html"), "utf8"));
      res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
      res.end(indexHtml.split(TOKEN_PLACEHOLDER).join(token));
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, { "content-type": type, "cache-control": "public, max-age=3600" });
    res.end(body);
  }

  return createServer((req, res) => {
    setSecurityHeaders(res);
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const started = Date.now();
    res.on("finish", () => console.error(`web: ${req.method} ${path} -> ${res.statusCode} (${Date.now() - started} ms)`));

    void (async () => {
      try {
        const guard = checkRequestOrigin(req, req.socket.localPort ?? config.web.port);
        if (guard) throw new HttpError(guard.status, guard.code, guard.message);
        if (path.startsWith("/api/")) return await handleApi(req, res, path);
        if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "METHOD_NOT_ALLOWED", "Method not allowed.");
        return await serveStatic(res, path);
      } catch (error) {
        if (res.headersSent) return void res.end();
        if (error instanceof HttpError) return sendError(res, error.status, error.code, error.message);
        if (error instanceof ProviderError) {
          const status = error.kind === "not_configured" ? 400 : error.kind === "auth" ? 401 : error.kind === "rate_limit" || error.kind === "quota" ? 429 : error.kind === "timeout" ? 504 : 502;
          // 401 here refers to the provider key, not the local token – the UI distinguishes by error.code.
          return sendError(res, status, `PROVIDER_${error.kind.toUpperCase()}`, error.message);
        }
        const norm = normalizeError(error, runtime.redact);
        if (norm.code === "INTERNAL") {
          // Abort/timeouts raised by the orchestrator surface as provider-style timeouts.
          const classified = classifyProviderError(error, "The request", runtime.redact);
          if (classified.kind === "timeout") return sendError(res, 504, "TIMEOUT", "The request timed out.");
        }
        return sendError(res, STATUS_BY_CODE[norm.code] ?? 500, norm.code, norm.message);
      }
    })();
  });
}
