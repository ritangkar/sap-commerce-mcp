# Troubleshooting

Each entry: **problem → cause → fix**. Error codes appear in tool results (MCP), the UI and the web API.

## Build and dependencies

**`npm ci` fails with `EBADENGINE` / unsupported Node** → Node is older than 22.19 (the HTTP stack requires it). Install Node ≥ 22.19 and retry. Check with `node -v`.

**`npm ci` fails with lockfile errors** → the lockfile and `package.json` are out of sync, or a proxy blocks the registry. Use the committed lockfile; do not run `npm install` first. Behind a corporate proxy configure `npm config set proxy/https-proxy` and, if needed, `cafile`.

**`npm run build` fails in `vite build` or `tsc`** → run `npm run typecheck` for the precise error; delete `dist/` and retry. Make sure you ran `npm ci` in the repo root.

**Web UI shows a blank page or "Frontend is not built"** → run `npm run build` (or `npm run build:web`) and restart `npm run start:web`. After rebuilding the UI the server must be restarted (it caches `index.html`).

## MCP startup, transport and client configuration

**Server exits immediately; stderr: `Missing or invalid HAC settings: HAC_USER, HAC_PASS`** → set them in `.env` (repo root) or the client's `env` block. Variables from the client override `.env`.

**Client says the server failed to start / `spawn node ENOENT`** → use an absolute `command` path (`which node`), common with nvm/Volta/asdf where GUI apps do not inherit your shell PATH.

**`Cannot find module '…/dist/mcp/main.js'`** → run `npm run build`; use an absolute path in the client config.

**`Unexpected token` / JSON parse errors in the client** → something other than MCP wrote to stdout (wrapper script, `echo`, shell profile output). Run `node dist/mcp/main.js` directly; stdout must stay silent.

**Tools do not show up in Copilot** → use **Agent** mode; start the server via *MCP: List Servers*; in Copilot Business/Enterprise ask an administrator whether the *MCP servers in Copilot* policy is enabled and whether an allowlist/registry blocks local servers. Only VS Code is covered by this documentation.

**Claude Code: `✘ Failed to connect`** → run the server command by hand with the same env; check `claude mcp get sap-commerce`; remember project-scoped servers need approval (`claude mcp reset-project-choices` to re-prompt).

**Works in the terminal, not in the client** → the client's environment differs: pass `HAC_*` through the client's `env` block or rely on `.env` (the server looks in its working directory first, then in the repository root).

## HAC connection

**`HAC_UNREACHABLE … ECONNREFUSED`** → SAP Commerce is not running, wrong port, or `localhost` is not the machine hosting it (VM/container/WSL). Open `HAC_URL` in a browser from the same machine.

**`Refusing HAC host "…"`** → only localhost/private-network IPs and `*.local` are accepted; use the numeric private IP. There is deliberately no override.

**`HAC_TLS … SELF_SIGNED`** → trust your local certificate with `NODE_EXTRA_CA_CERTS=/path/ca.pem`, or, for your own local instance only, set `HAC_INSECURE_TLS=true`.

**`HAC_AUTH`** → wrong user/password, account locked, or the user cannot access HAC. Verify by logging in with a browser. Check `HAC_URL` includes the `/hac` context.

**`Could not find the HAC login _csrf token`** → `HAC_URL` points somewhere that is not HAC (missing `/hac`, or a reverse proxy login page).

**`HAC_TIMEOUT`** → heavy query or slow instance; narrow the query or raise `HAC_TIMEOUT_MS`.

**`HAC_QUERY_ERROR: HAC rejected the query: …`** → HAC itself rejected the query (unknown type/attribute, syntax). The message is HAC's. For `type_info`/`cronjob`, this can also mean your SAP Commerce version names an attribute differently; see [SAP-COMMERCE-CONNECTION.md](SAP-COMMERCE-CONNECTION.md#verification-status).

**`config_get` → `Could not find configuration properties on HAC's platform/config page`** → the page layout differs in your HAC version. Please open an issue with a redacted sample of the page structure; use the HAC UI meanwhile.

## Log files

**`LOG_UNAVAILABLE: HAC_LOG_PATH is not set`** → set the variable to the absolute path of the console log.

**`Log file not found or not readable`** → the daily file name changed (`console-YYYYMMDD.log`), the path is wrong, or the process lacks read permission; with containers, mount the log directory.

## Query validation

**`QUERY_REJECTED … Unsupported identifier 'x' outside { }`** → reference types and attributes with `{Type AS t}` / `{t:attribute}`; raw SQL is not supported.

**`… '…' is not allowed: only read-only SELECT queries are supported`** → the query contains a forbidden word. If it is an attribute that happens to share a name with one, alias it differently or query another way.

**`Query parameters (?name) are not supported`** → inline the value as a quoted literal.

**`'LIMIT' is not allowed`** → use the `maxCount` argument / *Max rows* selector.

**`Function 'x' is not on the read-only function allow-list`** → only the listed functions are supported (see [SECURITY.md](SECURITY.md)).

**`INVALID_ARGUMENTS`** → the arguments do not match the tool schema (wrong type, unknown key, value too large). The message names the field.

## AI providers (web mode)

**`PROVIDER_NOT_CONFIGURED`** → set the provider's key (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY`) in `.env` and restart `npm run start:web`. Keys cannot be entered in the UI.

**`PROVIDER_AUTH`** → key invalid, revoked, or for another organization/project. Create a new key in the provider's console.

**`PROVIDER_QUOTA` / `PROVIDER_RATE_LIMIT`** → exhausted credit or rate limit. API billing is separate from chat/IDE subscriptions; add credit or wait. 

**`PROVIDER_MODEL`, or `UNKNOWN_MODEL`** → the model id does not exist for your account, or is not in the configured list. Update `*_MODELS` / `*_MODEL` in `.env` after checking the provider's current model list.

**`PROVIDER_BAD_REQUEST`** → the provider rejected the request (often a model that does not support tool/function calling or the sampling/limit parameters used). Choose a tool-capable model.

**`PROVIDER_TIMEOUT` / `TIMEOUT`** → raise `AI_REQUEST_TIMEOUT_MS`, pick a faster model, or ask a narrower question.

**Answer says the tool-call limit was reached** → raise `AI_MAX_TOOL_CALLS` (≤ 25) or ask a narrower question.

**`BAD_TOKEN`, `BAD_HOST`, `BAD_ORIGIN`** → reload the page; open it as `http://localhost:<port>` (not via another host name, proxy or tunnel); the token is regenerated on every server start.

**`Port 3737 is already in use`** → set `WEB_PORT` to a free port.

## Running the tests

**`npm test` fails to find `jsdom` or similar** → run `npm ci`. The tests need no HAC and no API keys.

**`npm run test:live` shows all tests skipped** → set `LIVE_HAC=1` and the `HAC_*` variables.
