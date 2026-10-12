# MCP setup

Use this guide to connect an MCP client to the read-only SAP Commerce server. The MCP server is a local child process that your client starts and talks to over **stdio**. It does **not** need the web UI, and it needs no AI-provider key (your client supplies the model).

> **Local development only.** Point it at your own local/dev SAP Commerce. See [SECURITY.md](SECURITY.md).

## Verification status (read this first)

| Client | What was verified | What was not |
| --- | --- | --- |
| Generic MCP over stdio | `tests/integration/mcp.test.ts`: the official MCP SDK client lists the tools and calls them against the server both in-process and as a **spawned child process** (`node --import tsx src/mcp/main.ts`) talking to a fake HAC | – |
| GitHub Copilot in VS Code | Configuration format taken from the VS Code MCP configuration reference and GitHub's Copilot MCP policy docs | The real VS Code / Copilot client was **not** run by the authors |
| Claude Code | `claude mcp add` syntax, `.mcp.json` shape and `claude mcp list` checked against Claude Code's MCP documentation | The real Claude Code client was **not** run by the authors |
| Claude Desktop | – | **Untested** |
| Other clients | – | **Untested** |

Steps that need a live SAP Commerce instance (any real tool result) are marked ⚠ *live*. Nobody has run them for you; follow the verification section on your machine.

## 1. Prerequisites

* Node.js ≥ 22.19 (`node -v`)
* A running local SAP Commerce with HAC, and a HAC user (see [SAP-COMMERCE-CONNECTION.md](SAP-COMMERCE-CONNECTION.md))
* This repository built:

```bash
git clone https://github.com/ritangkar/sap-commerce-mcp.git
cd sap-commerce-mcp
npm ci
npm run build
pwd          # note this absolute path; clients need it
```

The server entry point is `dist/mcp/main.js`. The commands below call it `/ABS/PATH/sap-commerce-mcp/dist/mcp/main.js` – replace the prefix with your `pwd`. On Windows use a full path such as `C:\\Users\\you\\sap-commerce-mcp\\dist\\mcp\\main.js` in JSON.

## 2. How the client launches and talks to the server

The client starts `node /ABS/PATH/.../dist/mcp/main.js` itself and exchanges JSON-RPC messages over the process's stdin/stdout (MCP stdio transport). stdout is reserved for the protocol; diagnostics go to **stderr**. On startup the server:

