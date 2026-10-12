# Third-party notice

## hybris-mcp-lite

Parts of this project are adapted from **hybris-mcp-lite**
(<https://github.com/andreescocard/hybris-mcp-lite>), Copyright (c) 2026 André Escocard, licensed under the MIT License.

Adapted material:

| Here | Adapted from | What |
| --- | --- | --- |
| `src/commerce/hac-client.ts` | `src/hacClient.ts` | HAC login flow, CSRF token rotation, cookie handling, 405 re-login, manual redirects |
| `src/commerce/html-parse.ts` | `src/htmlParse.ts` | `decodeHtml`, `stripTags`, `extractCsrf`, HTML-table fallback parser |
| `src/commerce/host-guard.ts` | `src/guard.ts` | private-host check (the `HAC_ALLOW_REMOTE` override was removed) |
| `src/core/security/redact.ts` | `src/mask.ts` | secret-key masking idea (extended) |
| tool names `flexible_search`, `type_info`, `config_get`, `logs_tail`, `cronjob` and their input semantics | `src/tools/*.ts` | tool surface / compatibility |

Everything else (shared tool core, validator, MCP adapter, web backend, AI orchestration, UI, tests) was written for this repository.
The Groovy-template based implementations of the reference are intentionally **not** carried over; see `docs/REFERENCE-AUDIT.md`.

The original license text, as required by its terms:

```
MIT License

Copyright (c) 2026 André Escocard

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

SAP, SAP Commerce and Hybris are trademarks of SAP SE. This project is not affiliated with or endorsed by SAP.
