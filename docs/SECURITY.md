# Security

## Scope

* **Local development only.** For one developer, on their own machine, against an authorized development SAP Commerce instance. Not for production administration, shared hosting, CI servers or any higher environment. There are no production presets, and the HAC host guard has no override.
* **Strictly read-only.** The tool set can fetch, search, display and explain existing information. It cannot modify SAP Commerce data, configuration, jobs, files or runtime state.

This is a developer convenience tool, not a security product. The mechanisms below reduce risk; they are not a formal guarantee.

## Read-only enforcement strategy

Safety is enforced in code, in layers, independent of any model's behaviour:

1. **Explicit tool allow-list.** [`src/core/tools/allowlist.ts`](../src/core/tools/allowlist.ts) lists the five tools. The registry refuses to be constructed if it differs from that list, and tests pin the list. Tools are looked up in a `Map`, so names such as `__proto__` or `constructor` cannot resolve to anything. The `ToolDefinition` type can only be `readOnly: true`.
2. **Strict argument schemas** (zod, unknown keys rejected, string patterns for identifiers that are interpolated into queries – type codes and CronJob codes cannot contain quotes).
3. **FlexibleSearch validator** (below), applied in the tool *and again* inside the HAC client, which is the only function that sends queries. No caller can skip it.
4. **A HAC client with no generic request API.** Only login, the landing page, `GET platform/config` and `POST console/flexsearch/{execute,translate}` can be requested (hard-coded, type-restricted and asserted by a test). No Groovy/scripting console, ImpEx, SQL console, CronJob or monitoring endpoint. The client never sends HAC's SQL-mode flag.
5. **No dangerous capabilities exist to be called:** no shell, no file write, no outbound HTTP tool, no code execution. The log tool reads one configured file.
6. **One implementation for every entry point.** MCP, the web API and AI providers all call `toolset.execute()`; there is no second code path with different permissions.
7. **Output limits, timeouts and loop limits** (below).

Excluded on purpose: the reference project's Spring-bean and monitoring tools, because they run Groovy ([REFERENCE-AUDIT.md](REFERENCE-AUDIT.md)).

## FlexibleSearch validation and its limitations

`src/core/validation/flexsearch-validator.ts` tokenizes the query and accepts only a conservative subset:

* one statement beginning with `SELECT`; length ≤ 4000 characters, ≤ 800 tokens, ≤ 6 levels of nesting; no control characters;
* rejected outright: `;`, `--` and `/* */` comments, `?param` placeholders, double quotes/backticks/`#`/`$`/`&`, unterminated strings, unbalanced `{ } ( )`;
* rejected words anywhere outside string literals: `INSERT UPDATE DELETE REMOVE CREATE DROP ALTER TRUNCATE MERGE REPLACE UPSERT GRANT REVOKE EXEC EXECUTE CALL INTO SET BEGIN COMMIT ROLLBACK … FOR WITH LIMIT OFFSET SLEEP BENCHMARK …` (full list in the source);
* outside `{ … }` only allow-listed SQL keywords, allow-listed functions (`COUNT SUM AVG MIN MAX LOWER UPPER LENGTH TRIM LTRIM RTRIM SUBSTR SUBSTRING CONCAT COALESCE IFNULL NVL ABS ROUND FLOOR CEIL CEILING MOD`) and aliases after `AS` are accepted – so raw SQL table names and arbitrary database functions are rejected;
* a `FROM {…}` clause is required.

Limitations (be aware):

* It is **not** a complete FlexibleSearch parser; it may reject valid queries (e.g. attributes named like a forbidden word, `?parameters`, `LIMIT`) and says why. Rejecting is the intended failure mode.
* It does not understand semantics: a syntactically accepted `SELECT` can still be expensive (large joins, `LIKE '%…%'` scans) or read sensitive data. Row caps and timeouts reduce, not eliminate, load on your instance.
* It relies on HAC's FlexibleSearch console itself being a read-only query facility. A defect in HAC or its database layer would not be caught here.
* There is no formal verification. Treat it as one layer of defence together with the narrow HAC client and the allow-listed endpoints.

## Tool allow-listing, input validation, output limits, timeouts

