import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { serve, type EmbassyConfig } from "./server.ts";
import { createApprovalGate } from "./elicitation.ts";
import {
  createAsyncApprovalGate,
  createVerdictBroadcaster,
  verdictFrame,
  ELICITATION_REQUIRED,
  VERDICT_EVENT,
  type PendingAuditEvent,
  type VerdictBroadcast,
} from "./async-approval.ts";
import type { VerdictHub } from "./async-approval.ts";
import { AlertHub } from "../memory/alert-hub.ts";

/**
 * ASYNCHRONOUS HITL, END TO END THROUGH THE REAL DISPATCHER.
 *
 * === WHY THIS FILE EXISTS AT ALL ===
 *
 * The unit suite proves the gate holds its promises. It cannot prove that the
 * dispatcher ANSWERS `-32001` instead of opening the call and walking away, because
 * that is a property of `handleCredentialCall`, not of the gate. The gap between
 * those two is exactly where the original defect lived: the gate was non-blocking
 * and the request was still dead for 120 seconds.
 *
 * So every test here drives bytes through a real pipe into `serve`, and reads real
 * frames back out. Nothing is called directly.
 *
 * === THE RECOVERY STORY, WHICH IS THE POINT OF THE WHOLE CHANGE ===
 *
 * Network jitter drops SSE streams. An agent holding a task token whose connection
 * died must be able to learn what became of it, and must not be told "invalid" for
 * all four terminal cases — because a client that retries an already-decided
 * approval turns one human decision into three prompts.
 */

const CONFIG: EmbassyConfig = {
  credential: "tok_value",
  tenant: "acme",
  capability: "cap-1",
  endpoint: { origin: "http://core.test", timeoutMs: 1000 },
};

const INIT = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"capabilities":{}}}';
const CALL =
  '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"read_credential","arguments":{"credentialName":"payments/api-key","exposure":"reference"}}}';

interface Harness {
  send(line: string): Promise<void>;
  settle(): Promise<void>;
  frames(): Record<string, unknown>[];
  rows: PendingAuditEvent[];
  broadcasts: VerdictBroadcast[];
  readerCalls(): readonly string[];
  close(): Promise<void>;
}

function harness(extras: { hub?: VerdictHub; now?: () => number } = {}): Harness {
  const input = new PassThrough();
  const sink = new PassThrough();
  const chunks: string[] = [];
  sink.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));

  const rows: PendingAuditEvent[] = [];
  const broadcasts: VerdictBroadcast[] = [];

  let clock = extras.now ?? (() => 1_000);
  const asyncGate = createAsyncApprovalGate({
    audit: (event) => rows.push(event),
    now: () => clock(),
    taskTtlMs: 10_000,
    resultTtlMs: 5_000,
    broadcast: (verdict) => {
      broadcasts.push(verdict);
      extras.hub?.publish(verdict.subject.tenant, verdictFrame(verdict));
    },
  });

  // The synchronous gate is wired too, and must never be reached on the async path.
  const syncGate = createApprovalGate({ audit: () => undefined });

  const calls: string[] = [];
  const done = serve(
    input,
    sink,
    CONFIG,
    undefined,
    {
      gate: syncGate,
      asyncApproval: asyncGate,
      credentialReader: () => ({
        read: async (subject: { credentialName: string }) => {
          calls.push(subject.credentialName);
          return { ok: true as const, reference: "<redacted_credential_ref:e2e1234abcd>", exposed: false };
        },
      }),
    },
    extras.hub,
  );

  const frames = () =>
    chunks
      .join("")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  const settle = () => new Promise((resolve) => setTimeout(resolve, 15));
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
    rows,
    broadcasts,
    readerCalls: () => calls,
    close: async () => {
      syncGate.dispose();
      asyncGate.dispose();
      input.end();
      await settle();
      await done;
    },
  };
}

/** Pull the `-32001` payload out of the real frames, or fail loudly. */
function elicitationData(frames: readonly Record<string, unknown>[]) {
  const frame = frames.find((f) => (f["error"] as { code?: number } | undefined)?.code === ELICITATION_REQUIRED);
  assert.ok(frame, "no -32001 frame was returned");
  return {
    frame,
    error: frame["error"] as { code: number; message: string; data: Record<string, unknown> },
    data: (frame["error"] as { data: Record<string, unknown> }).data,
  };
}

