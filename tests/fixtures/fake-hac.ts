import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A minimal in-process imitation of the HAC endpoints this project uses (login + CSRF + flexsearch +
 * platform/config). It is a SYNTHETIC fixture built from the reference implementation's handling of
 * HAC, not a recording of a real SAP Commerce instance.
 */
export interface FakeHacOptions {
  user?: string;
  pass?: string;
  /** Map a FlexibleSearch query to a HAC-style JSON payload. */
  flex?: (query: string) => Record<string, unknown>;
  configHtml?: string;
  /** Respond 405 once to the first execute call (stale CSRF) to exercise re-login. */
  staleCsrfOnce?: boolean;
  delayMs?: number;
}

export interface FakeHac {
  url: string;
  requests: Array<{ method: string; path: string; body: string }>;
  queries: string[];
  logins: number;
  close(): Promise<void>;
}

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });

export const DEFAULT_CONFIG_HTML = `<table>
<tr><td>build.version</td><td>6.7.0.1</td></tr>
<tr><td>db.password</td><td><input type="text" value="hunter2-db"/></td></tr>
<tr><td>media.default.url</td><td>https://media.example.test/</td></tr>
<tr><td>some.api.key</td><td>abcdef123456</td></tr>
</table>`;

export async function startFakeHac(opts: FakeHacOptions = {}): Promise<FakeHac> {
  const user = opts.user ?? "admin";
  const pass = opts.pass ?? "nimda";
  const state = { stale: !!opts.staleCsrfOnce };
  const requests: FakeHac["requests"] = [];
  const queries: string[] = [];
  const handle: FakeHac = { url: "", requests, queries, logins: 0, close: async () => {} };

  const server: Server = createServer(async (req, res) => {
    const body = await readBody(req);
    const path = (req.url ?? "").split("?")[0] as string;
    requests.push({ method: req.method ?? "", path, body });
    const cookie = req.headers.cookie ?? "";
    const authed = cookie.includes("JSESSIONID=auth");
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));

    if (path === "/hac/login" && req.method === "GET") {
      res.writeHead(200, { "set-cookie": "JSESSIONID=pre; Path=/hac" });
      return void res.end('<form><input type="hidden" name="_csrf" value="pre-csrf"/></form>');
    }
    if (path === "/hac/j_spring_security_check" && req.method === "POST") {
      const p = new URLSearchParams(body);
      if (p.get("j_username") === user && p.get("j_password") === pass && p.get("_csrf") === "pre-csrf") {
        handle.logins++;
        res.writeHead(302, { location: "/hac/", "set-cookie": "JSESSIONID=auth; Path=/hac" });
      } else {
        res.writeHead(302, { location: "/hac/login?error=true" });
      }
      return void res.end();
    }
    if (!authed) {
      res.writeHead(302, { location: "/hac/login" });
      return void res.end();
    }
    if (path === "/hac/" && req.method === "GET") {
      res.writeHead(200);
      return void res.end('<meta name="_csrf" content="session-csrf"/>');
    }
    if (path === "/hac/platform/config" && req.method === "GET") {
      res.writeHead(200);
      return void res.end(opts.configHtml ?? DEFAULT_CONFIG_HTML);
    }
    if ((path === "/hac/console/flexsearch/execute" || path === "/hac/console/flexsearch/translate") && req.method === "POST") {
      const p = new URLSearchParams(body);
      if (p.get("_csrf") !== "session-csrf" || state.stale) {
        state.stale = false;
        res.writeHead(405);
        return void res.end("csrf");
      }
      const q = p.get("flexibleSearchQuery") ?? "";
      queries.push(q);
      res.writeHead(200, { "content-type": "application/json" });
      if (path.endsWith("translate")) return void res.end(JSON.stringify({ query: "SELECT t0.PK FROM products t0" }));
      return void res.end(JSON.stringify(opts.flex ? opts.flex(q) : { headers: ["PK"], resultList: [["8796093054977"]], resultCount: 1 }));
    }
    res.writeHead(404);
    res.end("not found");
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  handle.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hac`;
  handle.close = () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); });
  return handle;
}
