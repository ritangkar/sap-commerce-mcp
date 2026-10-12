import { z } from "zod";
import { ToolError } from "../errors.js";
import { assertReadOnlyFlexibleSearch } from "../validation/flexsearch-validator.js";
import { MASK, isSensitiveColumn, redactConfigValue } from "../security/redact.js";
import type { ToolDefinition } from "./types.js";

/** Identifier-like values that are interpolated into queries must match these patterns. */
const TYPE_CODE = /^[A-Za-z][A-Za-z0-9_]{0,99}$/;
const CRONJOB_CODE = /^[A-Za-z0-9][A-Za-z0-9 _.:/-]{0,199}$/;

const toBool = (v: string | undefined): boolean | null => (v === undefined || v === "" ? null : /^(true|1)$/i.test(v));

// ------------------------------------------------------------------ flexible_search

const flexibleSearchSchema = z
  .object({
    query: z.string().min(1).max(4000).describe("A read-only FlexibleSearch SELECT query, e.g. SELECT {pk},{code} FROM {Product}"),
    maxCount: z.number().int().min(1).max(200).default(200).describe("Maximum number of rows to return (1-200)."),
    translate: z.boolean().default(false).describe("If true, return the generated SQL instead of executing the query.")
  })
  .strict();

export const flexibleSearchTool: ToolDefinition<typeof flexibleSearchSchema> = {
  name: "flexible_search",
  title: "FlexibleSearch",
  description:
    "Read-only. Run a FlexibleSearch SELECT query against the configured local SAP Commerce HAC (max 200 rows). " +
    "Only a strict SELECT subset is accepted: no comments, no ';', no ?parameters, no raw SQL tables, no LIMIT, " +
    "no mutation keywords. Set translate=true to get the generated SQL only.",
  readOnly: true,
  inputSchema: flexibleSearchSchema,
  async run({ query: rawQuery, maxCount, translate }, ctx) {
    // Validated here AND inside HacClient: no HacPort implementation ever receives a rejected query.
    const query = assertReadOnlyFlexibleSearch(rawQuery);
    if (translate) {
      const { sql } = await ctx.hac.translateFlexibleSearch(query);
      return { sql: ctx.redact(sql) };
    }
    const result = await ctx.hac.flexibleSearch(query, { maxCount });
    const sensitive = new Set(result.columns.filter(isSensitiveColumn));
    const rows = result.rows.map((row) =>
      Object.fromEntries(Object.entries(row).map(([k, v]) => [k, sensitive.has(k) && v ? MASK : ctx.redact(v)]))
    );
    return {
      columns: result.columns,
      rows,
      rowCount: rows.length,
      truncated: result.truncated,
      ...(sensitive.size > 0 ? { maskedColumns: [...sensitive] } : {})
    };
  }
};

// ------------------------------------------------------------------ type_info

const typeInfoSchema = z
  .object({
    type: z.string().regex(TYPE_CODE, "Type code must be letters, digits or underscore, starting with a letter.").describe("Composed type code, e.g. Product"),
    includeInherited: z.boolean().default(false).describe("Also include attributes declared on super types.")
  })
  .strict();

const q = (s: string) => `'${s}'`; // safe: inputs are validated against TYPE_CODE before interpolation

async function typeRow(ctx: Parameters<ToolDefinition["run"]>[1], code: string) {
  const r = await ctx.hac.flexibleSearch(
    `SELECT {c:code}, {s:code}, {c:abstract} FROM {ComposedType AS c LEFT JOIN ComposedType AS s ON {c:superType}={s:pk}} WHERE {c:code} = ${q(code)}`,
    { maxCount: 1 }
  );
  const row = r.rows[0];
  if (!row) return undefined;
  const v = Object.values(row);
  return { code: v[0] ?? code, superType: v[1] || null, abstract: toBool(v[2]) };
}

