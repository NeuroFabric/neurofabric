/**
 * THE SEMANTIC PROFILER. What is this file FOR?
 *
 * Every surface this product had was named after a FILE SHAPE rather than a
 * QUESTION. "Bottleneck report". "Alert categories by frequency". The engine was
 * very good at telling a person how a column behaved and completely silent about
 * what the column was for, so somebody opening a database performance log was
 * asked to interpret latency statistics as though the tool had no idea -- and
 * somebody opening a sales export was asked the same question about different
 * data and got the same shape of answer.
 *
 * This module is the thing that opens its mouth about the FILE first.
 *
 * === AND IT IS A HYPOTHESIS, SAYED AS ONE ===
 *
 * Every statement below is a claim about a file nobody has described. It is
 * derived from column NAMES and the SHAPE OF VALUES, never from content the
 * engine claims to have read. So the result carries three things the rest of
 * this codebase insists on everywhere else:
 *
 *   - `evidence`: the specific columns that produced the conclusion, so a person
 *     can check the reasoning rather than take it.
 *   - `confidence`: high only when two independent domain columns agree. One
 *     matching column in a file of five anonymous ones is a coincidence, and
 *     naming the file on that basis is worse than saying nothing, because a
 *     purpose statement FRAMES every number that follows it.
 *   - `kind: "unknown"`: a real, first-class answer. Not a fallback and not an
 *     error. An engine that improvises when it does not know is the failure this
 *     repository refuses to commit elsewhere, and a universal data agent that
 *     guesses every file is a narrator, not an agent.
 *
 * === WHY HEADERS AND A SAMPLE, AND NOT THE DATA ===
 *
 * It reads the header row and a bounded sample of values. A million-row file
 * must cost the same as a three-row one, because this runs BEFORE anything else
 * -- the greeting cannot wait on a full scan -- and because a profiler that
 * streams the whole file to categorise it has already done the expensive part
 * it was supposed to make unnecessary.
 *
 * === WHY MATCHING IS ON SUBSTRINGS, NOT EQUALITY ===
 *
 * `total_elapsed_time_ms`, `elapsed_time` and `avgElapsedMs` are the same idea
 * written by three different exporters. Exact matching would recognise one of
 * them and score the other two as anonymous, and a domain whose vocabulary
 * varies by vendor is precisely the domain that needs recognising. Every match
 * records the column it came from, so the looseness stays checkable.
 */

/** What the engine believes the file IS. A closed set, never an open string. */
export type PurposeKind =
  | "database-performance"
  | "transaction"
  | "web-access"
  | "application-log"
  | "unknown";

/**
 * Confidence, stated as a property of the EVIDENCE rather than of the model's
 * certainty. `none` is a real answer and it is the one this module is most often
 * right about.
 */
export type PurposeConfidence = "high" | "medium" | "low" | "none";

export interface Purpose {
  readonly kind: PurposeKind;
  /**
   * One sentence, addressed to a person about a file. Never a key, never a
   * label on its own -- the Owner's requested shape was "This file appears to
   * be a database performance log tracking query execution times", and a bare
   * `database-performance` is not that.
   */
  readonly statement: string;
  /** How sure the engine is, and why it will not be more sure. */
  readonly confidence: PurposeConfidence;
  /** The columns the conclusion rests on. Empty when the answer is `unknown`. */
  readonly evidence: readonly string[];
  /** The columns that are accounted for by the conclusion, for a reader to check. */
  readonly columns: readonly string[];
}

/**
 * A domain signature: what its columns look like, and what to say about it.
 *
 * `required` are the columns that carry the domain's meaning -- two of them
 * agreeing is a HIGH confidence reading. `supporting` strengthen it without
 * being necessary. The split exists because `status_code` alone is a web log,
 * but `status_code` plus `elapsed_time_ms` is unmistakably one, and treating
 * those two cases identically would make confidence a decoration.
 */
interface Domain {
  readonly kind: Exclude<PurposeKind, "unknown">;
  readonly required: readonly { readonly term: string; readonly weight: number }[];
  readonly supporting: readonly string[];
  readonly subject: string;
  readonly detail: string;
}

