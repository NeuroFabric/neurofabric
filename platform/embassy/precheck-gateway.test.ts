import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { serve, type EmbassyConfig } from "./server.ts";
import { createApprovalGate } from "./elicitation.ts";
import { TOOLS } from "./tools.ts";
import { RPC } from "./jsonrpc.ts";

/**
 * THE GATEWAY ASSEMBLED: precheck, pending state, and the vault as a
 * DEPENDENCY OF THE APPROVED READ.
 *
 * === WHAT IS ACTUALLY BEING PINNED ===
 *
 * Three claims, and the third is the one that is easy to claim and hard to mean.
 *
 * 1. NOTHING BLOCKS. A credential call emits an elicitation request and returns
 *    no result yet. The call is answered by a LATER line, not by a suspended
 *    call, so there is no thread to block and nothing to unblock.
 *
 * 2. FAILURE IS HARD. Declined, cancelled, unsupported, expired -- in every case
 *    the reader is never consulted. A gate that returns a refusal but still
 *    constructs the reader is a gate with a very convincing no.
 *
 * 3. THE READER IS NOT A GATEWAY DEPENDENCY. It arrives as a FACTORY, consulted
 *    inside the approved branch and nowhere else. So "the store is only reachable
 *    through an approval" is a claim about construction, not about intention, and
 *    it can be checked by counting how many times the factory is called.
 */

const CONFIG: EmbassyConfig = {
  credential: "tok_value",
  endpoint: { origin: "http://core.test", timeoutMs: 1000 },
};

/** A live session over a pipe, with the input end under the test's hand. */
function session(extras: {
  elicitation?: boolean;
  reader?: () => { calls: string[]; read: (subject: { tenant: string; credentialName: string }) => Promise<{ ok: true; value: string }> };
  audit?: (event: { outcome: string }) => void;
  timeoutMs?: number;
}) {
  const input = new PassThrough();
  const sink = new PassThrough();
  const chunks: string[] = [];
  sink.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));

  const audit: { outcome: string }[] = [];
  const gate = createApprovalGate({
    timeoutMs: extras.timeoutMs ?? 30_000,
    audit: (event) => {
      audit.push({ outcome: event.outcome });
      extras.audit?.(event);
    },
  });

  const calls: string[] = [];
  let factoryCalls = 0;
  const readerFactory = () => {
    factoryCalls += 1;
    // An override is honoured, but the counter and the default value are not: the
    // counting is the point of the whole harness, so a substitute reader replaces
    // only the VALUE, never the fact of construction.
    return extras.reader === undefined
      ? {
          calls,
          read: async (subject: { tenant: string; credentialName: string }) => {
            calls.push(subject.credentialName);
            return { ok: true as const, value: "value-for-" + subject.credentialName };
          },
        }
      : extras.reader();
  };

  const done = serve(
    input,
    sink,
    CONFIG,
    undefined,
    extras.reader === undefined ? { gate } : { gate, credentialReader: readerFactory },
  );

  const frames = () =>
    chunks
      .join("")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  /** Let the readline loop turn over. A real tick, so ordering is real. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 15));

  /**
   * Send a line, then FLUSH.
   *
   * The loop holds one line back on purpose -- a line is only known-complete when
   * something follows it, because only that proves a terminator arrived. So a
   * reply to line N is written when line N+1 arrives, and a test that writes one
   * line and waits sees nothing. The blank line is the follow-on that releases it,
   * and blank lines are ignored rather than answered as parse errors.
   *
   * That behaviour is correct and was already pinned by the framing tests. It is
   * re-stated here because a precheck test that forgets it fails in a way that
   * looks like the precheck is broken: nothing is ever emitted, ever.
   */
  const send = async (line: string) => {
    input.write(`${line}\n`);
    await settle();
    input.write("\n");
    await settle();
  };

  return {
    send,
    settle,
    frames,
    audit,
    calls,
    factoryCalls: () => factoryCalls,
    close: async () => {
      gate.dispose();
      input.end();
      await settle();
      await done;
    },
  };
}

const INIT_WITH_ELICITATION =
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"capabilities":{"elicitation":{}}}}';
const INIT_WITHOUT_ELICITATION = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"capabilities":{}}}';
const CALL =
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"read_credential","arguments":{"credentialName":"payments/api-key"}}}';

test("THE CREDENTIAL TOOL IS DISCOVERABLE, because a client cannot bind to what it cannot see", () => {
  assert.ok(
    TOOLS.some((tool) => tool.name === "read_credential"),
    "the published list is the capability surface, and this tool is part of it",
  );
});