async function declaredAttributes(ctx: Parameters<ToolDefinition["run"]>[1], code: string) {
  const r = await ctx.hac.flexibleSearch(
    `SELECT {a:qualifier}, {ty:code}, {a:localized}, {a:optional}, {a:unique}, {a:partOf} FROM {AttributeDescriptor AS a JOIN ComposedType AS t ON {a:enclosingType}={t:pk} LEFT JOIN Type AS ty ON {a:attributeType}={ty:pk}} WHERE {t:code} = ${q(code)} ORDER BY {a:qualifier}`,
    { maxCount: 1000 }
  );
  return r.rows.map((row) => {
    const v = Object.values(row);
    return {
      qualifier: v[0] ?? "",
      type: v[1] || null,
      localized: toBool(v[2]),
      optional: toBool(v[3]),
      unique: toBool(v[4]),
      partOf: toBool(v[5]),
      declaredIn: code
    };
  });
}

export const typeInfoTool: ToolDefinition<typeof typeInfoSchema> = {
  name: "type_info",
  title: "Type system info",
  description:
    "Read-only. Return a SAP Commerce type's super type, abstract flag, declared attributes (qualifier, type, localized, optional, unique, partOf) and all sub types. " +
    "Implemented with read-only FlexibleSearch queries on the type system. The deployment table is not available.",
  readOnly: true,
  inputSchema: typeInfoSchema,
  async run({ type, includeInherited }, ctx) {
    const self = await typeRow(ctx, type);
    if (!self) throw new ToolError("NOT_FOUND", `Type "${type}" was not found in the type system.`);

    // Attributes (optionally along the super type chain, bounded).
    const attributes = await declaredAttributes(ctx, self.code);
    const superChain: string[] = [];
    if (includeInherited) {
      let current = self.superType;
      for (let depth = 0; current && depth < 15; depth++) {
        superChain.push(current);
        attributes.push(...(await declaredAttributes(ctx, current)));
        current = (await typeRow(ctx, current))?.superType ?? null;
      }
    }

    // Sub types, breadth first with hard bounds.
    const subtypes: string[] = [];
    let frontier = [self.code];
    let subtypesTruncated = false;
    for (let level = 0; level < 6 && frontier.length > 0 && !subtypesTruncated; level++) {
      const next: string[] = [];
      for (const parent of frontier) {
        const r = await ctx.hac.flexibleSearch(
          `SELECT {c:code} FROM {ComposedType AS c JOIN ComposedType AS s ON {c:superType}={s:pk}} WHERE {s:code} = ${q(parent)} ORDER BY {c:code}`,
          { maxCount: 500 }
        );
        for (const row of r.rows) {
          const child = Object.values(row)[0];
          if (!child) continue;
          if (subtypes.length >= 300) { subtypesTruncated = true; break; }
          subtypes.push(child);
          next.push(child);
        }
        if (subtypesTruncated) break;
      }
      frontier = next;
    }

    return {
      code: self.code,
      superType: self.superType,
      abstract: self.abstract,
      ...(includeInherited ? { superTypeChain: superChain } : {}),
      attributes,
      subtypes: subtypes.sort(),
      ...(subtypesTruncated ? { subtypesTruncated: true } : {}),
      notes: ["Deployment table / persistence info is not exposed (requires scripting access, which this tool does not use)."]
    };
  }
};

// ------------------------------------------------------------------ config_get

const configGetSchema = z
  .object({
    key: z.string().min(1).max(300).optional().describe("Exact property key to read, e.g. build.version."),
    filter: z.string().min(1).max(100).optional().describe("Case-insensitive substring filter on property keys.")
  })
  .strict();

const MAX_CONFIG_ENTRIES = 500;

