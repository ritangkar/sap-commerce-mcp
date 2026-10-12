/*
 * HTML/JSON response parsing for HAC pages.
 *
 * Portions adapted from hybris-mcp-lite (MIT, Copyright (c) 2026 André Escocard):
 * decodeHtml, stripTags, extractCsrf and the HTML-table fallback of the FlexibleSearch parser.
 * See NOTICE.md.
 */

export interface FlexibleSearchResult {
  columns: string[];
  rows: Record<string, string>[];
  rowCount: number;
  truncated: boolean;
}

export interface ConfigEntry {
  key: string;
  value: string;
}

export function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&amp;/g, "&");
}

export function stripTags(value: string): string {
  return decodeHtml(
    value
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|li|pre|textarea)>/gi, "\n")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]*>/g, "")
  )
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function extractCsrf(html: string): string | undefined {
  const inputMatch = html.match(/<input[^>]+name=["']_csrf["'][^>]*>/i);
  const token =
    inputMatch?.[0].match(/value=["']([^"']+)["']/i)?.[1] ??
    html.match(/<meta[^>]+name=["']_csrf["'][^>]*>/i)?.[0].match(/content=["']([^"']+)["']/i)?.[1];
  return token ? decodeHtml(token) : undefined;
}

export function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export function stringifyField(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return JSON.stringify(value);
}

/** Make column names unique so that two selected attributes called "code" do not overwrite each other. */
function uniqueColumns(columns: string[]): string[] {
  const seen = new Map<string, number>();
  return columns.map((raw, index) => {
    const base = raw || `column${index + 1}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}_${count}`;
  });
}

function toRows(columns: string[], rawRows: unknown[][]): Record<string, string>[] {
  return rawRows.map((cells) => {
    const row: Record<string, string> = {};
    columns.forEach((column, i) => {
      row[column] = stringifyField(cells[i]);
    });
    return row;
  });
}

export interface ParsedExecuteResponse {
  /** Set when HAC reported a query error. */
  error?: string;
  result?: FlexibleSearchResult;
}

/**
 * Parse the response of HAC's `console/flexsearch/execute`.
 * Primary format is HAC's JSON (`headers` + `resultList` + `exception`); the table-based HTML fallback
 * is kept from the reference implementation. NOTE: the JSON shape has been validated only against
 * documented/observed HAC behaviour and synthetic fixtures, not against a live instance in this repo.
 */
export function parseFlexibleSearchResponse(body: string, maxCount: number): ParsedExecuteResponse {
  const json = tryParseJson(body);
  if (json && typeof json === "object" && !Array.isArray(json)) {
    const record = json as Record<string, unknown>;

    const exception = record.exception;
    if (exception) {
      const message =
        typeof exception === "string"
          ? exception
          : typeof (exception as Record<string, unknown>).message === "string"
            ? ((exception as Record<string, unknown>).message as string)
            : JSON.stringify(exception);
      return { error: message };
    }

    const rawRows = (record.resultList ?? record.rows ?? record.data) as unknown;
    if (Array.isArray(rawRows)) {
      const listRows = rawRows.map((row) =>
        Array.isArray(row) ? row : row && typeof row === "object" ? Object.values(row as object) : [row]
      );
      let columns: string[];
      if (Array.isArray(record.headers)) columns = (record.headers as unknown[]).map(stringifyField);
      else if (Array.isArray(record.columns)) columns = (record.columns as unknown[]).map(stringifyField);
      else if (rawRows[0] && typeof rawRows[0] === "object" && !Array.isArray(rawRows[0])) columns = Object.keys(rawRows[0] as object);
      else columns = (listRows[0] ?? []).map((_, i) => `column${i + 1}`);
      columns = uniqueColumns(columns);

      const reported = typeof record.resultCount === "number" ? record.resultCount : undefined;
      const rows = toRows(columns, listRows.slice(0, maxCount));
      return {
        result: {
          columns,
          rows,
          rowCount: rows.length,
          truncated: listRows.length > maxCount || (reported !== undefined ? reported > rows.length : false)
        }
      };
    }
  }

  const tableMatch = body.match(/<table[\s\S]*?<\/table>/i);
  if (!tableMatch) {
    const text = stripTags(body);
    return { error: text ? text.slice(0, 500) : "HAC returned an empty response." };
  }

  const table = tableMatch[0];
  const headerCells = Array.from(table.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)).map((m) => stripTags(m[1] ?? ""));
  const bodyRows: string[][] = [];
  for (const rowMatch of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = Array.from((rowMatch[1] ?? "").matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)).map((m) => stripTags(m[1] ?? ""));
    if (cells.length > 0) bodyRows.push(cells);
  }
  const width = Math.max(headerCells.length, ...bodyRows.map((r) => r.length), 0);
  const columns = uniqueColumns(Array.from({ length: width }, (_, i) => headerCells[i] ?? ""));
  const capped = bodyRows.slice(0, maxCount);
  return {
    result: {
      columns,
      rows: toRows(columns, capped),
      rowCount: capped.length,
      truncated: bodyRows.length > capped.length
    }
  };
}

/** Extract the plain-text SQL out of HAC's `console/flexsearch/translate` response. */
export function parseTranslateResponse(body: string): string {
  const json = tryParseJson(body);
  if (json && typeof json === "object") {
    const record = json as Record<string, unknown>;
    if (record.exception) return "";
    const sql = record.query ?? record.sql ?? record.result;
    if (typeof sql === "string") return stripTags(sql);
  }
  return stripTags(body);
}

/**
 * Parse HAC's `platform/config` page into key/value pairs. The page is rendered as an HTML table in
 * which the value is either cell text or the `value` of an input/textarea. We only read text; the
 * forms on that page are never submitted.
 */
export function parseConfigPage(html: string): ConfigEntry[] {
  const entries = new Map<string, string>();
  for (const rowMatch of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = Array.from((rowMatch[1] ?? "").matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)).map((m) => m[1] ?? "");
    if (cells.length < 2) continue;
    const cellValue = (cell: string): string => {
      const input = cell.match(/<input[^>]*\svalue=["']([^"']*)["'][^>]*>/i);
      if (input) return decodeHtml(input[1] ?? "");
      const area = cell.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/i);
      if (area) return decodeHtml(area[1] ?? "").trim();
      return stripTags(cell);
    };
    const key = stripTags(cells[0] as string);
    if (!key || /\s/.test(key) || key.length > 300) continue;
    if (!entries.has(key)) entries.set(key, cellValue(cells[1] as string));
  }
  return Array.from(entries, ([key, value]) => ({ key, value }));
}