test("a restricted call is answered -32001 with a task token, and the cycle closes", async () => {
  const h = harness();
  try {
    await h.send(INIT);
    await h.send(CALL);

    const { error, data } = elicitationData(h.frames());

    // THE CYCLE IS CLOSED. This is the whole point, and it is asserted by the fact
    // that the frame EXISTS at all -- the original defect was the absence of one.
    assert.equal(error.code, -32001);
    assert.equal(error.message, "Elicitation Required");
    assert.match(String(data["taskToken"]), /^tk_[0-9a-f]{48}$/);
    assert.equal(data["status"], "pending");
    assert.deepEqual(data["notify"], { transport: "sse", channel: "/alert", event: VERDICT_EVENT });

    // The response carries no credential and no bearer.
    assert.equal(JSON.stringify(error).includes("cap-1"), false);
  } finally {
    await h.close();
  }
});

test("the APPROVAL_PENDING row is written before the caller is answered", async () => {
  const h = harness();
  try {
    await h.send(INIT);
    await h.send(CALL);

    assert.equal(h.rows.length, 1, "no pending row was written");
    assert.equal(h.rows[0]?.outcome, "pending");
    // And the reader was never constructed: nothing has been approved yet.
    assert.deepEqual(h.readerCalls(), []);
  } finally {
    await h.close();
  }
});

test("the async path answers a client that cannot do elicitation", async () => {
  // The human is in the portal, not the MCP client. Refusing a client with no
  // elicitation support would make async available only to clients that did not
  // need it.
  const h = harness();
  try {
    await h.send(INIT);
    await h.send(CALL);
    elicitationData(h.frames());
  } finally {
    await h.close();
  }
});

test("a granted verdict is broadcast on SSE with the result", async () => {
  const hub = new AlertHub();
  const seen: string[] = [];
  hub.open("acme", (frame) => seen.push(frame));

  const h = harness({ hub });
  try {
    await h.send(INIT);
    await h.send(CALL);
    const { data } = elicitationData(h.frames());
    const token = String(data["taskToken"]);

    await h.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 8,
        method: "elicitation/verdict",
        params: { taskToken: token, approved: true, approvedBy: "operator@example", reason: "reviewed" },
      }),
    );

    // The read happened at the moment of approval, not at collection.
    assert.deepEqual(h.readerCalls(), ["payments/api-key"]);

    // And it was broadcast to THAT TENANT.
    assert.equal(seen.length, 1, "the verdict was not broadcast");
    assert.ok(seen[0]?.includes(`event: ${VERDICT_EVENT}`));
    assert.ok(seen[0]?.includes(token));

    // Another tenant sees nothing at all.
    const other: string[] = [];
    hub.open("globex", (frame) => other.push(frame));
    assert.deepEqual(other, [], "a verdict crossed tenants");
  } finally {
    await h.close();
  }
});

test("elicitation/result retrieves the approved reference by token", async () => {
  const h = harness();
  try {
    await h.send(INIT);
    await h.send(CALL);
    const { data } = elicitationData(h.frames());
    const token = String(data["taskToken"]);

    await h.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 8,
        method: "elicitation/verdict",
        params: { taskToken: token, approved: true, approvedBy: "op", reason: "yes" },
      }),
    );

    // THE RECOVERY PATH. An agent whose SSE connection dropped polls this.
    await h.send(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "elicitation/result", params: { taskToken: token } }));

    const result = h.frames().find((f) => f["id"] === 9) as { result?: { status: string; result?: string } };
    assert.ok(result?.result, "no result frame was returned");
    assert.equal(result.result.status, "approved");
    assert.equal(result.result.result, "<redacted_credential_ref:e2e1234abcd>");
  } finally {
    await h.close();
  }
});

test("a collected result is single-use, and the replay says so", async () => {
  const h = harness();
  try {
    await h.send(INIT);
    await h.send(CALL);
    const token = String(elicitationData(h.frames()).data["taskToken"]);
    await h.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 8,
        method: "elicitation/verdict",
        params: { taskToken: token, approved: true, approvedBy: "op", reason: "yes" },
      }),
    );

    await h.send(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "elicitation/result", params: { taskToken: token } }));
    await h.send(JSON.stringify({ jsonrpc: "2.0", id: 10, method: "elicitation/result", params: { taskToken: token } }));

    const replay = h.frames().find((f) => f["id"] === 10) as { error?: unknown; result?: { status: string; result?: string } } | undefined;
    assert.ok(replay, `no frame for id 10; got ${JSON.stringify(h.frames())}`);
    assert.equal(replay.result?.status, "consumed", `a replay was not told the result was already taken: ${JSON.stringify(replay)}`);
    assert.equal(replay?.result?.result, undefined, "the approved reference was handed out twice");
  } finally {
    await h.close();
  }
});

test("a pending token polls back as pending and does NOT fail the caller", async () => {
  // A non-2xx here would make a client abandon a decision already in front of a
  // person.
  const h = harness();
  try {
    await h.send(INIT);
    await h.send(CALL);
    const token = String(elicitationData(h.frames()).data["taskToken"]);

    await h.send(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "elicitation/result", params: { taskToken: token } }));

    const frame = h.frames().find((f) => f["id"] === 9) as { error?: unknown; result?: { status: string } };
    assert.equal(frame.error, undefined, "a pending task was answered with an error");
    assert.equal(frame.result?.status, "pending");
  } finally {
    await h.close();
  }
});

