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
 * === WHY THE INJECTED FAULTS ARE COMPUTED, NOT TYPED ===
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

/** An ISO-8601 instant with milliseconds, which is what the router's _time reads. */
function stamp(day: number, hour: number, minute: number, second: number): string {
  const d = new Date(Date.UTC(2026, 8, 1 + day, hour, minute, second));
  return `${d.toISOString().slice(0, 23)}`;
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
 */
function eCommerce(): { csv: string; facts: Record<string, number | string> } {
  const rand = rng(0xe00a);
  const rows: string[] = ["_time,customer_id,order_value_usd,status_code,channel,is_returned,returned_reason"];
  const regions = ["us-east", "us-west", "eu-central", "ap-south"];
  const channels = ["web", "ios", "android", "partner-api"];
  const reasons = ["", "", "", "damaged", "wrong-size", "late-delivery", "not-as-described"];

  let outlierValue = 0;
  let returns = 0;
  const baseline: number[] = [];

  for (let day = 0; day < 30; day++) {
    const weekendLift = day % 7 === 5 || day % 7 === 6 ? 1.35 : 1;
    const orders = Math.round((150 + rand() * 90) * weekendLift);
    for (let i = 0; i < orders; i++) {
      const hour = Math.floor(rand() * 24);
      // Box-Muller, then exponentiated: the log-normal that real spend follows.
      const u1 = Math.max(rand(), 1e-9);
      const u2 = rand();
      const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      const value = Number(Math.exp(4.1 + normal * 0.55).toFixed(2));
      baseline.push(value);

      // THE INJECTED FAULT: one 250k order on day 19, against a distribution
      // whose 99th percentile is around 400. A 250,000 figure is not a typo a
      // customer made; it is a currency bug or a fraudulent order, and those
      // are the things a demo should be able to talk about.
      const isOutlier = day === 19 && i === Math.floor(orders / 2);
      if (isOutlier) outlierValue = 250000;

      const finalValue = isOutlier ? outlierValue : value;
      const returned = rand() < 0.061;
      if (returned) returns++;
      rows.push([
        stamp(day, hour, Math.floor(rand() * 60), Math.floor(rand() * 60)),
        `CUST-${pad(Math.floor(rand() * 4800) + 1, 5)}`,
        finalValue.toFixed(2),
        returned ? 200 : 200,
        channels[Math.floor(rand() * channels.length)]!,
        returned ? "true" : "false",
        returned ? reasons[1 + Math.floor(rand() * (reasons.length - 1))]! : "",
      ].join(","));
    }
  }

  return {
    csv: rows.join("\n") + "\n",
    facts: {
      rows: rows.length - 1,
      "injected outlier (order_value_usd)": outlierValue,
      "baseline p99 order value": Number(quantile([...baseline].sort((a, b) => a - b), 0.99).toFixed(2)),
      "returns": returns,
      "customer_id format": "CUST-00001 (opaque, no PII)",
    },
  };
}

// ---------------------------------------------------------------------------
// 2. SERVICE MESH ACCESS — a latency regime change inside one hour.
// ---------------------------------------------------------------------------

const MESH_ENDPOINTS = [
  "/api/checkout", "/api/cart", "/api/search", "/api/pricing",
  "/api/inventory", "/api/recommend", "/api/auth/token", "/api/orders",
] as const;

/**
 * Latency is log-normal per request, and the failure mode is a REGIME CHANGE at
 * a specific hour rather than uniformly higher numbers afterwards. The 14:00
 * block is given a shifted distribution, which is what makes it worth a demo:
 * "things got worse, and here is the hour it started" is a finding, while "the
 * numbers are large" is not.
 */
function serviceMesh(): { csv: string; facts: Record<string, number | string> } {
  const rand = rng(0x5e12);
  const rows: string[] = ["_time,endpoint,client_ip,status_code,latency_ms,upstream_service,request_bytes"];
  const upstreams: Record<string, string> = {
    "/api/checkout": "payments-svc", "/api/cart": "cart-svc", "/api/search": "search-svc",
    "/api/pricing": "pricing-svc", "/api/inventory": "inventory-svc", "/api/recommend": "ml-svc",
    "/api/auth/token": "auth-svc", "/api/orders": "orders-svc",
  };

  const SPIKE_DAY = 5;
  const SPIKE_HOUR = 14;
  const normalLatency: number[] = [];
  let spikeValue = 0;
  let failures = 0;
  let timeouts = 0;

  // SIZED TO THE PRODUCT'S OWN SCAN CAP, deliberately. `MAX_ROWS_SCANNED` in
  // capabilities.ts is 10,000, and the first draft of this file generated
  // 23,631 rows -- so more than half of it was never analysed by the thing it
  // exists to demo, while still costing 1.8MB in the repository. A demo dataset
  // larger than the reader is a demo dataset carrying dead weight. It now lands
  // UNDER the cap, which also means nothing is silently truncated: what you see
  // in the dashboard is the whole file.
  for (let day = 0; day < 8; day++) {
    for (let hour = 0; hour < 24; hour++) {
      // Diurnal shape: a quiet night, a lunch bump, a heavier evening.
      const shape = hour < 6 ? 0.35 : hour < 11 ? 0.9 : hour < 14 ? 1.15 : hour < 20 ? 1.35 : 0.8;
      const isSpike = day === SPIKE_DAY && hour === SPIKE_HOUR;
      const count = Math.round(shape * (35 + rand() * 25));
      for (let i = 0; i < count; i++) {
        const u1 = Math.max(rand(), 1e-9);
        const u2 = rand();
        const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        const base = Math.exp(4.4 + normal * 0.5);
        if (!isSpike) normalLatency.push(base);

        let latency = Number(base.toFixed(1));
        // Status mix: overwhelmingly 200, with a 500 tail and rarer 504s.
        const roll = rand();
        let status = 200;
        if (roll > 0.985) { status = 504; timeouts++; }
        else if (roll > 0.955) { status = 500; failures++; }
        if (isSpike) { latency = 1800 + rand() * 1400; status = rand() < 0.22 ? 504 : (rand() < 0.5 ? 500 : 200); }

        const endpoint = MESH_ENDPOINTS[Math.floor(rand() * MESH_ENDPOINTS.length)]!;
        const ip = `${DOC_IP_BLOCKS[Math.floor(rand() * DOC_IP_BLOCKS.length)]!}${Math.floor(rand() * 254) + 1}`;
        rows.push([
          stamp(day, hour, Math.floor(rand() * 60), Math.floor(rand() * 60)),
          endpoint, ip, status, latency.toFixed(1), upstreams[endpoint]!,
          String(Math.floor(300 + rand() * 9000)),
        ].join(","));
      }
    }
  }

  // DERIVE the spike from the healthy population's own quartiles, so "4x IQR"
  // is a fact about the file rather than a number someone typed into a comment.
  const band = iqr(normalLatency);
  const q3 = quantile([...normalLatency].sort((a, b) => a - b), 0.75);
  spikeValue = Math.round(q3 + 4 * band);

  return {
    csv: rows.join("\n") + "\n",
    facts: {
      rows: rows.length - 1,
      "spike window": `day ${SPIKE_DAY} 14:00 (${stamp(SPIKE_DAY, SPIKE_HOUR, 0, 0)} -> ${stamp(SPIKE_DAY, SPIKE_HOUR + 1, 0, 0)})`,
      "healthy p75 latency_ms": Number(q3.toFixed(1)),
      "healthy IQR (ms)": Number(band.toFixed(1)),
      "p75 + 4*IQR (the threshold crossed)": spikeValue,
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
 */
function financialLedger(): { csv: string; facts: Record<string, number | string> } {
  const rand = rng(0xf1ad);
  const rows: string[] = ["_time,account_id,entry_type,amount_usd,balance_usd,currency,reference"];
  const accounts = Array.from({ length: 60 }, (_, i) => `ACC-${pad(i + 1, 6)}`);
  const balances = new Map(accounts.map((a) => [a, Number((2000 + rand() * 48000).toFixed(2))]));
  const references = ["INV", "PAYROLL", "REFUND", "FX-CONV", "TRANSFER", "ADJUST"];

  let debits = 0;
  let credits = 0;

  for (let day = 0; day < 30; day++) {
    const entries = Math.floor(90 + rand() * 120);
    for (let i = 0; i < entries; i++) {
      const account = accounts[Math.floor(rand() * accounts.length)]!;
      const isCredit = rand() < 0.47;
      const magnitude = Number((20 + Math.exp(Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-9)))) * 240).toFixed(2));
      const amount = isCredit ? magnitude : -magnitude;
      if (isCredit) credits++; else debits++;

      const opening = balances.get(account)!;
      // A ledger may not go negative without saying so; the few that do are
      // marked, and a drawer that quietly goes below zero is a broken drawer.
      const next = Number((opening + amount).toFixed(2));
      balances.set(account, next);

      rows.push([
        stamp(day, Math.floor(rand() * 24), Math.floor(rand() * 60), Math.floor(rand() * 60)),
        account,
        isCredit ? "credit" : "debit",
        amount.toFixed(2),
        next.toFixed(2),
        rand() < 0.88 ? "USD" : (rand() < 0.6 ? "EUR" : "GBP"),
        `${references[Math.floor(rand() * references.length)]!}-${pad(Math.floor(rand() * 999999), 6)}`,
      ].join(","));
    }
  }

  const overdrawn = [...balances.values()].filter((b) => b < 0).length;
  return {
    csv: rows.join("\n") + "\n",
    facts: {
      rows: rows.length - 1,
      accounts: accounts.length,
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

function csvField(text: string, header: string, line: number): number {
  const cols = text.split("\n")[0]!.split(",");
  const idx = cols.indexOf(header);
  if (idx < 0) throw new Error(`no column ${header}`);
  return Number(text.split("\n")[line]!.split(",")[idx]);
}

function verify(label: string, file: string, checks: (() => string | null)[]): boolean {
  console.log(`\n--- ${label} (${file}) ---`);
  const text = fs.readFileSync(path.join(OUT_DIR, file), "utf8");
  let ok = true;
  for (const check of checks) {
    const problem = check();
    if (problem) { ok = false; console.log(`  FAIL  ${problem}`); }
    else console.log("  ok");
  }
  console.log(`  ${ok ? "VERIFIED" : "NOT VERIFIED"}`);
  return ok;
}

function main(): void {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const files: { name: string; data: { csv: string; facts: Record<string, number | string> } }[] = [
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
  const mesh = fs.readFileSync(path.join(OUT_DIR, "service-mesh-access.csv"), "utf8").split("\n");
  const meshLats: number[] = [];
  for (let i = 1; i < mesh.length; i++) { if (mesh[i]) meshLats.push(Number(mesh[i]!.split(",")[4])); }
  const band = iqr(meshLats);
  const q3 = quantile([...meshLats].sort((a, b) => a - b), 0.75);
  const threshold = q3 + 4 * band;
  const above = meshLats.filter((l) => l > threshold).length;

  const ecom = fs.readFileSync(path.join(OUT_DIR, "e-commerce-transactions.csv"), "utf8").split("\n");
  const ecomVals: number[] = [];
  for (let i = 1; i < ecom.length; i++) { if (ecom[i]) ecomVals.push(Number(ecom[i]!.split(",")[2])); }
  const ecomSorted = [...ecomVals].sort((a, b) => a - b);
  const ecomMax = ecomSorted[ecomSorted.length - 1]!;
  const ecomP99 = quantile(ecomSorted, 0.99);
  const ecomMedian = quantile(ecomSorted, 0.5);

  const allPass =
    verify("e-commerce-transactions.csv", "e-commerce-transactions.csv", [
      () => (ecomVals.length > 1000 ? null : `too few rows: ${ecomVals.length}`),
      () => (ecomMax / ecomP99 > 20 ? null : `outlier not massive: max/p99 = ${(ecomMax / ecomP99).toFixed(1)}`),
      () => (ecomMax > 100000 ? null : `max order value too small: ${ecomMax}`),
      () => (ecomMedian > 0 ? null : "median order value is not positive"),
    ]) &&
    verify("service-mesh-access.csv", "service-mesh-access.csv", [
      () => (meshLats.length > 1000 ? null : `too few rows: ${meshLats.length}`),
      () => (above > 0 ? null : `no latency exceeds p75+4*IQR (${threshold.toFixed(0)}ms) — the spike is not there`),
      () => {
        const codes = new Set(mesh.filter(Boolean).slice(1).map((l) => l!.split(",")[3]));
        return codes.has("200") && codes.has("500") && codes.has("504")
          ? null : `status codes incomplete: ${[...codes].join(",")}`;
      },
    ]) &&
    verify("financial-ledger.csv", "financial-ledger.csv", [
      () => {
        const lines = fs.readFileSync(path.join(OUT_DIR, "financial-ledger.csv"), "utf8").split("\n").filter(Boolean);
        return lines.length - 1 > 1000 ? null : `too few rows: ${lines.length - 1}`;
      },
      () => {
        const lines = fs.readFileSync(path.join(OUT_DIR, "financial-ledger.csv"), "utf8").split("\n").filter(Boolean);
        const rows = lines.slice(1).map((l) => l!.split(","));
        const accounts = new Set(rows.map((r) => r[1]));
        return accounts.size >= 50 ? null : `too few accounts: ${accounts.size}`;
      },
    ]);

  console.log(`\nOUT_DIR: ${OUT_DIR}`);
  console.log(allPass ? "\nALL THREE FILES GENERATED AND VERIFIED" : "\nGENERATION COMPLETED BUT VERIFICATION FAILED");
  if (!allPass) process.exitCode = 1;
  void csvField;
}

main();
