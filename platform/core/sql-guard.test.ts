import test from "node:test";
import assert from "node:assert/strict";
import { classifySql } from "./sql-guard.ts";

/**
 * THE SQL GUARD FAILS CLOSED, AND "FAILS CLOSED" IS THE WHOLE DESIGN.
 *
 * A read-only analysis product that will run a caller's SQL is one typo away
 * from deleting their data, and the difference between a SELECT and a DROP is
 * eleven characters that a naive blocklist will eventually miss. So this is a
 * WHITELIST: the query is refused unless it can be PROVEN to be a single
 * read-only statement. Everything else is denied, including anything the parser
 * does not understand, because a parser that is confused is exactly the case
 * where guessing is most expensive.
 *
 * THE THINGS THAT MAKE SQL INJECTION GUARDS FAIL, AND WHAT IS DONE ABOUT EACH.
 *
 * 1. STACKED STATEMENTS. `SELECT 1; DROP TABLE t` runs two statements wherever
 *    a naive "does it contain DROP" check would look. Any semicolon that is not
 *    the very last non-space character ends the verdict, so the trailing one is
 *    allowed and everything after it is not.
 *
 * 2. COMMENTS AS SMUGGLING. A trailing line comment or an inline block comment
 *    can hide a second statement from a reader and from a naive scanner. They are
 *    REFUSED outright rather than stripped. Stripping is the obvious fix and it
 *    is a trap: a comment-handling routine that disagrees with the database's own
 *    about where a comment ends is a bypass waiting to be found, and refusing
 *    costs a query nobody writes on purpose.
 *
 * 3. KEYWORDS HIDDEN IN STRING LITERALS. `SELECT 'DROP TABLE' AS s` is data,
 *    not an attack, and a bare keyword scan denies it. So literals are
 *    tokenised properly -- a doubled quote is an escaped quote, a backslash
 *    escape is honoured -- and keywords are only counted OUTSIDE them.
 *
 * 4. THE ESCAPE DIALECT IS THE UNCERTAIN PART. SQLite and Postgres disagree
 *    about backslash escapes in string literals. Rather than guess and get it
 *    subtly wrong on one of them, a backslash inside a literal DENIES the query.
 *    A query containing one is vanishingly rare, and a rare refusal is a far
 *    better failure than a rare bypass.
 *
 * 5. UNICODE AND HOMOGLYPHS. Keywords are matched ASCII-case-insensitively with
 *    a word boundary, so a Cyrillic "DRO" cannot impersonate "DROP" and cannot
 *    smuggle one either: it simply is not a recognised keyword, and the statement
 *    still has to be a SELECT to pass.
 */

const DENY = (q: string) => assert.equal(classifySql(q).allowed, false, `must be denied: ${q}`);
const ALLOW = (q: string) => assert.equal(classifySql(q).allowed, true, `must be allowed: ${q}`);

test("a plain SELECT is allowed", () => {
  ALLOW("SELECT 1");
  ALLOW("select id, name from users");
  ALLOW("  SELECT   *  FROM  t  ");
  ALLOW("SELECT * FROM t;");
  ALLOW("SELECT * FROM t;\n");
});

test("a CTE is allowed, because it is still one read-only statement", () => {
  ALLOW("WITH recent AS (SELECT * FROM t WHERE ts > 0) SELECT * FROM recent");
  ALLOW("WITH a AS (SELECT 1 AS x), b AS (SELECT 2 AS y) SELECT * FROM a, b");
});

test("every destructive verb is denied", () => {
  for (const sql of [
    "DROP TABLE users",
    "delete from users",
    "INSERT INTO users VALUES (1)",
    "UPDATE users SET a = 1",
    "CREATE TABLE t (a int)",
    "ALTER TABLE t ADD COLUMN b int",
    "TRUNCATE TABLE t",
    "REPLACE INTO t VALUES (1)",
    "PRAGMA table_list",
    "ATTACH DATABASE 'x.db' AS y",
    "DETACH DATABASE y",
    "VACUUM",
    "REINDEX",
    "GRANT ALL ON t TO bob",
    "REVOKE ALL ON t FROM bob",
  ]) DENY(sql);
});

test("THE STACKED STATEMENT IS THE ONE THAT MATTERS MOST", () => {
  DENY("SELECT 1; DROP TABLE users");
  DENY("SELECT * FROM t; DELETE FROM t");
  DENY("SELECT 1;\n; DROP TABLE t");
  DENY("SELECT 1; SELECT 2"); // harmless, but it is not ONE statement, and the rule is one statement
});

test("comments are refused outright rather than stripped", () => {
  DENY("SELECT 1 -- comment");
  DENY("SELECT 1 /* comment */");
  DENY("-- get everything\nSELECT * FROM t");
  DENY("SELECT 1 /* */ ; DROP TABLE t");
});

test("a destructive KEYWORD inside a string literal is data, not an attack", () => {
  ALLOW("SELECT 'DROP TABLE users' AS warning");
  ALLOW('SELECT "delete from t" AS s');
  // And the tokeniser handles a doubled quote as an escaped quote rather than
  // ending the literal, so this stays DATA:
  ALLOW("SELECT 'it''s fine' AS s");
});

test("but a statement after a properly closed literal is still caught", () => {
  DENY("SELECT 'safe' AS s; DROP TABLE users");
  DENY("SELECT 'it''s fine' ; DELETE FROM t");
});

test("a backslash inside a literal denies, because the escape dialects disagree", () => {
  DENY("SELECT 'a\\' ; DROP TABLE users");
  DENY("SELECT 'back\\slash'");
});

test("the word boundary holds, so a column called drop is fine", () => {
  ALLOW("SELECT drop_count, deleted_at FROM t");
  ALLOW("SELECT updates FROM t");
  // ...and a keyword glued to other text is still not a SELECT, so it denies.
  DENY("SELECTED * FROM t");
  DENY("MYSELECT * FROM t");
});

test("an EMPTY or non-SELECT statement denies rather than defaulting to allow", () => {
  for (const q of ["", "   ", ";", "1", "--", "/* */", "EXPLAIN SELECT 1"]) DENY(q);
});

test("a nested subquery is still one statement and is allowed", () => {
  ALLOW("SELECT * FROM t WHERE id IN (SELECT id FROM u WHERE flag = 1)");
});

test("the reason is reported, so a refusal is explainable rather than opaque", () => {
  const r = classifySql("DROP TABLE users");
  assert.equal(r.allowed, false);
  assert.match(r.reason, /DROP/, "the verdict names what was found");
  const ok = classifySql("SELECT 1");
  assert.equal(ok.reason, "single read-only SELECT");
});