/**
 * THE DOMAINS.
 *
 * Deliberately few. A taxonomy of thirty shapes would be a taxonomy nobody
 * maintains, and every domain that is too specific to be recognised correctly
 * is a domain that will confidently mislabel somebody's file. Four is what the
 * evidence in this repository actually supports, and `unknown` is the honest
 * answer for the rest.
 *
 * Weights are not a tuning knob; they are a statement about how diagnostic a
 * term is. `query_snippet` is worth 3 because a column holding SQL text is not
 * plausibly anything else. `db_name` is worth 1 because plenty of things have a
 * name column.
 */
const DOMAINS: readonly Domain[] = [
  {
    kind: "database-performance",
    required: [
      { term: "query_snippet", weight: 3 },
      { term: "query_text", weight: 3 },
      { term: "sql", weight: 3 },
      { term: "execution_plan", weight: 3 },
      { term: "elapsed_time", weight: 2 },
      { term: "execution_time", weight: 2 },
      { term: "duration_ms", weight: 2 },
      { term: "query_time", weight: 2 },
      { term: "logical_reads", weight: 3 },
      { term: "physical_reads", weight: 3 },
      { term: "buffer_gets", weight: 2 },
      { term: "db_name", weight: 1 },
      { term: "database", weight: 1 },
      { term: "explain_plan", weight: 3 },
    ],
    supporting: ["lock_wait", "rows_examined", "rows_affected", "plan_id", "wait_event"],
    subject: "a database performance log",
    detail: "tracking query execution times",
  },
  {
    kind: "transaction",
    required: [
      { term: "purchase_amount", weight: 3 },
      // THE ORDER-SHAPED MONEY COLUMN, which the list did not have.
      //
      // `order_value_usd`, `order_total`, `order_amount` are among the most
      // common column names in any sales export, and `order_value_usd` matched
      // NONE of the terms below -- `order_id` and `order_date` are different
      // strings, and `amount` is not a substring of `order_value`. The file
      // scored one hit and failed the confidence gate.
      //
      // The GATE was right and must not move: `customer_id` alone really is not
      // a transaction, and relaxing the gate would make this file identifiable
      // AND make every weakly-signalled file confidently mislabelled. What was
      // missing was the vocabulary, not the strictness.
      { term: "order_value", weight: 3 },
      { term: "order_total", weight: 3 },
      { term: "order_amount", weight: 3 },
      { term: "line_total", weight: 3 },
      { term: "unit_price", weight: 3 },
      { term: "net_amount", weight: 3 },
      { term: "gross_amount", weight: 3 },
      { term: "transaction_id", weight: 3 },
      { term: "transaction", weight: 2 },
      { term: "amount", weight: 1 },
      { term: "price", weight: 2 },
      { term: "total", weight: 1 },
      { term: "revenue", weight: 2 },
      { term: "order_id", weight: 3 },
      { term: "order_date", weight: 2 },
      { term: "customer_id", weight: 2 },
      { term: "product_sku", weight: 3 },
      { term: "sku", weight: 3 },
      { term: "quantity", weight: 2 },
      { term: "cart", weight: 2 },
      { term: "invoice", weight: 2 },
      { term: "basket", weight: 2 },
      { term: "balance", weight: 1 },
    ],
    // RETURNS AND REFUNDS. A returns flag is one of the few things that
    // separates a retail export from a generic ledger, and it costs nothing to
    // ask for: it is supporting evidence, never the load-bearing claim.
    supporting: ["region", "store", "currency", "discount", "ship_date", "channel", "line_item",
      "return", "refund", "returned", "is_returned", "account_id", "entry_type", "debit", "credit"],
    subject: "a customer transaction or sales record",
    detail: "tracking orders and what was bought",
  },
  {
    kind: "web-access",
    required: [
      { term: "request_method", weight: 3 },
      { term: "method", weight: 1 },
      { term: "status_code", weight: 3 },
      { term: "response_bytes", weight: 3 },
      { term: "request_path", weight: 3 },
      { term: "path", weight: 1 },
      { term: "url", weight: 2 },
      { term: "remote_addr", weight: 3 },
      { term: "user_agent", weight: 3 },
      { term: "referer", weight: 2 },
      { term: "http", weight: 2 },
      { term: "response_time", weight: 2 },
    ],
    supporting: ["bytes_sent", "bytes", "protocol", "referrer", "session_id", "hostname", "port"],
    subject: "a web access log",
    detail: "tracking HTTP requests and how they were served",
  },
  {
    kind: "application-log",
    required: [
      { term: "stack_trace", weight: 3 },
      { term: "exception", weight: 3 },
      { term: "severity", weight: 3 },
      { term: "log_level", weight: 3 },
      { term: "level", weight: 1 },
      { term: "trace_id", weight: 3 },
      { term: "thread_name", weight: 3 },
      { term: "logger", weight: 2 },
      { term: "message", weight: 1 },
      { term: "error_count", weight: 2 },
    ],
    supporting: ["service", "environment", "host", "pid", "correlation_id", "span_id"],
    subject: "an application log",
    detail: "tracking service behaviour and errors",
  },
];