1. loads `.env` from the repository root (variables already set by the client's `env` block take precedence; set `SAP_COMMERCE_MCP_NO_DOTENV=1` to skip `.env`),
2. validates the HAC settings and **exits with code 1 and an actionable stderr message** if `HAC_USER`/`HAC_PASS` are missing or the HAC host is not local/private,
3. registers the five read-only tools and waits for requests. It prints `sap-commerce-mcp: read-only MCP server ready (HAC …)` to stderr.

It logs in to HAC lazily, on the first tool call.

## 3. HAC settings

Either put them in `.env` in the repository root (simplest; the same file serves the web app), or pass them in the client's `env` block (examples below). Variables: `HAC_URL`, `HAC_USER`, `HAC_PASS`, optional `HAC_TIMEOUT_MS`, `HAC_INSECURE_TLS`, `HAC_LOG_PATH`. See [`.env.example`](../.env.example).

> Do not commit a client config file that contains your real password. Prefer `.env` (git-ignored) or VS Code's prompted input shown below.

## 4. GitHub Copilot in VS Code

Scope: this section covers **Copilot Chat agent mode in Visual Studio Code**. Other GitHub Copilot surfaces (JetBrains IDEs, Visual Studio, Xcode, github.com, Copilot cloud agent) have separate MCP support and policies and are **not covered or verified here**.

Requirements (check against current VS Code/GitHub documentation):

* A recent VS Code with GitHub Copilot Chat and agent mode.
* A Copilot plan that permits MCP servers. For Copilot Business/Enterprise the **"MCP servers in Copilot"** policy is controlled by the organization/enterprise and, per GitHub's documentation, is disabled by default. If it is disabled, VS Code will not run the server and only an administrator can enable it (Organization settings → Copilot → Policies → *MCP servers in Copilot*; enterprise: AI controls → MCP). Administrators can also restrict MCP servers by registry/allowlist, which may block a locally defined server.

Create `.vscode/mcp.json` in a workspace (or run **MCP: Add Server** / **MCP: Open User Configuration** from the Command Palette for a user-level file). Using VS Code's prompted input keeps the password out of the file:

```json
{
  "inputs": [
    { "type": "promptString", "id": "hac-pass", "description": "HAC password (local dev instance)", "password": true }
  ],
  "servers": {
    "sap-commerce": {
      "type": "stdio",
      "command": "node",
      "args": ["/ABS/PATH/sap-commerce-mcp/dist/mcp/main.js"],
      "env": {
        "HAC_URL": "https://localhost:9002/hac",
        "HAC_USER": "admin",
        "HAC_PASS": "${input:hac-pass}",
        "HAC_INSECURE_TLS": "true",
        "HAC_LOG_PATH": "/path/to/hybris/log/tomcat/console-YYYYMMDD.log"
      }
    }
  }
}
```

Notes: set `HAC_INSECURE_TLS` to `"true"` only if your local HAC uses a self-signed certificate (see [SAP-COMMERCE-CONNECTION.md](SAP-COMMERCE-CONNECTION.md#tls)); drop `HAC_LOG_PATH` if you do not need `logs_tail`; if you keep the settings in `.env` you can omit the whole `env` block.

Start and verify:

1. Command Palette → **MCP: List Servers** → `sap-commerce` → **Start** (VS Code also offers a start action inline in `mcp.json`). The status should become *Running*. **Show Output** displays the server's stderr, which should contain `read-only MCP server ready`.
2. Open Copilot Chat, switch to **Agent** mode, open the tools picker and confirm the five tools appear under `sap-commerce`: `flexible_search`, `type_info`, `config_get`, `logs_tail`, `cronjob`.
3. ⚠ *live* Ask: *"Using sap-commerce, list the 5 most recent CronJobs."* VS Code asks you to confirm the tool call; the result is the CronJob list from your instance.

## 5. Claude Code

```bash
claude mcp add --transport stdio --env HAC_URL=https://localhost:9002/hac --env HAC_USER=admin --env HAC_PASS='your-local-password' --env HAC_INSECURE_TLS=true sap-commerce -- node /ABS/PATH/sap-commerce-mcp/dist/mcp/main.js
```

* `--` separates Claude's options from the server command. Keep another option (here `--transport stdio`) between the last `--env` and the server name, as the CLI otherwise reads the name as an env pair.
* Default scope is `local` (private to you, stored in `~/.claude.json`). Do **not** use `--scope project` with a real password, because that writes `.mcp.json` into the repository.
* If your settings live in `.env`, you can omit all `--env` flags: `claude mcp add --transport stdio sap-commerce -- node /ABS/PATH/sap-commerce-mcp/dist/mcp/main.js`.

Verify:

```bash
claude mcp list         # sap-commerce should show "✔ Connected"
claude mcp get sap-commerce
```

Inside Claude Code run `/mcp` and check that `sap-commerce` is connected and lists its five tools. ⚠ *live*: ask *"Use sap-commerce to run SELECT {code} FROM {CronJob} and show me the first rows."*

A project-shared `.mcp.json` (without secrets) can use environment expansion, e.g. `"HAC_PASS": "${HAC_PASS}"`; Claude Code asks you to approve project-scoped servers on first use.

## 6. Claude Desktop – untested

Claude Desktop reads an `mcpServers` object from its `claude_desktop_config.json`. The entry has the same shape as the reference project's documented configuration and should work, but **it has not been tested here**:

```json
{
  "mcpServers": {
    "sap-commerce": {
      "command": "node",
      "args": ["/ABS/PATH/sap-commerce-mcp/dist/mcp/main.js"],
      "env": { "HAC_USER": "admin", "HAC_PASS": "your-local-password" }
    }
  }
}
```

## 7. Generic stdio clients and manual check without a client

Any stdio MCP client needs: command `node`, args `[".../dist/mcp/main.js"]`, and the HAC environment. To exercise the protocol by hand without HAC credentials being used (no tool call → no HAC traffic):

```bash
HAC_USER=x HAC_PASS=y SAP_COMMERCE_MCP_NO_DOTENV=1 node dist/mcp/main.js
# paste, then press Enter:
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"manual","version":"0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
```

Expected: a response to `id` 2 listing the five tools (all with `readOnlyHint: true`).

## 8. First-use examples (⚠ live)

* "What attributes does `Product` have, and which are localized?" → `type_info`
* "Which CronJobs finished with an error?" → `cronjob`, then `flexible_search` if needed
* "Find the 10 most recently modified products." → `flexible_search`
* "Show the value of `build.version` and anything about `solr` in the configuration." → `config_get`
* "Show recent ERROR lines from the console log." → `logs_tail` (needs `HAC_LOG_PATH`)

The model can only call those five read-only tools; requests to modify data are rejected by code.

## 9. Troubleshooting

More entries are in [TROUBLESHOOTING.md](TROUBLESHOOTING.md). The most common:

| Symptom | Fix |
| --- | --- |
| Server fails to start, stderr says `Missing or invalid HAC settings` | Set `HAC_USER`/`HAC_PASS` in `.env` or the client `env` block |
| `Refusing HAC host …` | HAC must be localhost/private (see [SAP-COMMERCE-CONNECTION.md](SAP-COMMERCE-CONNECTION.md#networking)) |
| `spawn node ENOENT` / client cannot find node | Use the absolute path to `node` as `command` (`which node`), especially with nvm/Volta |
| `Cannot find module …/dist/mcp/main.js` | Run `npm run build`; use an **absolute** path |
| Startup errors about missing Node features or modules | Node is too old; use ≥ 22.19 (`node -v`) |
| Tools do not appear | Restart the server from the client; check the client's MCP output panel; in Copilot check the organization policy and that you are in **Agent** mode |
| Garbled protocol / `Unexpected token` | Something wrote to stdout. Do not wrap the command in a script that prints to stdout |
| Tool returns `HAC_AUTH`, `HAC_UNREACHABLE`, `HAC_TLS` | See [SAP-COMMERCE-CONNECTION.md](SAP-COMMERCE-CONNECTION.md) |
| Tool returns `QUERY_REJECTED` | The query uses something outside the supported read-only subset; the message says what and where |
