import { ToolError } from "../errors.js";

/**
 * Conservative, allow-list based validator for FlexibleSearch queries.
 *
 * It is NOT a full FlexibleSearch parser and NOT a formal security guarantee (see docs/SECURITY.md).
 * It tokenizes the query and accepts only a small, explicit subset:
 *
 *   - exactly one statement that starts with SELECT, no comments, no `;`, no `?param` placeholders
 *   - SQL keywords only from an allow-list; outside `{ ... }` every word must be such a keyword,
 *     an allow-listed function name, or an alias directly after AS
 *   - inside `{ ... }` (type and attribute references) identifiers are accepted, but never a
 *     mutation / session / file keyword
 *   - function calls only for an allow-listed set of read-only functions
 *   - a FROM clause that uses the `{ ... }` type syntax (raw SQL table names are rejected)
 *
 * Anything it does not recognize is rejected instead of guessed at. Rejected queries never reach HAC.
 */

export const MAX_QUERY_CHARS = 4000;
const MAX_TOKENS = 800;
const MAX_NESTING = 6;

/** Rejected wherever they appear (outside string literals), including inside `{ ... }`. */
export const FORBIDDEN_WORDS: ReadonlySet<string> = new Set([
  "INSERT", "UPDATE", "DELETE", "REMOVE", "CREATE", "DROP", "ALTER", "TRUNCATE", "MERGE", "REPLACE",
  "UPSERT", "GRANT", "REVOKE", "EXEC", "EXECUTE", "CALL", "INTO", "SET", "BEGIN", "COMMIT", "ROLLBACK",
  "SAVEPOINT", "LOCK", "UNLOCK", "DECLARE", "USE", "SHOW", "DESCRIBE", "EXPLAIN", "ANALYZE", "PRAGMA",
  "ATTACH", "DETACH", "VACUUM", "LOAD", "COPY", "IMPORT", "EXPORT", "OUTFILE", "DUMPFILE", "SHUTDOWN",
  "KILL", "WAITFOR", "SLEEP", "BENCHMARK", "CHECKPOINT", "RETURNING", "VALUES", "FOR", "WITH", "LIMIT",
  "OFFSET", "FETCH", "TOP", "SCRIPT", "GROOVY", "SHELL"
]);

const KEYWORDS: ReadonlySet<string> = new Set([
  "SELECT", "DISTINCT", "FROM", "WHERE", "AND", "OR", "NOT", "IN", "IS", "NULL", "LIKE", "BETWEEN", "EXISTS",
  "AS", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "CROSS", "FULL", "ON", "GROUP", "BY", "HAVING", "ORDER",
  "ASC", "DESC", "UNION", "ALL", "ANY", "SOME", "CASE", "WHEN", "THEN", "ELSE", "END", "ESCAPE", "TRUE", "FALSE"
]);

/** Keywords that may legitimately be followed by "(". */
const KEYWORDS_BEFORE_PAREN: ReadonlySet<string> = new Set([
  "IN", "EXISTS", "AND", "OR", "NOT", "ON", "WHERE", "HAVING", "ANY", "SOME", "ALL", "SELECT", "UNION",
  "BETWEEN", "LIKE", "WHEN", "THEN", "ELSE", "CASE", "BY", "DISTINCT", "JOIN", "FROM", "IS"
]);

export const ALLOWED_FUNCTIONS: ReadonlySet<string> = new Set([
  "COUNT", "SUM", "AVG", "MIN", "MAX", "LOWER", "UPPER", "LENGTH", "TRIM", "LTRIM", "RTRIM", "SUBSTR",
  "SUBSTRING", "CONCAT", "COALESCE", "IFNULL", "NVL", "ABS", "ROUND", "FLOOR", "CEIL", "CEILING", "MOD"
]);

export type ValidationResult =
  | { ok: true; query: string }
  | { ok: false; reason: string; position?: number };

type Frame = "ref" | "sub";

interface Token {
  kind: "word" | "string" | "number" | "punct";
  text: string;
  pos: number;
}

class Reject extends Error {
  constructor(message: string, public readonly position?: number) {
    super(message);
  }
}