/** How many rows are worth looking at. Enough to spot a shape, bounded to stay cheap. */
const SAMPLE_ROWS = 20;

/**
 * What a column's values look like, because two of these are load-bearing.
 *
 * `numeric` is what separates a web access log from an application log when both
 * carry `duration`. `temporal` is what separates either from a file that merely
 * has a column called `date`.
 */
interface ColumnShape {
  readonly name: string;
  readonly numeric: boolean;
  readonly temporal: boolean;
  readonly distinctRatio: number;
}

/** A value that looks like an instant or a date. Deliberately conservative. */
function looksTemporal(values: readonly string[]): boolean {
  let hits = 0;
  for (const v of values) {
    if (v === "") continue;
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) { hits += 1; continue; }
    if (/^\d{1,2}\/\d{1,2}\/\d{4}/.test(v)) { hits += 1; continue; }
    if (/^\d{10,13}$/.test(v)) { hits += 1; }
  }
  const filled = values.filter((v) => v !== "");
  return filled.length > 0 && hits / filled.length >= 0.6;
}

function looksNumeric(values: readonly string[]): boolean {
  let hits = 0;
  for (const v of values) {
    if (v === "") continue;
    if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v)) hits += 1;
  }
  const filled = values.filter((v) => v !== "");
  return filled.length > 0 && hits / filled.length >= 0.8;
}

function shapeOf(headers: readonly string[], rows: readonly Record<string, string>[]): ColumnShape[] {
  const sample = rows.slice(0, SAMPLE_ROWS);
  return headers.map((name) => {
    const values = sample.map((r) => String(r[name] ?? ""));
    const filled = values.filter((v) => v !== "");
    const distinct = new Set(filled).size;
    return {
      name,
      numeric: looksNumeric(values),
      temporal: looksTemporal(values),
      distinctRatio: filled.length === 0 ? 0 : distinct / filled.length,
    };
  });
}

/**
 * Score one domain against the file.
 *
 * Returns the weight earned and the columns that earned it. A term matches on
 * SUBSTRING, because the same idea is spelled differently by every exporter, and
 * `query_snippet` must not miss `db_query_snippet_hash`. The matched column is
 * recorded either way, which is what keeps the looseness checkable.
 */
function scoreDomain(domain: Domain, shapes: readonly ColumnShape[]): {
  weight: number;
  evidence: string[];
  hits: number;
} {
  let weight = 0;
  const evidence: string[] = [];
  let hits = 0;

  for (const shape of shapes) {
    const haystack = shape.name.toLowerCase();
    let matched = false;

    for (const { term, weight: w } of domain.required) {
      if (haystack.includes(term)) {
        weight += w;
        evidence.push(`${shape.name} (${term})`);
        matched = true;
        hits += 1;
        break; // one term per column: `elapsed_time` must not score twice
      }
    }
    if (matched) continue;

    for (const term of domain.supporting) {
      if (haystack.includes(term)) {
        weight += 1;
        evidence.push(`${shape.name} (${term})`);
        hits += 1;
        break;
      }
    }
  }
  return { weight, evidence, hits };
}

/**
 * SAY WHAT THE FILE IS, OR SAY THAT WE DO NOT KNOW.
 *
 * The whole module in one function. There is no partial answer and no best
 * effort: a file either matches a domain on enough evidence to defend it, or it
 * is `unknown`, and `unknown` is returned with the same confidence as anything
 * else rather than as an apology.
 */
