import { parseCorrection } from "../platform/web/chat-parse.ts";

const cases = [
  // The directive's own examples.
  "col_15 is the duration",
  "What are the top categories?",
  // Form 1: column-first.
  "alert_code is the category",
  "total_elapsed_time_ms is actually the duration",
  "created_at is really the time",
  "client_ip is the source",
  "return_reason is just the message",
  // Dots, spaces, parens in real headers.
  "total.usd is the threshold",
  "Alert Code is the category",
  "total (USD) is the duration",
  // Form 2: reversed.
  "the category is alert_code",
  "the time is created_at",
  // Form 3: use/set/treat/mark ... as ...
  "use alert_code as the category",
  "set created_at as time",
  "treat host as the source",
  "mark outcome as status",
  // Form 4: should be.
  "alert_code should be the category",
  "latency_ms should be the duration",
  // Synonyms.
  "kind is the category",
  "timestamp is the time",
  "hostname is the source",
  "elapsed is the duration",
  "sla is the threshold",
  "outcome is the state",
  // Trailing punctuation.
  "alert_code is the category.",
  "alert_code is the category?",
  // REFUSALS.
  "col_3 is actually the amount",
  "col_3 is the cost",
  "col_3 is the revenue",
  "",
  "just tell me about the data",
];

let unexpected = 0;
for (const c of cases) {
  const r = parseCorrection(c);
  const label = c === "" ? "(empty string)" : `"${c}"`;
  if (r.ok) {
    console.log(`ACCEPT  ${label.padEnd(48)} -> column=${r.column}  role=${r.role}  (${r.confidence})`);
  } else {
    console.log(`REFUSE  ${label.padEnd(48)} -> ${r.reason.slice(0, 62)}`);
  }
  void unexpected;
}