* Arguments: strict schemas; `maxCount` ≤ 200; `lines` ≤ 2000; filters ≤ 100–300 characters.
* Results: capped at `TOOL_MAX_RESULT_CHARS` (default 100 000) by shrinking row/line arrays and flagging `truncated`; a smaller budget (`AI_TOOL_RESULT_CHARS`, 24 000) applies to what is fed back to a model. HAC responses are capped at 8 MB.
* Timeouts: `HAC_TIMEOUT_MS` per HAC request; `AI_REQUEST_TIMEOUT_MS` per assistant question; provider test 20 s.
* Assistant loop: ≤ `AI_MAX_TOOL_CALLS` tool calls and ≤ `AI_MAX_STEPS` model calls per question; identical repeated calls blocked; after a limit the model is called once more without tools; tool calls requested while tools are disabled are ignored. Model-generated names and arguments are untrusted input and validated like any other.

## Credentials and secrets

* HAC and provider credentials are **environment variables** (`.env` is git-ignored; `.env.example` holds placeholders only). No real secret is committed.
* Provider API keys never reach the browser: there is no key input in the UI, the status API returns only a boolean, and the bundle contains no keys. Nothing secret is stored in `localStorage`/`sessionStorage`/IndexedDB (only provider/model names).
* All error messages and model answers pass through a redactor that removes the exact known secret values (HAC password, API keys) plus patterns (`password=…`, `Bearer …`, `user:pass@`, JWTs, `sk-…`, `AIza…`).
* Authorization headers, cookies, passwords and keys are never logged. The web server logs only `METHOD path → status (ms)`; request bodies and headers are not logged.
* HAC TLS verification is on by default. `HAC_INSECURE_TLS=true` is opt-in, exactly `true`, and relaxes verification **only** for HAC requests (a dedicated dispatcher), never process-wide.

## Redaction

* `config_get`: values of keys containing `pass`, `secret`, `token`, `key`, `credential`, `auth`, `private`, `cert`, `salt`, `signature`, `cookie`, `session` are replaced by `****`; other values have embedded credentials masked. This is intentionally over-inclusive.
* `flexible_search`: columns whose header looks like a secret (`password`, `token`, `encoded…`, `hash`, …) are masked and listed in `maskedColumns`; string values go through the pattern redactor. Header-based masking cannot detect a secret in an arbitrarily named column.
* `logs_tail`: each line goes through the pattern redactor (best effort).

## Sensitive data in results and logs

Query results, CronJob output and logs can contain **personal data, order data, tokens or internal hostnames** that no pattern can reliably detect. In the web assistant, tool results are **sent to the AI provider you selected** and may be retained under that provider's terms. In MCP mode they go to your MCP client and its model. Use a development instance with synthetic data, and do not use these tools on data you may not share with the chosen provider.

## Local server binding and network exposure (web mode)

* `WEB_HOST` must be a loopback address; other values stop startup. Default `127.0.0.1`, port `3737`.
* `Host` header must be `localhost|127.0.0.1|[::1]` with the real port (blocks DNS rebinding); `Origin` (if present) and `Sec-Fetch-Site` must be same-origin.
* Every `/api` request needs a random per-process token (embedded in the served page, header `x-local-token`, constant-time compared). It defends against other websites; **it does not protect against other programs or users on the same machine**, who can fetch the page and read the token. Do not run this on a shared multi-user host.
* JSON-only `POST` (forces a CORS preflight for foreign sites), 256 KiB body limit, ≤ 2 concurrent chats.
* Security headers: strict CSP (`default-src 'self'`, no inline script/style), `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` for API responses. Static files are served from one directory with path-traversal protection.
* The MCP server uses stdio only and opens no network port.

## Known limitations

* The validator is conservative but not exhaustive and not formally proven.
* Not verified against a live SAP Commerce/HAC: exact HAC response formats, `platform/config` page layout and type-system attribute names across versions ([SAP-COMMERCE-CONNECTION.md](SAP-COMMERCE-CONNECTION.md#verification-status)). No live provider API call was made by the authors; adapters are verified against mocked SDK clients and the SDK type definitions.
* Prompt injection: model-visible data (log lines, field values) may contain instructions. The system prompt says to ignore them, but the real protection is that tools are read-only and allow-listed; an injected instruction can at most cause more *reads* (bounded by the loop limits) whose results go to the provider.
* Host check is lexical; it does not resolve DNS.
* Redaction is best effort.
* Dependencies are not independently audited beyond `npm audit`; the lockfile is committed.

## Safe-use recommendations

* Use a dedicated, least-privilege HAC account on a development instance with non-sensitive data.
* Keep `.env` private; do not paste real keys or passwords into issues, chats or MCP client files that you commit.
* Prefer trusting your local CA over `HAC_INSECURE_TLS`.
* Review the tool-call cards in the UI / your MCP client's confirmations when a model drives the tools.
* Report security issues privately to the repository owner rather than in a public issue.
