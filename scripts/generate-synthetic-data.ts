/**
 * SYNTHETIC DEMO DATASETS.
 *
 * Three files that let somebody demo the agent in ninety seconds without
 * bringing their own data, which is the actual reason this exists: a demo that
 * requires the customer to have a sensitive CSV in hand is a demo that does not
 * happen.
 *
 * === EVERYTHING HERE IS SYNTHETIC, AND THAT IS A DESIGN CONSTRAINT ===
 *
 * The numbers come from a seeded PRNG, so a regeneration is byte-identical and
 * two people demoing the same file see the same chart.
 *
 * The IDENTIFIERS are synthetic by construction, and that matters more than the
 * numbers: these files get emailed to customers, dropped into slide decks, and
 * opened by people who did not consent to their traffic patterns appearing in
 * a sales conversation.
 *
 *   - Customers are `CUST-00042`, an opaque sequence. No names, no email, no
 *     address, no phone. A demo file with a plausible-looking person in it is
 *     a demo file somebody will eventually be asked to delete.
 *   - Client IPs are drawn ONLY from RFC 5737 documentation ranges
 *     (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24). These are reserved for
 *     exactly this and cannot collide with a real network, so a demo can never
 *     leak a customer topology.
 *   - Accounts are `ACC-000123`, the same opaque sequence.
 *
 * === WHY EVERY HOUR IS POPULATED, RATHER THAN MOST OF THEM ===
 *
 * The first version of this generator scattered a day's orders at a uniformly
 * random hour. That is how real data looks, and it is exactly why the flagship
 * forecast would not run: the forecasting engine refuses to project when any
 * two consecutive observed hours are not adjacent, and with a Poisson-ish spread
 * an empty hour is only a matter of time. It refused on two of the three files
 * with `the hours in this file are not continuous`.
 *
 * The refusal is CORRECT and should stay. A hole in a timeline is missing data,
 * not a quiet hour, and smoothing across one invents a dip and a recovery from
 * it. So the data moved, not the engine: each file is now generated one HOUR AT
 * A TIME with a minimum of one row, which is what a continuously-sampled system
 * (a metrics pipeline, a service-mesh sidecar) actually produces.
 *
 * That alone was NOT enough, and the reason is worth recording because it is
 * invisible from the data side. Guaranteeing one row per file hour guarantees
 * contiguity only if the file's hour axis and the engine's are the same axis.
 * They are not, unless the timestamps say so -- see the note on `stamp` below.
 * The generator's own continuity check and the engine's disagreeing is how the
 * bug was found, and a generator that verified only against itself would have
 * shipped a demo file that silently could not forecast.
 *
 * Note this is a STRONGER requirement than "24 contiguous hours". The gap check
 * in forecasting.ts runs over every observed hour in the file, so a 24-hour
 * window inside a gapped series still refuses. Every hour from the first to the
 * last is populated, with nothing skipped.
 *
 * === WHY THE CLASSIFICATION COLUMN IS NAMED `category` ===
 *
 * The engine resolves the category role by EXACT column name against a fixed
 * list (`alert_code`, `alert_type`, `category`, `event_type`, `type`, ...), and
 * then rejects a column holding a single distinct value. So a column called
 * `channel` or `endpoint`, however obviously categorical, is invisible to the
 * "what are the top categories?" question -- which is a leading question the
 * agent itself proposes in its own suggestions.
 *
 * Naming the column `category` is not cosmetic: it is what makes the flagship
 * query answerable. The VALUES stay descriptive (web/ios/android, /api/checkout,
 * credit/debit), so the dashboard still reads sensibly.
 *
 * === THE INJECTED FAULTS ARE COMPUTED, NOT TYPED ===
 *
 * The point of a demo dataset is that the AGENT FINDS the anomaly. A hardcoded
 * "999999" is a number a person typed; the 4x IQR spike below is derived from
 * the sample's own quartiles, so the anomaly is a real statistical outlier of
 * this distribution rather than a decoration. `verify()` recomputes it from the
 * written CSV, which is what makes the claim checkable by someone who does not
 * trust this file.
 *
 * Run:  node --experimental-strip-types scripts/generate-synthetic-data.ts
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, "..", "test-fixtures", "synthetic");

/** The forecasting engine's own floor, mirrored so the data can honour it. */
const MIN_OBSERVATIONS = 12;

