import test from "node:test";
import assert from "node:assert/strict";

import { StreamBroker, type BrokerRecord } from "./stream-broker.ts";
import { evaluateLive, liveFindings } from "./live-anomaly.ts";
import { anomalyAgent } from "./subagents/anomaly-agent.ts";

/**
 * THE ANOMALY AGENT, ASKED OF A STREAM THAT HAS NOT FINISHED.
 *
 * THE FAILURE THIS EXISTS TO PREVENT. The router cannot tell a live topic from a
 * closed file. Handed an open stream, an agent that reaches for rows finds none
 * and answers "nothing is wrong" -- which is indistinguishable, on screen, from a
 * stream that is genuinely clean. That is the most dangerous sentence this product
 * can emit, and it is why `answerLive` is on the subagent contract at all.
 *
 * WHAT IS DELIBERELY NOT CLAIMED. No outlier COUNT. The file pipeline counts
 * exactly because it re-reads after the fences are known; a live stream cannot
 * promise that, so a count would be a number about a file that does not exist,
 * and it would change under the reader's feet. What is claimed instead is a
 * statement about the observed extreme, which stays true as more data arrives.
 */

async function* feed(total: number, injectAt: number, injected: number): AsyncGenerator<BrokerRecord> {
  for (let i = 0; i < total; i += 1) {
    yield {
      fields: {
        ts: `2026-09-30T${String(i % 24).padStart(2, "0")}:00:00Z`,
        service: i % 2 === 0 ? "checkout" : "search",
        latency_ms: String(i === injectAt ? injected : 100 + (i % 300)),
      },
    };
  }
}

async function settle(broker: StreamBroker, target: number): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (broker.snapshot().records < target && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("THE AGENT ANSWERS MID-STREAM, while the stream is still open", async (t) => {
  // A paced feed, so the stream is genuinely still running when it is asked.
  // Without the delay the generator finishes inside one macrotask and "mid-stream"
  // would be a fiction the test could not tell from "after the end".
  const broker = new StreamBroker({ keyColumn: "service", timeColumn: "ts" });
  broker.attach("events", (async function* () {
    for (let i = 0; i < 400; i += 1) {
      yield { fields: { service: "checkout", latency_ms: String(100 + (i % 300)) } };
      if (i % 40 === 0) await new Promise((resolve) => setTimeout(resolve, 2));
    }
  })());
  broker.start();
  await settle(broker, 200);

  const snapshot = broker.snapshot();
  assert.equal(snapshot.open, true, "the stream is STILL OPEN -- that is the whole premise");
  const reply = anomalyAgent.answerLive!(snapshot);
  t.diagnostic(reply.text);
  assert.equal(reply.kind, "answer");
  assert.match(reply.text, /still open/i, "and the answer says so rather than implying a finished file");
});

test("AN ANOMALY INJECTED MID-STREAM IS CAUGHT, and described honestly", async (t) => {
  const broker = new StreamBroker({ keyColumn: "service", timeColumn: "ts" });
  broker.attach("events", feed(2_000, 1_900, 9_000_000));
  broker.start();

  // A SEPARATE CLEAN FEED, and deliberately so. The first version waited on the
  // SAME stream for 500 of 2,000 records and asserted nothing was past its fence
  // -- but the broker drains a generator faster than a test can sample it, so the
  // snapshot was routinely taken after the injected value had already arrived.
  // The assertion was passing or failing according to a race, which is worse than
  // not having it: it looked like a false-alarm check and was a coin toss.
  const cleanBroker = new StreamBroker({ keyColumn: "service", timeColumn: "ts" });
  cleanBroker.attach("events", feed(500, -1, 0));
  cleanBroker.start();
  await settle(cleanBroker, 500);
  const clean = evaluateLive(cleanBroker.snapshot());
  assert.equal(clean.breachedColumns, 0, "clean traffic raises no alarm");
  assert.match(liveFindings(clean), /Nothing is past its fence/);

  await settle(broker, 2_000);
  const verdict = evaluateLive(broker.snapshot());
  const latency = verdict.columns.find((column) => column.column === "latency_ms");
  assert.ok(latency !== undefined, "the numeric column is judged live");
  assert.equal(latency!.max, 9_000_000, "the injected value is observed");
  assert.equal(latency!.breached, true, "and it is beyond the outer fence");
  assert.ok((latency!.extremeMultiple ?? 0) > 0, "with a magnitude, so the flag carries its size");

  const text = liveFindings(verdict);
  t.diagnostic(text);
  assert.match(text, /latency_ms/);
  assert.match(text, /outer fence/);
  assert.match(text, /so far|have not finished|still open/,
    "and it declines to give a count, because a running stream has none to give");
});

test("NO COUNT IS EVER CLAIMED for a live verdict", async () => {
  const broker = new StreamBroker({ keyColumn: "service" });
  broker.attach("events", feed(400, 380, 9_000_000));
  broker.start();
  await settle(broker, 400);
  const text = liveFindings(evaluateLive(broker.snapshot()));
  assert.doesNotMatch(text, /\b\d+ outlier/,
    "a count on an open stream is a number about a file that does not exist");
});

test("an EMPTY stream says nothing has arrived, rather than claiming it is clean", async () => {
  const broker = new StreamBroker({ keyColumn: "service" });
  broker.attach("idle", (async function* () { /* nothing, yet */ })());
  broker.start();
  const text = liveFindings(evaluateLive(broker.snapshot()));
  assert.match(text, /Nothing has arrived/,
    "'nothing has arrived' and 'nothing is wrong' are different sentences, and only one is true here");
});

test("the fence arithmetic is the SAME one the file path uses", async () => {
  const broker = new StreamBroker({ keyColumn: "service" });
  broker.attach("events", feed(600, 590, 9_000_000));
  broker.start();
  await settle(broker, 600);
  const column = evaluateLive(broker.snapshot()).columns.find((c) => c.column === "latency_ms")!;
  const iqr = column.q3! - column.q1!;
  // 1.5x and 3x, the product's own constants. A live panel built on different
  // factors would disagree with the report over the same events.
  assert.ok(Math.abs(column.fenceUpper! - (column.q3! + 1.5 * iqr)) < 1e-9);
  assert.ok(Math.abs(column.extremeUpper! - (column.q3! + 3 * iqr)) < 1e-9);
});