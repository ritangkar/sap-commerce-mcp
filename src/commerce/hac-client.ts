/*
 * HAC client. Session/CSRF/cookie handling adapted from hybris-mcp-lite (MIT, Copyright (c) 2026
 * André Escocard) – see NOTICE.md. Differences: no Groovy scripting console, no generic request API,
 * mandatory read-only validation of every FlexibleSearch query, TLS relaxation scoped to HAC only.
 */
import { Agent, fetch as undiciFetch } from "undici";
import type { HacConfig } from "../config/env.js";
import { ToolError } from "../core/errors.js";
import { assertReadOnlyFlexibleSearch } from "../core/validation/flexsearch-validator.js";
import {
  extractCsrf,
  parseConfigPage,
  parseFlexibleSearchResponse,
  parseTranslateResponse,
  stripTags,
  type ConfigEntry,
  type FlexibleSearchResult
} from "./html-parse.js";

/** The HAC operations the rest of the code base may use. Tools depend on this interface, not on HTTP. */
export interface HacPort {
  flexibleSearch(query: string, options?: { maxCount?: number }): Promise<FlexibleSearchResult>;
  translateFlexibleSearch(query: string): Promise<{ sql: string }>;
  getConfigEntries(): Promise<ConfigEntry[]>;
}

export type FetchLike = (url: string, init: Record<string, unknown>) => Promise<Response>;

export interface HacClientOptions {
  config: HacConfig;
  /** Applied to every error message that can leave this class. */
  redact?: (text: string) => string;
  /** Test seam. Defaults to undici's fetch with a HAC-scoped TLS policy. */
  fetchImpl?: FetchLike;
}

const MAX_RESPONSE_CHARS = 8_000_000;
/** The only POST endpoints this client will ever call. Adding one is a security-relevant change. */
const POST_PATHS = ["console/flexsearch/execute", "console/flexsearch/translate"] as const;
type PostPath = (typeof POST_PATHS)[number];
/** The only GET endpoints (besides login). */
const GET_PATHS = ["platform/config", ""] as const;
type GetPath = (typeof GET_PATHS)[number];

export class HacClient implements HacPort {
  private readonly cookies = new Map<string, string>();
  private csrf: string | undefined;
  private loginInFlight: Promise<void> | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly redact: (text: string) => string;

  constructor(private readonly options: HacClientOptions) {
    this.redact = options.redact ?? ((t) => t);
    if (options.fetchImpl) {
      this.fetchImpl = options.fetchImpl;
    } else {
      // TLS verification is relaxed ONLY for this dispatcher (HAC), never process-wide.
      const dispatcher = options.config.insecureTls
        ? new Agent({ connect: { rejectUnauthorized: false } })
        : new Agent();
      this.fetchImpl = ((url: string, init: Record<string, unknown>) =>
        undiciFetch(url, { ...init, dispatcher } as never) as unknown as Promise<Response>) as FetchLike;
    }
  }

  async flexibleSearch(query: string, options: { maxCount?: number } = {}): Promise<FlexibleSearchResult> {
    const safeQuery = assertReadOnlyFlexibleSearch(query);
    const maxCount = Math.min(Math.max(options.maxCount ?? 200, 1), 5000);
    const body = await this.post("console/flexsearch/execute", {
      flexibleSearchQuery: safeQuery,
      maxCount: String(maxCount),
      user: "admin"
    });
    const parsed = parseFlexibleSearchResponse(body, maxCount);
    if (parsed.error !== undefined || !parsed.result) {
      throw new ToolError("HAC_QUERY_ERROR", `HAC rejected the query: ${this.clean(parsed.error ?? "unknown error")}`);
    }
    return parsed.result;
  }

  async translateFlexibleSearch(query: string): Promise<{ sql: string }> {
    const safeQuery = assertReadOnlyFlexibleSearch(query);
    const body = await this.post("console/flexsearch/translate", { flexibleSearchQuery: safeQuery, user: "admin" });
    const sql = parseTranslateResponse(body);
    if (!sql) throw new ToolError("HAC_QUERY_ERROR", "HAC could not translate the query.");
    return { sql: this.clean(sql) };
  }

  async getConfigEntries(): Promise<ConfigEntry[]> {
    const html = await this.get("platform/config");
    const entries = parseConfigPage(html);
    if (entries.length === 0) {
      throw new ToolError(
        "HAC_ERROR",
        "Could not find configuration properties on HAC's platform/config page. The page layout may differ in this SAP Commerce version."
      );
    }
    return entries;
  }

  /** Logs in (if needed) and runs a trivial read-only query. Used by the connection test. */
  async checkConnection(): Promise<{ ok: true; user: string; baseUrl: string }> {
    await this.flexibleSearch("SELECT {pk} FROM {Language}", { maxCount: 1 });
    return { ok: true, user: this.options.config.user, baseUrl: this.options.config.baseUrl.origin + this.options.config.baseUrl.pathname };
  }

  // ---------------------------------------------------------------- transport

  private clean(text: string): string {
    return this.redact(text).slice(0, 600);
  }

  private url(path: string): string {
    return new URL(path.replace(/^\//, ""), this.options.config.baseUrl).toString();
  }

  private async post(path: PostPath, body: Record<string, string>, retry = true): Promise<string> {
    if (!(POST_PATHS as readonly string[]).includes(path)) throw new ToolError("INTERNAL", "Blocked HAC endpoint.");
    await this.ensureAuthenticated();
    const response = await this.request(path, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        cookie: this.cookieHeader(),
        accept: "application/json, text/html, */*",
        "x-csrf-token": this.csrf ?? ""
      },
      body: new URLSearchParams({ ...body, _csrf: this.csrf ?? "" }).toString(),
      redirect: "manual"
    });
    this.storeCookies(response.headers);

    // HAC answers a rejected/expired CSRF token with 405 (not 403).
    if ((this.needsLogin(response) || response.status === 405) && retry) {
      this.resetSession();
      return this.post(path, body, false);
    }
    return this.readBody(path, response);
  }