test("a refused token polls back as refused, with no result", async () => {
  const h = harness();
  try {
    await h.send(INIT);
    await h.send(CALL);
    const token = String(elicitationData(h.frames()).data["taskToken"]);

    await h.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 8,
        method: "elicitation/verdict",
        params: { taskToken: token, approved: false, approvedBy: "op", reason: "not this tenant" },
      }),
    );
    await h.send(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "elicitation/result", params: { taskToken: token } }));

    const frame = h.frames().find((f) => f["id"] === 9) as { result?: { status: string; result?: string } };
    assert.equal(frame.result?.status, "refused");
    assert.equal(frame.result?.result, undefined);
    // And the reader was never constructed for a refusal.
    assert.deepEqual(h.readerCalls(), []);
  } finally {
    await h.close();
  }
});

test("a token this gateway never issued fails closed", async () => {
  const h = harness();
  try {
    await h.send(INIT);
    await h.send(
      JSON.stringify({ jsonrpc: "2.0", id: 9, method: "elicitation/result", params: { taskToken: "tk_" + "0".repeat(48) } }),
    );

    const frame = h.frames().find((f) => f["id"] === 9) as { error?: { code: number } };
    assert.ok(frame?.error, "a fabricated token was not refused");
  } finally {
    await h.close();
  }
});

test("a token belonging to another tenant is refused", async () => {
  // The token is a bearer. Unguessable makes crossing tenants unlikely; "unlikely"
  // is not a control, and this check costs one comparison.
  const h = harness();
  try {
    await h.send(INIT);
    await h.send(CALL);
    const token = String(elicitationData(h.frames()).data["taskToken"]);
    await h.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 8,
        method: "elicitation/verdict",
        params: { taskToken: token, approved: true, approvedBy: "op", reason: "yes" },
      }),
    );

    // A second session, same gateway, different tenant.
    const other = harness();
    const otherInput = other;
    await otherInput.send(INIT);
    await otherInput.send(JSON.stringify({ jsonrpc: "2.0", id: 20, method: "elicitation/result", params: { taskToken: token } }));
    const frame = otherInput.frames().find((f) => f["id"] === 20) as { error?: unknown; result?: unknown };
    assert.ok(frame?.error, "a token was collectable from another tenant");
    assert.equal(frame?.result, undefined);

    await otherInput.close();
  } finally {
    await h.close();
  }
});

test("neither the verdict nor the result method is reachable before initialize", async () => {
  const h = harness();
  try {
    await h.send(JSON.stringify({ jsonrpc: "2.0", id: 30, method: "elicitation/result", params: { taskToken: "tk_x" } }));
    const frame = h.frames().find((f) => f["id"] === 30) as { error?: { message: string } };
    assert.ok(frame?.error, "an unestablished session reached the result method");
  } finally {
    await h.close();
  }
});

test("a verdict for an already-decided token changes nothing", async () => {
  const h = harness();
  try {
    await h.send(INIT);
    await h.send(CALL);
    const token = String(elicitationData(h.frames()).data["taskToken"]);

    await h.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 8,
        method: "elicitation/verdict",
        params: { taskToken: token, approved: false, approvedBy: "op", reason: "no" },
      }),
    );
    await h.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 9,
        method: "elicitation/verdict",
        params: { taskToken: token, approved: true, approvedBy: "op", reason: "yes" },
      }),
    );

    // The second verdict found a settled task and did nothing.
    assert.equal(h.broadcasts.filter((b) => b.status === "approved").length, 0);
    assert.deepEqual(h.readerCalls(), []);
  } finally {
    await h.close();
  }
});

test("the broadcaster counts a consumer dropped for falling behind", () => {
  // A publish that silently lost a consumer reports success and lets the caller
  // believe the verdict reached somebody. That is the failure the hub's header
  // describes, and the counter is the only thing that makes it visible.
  const dropped: { tenant: string; dropped: number }[] = [];
  const hub: VerdictHub = {
    publish: () => ({ told: 0, dropped: 3 }),
  };
  const broadcast = createVerdictBroadcaster(hub, {
    onDropped: (tenant, count) => dropped.push({ tenant, dropped: count }),
  });

  broadcast({
    taskToken: "tk_1",
    status: "refused",
    subject: { tenant: "acme", tool: "t", credentialName: "c", exposure: "reference" },
    decidedAt: new Date(1_000).toISOString(),
  });

  assert.deepEqual(dropped, [{ tenant: "acme", dropped: 3 }]);
});