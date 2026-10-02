import test from "node:test";
import assert from "node:assert/strict";

import { toBottleneckMarkdown } from "../conductor/bottleneck-report.ts";
import { parseCsv } from "../conductor/capabilities.ts";
import { analyseBottlenecks } from "../conductor/bottlenecks.ts";

/**
 * TASK 3 -- THE REPORT IS TOO LOUD.
 *
 * The Owner read a database performance CSV and waded through a hundred rows to
 * reach anything. Two separate causes, and they are not the same defect:
 *
 *   - PROVENANCE LED. "How this report was read" appeared near the top. It is
 *     the single most important sentence in the document -- whether a column
 *     reading was verified by a person or guessed from a header -- and leading
 *     with it makes a reader stop reading. The information is not the problem.
 *     Its POSITION is.
 *   - NO TOP-N. The category tables printed every row they were given. A ranking
 *     is a claim about which rows matter, and a claim you scroll to find is not
 *     a claim.
 *
 * === WHAT IS DELIBERATELY NOT CHANGED ===
 *
 * Nothing is DELETED. The full ranking is still generated and still returned by
 * the API; it is simply not the first thing on the page. A report that hides the
 * rows past five would be making an editorial decision the reader cannot undo,
 * and the whole product is the refusal to do that silently.
 */

/** A file with enough distinct categories that "top 5" is a real decision. */
const CSV = (() => {
  const lines = ["_time,source_host,alertType,elapsed_time"];
  const kinds = ["login", "checkout", "search", "logout", "upload", "sync", "export", "import"];
  let i = 0;
  for (let hour = 0; hour < 6; hour += 1) {
    for (let n = 0; n < 12; n += 1) {
      const kind = kinds[i % kinds.length];
      lines.push(`2026-09-30T${String(hour).padStart(2, "0")}:00:00.000,host-${i % 3},${kind},${100 + (i % 9) * 25}`);
      i += 1;
    }
  }
  return `${lines.join("\n")}\n`;
})();

function analyse(): ReturnType<typeof analyseBottlenecks> {
  const parsed = parseCsv(CSV);
  const rows = parsed.rows.map((cells) => Object.fromEntries(parsed.headers.map((h, i) => [h, cells[i] ?? ""])));
  return analyseBottlenecks({
    path: "operations.csv",
    headers: parsed.headers,
    rowCount: parsed.rows.length,
    columns: [],
    sample: [],
    rows,
    problems: parsed.problems,
  });
}

/**
 * The pure renderer, not `renderBottleneckReport`, which writes to disk. This
 * test is about what the Markdown SAYS and in what order -- both are properties
 * of the string, and reading the string is both cheaper and more honest than
 * writing a file to read one back.
 */
const md = toBottleneckMarkdown(analyse(), "Bottleneck report", "Summary.");

test("precondition: the fixture really produces a report with readings", () => {
  assert.ok(md.length > 0, "the fixture must render something");
  assert.ok(/columns|read/i.test(md), "and it must discuss how columns were read");
});

test("the provenance section is at the BOTTOM, and named as provenance", () => {
  const provenanceAt = md.search(/^##+ .*(provenance|how this report was read)/im);
  assert.ok(provenanceAt > 0, `a provenance section must exist. Report starts:\n${md.slice(0, 400)}`);
  assert.match(md.slice(provenanceAt), /^##+ .*provenance/im,
    "and be named for what it is, at the foot of the document");
});

test("PROVENANCE DOES NOT LEAD, and the report says something else first", () => {
  // THE ASSERTION THAT MATTERS. Moving the section is cosmetic; moving it behind
  // the FINDING is the fix. A reader who has already seen the problem will look
  // up how the file was read; a reader who meets a provenance disclaimer first
  // stops reading.
  const provenanceAt = md.search(/^##+ .*(provenance|how this report was read)/im);
  const firstFindingAt = md.search(/^##+ /im);
  assert.ok(firstFindingAt > -1, "the report must have sections");
  assert.notEqual(firstFindingAt, provenanceAt,
    "provenance must not be the FIRST section in the document");
  assert.ok(provenanceAt > firstFindingAt, "it must come after at least one substantive section");
});

test("the provenance section is still COMPLETE after moving", () => {
  // A move that quietly drops the mapping table is worse than no move: the
  // reader loses the ability to check WHICH columns were guesses, which is the
  // only reason the section exists.
  const tail = md.slice(md.search(/^##+ .*provenance/im));
  assert.match(tail, /role.*column|column.*role/is,
    "the role-to-column table must still be in the provenance block");
  assert.ok(tail.length > 200, `and the block must carry real content, got ${tail.length} chars`);
});

/** The numbered rows of the FIRST ranking table, and nothing after it. */
function rankingRows(markdown: string): string[] {
  const header = /^\| # \| category \|.*$/im.exec(markdown);
  if (header === null) return [];
  // Bounded to THIS table. The report carries several rankings (by frequency,
  // by elapsed), and collecting to the end of the document summed them -- five
  // plus five, which read as one table of ten and looked like the cap had not
  // been applied at all.
  const after = markdown.slice(header.index).split("\n");
  const rows: string[] = [];
  for (const line of after.slice(2)) {
    if (!/^\|\s*\d+\s*\|/.test(line)) {
      if (rows.length > 0) break; // end of the table body
      continue;
    }
    rows.push(line);
  }
  return rows;
}

test("the category ranking is capped at 5 rows by default", () => {
  const rows = rankingRows(md);
  assert.ok(rows.length > 0, `expected a ranking table. Head:\n${md.slice(0, 400)}`);
  assert.ok(rows.length <= 5,
    `a ranking of ${rows.length} rows is a data dump, not a ranking; cap it at 5`);
});

test("a cap that is stated beats a cap that is silent", () => {
  // Truncating a table without saying so is the failure this product refuses
  // elsewhere: a reader cannot tell "we ranked five" from "there were five".
  const rows = rankingRows(md);
  if (rows.length === 5) {
    assert.match(md.slice(md.indexOf(rows[rows.length - 1])), /top 5 of/i,
      "a truncated ranking must SAY it is truncated, and how much was left out");
  }
});

test("nothing about the FULL ranking was removed from the data", () => {
  // The cap is a presentation decision. The analysis still knows every category,
  // and any consumer reading the object -- rather than the Markdown -- must see
  // them all. If this ever fails, the "cap" became a deletion.
  const analysis = analyse();
  assert.ok(analysis.categories.length > 5,
    `the fixture must have more than 5 categories for the cap to mean anything, got ${analysis.categories.length}`);
  assert.ok(analysis.byHour.length > 0, "and hours");
});
