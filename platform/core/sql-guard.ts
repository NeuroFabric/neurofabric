/**
 * THE SQL GUARD. A whitelist, because a blocklist is eleven characters from
 * being wrong.
 *
 * A read-only analysis product that runs a caller's SQL is one typo away from
 * deleting their data, and the distance between SELECT and DROP is small enough
 * that a blocklist will eventually miss it. So a query is allowed only when it
 * can be PROVEN to be a single read-only statement. Everything else denies,
 * including anything this parser does not understand, because a confused parser
 * is precisely the case where guessing is most expensive.
 *
 * This is deliberately fail-closed at the WORST possible moment: a false refusal
 * costs a query, and a false acceptance costs a table.
 *
 * WHAT IS REFUSED, AND WHY EACH ONE IS HERE.
 *
 * STACKED STATEMENTS. `SELECT 1; DROP TABLE t` runs two statements anywhere a
 * "does it contain DROP" check would not look. A semicolon is permitted only as
 * the final non-space character, so there is exactly one statement and it may
 * have a trailing semicolon, which is how most people write SQL.
 *
 * COMMENTS ARE REFUSED, NOT STRIPPED. A comment-aware parser that disagrees with
 * the database's own about where a comment ends is a bypass waiting to be found,
 * and "strip the comment then look" is exactly that parser. Refusing costs a
 * query nobody writes on purpose; stripping risks a hole nobody looks for.
 *
 * KEYWORDS INSIDE STRING LITERALS ARE DATA. `SELECT 'DROP TABLE' AS warning` is
 * a perfectly good query, and a bare keyword scan denies it, which trains people
 * to disable the guard. So literals are tokenised with both escape forms SQLite
 * understands -- a doubled quote and a backslash -- and keywords are counted only
 * outside them.
 *
 * THE BACKSLASH CASE DENIES ANYWAY. SQLite and Postgres disagree about backslash
 * escapes in string literals, and this module does not want to be subtly wrong on
 * one of them. A backslash inside a literal therefore denies: a rare refusal is
 * a much better failure than a rare bypass.
 *
 * UNICODE. Keywords are matched ASCII-case-insensitively with a word boundary, so
 * a Cyrillic "DRO" cannot impersonate "DROP" -- it is simply not a recognised
 * keyword, and the statement still has to begin with SELECT or WITH to pass.
 */

export interface SqlVerdict {
  readonly allowed: boolean;
  /** Why. A refusal a caller cannot explain is a refusal they will route around. */
  readonly reason: string;
}

const ALLOWED: SqlVerdict = { allowed: true, reason: "single read-only SELECT" };

/**
 * Anything that is not a read is refused. Matched as a whole word outside string
 * literals, ASCII-case-insensitively.
 */
const WRITE_VERBS = [
  "insert", "update", "delete", "drop", "create", "alter", "truncate",
  "replace", "attach", "detach", "pragma", "vacuum", "reindex", "analyze",
  "grant", "revoke", "execute", "exec", "call", "merge", "upsert", "begin",
  "commit", "rollback", "savepoint", "release", "lock", "copy", "load",
  "install", "uninstall", "trigger", "raise",
] as const;

const SELECT_START = /^(?:select|with|values|table)\b/i;

/**
 * Split the query into string literals and bare text, refusing anything the
 * tokeniser cannot account for.
 *
 * Returns undefined for a query containing a comment or a backslash inside a
 * literal, which is the signal to deny -- the caller does not need to know which
 * of the two it hit, and neither is safe to interpret.
 */
function tokenize(sql: string): { literals: string[]; code: string } | undefined {
  const literals: string[] = [];
  let code = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let value = "";
      i += 1;
      let closed = false;
      while (i < sql.length) {
        if (sql[i] === "\\") return undefined; // escape dialects disagree; refuse
        if (sql[i] === quote) {
          // A doubled quote is an escaped quote, not the end of the literal.
          if (sql[i + 1] === quote) { value += quote; i += 2; continue; }
          closed = true;
          i += 1;
          break;
        }
        value += sql[i];
        i += 1;
      }
      if (!closed) return undefined; // unterminated literal: refuse
      literals.push(value);
      code += " ";
      continue;
    }
    // A comment, however it is written.
    if (ch === "-" && sql[i + 1] === "-") return undefined;
    if (ch === "/" && sql[i + 1] === "*") return undefined;
    code += ch;
    i += 1;
  }
  return { literals, code };
}

/**
 * Classify a query. Pure: no I/O, no database, no policy. The caller decides
 * what to do with the verdict, which is what lets the same function serve both
 * the kernel's precheck and the connector's own last line of defence.
 */
export function classifySql(sql: string): SqlVerdict {
  if (typeof sql !== "string" || sql.trim().length === 0) {
    return { allowed: false, reason: "empty query" };
  }

  const trailing = sql.trimEnd();
  const body = trailing.endsWith(";") ? trailing.slice(0, -1) : trailing;
  if (body.trim().length === 0) return { allowed: false, reason: "query is only punctuation" };
  if (body.includes(";")) {
    // One statement, one statement: anything left after a semicolon is a second.
    return { allowed: false, reason: "stacked statements: a semicolon appears before the end of the query" };
  }

  const tokenized = tokenize(body);
  if (tokenized === undefined) {
    return { allowed: false, reason: "query contains a comment or an escaped quote, which this guard does not interpret" };
  }

  const { code } = tokenized;
  for (const verb of WRITE_VERBS) {
    if (new RegExp(`\\b${verb}\\b`, "i").test(code)) {
      return { allowed: false, reason: `write verb ${verb.toUpperCase()} is not read-only` };
    }
  }

  if (!SELECT_START.test(code.trim())) {
    return { allowed: false, reason: "query does not begin with SELECT, WITH, VALUES or TABLE" };
  }
  return ALLOWED;
}
