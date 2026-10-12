import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HacPort } from "../../src/commerce/hac-client.js";
import type { FlexibleSearchResult } from "../../src/commerce/html-parse.js";
import { LogReader } from "../../src/commerce/log-reader.js";
import { createRedactor } from "../../src/core/security/redact.js";
import { createToolset } from "../../src/core/tools/registry.js";

export const table = (columns: string[], rows: string[][], truncated = false): FlexibleSearchResult => ({
  columns,
  rows: rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? ""]))),
  rowCount: rows.length,
  truncated
});

export function mockHac(over: Partial<HacPort> = {}): HacPort & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    flexibleSearch: async (q) => { queries.push(q); return table(["PK"], [["1"]]); },
    translateFlexibleSearch: async () => ({ sql: "SELECT 1" }),
    getConfigEntries: async () => [],
    ...over
  };
}

export function tmpLog(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "scm-log-"));
  const file = join(dir, "console.log");
  writeFileSync(file, content);
  return file;
}

export function toolsetWith(hac: HacPort, logPath?: string, secrets: string[] = [], maxResultChars = 100000) {
  const redact = createRedactor(secrets);
  return createToolset({ hac, logs: new LogReader(logPath, redact), redact }, { maxResultChars });
}