export const configGetTool: ToolDefinition<typeof configGetSchema> = {
  name: "config_get",
  title: "Configuration",
  description:
    "Read-only. Read SAP Commerce configuration properties from HAC's configuration page: one property by exact `key`, or the properties whose key contains `filter` " +
    `(max ${MAX_CONFIG_ENTRIES} entries). Values of secret-like keys (pass, secret, token, key, credential, auth, ...) are masked as ****.`,
  readOnly: true,
  inputSchema: configGetSchema,
  async run({ key, filter }, ctx) {
    const entries = await ctx.hac.getConfigEntries();
    if (key) {
      const hit = entries.find((e) => e.key === key);
      if (!hit) throw new ToolError("NOT_FOUND", `Configuration key "${key}" was not found.`);
      return { key: hit.key, value: redactConfigValue(hit.key, hit.value) };
    }
    const needle = filter?.toLowerCase();
    const matching = needle ? entries.filter((e) => e.key.toLowerCase().includes(needle)) : entries;
    const shown = matching.slice(0, MAX_CONFIG_ENTRIES);
    return {
      total: matching.length,
      truncated: matching.length > shown.length,
      entries: shown.map((e) => ({ key: e.key, value: redactConfigValue(e.key, e.value) }))
    };
  }
};

// ------------------------------------------------------------------ logs_tail

const logsTailSchema = z
  .object({
    lines: z.number().int().min(1).max(2000).default(200).describe("Number of trailing lines (1-2000)."),
    grep: z.string().min(1).max(200).optional().describe("Case-insensitive plain-text filter (not a regular expression).")
  })
  .strict();

export const logsTailTool: ToolDefinition<typeof logsTailSchema> = {
  name: "logs_tail",
  title: "Console log",
  description:
    "Read-only. Return the last lines of the local SAP Commerce console log file configured via HAC_LOG_PATH, optionally keeping only lines containing `grep` (plain text, case-insensitive). " +
    "Secret-like values are masked on a best-effort basis; logs can still contain sensitive data.",
  readOnly: true,
  inputSchema: logsTailSchema,
  async run({ lines, grep }, ctx) {
    const r = await ctx.logs.tail({ lines, ...(grep ? { contains: grep } : {}) });
    return { ...r, lines: r.lines.map(ctx.redact) };
  }
};

// ------------------------------------------------------------------ cronjob

const cronjobSchema = z
  .object({
    action: z.enum(["list", "status"]).default("list").describe("list: recent cronjobs; status: one cronjob by code."),
    code: z.string().regex(CRONJOB_CODE, "Invalid cronjob code.").optional().describe("Cronjob code (required for action=status).")
  })
  .strict()
  .refine((v) => v.action !== "status" || !!v.code, { message: 'action="status" requires code.', path: ["code"] });

const CRONJOB_SELECT =
  "SELECT {c:code}, {s:code}, {r:code}, {c:startTime}, {c:endTime} FROM {CronJob AS c LEFT JOIN CronJobStatus AS s ON {c:status}={s:pk} LEFT JOIN CronJobResult AS r ON {c:result}={r:pk}}";

export const cronjobTool: ToolDefinition<typeof cronjobSchema> = {
  name: "cronjob",
  title: "CronJobs",
  description:
    "Read-only. List CronJobs (action=list, newest 100 by modification time) or read the current status of one CronJob by code (action=status). " +
    "This tool cannot start, abort, schedule or modify CronJobs.",
  readOnly: true,
  inputSchema: cronjobSchema,
  async run({ action, code }, ctx) {
    const map = (row: Record<string, string>) => {
      const v = Object.values(row);
      return { code: v[0] ?? "", status: v[1] || null, result: v[2] || null, startTime: v[3] || null, endTime: v[4] || null };
    };
    if (action === "list") {
      const r = await ctx.hac.flexibleSearch(`${CRONJOB_SELECT} ORDER BY {c:modifiedtime} DESC`, { maxCount: 100 });
      return { cronjobs: r.rows.map(map), truncated: r.truncated };
    }
    const r = await ctx.hac.flexibleSearch(`${CRONJOB_SELECT} WHERE {c:code} = ${q(code as string)}`, { maxCount: 1 });
    const row = r.rows[0];
    if (!row) throw new ToolError("NOT_FOUND", `CronJob "${code}" was not found.`);
    return map(row);
  }
};

export const ALL_TOOLS: ToolDefinition<never>[] = [
  flexibleSearchTool,
  typeInfoTool,
  configGetTool,
  logsTailTool,
  cronjobTool
] as unknown as ToolDefinition<never>[];
