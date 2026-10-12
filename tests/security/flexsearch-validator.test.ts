import { describe, expect, it } from "vitest";
import {
  assertReadOnlyFlexibleSearch,
  MAX_QUERY_CHARS,
  validateReadOnlyFlexibleSearch
} from "../../src/core/validation/flexsearch-validator.js";
import { ToolError } from "../../src/core/errors.js";

const ok = (q: string) => expect(validateReadOnlyFlexibleSearch(q)).toMatchObject({ ok: true });
const bad = (q: string, reason?: RegExp) => {
  const r = validateReadOnlyFlexibleSearch(q);
  expect(r.ok).toBe(false);
  if (!r.ok && reason) expect(r.reason).toMatch(reason);
};

describe("FlexibleSearch validator: accepted read-only queries", () => {
  it.each([
    "SELECT {pk} FROM {Product}",
    "select {p:pk}, {p:code} from {Product AS p} where {p:code} like 'abc%' order by {p:code} desc",
    "SELECT COUNT(*) FROM {Product}",
    "SELECT {p:code} FROM {Product! AS p} WHERE {p:name[en]} = 'it''s fine'",
    "SELECT {c:code}, {s:code} FROM {CronJob AS c LEFT JOIN CronJobStatus AS s ON {c:status}={s:pk}} ORDER BY {c:modifiedtime} DESC",
    "SELECT {p:pk} FROM {Product AS p} WHERE {p:pk} IN ({{ SELECT {c:pk} FROM {Product AS c} WHERE {c:code} = 'x' }})",
    "SELECT LOWER({p:code}) AS lc FROM {Product AS p} GROUP BY {p:code} HAVING COUNT({p:pk}) > 1",
    "SELECT {p:pk} FROM {Product AS p} WHERE {p:code} IS NOT NULL AND {p:pk} BETWEEN 1 AND 99999999999",
    "SELECT {a:pk} FROM {Product AS a} UNION ALL SELECT {b:pk} FROM {Product AS b}"
  ])("accepts %s", (q) => ok(q));

  it("treats forbidden words inside string literals as data", () => {
    ok("SELECT {p:pk} FROM {Product AS p} WHERE {p:code} = 'DROP TABLE; -- /* ? {'");
  });
});

describe("FlexibleSearch validator: mutation attempts are rejected", () => {
  it.each([
    "INSERT INTO products VALUES (1)",
    "UPDATE {Product} SET {name}='x'",
    "DELETE FROM {Product}",
    "REMOVE {Product}",
    "CREATE TABLE x (a int)",
    "DROP TABLE products",
    "ALTER TABLE products ADD x int",
    "TRUNCATE TABLE products",
    "MERGE INTO t USING s ON 1=1",
    "REPLACE INTO t VALUES (1)",
    "GRANT ALL ON t TO u",
    "EXEC sp_who",
    "CALL some_proc()",
    "SELECT {pk} INTO OUTFILE '/tmp/x' FROM {Product}",
    "SELECT {pk} FROM {Product} FOR UPDATE",
    "WITH x AS (SELECT 1) SELECT * FROM x"
  ])("rejects %s", (q) => bad(q));

  it("rejects mutation keywords embedded in an otherwise valid SELECT", () => {
    bad("SELECT {p:pk} FROM {Product AS p} WHERE 1=1 AND DELETE", /DELETE/);
    bad("SELECT {p:pk} FROM {Product AS p} WHERE {p:code} = 'a' UNION SELECT {x:pk} FROM {Product AS x} UPDATE", /UPDATE/);
    bad("SELECT {p:pk} FROM {Product AS p} WHERE {p:drop} = 1", /drop/i);
  });
});

