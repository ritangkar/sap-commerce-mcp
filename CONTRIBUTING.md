# Contributing

Please read the scope rules first: this project is a **local-development, strictly read-only** SAP Commerce inspection tool. Contributions that add write capability, scripting, generic HTTP/exec tools, production presets or remote-environment support will not be accepted. Keep it separate from code-generation or OCC-generation projects.

## Project structure

```
src/
  config/env.ts            environment parsing/validation (single source of truth for settings)
  core/                    SHARED, entry-point independent
    tools/                 allowlist.ts, definitions.ts (the tools), registry.ts (validate+execute), types.ts
    validation/            flexsearch-validator.ts (read-only allow-list validator)
    security/redact.ts     secret redaction
    results/limits.ts      output size limiting
    errors.ts, create-context.ts
  commerce/                hac-client.ts (HAC auth + 3 read ops), html-parse.ts, log-reader.ts, host-guard.ts
  mcp/                     server.ts (adapter), main.ts (stdio entry point)
  ai/                      types.ts, orchestrator.ts (tool-calling loop), providers/{openai,anthropic,gemini,index}.ts
  web/backend/             server.ts (API + static), security.ts, main.ts (entry point)
  web/frontend/            React + Vite UI (own tsconfig, bundler resolution)
tests/
  unit/ security/ integration/ frontend/ fixtures/ live/(opt-in)
docs/
```

Rules of the architecture: `mcp/` and `web/` are adapters over `core/` and must not contain SAP Commerce logic; `core/` and `ai/` must not import `fs`/`child_process` (enforced by ESLint); the MCP entry point must not import the web server and vice versa.

## Commands

```bash
npm ci                 # install exactly from the lockfile
npm run build          # build:server (tsc -> dist/) + build:web (vite -> dist/web/static)
npm test               # vitest: everything except tests/live
npm run typecheck      # tsc for backend and frontend
npm run lint           # eslint
npm run dev:mcp        # run the MCP server from source (tsx)
npm run dev:web        # run the web backend from source (build:web first for the UI)
LIVE_HAC=1 npm run test:live   # optional, read-only, your own local HAC
```

Before sending a change: `npm run typecheck && npm run lint && npm test && npm run build`.

## Conventions

* TypeScript strict, ESM (`.js` extensions in backend imports). Match the surrounding style; comments explain *why*.
* Errors thrown to callers are `ToolError` with a code from `core/errors.ts`; never include secrets in messages (the redactor is a safety net, not a licence).
* No new dependency unless it clearly earns its place; no UI component/animation libraries.
* Tests never need a live HAC or a real API key. Use `tests/fixtures/fake-hac.ts` and mocked SDK clients. Never write a test that mutates a real database.

## Adding a read-only tool

1. Decide whether it is truly read-only **by reading its implementation**. If it needs Groovy/scripting, a write endpoint, a file write or arbitrary HTTP, do not add it.
2. If it needs a new HAC endpoint: add it (GET only unless it is a read-only POST like flexsearch) to the hard-coded `GET_PATHS`/`POST_PATHS` in `src/commerce/hac-client.ts`, expose it through the `HacPort` interface, add parsing in `html-parse.ts`, and extend the endpoint allow-list test in `tests/unit/hac-client.test.ts`.
3. Define the tool in `src/core/tools/definitions.ts`: a strict zod schema (`.strict()`, bounded strings/numbers, patterns for anything interpolated into queries), a precise description saying it is read-only, and a `run` that returns plain data. Route every FlexibleSearch through `ctx.hac` (it validates).
4. Add the name to `APPROVED_TOOL_NAMES` and `ALL_TOOLS` – the registry throws if they diverge.
5. Redact output that can hold secrets; bound output size.
6. Tests: argument validation, happy path, error path, and a **negative safety test** (what must be rejected). Update the tool-list expectations in `tests/integration/*.test.ts`, `tests/frontend/app.test.tsx`.
7. UI (optional): add a view in `src/web/frontend/src/views/` and a route in `App.tsx`; it must call the real API – no decorative controls.
8. Docs: README capability table, `docs/REFERENCE-AUDIT.md` if it relates to the reference, `docs/SECURITY.md`, `docs/MCP-SETUP.md` examples if relevant.

## Adding an AI provider adapter

1. Implement `ProviderAdapter` (`src/ai/types.ts`) in `src/ai/providers/<name>.ts`: convert normalized `Turn[]` to the provider's messages, map tool specs to its function-calling format (JSON Schema from `toolset.list()`), map tool calls back to `ModelToolCall`, return `providerData` if the provider needs opaque blocks replayed (see Anthropic thinking blocks, Gemini thought signatures), classify errors with `classifyProviderError`, and implement a free `testConnection` (model lookup, not generation). Accept an injectable SDK client for tests.
2. Add the id to `ProviderId`/`PROVIDER_IDS` and `DEFAULT_MODELS` in `src/config/env.ts`, the key variable in `providerConfig`, and the adapter in `src/ai/providers/index.ts` (+ `ENV_VARS`).
3. The adapter must never execute tools itself. Tool execution stays in the orchestrator via the shared toolset.
4. Tests in `tests/unit/providers.test.ts` with a fake client: request mapping, response mapping, replay of provider data, errors, missing key.
5. Update `.env.example`, `docs/WEB-APP-SETUP.md` and `docs/TROUBLESHOOTING.md`.

## Tests and documentation are part of the change

A change that alters behaviour, configuration, commands or limits must update the tests and every affected document (README, `docs/*`, `.env.example`). Document what you did **not** verify instead of implying it works. Do not commit real credentials, tokens, customer data or internal endpoints.