function tokenize(query: string): Token[] {
  const tokens: Token[] = [];
  const stack: Frame[] = [];
  let i = 0;
  const n = query.length;
  const inRef = () => stack[stack.length - 1] === "ref";

  const push = (token: Token) => {
    tokens.push(token);
    if (tokens.length > MAX_TOKENS) throw new Reject(`Query is too complex (more than ${MAX_TOKENS} tokens).`);
  };

  while (i < n) {
    const ch = query[i] as string;
    const next = query[i + 1];

    if (/\s/.test(ch)) { i++; continue; }

    if (ch === "'") {
      let j = i + 1;
      for (;;) {
        if (j >= n) throw new Reject("Unterminated string literal.", i);
        if (query[j] === "'") {
          if (query[j + 1] === "'") { j += 2; continue; }
          break;
        }
        j++;
      }
      push({ kind: "string", text: query.slice(i, j + 1), pos: i });
      i = j + 1;
      continue;
    }

    if (ch === "{") {
      // "{{ SELECT" opens a FlexibleSearch subquery; any other "{" opens a type/attribute reference.
      if (next === "{" && /^\{\{\s*SELECT\b/i.test(query.slice(i))) {
        if (stack.length >= MAX_NESTING) throw new Reject("Query is nested too deeply.", i);
        stack.push("sub");
        push({ kind: "punct", text: "{{", pos: i });
        i += 2;
      } else {
        if (stack.length >= MAX_NESTING) throw new Reject("Query is nested too deeply.", i);
        stack.push("ref");
        push({ kind: "punct", text: "{", pos: i });
        i += 1;
      }
      continue;
    }

    if (ch === "}") {
      const top = stack[stack.length - 1];
      if (top === "ref") {
        stack.pop();
        push({ kind: "punct", text: "}", pos: i });
        i += 1;
      } else if (top === "sub" && next === "}") {
        stack.pop();
        push({ kind: "punct", text: "}}", pos: i });
        i += 2;
      } else {
        throw new Reject("Unbalanced closing brace.", i);
      }
      continue;
    }

    if (/\d/.test(ch)) {
      const m = /^\d+(?:\.\d+)?/.exec(query.slice(i)) as RegExpExecArray;
      push({ kind: "number", text: m[0], pos: i });
      i += m[0].length;
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(query.slice(i)) as RegExpExecArray;
      push({ kind: "word", text: m[0], pos: i });
      i += m[0].length;
      continue;
    }

    if (ch === "-" && next === "-") throw new Reject("SQL comments are not allowed.", i);
    if (ch === "/" && next === "*") throw new Reject("SQL comments are not allowed.", i);
    if (ch === ";") throw new Reject("Multiple statements are not allowed (found ';').", i);
    if (ch === "?") throw new Reject("Query parameters (?name) are not supported. Inline the value as a literal.", i);

    const two = ch + (next ?? "");
    if (["<=", ">=", "<>", "!=", "||"].includes(two)) {
      push({ kind: "punct", text: two, pos: i });
      i += 2;
      continue;
    }

    // Single-character punctuation. ":" "." "!" "[" "]" only make sense inside a reference.
    if ("=<>+-*/%(),".includes(ch)) {
      push({ kind: "punct", text: ch, pos: i });
      i += 1;
      continue;
    }
    if (inRef() && ":.![]".includes(ch)) {
      push({ kind: "punct", text: ch, pos: i });
      i += 1;
      continue;
    }

    throw new Reject(`Unsupported character '${ch}'.`, i);
  }

  if (stack.length > 0) throw new Reject("Unbalanced braces: a '{' is never closed.");
  return tokens;
}

function check(query: string): void {
  // eslint-disable-next-line no-control-regex -- deliberately matching control characters
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(query)) {
    throw new Reject("Query contains control characters.");
  }

  const tokens = tokenize(query);
  const first = tokens[0];
  if (!first || first.kind !== "word" || first.text.toUpperCase() !== "SELECT") {
    throw new Reject("Only queries that start with SELECT are allowed.", first?.pos ?? 0);
  }

  // Walk tokens with the same frame logic as the tokenizer to know if a word is inside "{ ... }".
  const stack: Frame[] = [];
  let parenDepth = 0;
  let sawFromBrace = false;

  for (let idx = 0; idx < tokens.length; idx++) {
    const tok = tokens[idx] as Token;
    const prev = tokens[idx - 1];
    const nextTok = tokens[idx + 1];
    const prevWordUpper = prev?.kind === "word" ? prev.text.toUpperCase() : undefined;

    if (tok.kind === "punct") {
      switch (tok.text) {
        case "{":
          if (prevWordUpper === "FROM") sawFromBrace = true;
          stack.push("ref");
          break;
        case "{{": stack.push("sub"); break;
        case "}":
        case "}}": stack.pop(); break;
        case "(": parenDepth++; break;
        case ")":
          parenDepth--;
          if (parenDepth < 0) throw new Reject("Unbalanced closing parenthesis.", tok.pos);
          break;
        default: break;
      }
      continue;
    }
    if (tok.kind !== "word") continue;

    const upper = tok.text.toUpperCase();
    const insideRef = stack[stack.length - 1] === "ref";
    const followedByParen = nextTok?.kind === "punct" && nextTok.text === "(";

    if (FORBIDDEN_WORDS.has(upper)) {
      throw new Reject(`'${tok.text}' is not allowed: only read-only SELECT queries are supported.`, tok.pos);
    }

    if (followedByParen) {
      if (!ALLOWED_FUNCTIONS.has(upper) && !KEYWORDS_BEFORE_PAREN.has(upper)) {
        throw new Reject(`Function '${tok.text}' is not on the read-only function allow-list.`, tok.pos);
      }
    } else if (!KEYWORDS.has(upper) && !insideRef && prevWordUpper !== "AS") {
      throw new Reject(
        `Unsupported identifier '${tok.text}' outside { }. Reference types and attributes with {Type AS t} / {t:attribute}; raw SQL is not supported.`,
        tok.pos
      );
    }
  }

  if (parenDepth !== 0) throw new Reject("Unbalanced parentheses.");
  if (!sawFromBrace) {
    throw new Reject("A FROM clause using the { Type } syntax is required.");
  }
}

export function validateReadOnlyFlexibleSearch(query: string): ValidationResult {
  if (typeof query !== "string") return { ok: false, reason: "Query must be a string." };
  const trimmed = query.trim();
  if (trimmed.length === 0) return { ok: false, reason: "Query is empty." };
  if (trimmed.length > MAX_QUERY_CHARS) {
    return { ok: false, reason: `Query is longer than ${MAX_QUERY_CHARS} characters.` };
  }
  try {
    check(trimmed);
    return { ok: true, query: trimmed };
  } catch (error) {
    if (error instanceof Reject) {
      return { ok: false, reason: error.message, ...(error.position !== undefined ? { position: error.position } : {}) };
    }
    throw error;
  }
}

/** Throws a QUERY_REJECTED ToolError unless the query passes validation. Returns the trimmed query. */
export function assertReadOnlyFlexibleSearch(query: string): string {
  const result = validateReadOnlyFlexibleSearch(query);
  if (!result.ok) {
    const where = result.position !== undefined ? ` (at position ${result.position})` : "";
    throw new ToolError("QUERY_REJECTED", `Query rejected by the read-only validator${where}: ${result.reason}`);
  }
  return result.query;
}