test("A CREDENTIAL CALL EMITS A REQUEST AND RETURNS NO RESULT YET", async () => {
  const s = session({});
  try {
    await s.send(INIT_WITH_ELICITATION);
    await s.send(CALL);

    const emitted = s.frames();
    const elicitation = emitted.find((f) => f["method"] === "elicitation/create");

    assert.ok(elicitation !== undefined, "the operator is asked");
    assert.equal(elicitation["params"] !== undefined, true, "with params, which is where the request lives");
    assert.equal(
      emitted.some((f) => f["id"] === 2),
      false,
      "and the tool call has no answer yet, because nothing waits inside the handler",
    );
  } finally {
    await s.close();
  }
});

test("AN APPROVAL COMPLETES THE CALL, AND THE READER IS CONSULTED ONLY THEN", async () => {
  const order: string[] = [];
  const s = session({
    reader: () => ({
      calls: [],
      read: async (subject: { credentialName: string }) => {
        order.push(`read:${subject.credentialName}`);
        // The port now answers with a REFERENCE by default. A stub returning a raw
        // value here would have kept passing after redaction shipped, which is the
        // exact way a redaction gets undone by a test fixture rather than a decision.
        return { ok: true as const, reference: "<redacted_credential_ref:abc123>", exposed: false };
      },
    }),
    audit: () => order.push("audit"),
  });
  try {
    await s.send(INIT_WITH_ELICITATION);
    await s.send(CALL);

    assert.equal(s.factoryCalls(), 0, "the reader is a factory and nothing has asked for it");

    const elicitation = s.frames().find((f) => f["method"] === "elicitation/create");
    await s.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: elicitation?.["id"],
        result: { action: "accept", content: { approve: true, approvedBy: "operator", reason: "incident 4471" } },
      }),
    );

    const answered = s.frames().find((f) => f["id"] === 2);
    assert.ok(answered !== undefined, "the original call is answered, on its own id");
    assert.equal(answered["error"], undefined, "with a result rather than a refusal");
    assert.match(JSON.stringify(answered["result"]), /redacted_credential_ref/);
    assert.equal(s.factoryCalls(), 1, "and the reader was constructed exactly once");

    assert.deepEqual(order, ["audit", "read:payments/api-key"], "the decision is recorded BEFORE the value is read");
  } finally {
    await s.close();
  }
});

test("A RAW READ IS REFUSED WITHOUT ITS OWN TICK, AND THE READER IS NEVER BUILT", async () => {
  // The end-to-end half of redacted-by-default: approving the READ is not enough
  // to approve RAW EXPOSURE, so an agent that ticks the first box and forgets the
  // second gets nothing -- and cannot even tell that it tried, which is correct.
  const s = session({ reader: () => ({ calls: [], read: async () => ({ ok: true as const, reference: "x", exposed: true }) }) });
  try {
    await s.send(INIT_WITH_ELICITATION);
    await s.send('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"read_credential","arguments":{"credentialName":"payments/api-key","exposure":"raw"}}}');

    const elicitation = s.frames().find((f) => f["method"] === "elicitation/create");
    const message = String((elicitation?.["params"] as Record<string, unknown>)["message"] ?? "");
    const schema = (elicitation?.["params"] as Record<string, unknown>)["requestedSchema"] as Record<string, unknown>;

    assert.match(message, /RAW CREDENTIAL EXPOSURE REQUESTED/, "the operator is warned, in prose, before the box exists");
    assert.match(message, /context window/, "and told the specific mechanism rather than gesturing at risk");
    assert.deepEqual(schema["required"], ["approve", "acknowledgeRawExposure", "approvedBy", "reason"]);

    // Approve the read, decline the exposure.
    await s.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: elicitation?.["id"],
        result: { action: "accept", content: { approve: true, approvedBy: "operator", reason: "why" } },
      }),
    );

    const answered = s.frames().find((f) => f["id"] === 2);
    assert.ok(answered?.["error"] !== undefined, "the whole answer is treated as not given");
    assert.equal(s.factoryCalls(), 0, "and nothing was read");
  } finally {
    await s.close();
  }
});

test("A REFERENCE READ ASKS FOR NO EXPOSURE TICK, because a box that always appears teaches people to tick boxes", async () => {
  const s = session({});
  try {
    await s.send(INIT_WITH_ELICITATION);
    await s.send(CALL);

    const elicitation = s.frames().find((f) => f["method"] === "elicitation/create");
    const message = String((elicitation?.["params"] as Record<string, unknown>)["message"] ?? "");
    const schema = (elicitation?.["params"] as Record<string, unknown>)["requestedSchema"] as Record<string, unknown>;

    assert.equal(message.includes("RAW CREDENTIAL EXPOSURE REQUESTED"), false, "no warning nobody needs");
    assert.deepEqual(schema["required"], ["approve", "approvedBy", "reason"]);
  } finally {
    await s.close();
  }
});