describe("FlexibleSearch validator: structural rejections", () => {
  it("rejects multiple statements", () => {
    bad("SELECT {pk} FROM {Product}; SELECT {pk} FROM {Product}", /Multiple statements/);
    bad("SELECT {pk} FROM {Product};", /Multiple statements/);
    bad("SELECT {pk} FROM {Product}; DROP TABLE x", /Multiple statements/);
  });
  it("rejects comments", () => {
    bad("SELECT {pk} FROM {Product} -- hi", /comments/);
    bad("SELECT {pk} FROM {Product} /* hi */", /comments/);
    bad("SELECT /*!50000 1 */ {pk} FROM {Product}", /comments/);
  });
  it("rejects query parameters", () => bad("SELECT {pk} FROM {Product} WHERE {code} = ?code", /parameters/));
  it("rejects raw SQL identifiers and tables", () => {
    bad("SELECT * FROM users", /Unsupported identifier/);
    bad("SELECT 1 FROM dual", /Unsupported identifier|FROM clause/);
    bad("SELECT name FROM {Product}", /Unsupported identifier/);
  });
  it("requires a { } FROM clause", () => bad("SELECT 1", /FROM/));
  it("rejects non-SELECT starts, empty and oversized input", () => {
    bad("", /empty/);
    bad("   ", /empty/);
    bad("{pk} FROM {Product}", /start with SELECT/);
    bad("SELECT {pk} FROM {Product} WHERE {code} = '" + "a".repeat(MAX_QUERY_CHARS) + "'", /longer/);
  });
  it("rejects unterminated strings and unbalanced braces/parens", () => {
    bad("SELECT {pk} FROM {Product} WHERE {code} = 'abc", /Unterminated/);
    bad("SELECT {pk} FROM {Product", /Unbalanced/);
    bad("SELECT {pk} FROM {Product}}", /Unbalanced/);
    bad("SELECT COUNT({pk} FROM {Product}", /Unbalanced/);
    bad("SELECT {pk}) FROM {Product}", /Unbalanced/);
  });
  it("rejects non-allow-listed functions that could have side effects or DoS", () => {
    bad("SELECT pg_sleep(10) FROM {Product}", /allow-list/);
    bad("SELECT {p:pk} FROM {Product AS p} WHERE SLEEP(5) = 0", /SLEEP/);
    bad("SELECT LOAD_FILE('/etc/passwd') FROM {Product}", /allow-list/);
    bad("SELECT {p:pk} FROM {Product AS p} WHERE dbms_lock.sleep(5)", /Unsupported character|SLEEP|identifier|allow-list/i);
  });
  it("rejects scripting, control characters and odd punctuation", () => {
    bad("SELECT {pk} FROM {Product} WHERE 1=1 \u0000", /control/);
    bad("SELECT {pk} FROM {Product} WHERE {code} = \"x\"", /Unsupported character/);
    bad("SELECT {pk} FROM {Product} WHERE {code} = `x`", /Unsupported character/);
    bad("SELECT ${7*7} FROM {Product}", /Unsupported character/);
    bad("SELECT {pk} FROM {Product} WHERE {code} = 'a' # x", /Unsupported character/);
    bad("SELECT {pk} FROM {Product} WHERE 1 & 1", /Unsupported character/);
  });
  it("rejects LIMIT/OFFSET (the row cap is applied by the tool)", () => {
    bad("SELECT {pk} FROM {Product} LIMIT 5", /LIMIT/);
  });
  it("rejects absurd nesting", () => {
    const deep = "SELECT {a:pk} FROM {" + "{{ SELECT {b:pk} FROM {".repeat(7) + "Product" + "}}".repeat(7) + "}";
    bad(deep);
  });
});

describe("assertReadOnlyFlexibleSearch", () => {
  it("returns the trimmed query", () => {
    expect(assertReadOnlyFlexibleSearch("  SELECT {pk} FROM {Product}  ")).toBe("SELECT {pk} FROM {Product}");
  });
  it("throws a QUERY_REJECTED ToolError", () => {
    try {
      assertReadOnlyFlexibleSearch("DELETE FROM {Product}");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe("QUERY_REJECTED");
    }
  });
});