  private async get(path: GetPath, retry = true): Promise<string> {
    if (!(GET_PATHS as readonly string[]).includes(path)) throw new ToolError("INTERNAL", "Blocked HAC endpoint.");
    await this.ensureAuthenticated();
    const response = await this.request(path, {
      method: "GET",
      headers: { cookie: this.cookieHeader(), accept: "text/html" },
      redirect: "manual"
    });
    this.storeCookies(response.headers);
    if (this.needsLogin(response) && retry) {
      this.resetSession();
      return this.get(path, false);
    }
    return this.readBody(path, response);
  }

  private async readBody(path: string, response: Response): Promise<string> {
    const text = await response.text();
    if (text.length > MAX_RESPONSE_CHARS) throw new ToolError("HAC_ERROR", "HAC response is too large.");
    if (!response.ok) {
      throw new ToolError("HAC_ERROR", `HAC ${path || "/"} failed with HTTP ${response.status}: ${this.clean(stripTags(text))}`);
    }
    return text;
  }

  private resetSession(): void {
    this.csrf = undefined;
    this.cookies.clear();
  }

  private async ensureAuthenticated(): Promise<void> {
    if (this.csrf && this.cookies.size > 0) return;
    this.loginInFlight ??= this.login().finally(() => {
      this.loginInFlight = undefined;
    });
    await this.loginInFlight;
  }

  private async login(): Promise<void> {
    const { user, pass } = this.options.config;
    const loginPage = await this.request("login", {
      method: "GET",
      headers: { cookie: this.cookieHeader(), accept: "text/html" },
      redirect: "manual"
    });
    this.storeCookies(loginPage.headers);
    const preCsrf = extractCsrf(await loginPage.text());
    if (!preCsrf) throw new ToolError("HAC_ERROR", "Could not find the HAC login _csrf token. Is HAC_URL pointing at the /hac context?");

    const response = await this.request("j_spring_security_check", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8", cookie: this.cookieHeader() },
      body: new URLSearchParams({ j_username: user, j_password: pass, _csrf: preCsrf }).toString(),
      redirect: "manual"
    });
    this.storeCookies(response.headers);
    if (![200, 302, 303].includes(response.status)) {
      throw new ToolError("HAC_AUTH", `HAC login failed with HTTP ${response.status}.`);
    }

    const landing = await this.request("", {
      method: "GET",
      headers: { cookie: this.cookieHeader(), accept: "text/html" },
      redirect: "manual"
    });
    this.storeCookies(landing.headers);
    if (this.needsLogin(landing) || !landing.ok) {
      throw new ToolError("HAC_AUTH", "HAC login did not establish an authenticated session. Check HAC_USER and HAC_PASS.");
    }
    // Spring rotates the CSRF token on authentication; the pre-login token is never a valid fallback.
    const sessionCsrf = extractCsrf(await landing.text());
    if (!sessionCsrf) throw new ToolError("HAC_ERROR", "Could not find the post-login HAC _csrf token.");
    this.csrf = sessionCsrf;
  }

  private needsLogin(response: Response): boolean {
    const location = response.headers.get("location") ?? "";
    return (
      response.status === 401 ||
      response.status === 403 ||
      (response.status >= 300 && response.status < 400 && /login|j_spring_security_check/i.test(location))
    );
  }

  private async request(path: string, init: Record<string, unknown>): Promise<Response> {
    const { timeoutMs } = this.options.config;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetchImpl(this.url(path), { ...init, signal: controller.signal });
    } catch (error) {
      throw this.mapNetworkError(error, timeoutMs);
    } finally {
      clearTimeout(timer);
    }
  }

  private mapNetworkError(error: unknown, timeoutMs: number): ToolError {
    if (error instanceof ToolError) return error;
    const err = error as { name?: string; code?: string; cause?: { code?: string; message?: string }; message?: string };
    const code = err.cause?.code ?? err.code ?? "";
    const host = this.options.config.baseUrl.host;
    if (err.name === "AbortError") {
      return new ToolError("HAC_TIMEOUT", `HAC did not answer within ${timeoutMs} ms (HAC_TIMEOUT_MS).`);
    }
    if (/CERT|SELF_SIGNED|TLS|SSL|UNABLE_TO_VERIFY/i.test(code)) {
      return new ToolError(
        "HAC_TLS",
        `TLS verification failed for ${host} (${code}). For a local HAC with a self-signed certificate set HAC_INSECURE_TLS=true.`
      );
    }
    if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ECONNRESET|EAI_AGAIN/i.test(code)) {
      return new ToolError("HAC_UNREACHABLE", `Cannot reach HAC at ${host} (${code}). Is SAP Commerce running and HAC_URL correct?`);
    }
    return new ToolError("HAC_UNREACHABLE", `HAC request failed: ${this.clean(err.message ?? String(error))}`);
  }

  private cookieHeader(): string {
    return Array.from(this.cookies, ([name, value]) => `${name}=${value}`).join("; ");
  }

  private storeCookies(headers: Headers): void {
    const withMethod = headers as Headers & { getSetCookie?: () => string[] };
    const setCookies = typeof withMethod.getSetCookie === "function" ? withMethod.getSetCookie() : [headers.get("set-cookie") ?? ""];
    for (const header of setCookies) {
      const pair = header.split(";")[0] ?? "";
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
}