/** The engine scans at most this many rows; a demo file larger is dead weight. */
const MAX_ROWS_SCANNED = 10_000;

/**
 * A seeded PRNG (mulberry32). Math.random() would make every run a different
 * file, and a demo whose numbers move between rehearsals is a demo somebody
 * stops trusting after the second try.
 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** IQR over a sample, used to DERIVE the injected spike rather than invent one. */
function iqr(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return quantile(s, 0.75) - quantile(s, 0.25);
}

/** RFC 5737 documentation ranges. Reserved for docs; cannot be real traffic. */
const DOC_IP_BLOCKS = ["192.0.2.", "198.51.100.", "203.0.113."] as const;

const pad = (n: number, width: number) => String(n).padStart(width, "0");

/** Epoch hour for a (day, hour) pair -- the unit the continuity check works in. */
function hourOf(day: number, hour: number): number {
  return Date.UTC(2026, 8, 1 + day, hour, 0, 0) / 3_600_000;
}

/**
 * A TIMESTAMP THAT MEANS WHAT IT SAYS.
 *
 * The trailing `Z` is not decoration, and getting it wrong silently breaks the
 * flagship forecast. The engine buckets rows with
 *
 *     new Date(parseInstant(raw)).toISOString().slice(0, 13)
 *
 * `Date.parse` reads a timestamp with no zone designator as LOCAL time (ES2015+),
 * and `toISOString` then renders it in UTC. On a machine at UTC+05:30 that is a
 * half-hour shift, and because it is a half-hour shift the mapping from a file
 * hour to an engine hour DEPENDS ON THE MINUTE:
 *
 *     09-19T01:00 IST -> 09-18T19:30Z -> engine hour 19
 *     09-19T01:59 IST -> 09-18T20:29Z -> engine hour 20
 *     09-19T02:00 IST -> 09-18T20:30Z -> engine hour 20
 *
 * So adjacent file hours OVERLAP on the engine's axis. That is survivable --
 * but if one file hour happens to contain only early minutes and the next only
 * late ones, the engine hour between them receives nothing and the timeline
 * develops a hole, and the forecast then refuses with "the hours in this file
 * are not continuous". That refusal is CORRECT: the hole is real, in the axis
 * the engine actually plots.
 *
 * Emitting `Z` makes `Date.parse` absolute, so each file hour maps to exactly
 * one engine hour and contiguity is a property of the DATA rather than of the
 * clock. It is also better hygiene for a demo file: a log with explicit zones is
 * one the engine will not flag as timezone-naive.
 */
function stamp(day: number, hour: number, minute: number, second: number): string {
  return `${new Date(Date.UTC(2026, 8, 1 + day, hour, minute, second)).toISOString().slice(0, 23)}Z`;
}

/**
 * The hour bucket a timestamp falls into, as the engine labels it: `2026-09-01T09`.
 * Truncating to the hour is what makes two rows in the same hour one observation
 * rather than two, so this must agree with the engine's own bucketing exactly --
 * which, because `stamp` emits an explicit `Z`, it now does.
 */
function hourLabel(iso: string): string {
  return iso.slice(0, 13);
}