test("AN EXPOSURE THE SCHEMA DOES NOT PUBLISH IS REFUSED, so no third mode can be invented", async () => {
  const s = session({ reader: () => ({ calls: [], read: async () => ({ ok: true as const, reference: "x", exposed: false }) }) });
  try {
    await s.send(INIT_WITH_ELICITATION);
    await s.send('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"read_credential","arguments":{"credentialName":"payments/api-key","exposure":"everything"}}}');

    assert.equal(s.frames().some((f) => f["method"] === "elicitation/create"), false, "nobody is interrupted");
    assert.equal(s.factoryCalls(), 0);
  } finally {
    await s.close();
  }
});

test("A DECLINE NEVER CONSTRUCTS THE READER", async () => {
  const s = session({ reader: () => ({ calls: [], read: async () => ({ ok: true as const, value: "x" }) }) });
  try {
    await s.send(INIT_WITH_ELICITATION);
    await s.send(CALL);
    const elicitation = s.frames().find((f) => f["method"] === "elicitation/create");
    await s.send(JSON.stringify({ jsonrpc: "2.0", id: elicitation?.["id"], result: { action: "decline" } }));

    const answered = s.frames().find((f) => f["id"] === 2);
    assert.ok(answered !== undefined);
    assert.ok(answered["error"] !== undefined, "the caller gets a protocol error, not an empty success");
    assert.equal(s.factoryCalls(), 0, "and the reader was never even built");
    assert.deepEqual(s.audit, [{ outcome: "refused" }], "the refusal is on the trail");
  } finally {
    await s.close();
  }
});

test("A CLIENT THAT CANNOT ELICIT IS REFUSED OUTRIGHT, AND IS NEVER ASKED", async () => {
  // The specification says a server must not send an elicitation in a mode the
  // client did not declare. Asking anyway would park the call until it timed out,
  // which is a refusal that also burns the operator's time.
  const s = session({ reader: () => ({ calls: [], read: async () => ({ ok: true as const, value: "x" }) }) });
  try {
    await s.send(INIT_WITHOUT_ELICITATION);
    await s.send(CALL);

    const emitted = s.frames();
    assert.equal(emitted.some((f) => f["method"] === "elicitation/create"), false, "no request is sent");
    const answered = emitted.find((f) => f["id"] === 2);
    assert.ok(answered?.["error"] !== undefined, "the call is answered with a protocol error");
    assert.equal(s.factoryCalls(), 0);
    assert.deepEqual(s.audit, [], "nothing was decided, so nothing is on the trail");
  } finally {
    await s.close();
  }
});

test("AN EXPIRED WINDOW NEVER CONSTRUCTS THE READER", async () => {
  const s = session({
    reader: () => ({ calls: [], read: async () => ({ ok: true as const, value: "x" }) }),
    timeoutMs: 5,
  });
  try {
    await s.send(INIT_WITH_ELICITATION);
    await s.send(CALL);
    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.equal(s.factoryCalls(), 0, "an expired window is a refusal, not a slow yes");
    assert.deepEqual(s.audit, [{ outcome: "refused" }], "and the timeout is on the trail");
  } finally {
    await s.close();
  }
});

test("THE CREDENTIAL TOOL IS REFUSED BEFORE THE HANDSHAKE, like every other call", async () => {
  const s = session({ reader: () => ({ calls: [], read: async () => ({ ok: true as const, value: "x" }) }) });
  try {
    await s.send(CALL);

    const answered = s.frames().find((f) => f["id"] === 2);
    const error = answered?.["error"] as { code?: number } | undefined;
    assert.equal(error?.code, RPC.TENANT_REFUSED);
    assert.equal(s.factoryCalls(), 0);
  } finally {
    await s.close();
  }
});

test("A CALL NAMING NO CREDENTIAL IS REFUSED WITHOUT ASKING ANYBODY", async () => {
  const s = session({ reader: () => ({ calls: [], read: async () => ({ ok: true as const, value: "x" }) }) });
  try {
    await s.send(INIT_WITH_ELICITATION);
    await s.send('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"read_credential","arguments":{}}}');

    const emitted = s.frames();
    assert.equal(emitted.some((f) => f["method"] === "elicitation/create"), false, "a malformed call does not become an interruption");
    assert.ok(emitted.find((f) => f["id"] === 2)?.["result"] !== undefined, "it is answered as a tool-level refusal");
  } finally {
    await s.close();
  }
});

test("AN ANSWER FOR AN ID NOTHING IS WAITING ON IS IGNORED, AND DISCLOSES NOTHING", async () => {
  const s = session({});
  try {
    await s.send(INIT_WITH_ELICITATION);
    const before = s.frames().length;
    await s.send(JSON.stringify({ jsonrpc: "2.0", id: 4242, result: { action: "accept", content: { approve: true } } }));

    assert.equal(s.frames().length, before, "a response is not a request and gets no reply");
  } finally {
    await s.close();
  }
});