export function describePurpose(input: {
  readonly headers: readonly string[];
  readonly rows: readonly Record<string, string>[];
}): Purpose {
  const headers = input.headers ?? [];
  const rows = input.rows ?? [];

  // Nothing to go on is not a low-confidence guess; it is no answer.
  if (headers.length === 0) {
    return {
      kind: "unknown",
      statement: "This file has no columns I can read, so I cannot tell what it is.",
      confidence: "none",
      evidence: [],
      columns: [],
    };
  }

  const shapes = shapeOf(headers, rows);
  const scored = DOMAINS
    .map((domain) => ({ domain, ...scoreDomain(domain, shapes) }))
    // Highest weight wins; ties break on the domain with more independent hits,
    // because two distinct columns are a better reading than one column that
    // matched two terms.
    .sort((a, b) => b.weight - a.weight || b.hits - a.hits);

  const best = scored[0];
  const runnerUp = scored[1];

  // === THE CONFIDENCE GATE, AND WHY IT IS A GATE AND NOT A SCORE ===
  //
  // One matching column is a coincidence. `purchase_amount` appears in one sales
  // file and in a thousand others; a purpose statement built on it would frame
  // every subsequent number with a claim nobody checked. So a domain must earn
  // its answer with at least TWO independent columns AND enough total weight.
  //
  // This is the part most likely to be relaxed by a later change that wants one
  // more file to classify, and the test file pins the case that must stay
  // unclassified for exactly that reason.
  const enough = best !== undefined && best.weight >= 4 && best.hits >= 2;

  // A runner-up within reach means the file is genuinely between two readings.
  // Saying so is more useful than picking the larger number and hoping.
  const contested = best !== undefined && runnerUp !== undefined &&
    runnerUp.hits >= 2 && runnerUp.weight >= best.weight - 2;

  if (!enough) {
    return {
      kind: "unknown",
      statement: contested && runnerUp !== undefined
        ? `This file does not read clearly as one thing -- it looks part ${runnerUp.domain.subject}, part ${best?.domain.subject}. ` +
          "Tell me what it is and I will read it that way."
        : "I cannot tell from the column names what this file is. " +
          "Tell me what it is for and I will read it that way.",
      confidence: "none",
      evidence: [],
      columns: headers,
    };
  }

  const confidence: PurposeConfidence =
    best.weight >= 8 && best.hits >= 3 ? "high"
      : best.weight >= 6 && best.hits >= 3 ? "medium"
        : "low";

  const qualifier = confidence === "high" ? "This file is" : "This file appears to be";
  const seen = best.evidence.slice(0, 4).map((e) => e.replace(/\s*\(.*\)$/, "")).join(", ");

  return {
    kind: best.domain.kind,
    statement: `${qualifier} ${best.domain.subject} ${best.domain.detail}.`,
    confidence,
    evidence: best.evidence,
    columns: headers,
  };
}

/**
 * THE COLUMN SHAPES, exported because the caller already computed them and
 * recomputing would mean scanning the sample twice for no reason.
 */
export function columnShapes(input: {
  readonly headers: readonly string[];
  readonly rows: readonly Record<string, string>[];
}): ColumnShape[] {
  return shapeOf(input.headers ?? [], input.rows ?? []);
}

export type { ColumnShape };

/**
 * A TITLE THAT DESCRIBES THE FILE INSTE OF ASSUMING IT.
 *
 * "Bottleneck report: operations.csv" was the title of every artifact this
 * product produced, for every file, including sales exports and web access logs
 * where the word bottleneck was simply wrong. A universal agent that names
 * every file after one hypothesis is not universal, it is a template.
 *
 * So the title carries the file's NAME -- which is always true and never a
 * guess -- and the PURPOSE is carried separately, in the greeting, where it is
 * shown as a hypothesis with its evidence. Splitting the two is the point: the
 * title is a label, the purpose is a claim, and only one of them should be
 * stated flatly.
 */
export function titleFor(input: { readonly fileName: string; readonly purpose: Purpose }): string {
  const name = input.fileName.replace(/\.[^.]+$/, "") || input.fileName;
  return `Analysis: ${name}`;
}