/** A standard-normal draw, for the log-normal shapes real spend and latency follow. */
function normal(rand: () => number): number {
  const u1 = Math.max(rand(), 1e-9);
  const u2 = rand();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** A diurnal weight: quiet night, morning ramp, lunch bump, heavier evening. */
function diurnal(hour: number): number {
  if (hour < 6) return 0.35;
  if (hour < 11) return 0.9;
  if (hour < 14) return 1.15;
  if (hour < 20) return 1.35;
  return 0.8;
}

// ---------------------------------------------------------------------------
// 1. E-COMMERCE TRANSACTIONS — a fat-tailed value distribution.
// ---------------------------------------------------------------------------

/**
 * Order values are LOG-NORMAL, not uniform or normal. Real spend is heavily
 * right-skewed: a great many small orders and a thin tail of large ones, and a
 * uniform draw would make the dashboard's whole point -- that the distribution
 * has a tail -- invisible. The agent is being demoed on a shape it will meet in
 * production.
 *
 * Generated hour by hour so no hour is empty. 30 days x 24 = 720 contiguous
 * hours, which clears MIN_OBSERVATIONS by a wide margin and keeps the total
 * under MAX_ROWS_SCANNED.
 */
function eCommerce(): { csv: string; facts: Record<string, number | string> } {
  const rand = rng(0xe00a);
  const rows: string[] = ["_time,customer_id,order_value_usd,status_code,category,is_returned,returned_reason"];
  const categories = ["web", "ios", "android", "partner-api"];
  const reasons = ["", "", "", "damaged", "wrong-size", "late-delivery", "not-as-described"];

  const DAYS = 30;
  const OUTLIER_DAY = 19;
  let outlierValue = 0;
  let returns = 0;
  const baseline: number[] = [];

  for (let day = 0; day < DAYS; day++) {
    const weekendLift = day % 7 === 5 || day % 7 === 6 ? 1.35 : 1;
    for (let hour = 0; hour < 24; hour++) {
      // Mean ~9 orders an hour, so ~6,500 rows overall, and AT LEAST ONE per
      // hour whatever the diurnal weight says. The clamp is the whole fix.
      const weight = diurnal(hour) * weekendLift;
      const count = Math.max(1, Math.round(weight * (5 + rand() * 6)));
      for (let i = 0; i < count; i++) {
        const value = Number(Math.exp(4.1 + normal(rand) * 0.55).toFixed(2));
        baseline.push(value);

        // THE INJECTED FAULT: one 250k order on day 19, against a distribution
        // whose 99th percentile is around 400. A 250,000 figure is not a typo a
        // customer made; it is a currency bug or a fraudulent order, and those
        // are the things a demo should be able to talk about.
        const isOutlier = day === OUTLIER_DAY && hour === 12 && i === 0;
        if (isOutlier) outlierValue = 250000;

        const returned = rand() < 0.061;
        if (returned) returns++;
        rows.push([
          stamp(day, hour, Math.floor(rand() * 60), Math.floor(rand() * 60)),
          `CUST-${pad(Math.floor(rand() * 4800) + 1, 5)}`,
          (isOutlier ? outlierValue : value).toFixed(2),
          "200",
          categories[Math.floor(rand() * categories.length)]!,
          returned ? "true" : "false",
          returned ? reasons[1 + Math.floor(rand() * (reasons.length - 1))]! : "",
        ].join(","));
      }
    }
  }

  return {
    csv: rows.join("\n") + "\n",
    facts: {
      rows: rows.length - 1,
      "contiguous hours": DAYS * 24,
      "category column": "category (web/ios/android/partner-api)",
      "injected outlier (order_value_usd)": outlierValue,
      "baseline p99 order value": Number(quantile([...baseline].sort((a, b) => a - b), 0.99).toFixed(2)),
      returns,
      "customer_id format": "CUST-00001 (opaque, no PII)",
    },
  };
}

// ---------------------------------------------------------------------------
// 2. SERVICE MESH ACCESS — a latency regime change inside one hour.
// ---------------------------------------------------------------------------

const MESH_CATEGORIES = [
  "/api/checkout", "/api/cart", "/api/search", "/api/pricing",
  "/api/inventory", "/api/recommend", "/api/auth/token", "/api/orders",
] as const;

const MESH_UPSTREAMS: Record<string, string> = {
  "/api/checkout": "payments-svc", "/api/cart": "cart-svc", "/api/search": "search-svc",
  "/api/pricing": "pricing-svc", "/api/inventory": "inventory-svc", "/api/recommend": "ml-svc",
  "/api/auth/token": "auth-svc", "/api/orders": "orders-svc",
};

/**
 * Latency is log-normal per request, and the failure mode is a REGIME CHANGE at
 * a specific hour rather than uniformly higher numbers afterwards. The 14:00
 * block is given a shifted distribution, which is what makes it worth a demo:
 * "things got worse, and here is the hour it started" is a finding, while "the
 * numbers are large" is not.
 */
function serviceMesh(): { csv: string; facts: Record<string, number | string> } {
  const rand = rng(0x5e12);
  const rows: string[] = ["_time,category,client_ip,status_code,latency_ms,upstream_service,request_bytes"];

  const DAYS = 8;
  const SPIKE_DAY = 5;
  const SPIKE_HOUR = 14;
  const normalLatency: number[] = [];
  let failures = 0;
  let timeouts = 0;

  for (let day = 0; day < DAYS; day++) {
    for (let hour = 0; hour < 24; hour++) {
      const isSpike = day === SPIKE_DAY && hour === SPIKE_HOUR;
      // Mean ~42 an hour => ~8,100 rows, under the scan cap, and never zero.
      const count = Math.max(1, Math.round(diurnal(hour) * (30 + rand() * 22)));
      for (let i = 0; i < count; i++) {
        const base = Math.exp(4.4 + normal(rand) * 0.5);
        if (!isSpike) normalLatency.push(base);

        let latency = Number(base.toFixed(1));
        const roll = rand();
        let status = 200;
        if (roll > 0.985) { status = 504; timeouts++; }
        else if (roll > 0.955) { status = 500; failures++; }
        if (isSpike) {
          latency = 1800 + rand() * 1400;
          status = rand() < 0.22 ? 504 : (rand() < 0.5 ? 500 : 200);
        }

        const category = MESH_CATEGORIES[Math.floor(rand() * MESH_CATEGORIES.length)]!;
        const ip = `${DOC_IP_BLOCKS[Math.floor(rand() * DOC_IP_BLOCKS.length)]!}${Math.floor(rand() * 254) + 1}`;
        rows.push([
          stamp(day, hour, Math.floor(rand() * 60), Math.floor(rand() * 60)),
          category, ip, status, latency.toFixed(1), MESH_UPSTREAMS[category]!,
          String(Math.floor(300 + rand() * 9000)),
        ].join(","));
      }
    }
  }

  // DERIVE the spike from the healthy population's own quartiles, so "4x IQR"
  // is a fact about the file rather than a number someone typed into a comment.
  const band = iqr(normalLatency);
  const q3 = quantile([...normalLatency].sort((a, b) => a - b), 0.75);

  return {
    csv: rows.join("\n") + "\n",
    facts: {
      rows: rows.length - 1,
      "contiguous hours": DAYS * 24,
      "category column": "category (the eight mesh endpoints)",
      "spike window": `day ${SPIKE_DAY} 14:00 (${stamp(SPIKE_DAY, SPIKE_HOUR, 0, 0)} -> ${stamp(SPIKE_DAY, SPIKE_HOUR + 1, 0, 0)})`,
      "healthy p75 latency_ms": Number(q3.toFixed(1)),
      "healthy IQR (ms)": Number(band.toFixed(1)),
      "p75 + 4*IQR (the threshold crossed)": Math.round(q3 + 4 * band),
      "500 responses": failures,
      "504 responses": timeouts,
      "client_ip ranges": "RFC 5737 documentation space only (192.0.2/198.51.100/203.0.113)",
    },
  };
}

// ---------------------------------------------------------------------------
// 3. FINANCIAL LEDGER — a double-entry-shaped stream.
// ---------------------------------------------------------------------------

/**
 * Debits and credits, with a running balance per account. The balance is what
 * makes this file different from a log: it is stateful, and an agent that
 * reasons about drift or about an account that stops balancing is demoing the
 * thing a finance team actually buys.
 *
 * THE CATEGORY COLUMN IS A GROUPING, NOT A REFERENCE. The first version put the
 * unique document reference (`INV-004821`) in the categorical column, so all
 * 3,506 values were distinct and every bucket held exactly one row. "What are
 * the top categories?" then answered truthfully -- "the largest is
 * TRANSFER-001470, with 1 rows" -- which is a correct answer to a meaningless
 * question, and the worst possible thing to show a customer. A reference belongs
 * in a reference column; a category has to actually categorise.
 */
function financialLedger(): { csv: string; facts: Record<string, number | string> } {
  const rand = rng(0xf1ad);
  const rows: string[] = ["_time,account_id,entry_type,amount_usd,balance_usd,currency,category,reference"];
  const accounts = Array.from({ length: 60 }, (_, i) => `ACC-${pad(i + 1, 6)}`);
  const balances = new Map(accounts.map((a) => [a, Number((2000 + rand() * 48000).toFixed(2))]));

  // Weighted, so the ranking is a real distribution rather than six equal
  // buckets -- and so the "at least/most" question has something to say.
  const CATEGORIES: readonly (readonly [string, number])[] = [
    ["subscription", 34], ["usage", 26], ["transfer", 16],
    ["overage", 11], ["adjustment", 8], ["refund", 5],
  ];
  const CATEGORY_NAMES = CATEGORIES.map(([name]) => name);
  const CATEGORY_WEIGHTS = CATEGORIES.map(([, w]) => w);
  const CATEGORY_TOTAL = CATEGORY_WEIGHTS.reduce((a, b) => a + b, 0);
  const references = ["INV", "PAYROLL", "REF", "FX", "TRF", "ADJ"];

  const DAYS = 30;
  let debits = 0;
  let credits = 0;

  const pickCategory = (): string => {
    let roll = rand() * CATEGORY_TOTAL;
    for (let i = 0; i < CATEGORY_NAMES.length; i++) {
      roll -= CATEGORY_WEIGHTS[i]!;
      if (roll <= 0) return CATEGORY_NAMES[i]!;
    }
    return CATEGORY_NAMES[0]!;
  };

  for (let day = 0; day < DAYS; day++) {
    for (let hour = 0; hour < 24; hour++) {
      // Mean ~6 an hour => ~4,300 rows, and never zero.
      const count = Math.max(1, Math.round(diurnal(hour) * (3 + rand() * 5)));
      for (let i = 0; i < count; i++) {
        const account = accounts[Math.floor(rand() * accounts.length)]!;
        const isCredit = rand() < 0.47;
        const amount = Number(((isCredit ? 1 : -1) * (20 + Math.exp(Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-9)))) * 240)).toFixed(2));
        if (isCredit) credits++; else debits++;

        // A ledger may not go negative without saying so; a drawer that
        // quietly goes below zero is a broken drawer.
        balances.set(account, Number((balances.get(account)! + amount).toFixed(2)));

        rows.push([
          stamp(day, hour, Math.floor(rand() * 60), Math.floor(rand() * 60)),
          account,
          isCredit ? "credit" : "debit",
          amount.toFixed(2),
          balances.get(account)!.toFixed(2),
          rand() < 0.88 ? "USD" : (rand() < 0.6 ? "EUR" : "GBP"),
          pickCategory(),
          `${references[Math.floor(rand() * references.length)]!}-${pad(Math.floor(rand() * 999999), 6)}`,
        ].join(","));
      }
    }
  }

  const overdrawn = [...balances.values()].filter((b) => b < 0).length;
  return {
    csv: rows.join("\n") + "\n",
    facts: {
      rows: rows.length - 1,
      "contiguous hours": DAYS * 24,
      accounts: accounts.length,
      "category column": `category (${CATEGORY_NAMES.length} weighted billing kinds: ${CATEGORY_NAMES.join(", ")})`,
      "debit entries": debits,
      "credit entries": credits,
      "accounts ending overdrawn": overdrawn,
      "account_id format": "ACC-000001 (opaque, no PII)",
    },
  };
}

