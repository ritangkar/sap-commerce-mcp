# Reference audit and capability inventory

Audit of **hybris-mcp-lite** (<https://github.com/andreescocard/hybris-mcp-lite>, commit cloned 2026-10-12, shallow) against this project's requirements. Everything below was read from the source, not just the README.

## What the reference implements

* TypeScript, ESM, Node, npm; `@modelcontextprotocol/sdk` (`McpServer` + `StdioServerTransport`) and `zod`; tests with `vitest`.
* Entry point `src/index.ts`; one `register()` per tool in `src/tools/*.ts`; `HacClient` in `src/hacClient.ts`.
* **Transport:** MCP over stdio only.
* **HAC session handling:** GET `login` → read `_csrf` → POST `j_spring_security_check` → GET landing page → read the *post-login* `_csrf` (Spring rotates it); cookies kept in a map; redirects handled manually; 401/403/login-redirect and **405** (HAC's answer to a stale CSRF token) trigger one re-login; per-request timeout via `AbortController` (`HAC_TIMEOUT_MS`, default 30 s).
* **TLS:** `HAC_INSECURE_TLS=true` sets `NODE_TLS_REJECT_UNAUTHORIZED=0` **process-wide**.
* **Host guard:** refuses non-private hosts unless `HAC_ALLOW_REMOTE=true`.
* **Security controls present:** private-host guard, opt-in insecure TLS, config masking (`pass|secret|token|key|credential`, `config_get` only), `commit=false` on Groovy submissions, input caps on `flexible_search` (≤200 rows) and `logs_tail` (≤2000 lines).
* **Tests:** `test/parsers.test.ts` covers HTML parsing, CSRF extraction, host guard and config masking only. No test exercises HAC requests, tools or MCP. `scripts/smoke.ts` runs every tool against a live HAC.
* **License:** MIT, Copyright (c) 2026 André Escocard → notice preserved in `LICENSE`/`NOTICE.md`.
* **Known caveats (README):** masking applies to `config_get` only; log and monitoring output is unmasked.

## Capability inventory

Legend – *Risk*: side-effect risk of the **reference implementation**. *Here*: decision for this project.

| Reference tool | Purpose | Source | Inputs → output | Talks to | Reference risk | MCP | Web UI | Reference tests | Decision / restrictions here |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `flexible_search` | Run FlexibleSearch / translate to SQL | `tools/search.ts`, `hacClient.flexibleSearch` | `query`, `maxCount` 1–200, `translate` → `{columns, rows, truncated}` or `{sql}` | HAC `console/flexsearch/execute` / `translate` | **Query was forwarded unvalidated.** HAC's FlexibleSearch console is SELECT-only by design, but the reference relies entirely on that. | ✅ | ✅ FlexibleSearch view | HTML parser only | **Kept**, behind a strict allow-list validator applied twice (tool layer and HAC client). Result also gains `rowCount`, duplicate column names are de-duplicated, secret-like columns masked. |
| `type_info` | Type attributes, deployment table, sub types | `tools/typesystem.ts` + Groovy `typeInfo` | `type` → code, super type, table, jalo/item class, attributes, sub types | HAC **scripting console (Groovy)** | **Executes Groovy** in the Commerce JVM (`commit=false` only affects DB transactions, not JVM side effects). | ✅ | ✅ Type system view | none | **Re-implemented without Groovy** using read-only FlexibleSearch on `ComposedType` / `AttributeDescriptor`. **Dropped:** deployment table, jalo/item class (not available via FlexibleSearch). **Added:** `includeInherited`, abstract flag. Type code restricted to `[A-Za-z][A-Za-z0-9_]{0,99}`. |
| `config_get` | Read configuration | `tools/config.ts` + Groovy `configGet` | `key?` → value or all properties | Groovy (`configurationService`) | Groovy execution | ✅ | ✅ Configuration view | masking only | **Re-implemented without Groovy** by reading HAC's `platform/config` page (GET) and parsing the table. Masking extended (`pass…`, `secret`, `token`, `key`, `credential`, `auth`, `private`, `cert`, `salt`, …) and applied to values with embedded credentials. Added `filter`; capped at 500 entries. **Parser is untested against a live HAC** and may need adjusting per version. |
| `beans_info` | Spring bean class and aliases | `tools/beans.ts` + Groovy `beanInfo` | `name` → class, target class, aliases | Groovy (`spring.getBean(name)`) | **Executes Groovy; `getBean` can instantiate/initialise beans.** | ❌ | ❌ | none | **Excluded.** No read-only, non-scripting HAC endpoint for Spring beans is known/verified. Documented rather than weakened. |
| `logs_tail` | Tail console log | `tools/logs.ts`, `hacClient.logsTail` | `lines` 1–2000, `grep?` → last lines | **Local file** (`HAC_LOG_PATH`) | `new RegExp(grep)` from model input (ReDoS); whole file read into memory; unmasked output | ✅ | ✅ Console log view | none | **Kept**, `grep` is now a plain case-insensitive substring; only the last 4 MiB are read; best-effort secret redaction; path from config only. |
| `cronjob` | List / read CronJob status | `tools/cronjob.ts` + Groovy `cronjob` | `action` list/status, `code?` | Groovy running a FlexibleSearch | Groovy execution (the logic itself is read-only) | ✅ | ✅ CronJobs view | none | **Re-implemented** as read-only FlexibleSearch (adds start/end time). No trigger/abort/modify exists. `code` validated against a strict pattern. |
| `monitoring_info` | Memory, threads, thread dump, cache, cluster | `tools/monitoring.ts` + Groovy `monitoring` | `section` → diagnostics | Groovy (`Runtime`, `ThreadMXBean`, `cacheController`, `clusterService`) | **Executes Groovy**; thread dumps and cache/cluster beans touch live runtime state; output unmasked | ❌ | ❌ | none | **Excluded.** Same reason as `beans_info`. A future version could add diagnostics only via a verified GET-only HAC page. |

### Unsafe or incompatible behaviour found

1. **Groovy scripting console** is the only code path for five of seven tools. It is a general code-execution channel into the Commerce JVM; this project's rules forbid it. `commit=false` is not a read-only guarantee.
2. **Process-wide TLS disable** (`NODE_TLS_REJECT_UNAUTHORIZED=0`) would also weaken TLS to AI providers once an AI layer exists. Replaced by a dispatcher scoped to HAC requests.
3. **`HAC_ALLOW_REMOTE` override** removed (no remote-environment support).
4. **Regex from model input** in `logs_tail` → replaced by substring matching.
5. **Unvalidated FlexibleSearch** → validator.
6. Error messages included up to 2000 characters of raw HAC response → shortened and redacted.

### Destination repository state at the start

Empty: no commits, no files, no uncommitted work. Nothing existed to preserve.
