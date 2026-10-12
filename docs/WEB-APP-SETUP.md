# Web application setup

The web workbench is a local Node process that serves a UI and a small JSON API on your own machine. It works without any MCP client. Without an AI provider key everything except the **AI assistant** view works.

> **Local development only. Strictly read-only.** It binds to loopback and refuses to listen on any other address.

## 1. Prerequisites and installation

* Node.js ≥ 22.19, npm
* A running local SAP Commerce with HAC ([SAP-COMMERCE-CONNECTION.md](SAP-COMMERCE-CONNECTION.md))
* Optional, for the assistant: an API key from OpenAI, Anthropic or Google. **API use is billed by the provider** and is separate from ChatGPT, Claude.ai, Gemini or GitHub Copilot subscriptions.

```bash
git clone https://github.com/ritangkar/sap-commerce-mcp.git
cd sap-commerce-mcp
npm ci
cp .env.example .env     # edit it, see below
npm run build            # builds dist/ (server) and dist/web/static (UI)
npm run start:web
```

Expected stderr output:

```
SAP Commerce read-only workbench: http://localhost:3737  (bound to 127.0.0.1 only)
AI providers configured: anthropic          # or "none (the AI assistant is disabled until an API key is set)"
```

Open <http://localhost:3737>. The port is `WEB_PORT` (default `3737`); `WEB_HOST` can only be a loopback address. If the port is taken the process exits with `Port … is already in use. Set WEB_PORT …`.

After rebuilding the UI, restart `npm run start:web` (the server caches `index.html`).

## 2. HAC connection

Set in `.env`:

```
HAC_URL=https://localhost:9002/hac
HAC_USER=your-hac-user
HAC_PASS=your-hac-password
HAC_INSECURE_TLS=true          # only for a local HAC with a self-signed certificate
HAC_LOG_PATH=/path/to/hybris/log/tomcat/console-YYYYMMDD.log   # optional, for the Console log view
```

Open **Overview**. The HAC card shows what is configured (URL, user, TLS state – never the password). *Configured does not mean reachable*: press **Test HAC connection**. It logs in and runs one read-only query (`SELECT {pk} FROM {Language}`) and then reports success or the exact failure (`HAC_AUTH`, `HAC_UNREACHABLE`, `HAC_TLS`, `HAC_TIMEOUT`…). The success message is a point-in-time statement and says so.

The server starts even when HAC is not configured, so you can see what is missing; tools then fail with `CONFIG_MISSING` and an actionable message.

## 3. Providers, models and credentials

Credentials are **environment variables of the server process only**:

| Provider | Variable | Default models (override with `*_MODELS`) |
| --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` | `gpt-5.5` |
| Anthropic Claude | `ANTHROPIC_API_KEY` | `claude-sonnet-5-5`, `claude-opus-5-5`, `claude-haiku-5-5` |
| Google Gemini | `GEMINI_API_KEY` | `gemini-3.1-pro-preview`, `gemini-3-flash-preview` |

Model ids change; the defaults live in [`src/config/env.ts`](../src/config/env.ts) (`DEFAULT_MODELS`) and **must be checked against each provider's current documentation**. Override without touching code, e.g. `OPENAI_MODELS=gpt-5.5,gpt-5.5-mini` and `OPENAI_MODEL=gpt-5.5-mini` for the default. The API accepts only models from that configured list.

How credentials are handled:

* Keys are read from the environment at startup and held in the server process. There is **no credential form** in the UI, so keys never travel from the browser, are never returned by the API (the status endpoint reports only *configured / not configured*), never appear in URLs, logs or client-visible errors (they are scrubbed from every message), and are not stored in `localStorage`/`sessionStorage`. The browser stores only your selected provider and model names.
* Every developer sets their own keys on their own machine; do not copy keys between computers.

**Provider connection test** (Overview → *Test <provider>*): calls the provider's *get model* endpoint for the selected model – this verifies the key **and** that the model exists without generating tokens. Typical results: `PROVIDER_AUTH` (bad key), `PROVIDER_MODEL` (model id unknown to the provider), `PROVIDER_QUOTA`/`PROVIDER_RATE_LIMIT`, `PROVIDER_TIMEOUT`. Switching providers or models never changes the tools; all providers share the same allow-list and execution layer.

## 4. First-query walkthrough

1. **Overview** → *Test HAC connection* → green "Connected and authenticated".
2. **FlexibleSearch** → the editor holds an example. Press **Run query** (or Ctrl/⌘+Enter). A table appears; use the filter box, click column headers to sort, **Copy CSV / Copy JSON**. If the result is capped you will see a "truncated" notice.
3. Try an unsupported query, e.g. `DELETE FROM {Product}`: you get `QUERY_REJECTED` with the reason, and the query is **not sent** to HAC.
4. **Type system** → `Product` → *Inspect type*. **CronJobs** → *Load CronJobs* → click a row to re-read one job's status. **Configuration** → filter e.g. `solr`. **Console log** → *Load log* (needs `HAC_LOG_PATH`).
5. **AI assistant** → choose provider/model → click a suggestion or ask e.g. *"Which CronJobs failed recently?"*.

The steps that return data need a live HAC; the UI, validation errors and empty/error states can be checked without one.

## 5. How AI tool calling works

1. Your question and the descriptions/JSON-schemas of the five approved tools go to the selected provider.
2. If the model requests a tool, the backend looks the name up in the allow-list and validates the arguments against the tool's strict schema. Unknown tools and invalid arguments become *failed* tool calls, never executions.
3. The tool runs in the shared core (read-only validation, HAC call, redaction, size limit).
4. The result (clipped to `AI_TOOL_RESULT_CHARS`) is returned to the model, which answers or asks for another tool.
5. Limits: at most `AI_MAX_TOOL_CALLS` (8) tool calls and `AI_MAX_STEPS` (10) model round trips per question, `AI_REQUEST_TIMEOUT_MS` (120 s) overall, identical repeated calls are blocked, and after the limit the model gets one final turn **without** tools.

Privacy: **tool results are sent to the provider you selected.** Query results and logs can contain personal or confidential data; do not use the assistant with data you may not share with that provider.

## 6. Reading results and errors

* **"Fetched from SAP Commerce"** (blue) marks real tool activity: expand a card to see the arguments the model requested and the exact data returned (as a table when tabular). **"AI-generated explanation"** (amber) is the model's prose. If no tool was called, the UI says so: such an answer is not based on your instance.
* A red tool card (`failed: QUERY_REJECTED`, `UNKNOWN_TOOL`, `INVALID_ARGUMENTS`, `HAC_*`) means that call did **not** run or did not succeed.
* Banners warn when a limit stopped the model (answer may be incomplete) or output was truncated.
* `****` in a cell means a value was masked as a secret.

## 7. Troubleshooting

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md): provider authentication, quotas, model incompatibility, timeouts and HAC connectivity are covered there.

## 8. Local API protections (for reference)

Loopback bind; `Host` must be `localhost|127.0.0.1|[::1]` with the actual port (DNS-rebinding defence); `Origin`/`Sec-Fetch-Site` must be same-origin; every `/api` call needs a random per-process token (injected into the page, sent as `x-local-token`); `POST` bodies must be `application/json` and ≤ 256 KiB; at most two concurrent chats. Details: [SECURITY.md](SECURITY.md).