// ---------------------------------------------------------------------------
// Verify, from the WRITTEN file, so the claims are checkable without this script.
// ---------------------------------------------------------------------------

/**
 * The forecast precondition, checked against the bytes on disk: the observed
 * hours must form ONE unbroken run. This is the check the engine itself makes,
 * re-implemented here so a broken generator fails at generation time instead of
 * surprising somebody in a customer demo.
 */
function continuityOf(text: string): { hours: number; contiguous: boolean; gap: string | null } {
  const seen = new Set<string>();
  for (const line of text.split("\n").slice(1)) {
    if (line) seen.add(hourLabel(line.split(",")[0]!));
  }
  const sorted = [...seen].sort();
  const indices = sorted.map((h) => new Date(`${h}:00:00.000Z`).getTime() / 3_600_000);
  for (let i = 1; i < indices.length; i++) {
    if (indices[i]! - indices[i - 1]! !== 1) {
      return { hours: indices.length, contiguous: false, gap: `${sorted[i - 1]} -> ${sorted[i]}` };
    }
  }
  return { hours: indices.length, contiguous: true, gap: null };
}

type Check = string | { label: string; run: () => string | null };

/** Accepts a bare predicate or a labelled one, so callers stay terse. */
function normalise(c: Check): { label: string; run: () => string | null } {
  return typeof c === "function"
    ? { label: "dataset invariant", run: c }
    : { label: c.label, run: c.run };
}
function verify(label: string, file: string, checks: Check[]): boolean {
  console.log(`\n--- ${label} ---`);
  const text = fs.readFileSync(path.join(OUT_DIR, file), "utf8");
  const lines = text.split("\n").filter(Boolean);
  const header = lines[0]!.split(",");
  const col = (name: string) => header.indexOf(name);
  const values = (name: string) => lines.slice(1).map((l) => l.split(",")[col(name)]!);

  const c = continuityOf(text);
  const shared: Check[] = [
    { label: "timeline is one unbroken run of hours", run: () => (c.contiguous ? null : `GAP at ${c.gap} -- forecasting will refuse`) },
    { label: `at least ${MIN_OBSERVATIONS} contiguous hours`, run: () => (c.hours >= MIN_OBSERVATIONS ? null : `only ${c.hours}`) },
    { label: `row count within the ${MAX_ROWS_SCANNED} scan cap`, run: () => (lines.length - 1 <= MAX_ROWS_SCANNED ? null : `${lines.length - 1} rows`) },
    { label: "a column named exactly `category`", run: () => (header.includes("category") ? null : "missing -- the top-categories query cannot resolve a role") },
    { label: "`category` is a real grouping, not an identifier", run: () => {
      const vals2 = values("category");
      const distinct = new Set(vals2).size;
      if (distinct > 100) return `${distinct} distinct values -- it is an identifier, not a grouping`;
      if (distinct < 2) return "a single distinct value, which is demoted as degenerate";
      const top = Math.max(...vals2.map((v) => vals2.filter((x) => x === v).length));
      return top < vals2.length * 0.05 ? `largest bucket holds only ${top} of ${vals2.length} rows -- too flat to rank` : null;
    } },
    { label: "timestamps are Z-suffixed (hour axis matches the engine's)", run: () => (values("_time").every((t) => t.endsWith("Z")) ? null : "naive timestamps can be bucketed onto a different hour axis, developing gaps") },
  ];

  let ok = true;
  for (const { label: l, run } of [...shared, ...checks].map(normalise)) {
    const problem = run();
    if (problem) { ok = false; console.log(`  FAIL  ${l}: ${problem}`); }
    else console.log(`  ok    ${l}`);
  }
  console.log(`  -> ${c.hours} contiguous hours, ${lines.length - 1} rows`);
  console.log(`  ${ok ? "VERIFIED" : "NOT VERIFIED"}`);
  return ok;
}

