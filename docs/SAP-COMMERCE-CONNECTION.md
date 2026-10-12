# Connecting to SAP Commerce (HAC)

## What HAC is and how this tool uses it

The **Hybris Administration Console (HAC)** is the web admin UI of SAP Commerce (default context `/hac`, e.g. `https://localhost:9002/hac`). This tool logs in to HAC like a browser does (form login with CSRF token, session cookies) and uses only these endpoints:

| Method + path (relative to `HAC_URL`) | Used for |
| --- | --- |
| `GET login`, `POST j_spring_security_check`, `GET /` | authentication and obtaining the session CSRF token |
| `POST console/flexsearch/execute` | run a validated FlexibleSearch query |
| `POST console/flexsearch/translate` | translate a validated query to SQL |
| `GET platform/config` | read configuration properties (`config_get`) |

The client has no generic request function; these paths are hard-coded and enforced in `src/commerce/hac-client.ts` (a test asserts nothing else is ever requested). The HAC **scripting console (Groovy)**, ImpEx, SQL console, CronJob pages, monitoring pages and every other endpoint are never used. A rejected query never reaches HAC.

Log lines come from a **local file** you configure, not from HAC.

## Requirements

* A running SAP Commerce development instance you are authorized to inspect.
* A HAC user who may log in and use the FlexibleSearch console (the default `admin` account on a fresh local dev setup does; use a dedicated least-privilege account if your instance has one).
* HAC reachable from the machine that runs this tool (see Networking).

## Configuration

```
HAC_URL=https://localhost:9002/hac    # include the context path; default shown
HAC_USER=…
HAC_PASS=…
HAC_TIMEOUT_MS=30000                  # per request, 1000–300000
HAC_INSECURE_TLS=true                 # only for self-signed local certificates
HAC_LOG_PATH=/absolute/path/console-YYYYMMDD.log
```

`HAC_URL` must use `http` or `https`, must not embed credentials, and must be a local/private host. There is no override. Credentials live only in environment variables (or `.env`, which is git-ignored); they are redacted from any error text.

## Networking

* **Localhost vs. another host.** `localhost` always means *the machine running this tool*. If SAP Commerce runs in a VM, container or WSL instance, `localhost` may or may not reach it; use the address the instance is published on and make sure the port is forwarded. Accepted hosts: `localhost`, `*.localhost`, `*.local`, `127.0.0.0/8`, `::1`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`. Hostnames that resolve to other addresses (for example `host.docker.internal` or corporate DNS names) are **refused**, because the guard checks the literal host in `HAC_URL`; use the numeric private IP instead.
* The check is on the configured host name, not on DNS resolution. You are responsible for making sure that host really is your own development instance.
* Do not tunnel this tool to a shared or higher environment. It is not designed or supported for that.
* The web UI and MCP server need no inbound connectivity.

## TLS

Local HAC typically uses a self-signed certificate, and verification then fails with `HAC_TLS` (`DEPTH_ZERO_SELF_SIGNED_CERT` / `UNABLE_TO_VERIFY_LEAF_SIGNATURE`). Options, best first:

1. Make Node trust your local CA/certificate: `NODE_EXTRA_CA_CERTS=/path/to/local-ca.pem`.
2. `HAC_INSECURE_TLS=true` – disabled by default, must be exactly `true`. It turns off certificate verification **only for HAC requests** (a dedicated HTTP dispatcher); it does not affect AI-provider connections. Use only for your own local instance.

## Log file access

`logs_tail` reads the file at `HAC_LOG_PATH` (read-only, last 4 MiB, at most 2000 lines returned). Typical location: `<HYBRIS_LOG_DIR>/tomcat/console-YYYYMMDD.log` – the file name changes daily, so update the variable (or point it at a stable file) when needed. The path comes from configuration only; a tool call can never choose another file. When the SAP Commerce process runs on a different machine or in a container, the file must be accessible at that path on the machine running this tool (for example via a bind mount), otherwise `LOG_UNAVAILABLE` is returned.

## Authentication failures and session handling

* One login is performed lazily on first use and reused; concurrent first calls share a single login.
* A `401`/`403`, a redirect to the login page, or HAC's `405` (stale CSRF token) triggers exactly one transparent re-login and retry.
* Bad credentials give `HAC_AUTH` ("HAC login did not establish an authenticated session. Check HAC_USER and HAC_PASS."). The password is never included in messages. Repeated failures can lock the account under your instance's policy – fix the credentials before retrying.
* Redirects are never followed automatically, so credentials cannot be forwarded to another location.

## Supported operations and the read-only boundary

Read: FlexibleSearch `SELECT`, type-system metadata (via FlexibleSearch), configuration properties, existing log lines, CronJob list/status. Not possible: any write, import, job control, cache or index operation, scripting, arbitrary SQL, arbitrary endpoints. See [SECURITY.md](SECURITY.md).

HAC's FlexibleSearch console runs queries as a configurable user; this tool sends `user=admin` like the reference project did, so results reflect that user's access.

## Verification status

Honest statement of what has and has not been verified:

* **Verified by automated tests (synthetic fixtures):** login/CSRF/cookie flow, 405 re-login, timeouts, unreachable host, endpoint allow-list, parsing of the JSON and HTML-table shapes the reference implementation handles.
* **Not verified against a real SAP Commerce / HAC (needs your instance):**
  * the exact JSON field names of HAC's FlexibleSearch response (`headers`, `resultList`, `exception`, `resultCount` are assumed; the reference's `rows/resultList/data/columns` and HTML-table forms are also accepted);
  * the HTML structure of `platform/config` across HAC versions (parsing is best effort; if no entries are recognized you get a clear `HAC_ERROR`);
  * the attribute names used by the type/CronJob queries (`ComposedType.code/superType/abstract`, `AttributeDescriptor.qualifier/enclosingType/attributeType/localized/optional/unique/partOf`, `CronJob.code/status/result/startTime/endTime/modifiedtime`, enum types `CronJobStatus`/`CronJobResult`). If your version differs, HAC returns an error that is passed through as `HAC_QUERY_ERROR`.
* Run `LIVE_HAC=1 npm run test:live` to check these on your instance (read-only).
