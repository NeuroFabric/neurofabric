import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { describePurpose } from "./semantics.ts";

/**
 * THE DEMO FILES MUST BE IDENTIFIABLE, OR THE AGENT OPENS EVERY DEMO WITH AN
 * APOLOGY.
 *
 * "Looking at the column names, I cannot tell what this file is for, so I will
 * not guess" is a defensible sentence for a file the engine has never seen. It
 * is not defensible for the company's OWN demo dataset, in a demo. The Owner
 * reported exactly this: the semantic profiler failed to recognise
 * e-commerce-transactions.csv.
 *
 * === WHY IT FAILED, WHICH IS NOT A MISSING KEYWORD ===
 *
 * The file's columns are `_time, customer_id, order_value_usd, status_code,
 * category, is_returned, returned_reason`. The transaction domain knows
 * `customer_id` (weight 2) and nothing else here -- `order_value_usd` contains
 * none of `order_id`, `order_date`, `amount`, `price`, `total`, `revenue`,
 * `quantity`, `sku`. So the domain scored weight 2 on ONE hit and failed the
 * confidence gate, which requires two independent columns and weight >= 4.
 *
 * The gate was RIGHT. `customer_id` alone really is not enough -- it appears in
 * a thousand files that are not transactions. What was wrong is the
 * VOCABULARY: `order_value` is an extremely common name for the single most
 * transactional column there is, and the list did not have it.
 *
 * That distinction matters. Relaxing the gate would have made this pass AND
 * made every weakly-signalled file in the product confidently mislabelled,
 * because a wrong purpose statement frames every number after it. Fixing the
 * vocabulary makes this file identifiable without weakening anything.
 */

const SYNTHETIC = path.resolve(process.cwd(), "test-fixtures", "synthetic");

function csv(path0: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = fs.readFileSync(path0, "utf8").split("\n").filter(Boolean);
  const headers = lines[0]!.split(",");
  const rows = lines.slice(1, 60).map((l) =>
    Object.fromEntries(l.split(",").map((c, i) => [headers[i]!, c])));
  return { headers, rows };
}

test("the e-commerce demo file is identified, not apologised about", () => {
  const { headers, rows } = csv(path.join(SYNTHETIC, "e-commerce-transactions.csv"));
  const purpose = describePurpose({ headers, rows });

  assert.notEqual(purpose.kind, "unknown",
    `the demo file must be identifiable; got: ${purpose.statement}`);
  assert.equal(purpose.kind, "transaction",
    "and it is a transaction log, not a database or web log");
  assert.ok(purpose.confidence !== "none", "with a confidence worth acting on");
  assert.doesNotMatch(purpose.statement, /cannot tell|will not guess/i,
    "the statement must not be the fallback");
});

test("it names the columns it used, so the claim is checkable", () => {
  const { headers, rows } = csv(path.join(SYNTHETIC, "e-commerce-transactions.csv"));
  const purpose = describePurpose({ headers, rows });
  assert.ok(purpose.evidence.length >= 2,
    `at least two independent columns must carry the claim: ${JSON.stringify(purpose.evidence)}`);
  assert.ok(purpose.evidence.some((e) => e.includes("order_value_usd")),
    `the money column is the one that was missing from the vocabulary: ${JSON.stringify(purpose.evidence)}`);
});

test("a file that is still ambiguous stays ambiguous", () => {
  // The guard on the fix above. A lone `customer_id` is NOT a transaction log,
  // and widening the vocabulary must not make it one -- otherwise every weakly
  // signalled file in the product gets a confident label that frames every
  // number after it.
  const purpose = describePurpose({
    headers: ["customer_id", "notes"],
    rows: [{ customer_id: "CUST-1", notes: "hello" }, { customer_id: "CUST-2", notes: "hi" }],
  });
  assert.equal(purpose.kind, "unknown",
    "one suggestive column is a coincidence, not a purpose");
});

test("a financial ledger is identified too", () => {
  const { headers, rows } = csv(path.join(SYNTHETIC, "financial-ledger.csv"));
  const purpose = describePurpose({ headers, rows });
  assert.notEqual(purpose.kind, "unknown",
    `the ledger demo must be identifiable; got: ${purpose.statement}`);
});

test("a service mesh log is NOT called a transaction log", () => {
  // The counter-case. Latency and status codes are transaction-adjacent in a
  // real warehouse, and a vocabulary that grows too eagerly will claim them.
  const { headers, rows } = csv(path.join(SYNTHETIC, "service-mesh-access.csv"));
  const purpose = describePurpose({ headers, rows });
  assert.notEqual(purpose.kind, "transaction",
    `the mesh log is not a sales log: ${purpose.statement}`);
  assert.notEqual(purpose.kind, "unknown",
    `but it should still be identifiable as something: ${purpose.statement}`);
});