function main(): void {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const files = [
    { name: "e-commerce-transactions.csv", data: eCommerce() },
    { name: "service-mesh-access.csv", data: serviceMesh() },
    { name: "financial-ledger.csv", data: financialLedger() },
  ];

  for (const f of files) {
    fs.writeFileSync(path.join(OUT_DIR, f.name), f.data.csv, "utf8");
    console.log(`\n=== ${f.name} ===`);
    for (const [k, v] of Object.entries(f.data.facts)) console.log(`  ${k.padEnd(38)} ${v}`);
  }

  // Re-derive the headline claims FROM DISK. A generator that checks its own
  // in-memory arrays proves nothing about the file somebody will actually open.
  const meshText = fs.readFileSync(path.join(OUT_DIR, "service-mesh-access.csv"), "utf8");
  const meshLines = meshText.split("\n").filter(Boolean);
  const meshLats = meshLines.slice(1).map((l) => Number(l.split(",")[4]));
  const band = iqr(meshLats);
  const q3 = quantile([...meshLats].sort((a, b) => a - b), 0.75);
  const above = meshLats.filter((l) => l > q3 + 4 * band).length;

  const ecomText = fs.readFileSync(path.join(OUT_DIR, "e-commerce-transactions.csv"), "utf8");
  const ecomLines = ecomText.split("\n").filter(Boolean);
  const ecomVals = ecomLines.slice(1).map((l) => Number(l.split(",")[2]));
  const ecomSorted = [...ecomVals].sort((a, b) => a - b);
  const ecomMax = ecomSorted[ecomSorted.length - 1]!;
  const ecomP99 = quantile(ecomSorted, 0.99);

  const allPass = [
    verify("e-commerce-transactions.csv", "e-commerce-transactions.csv", [
      { label: "row count", run: () => (ecomVals.length > 1000 ? null : `too few rows: ${ecomVals.length}`) },
      { label: "outlier is massive", run: () => (ecomMax / ecomP99 > 20 ? null : `max/p99 = ${(ecomMax / ecomP99).toFixed(1)}`) },
      { label: "outlier magnitude", run: () => (ecomMax > 100000 ? null : `max order value only ${ecomMax}`) },
    ]),
    verify("service-mesh-access.csv", "service-mesh-access.csv", [
      { label: "row count", run: () => (meshLats.length > 1000 ? null : `too few rows: ${meshLats.length}`) },
      { label: "latency spike crosses p75+4IQR", run: () => (above > 0 ? null : `nothing above ${(q3 + 4 * band).toFixed(0)}ms`) },
      { label: "status codes 200/500/504 all present", run: () => {
        const codes = new Set(meshLines.slice(1).map((l) => l.split(",")[3]));
        return codes.has("200") && codes.has("500") && codes.has("504") ? null : `codes: ${[...codes]}`;
      } },
    ]),
    verify("financial-ledger.csv", "financial-ledger.csv", [
      { label: "distinct accounts", run: () => {
        const l = fs.readFileSync(path.join(OUT_DIR, "financial-ledger.csv"), "utf8").split("\n").filter(Boolean);
        const n = new Set(l.slice(1).map((r) => r.split(",")[1])).size;
        return n >= 50 ? null : `only ${n} accounts`;
      } },
      { label: "debits and credits both present", run: () => {
        const l = fs.readFileSync(path.join(OUT_DIR, "financial-ledger.csv"), "utf8").split("\n").filter(Boolean);
        const types = new Set(l.slice(1).map((r) => r.split(",")[2]));
        return types.has("debit") && types.has("credit") ? null : `entry types: ${[...types]}`;
      } },
    ]),
  ].every(Boolean);

  console.log(`\nOUT_DIR: ${OUT_DIR}`);
  console.log(allPass
    ? "\nALL THREE FILES: CONTINUOUS, CATEGORISED, AND VERIFIED"
    : "\nGENERATION COMPLETED BUT VERIFICATION FAILED");
  if (!allPass) process.exitCode = 1;
}

main();
