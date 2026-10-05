import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_FRAME_BYTES,
  RPC,
  failure,
  parseFrame,
  serialise,
  success,
} from "./jsonrpc.ts";
import { TOOLS, callTool, isTool } from "./tools.ts";
import { CORE_PATHS, type CoreFetch } from "./core.ts";
import { readConfig } from "./server.ts";

/**
 * THE FRAME PARSER AND THE TOOL DISPATCH.
 *
 * === WHY NO PIPE APPEARS ANYWHERE IN THIS FILE ===
 *
 * The framing defects ADR-006 section 3.2 names are byte-level, and a test that
 * cannot put a specific byte sequence in front of the parser cannot test any of
 * them. `parseFrame` takes a string and `callTool` takes values, so every case
 * below -- truncated JSON, a wrong version member, a boolean id, an oversized
 * frame, an unknown tool, a smuggled tenant -- is a table entry rather than
 * something to provoke through a real process.
 *
 * The stdio loop's own behaviour is exercised in `stdio.test.ts`, which uses real
 * streams precisely because that is the one place where the framing is not a
 * function of its argument.
 */

const line = (value: unknown): string => JSON.stringify(value);

function request(method: string, id: unknown = 1, params?: unknown): string {
  return line(params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params });
}

/** Parse and report the rejection code, failing the test if it did not reject. */
function rejectCode(raw: string): number {
  const frame = parseFrame(raw);
  assert.equal(frame.kind, "rejected", `expected a rejection, got ${frame.kind}`);
  return frame.kind === "rejected" ? frame.code : -1;
}

test("a well-formed request is a request, with its id and method", () => {
  const frame = parseFrame(request("tools/list", 7));
  assert.equal(frame.kind, "request");
  assert.equal(frame.kind === "request" ? frame.id : null, 7);
  assert.equal(frame.kind === "request" ? frame.method : null, "tools/list");
});

test("MALFORMED JSON IS REJECTED, and never throws", () => {
  // The obligation-4 case. A parse error is a value; the parser has no path by
  // which bad input can end the process.
  for (const raw of ["", "{", "not json", '{"jsonrpc":', '{"a":1,}', "[1,2", "{'jsonrpc':'2.0'}"]) {
    assert.equal(rejectCode(raw), RPC.PARSE_ERROR, `expected a parse error for ${JSON.stringify(raw)}`);
  }
});

test("JSON that parses but is not a Request object is INVALID REQUEST, not PARSE ERROR", () => {
  // The distinction is real: -32700 means "your bytes are broken", -32600 means
  // "your bytes are fine and your message is wrong". Collapsing them tells a client
  // to re-serialise something that was already serialised correctly.
  for (const raw of ["[]", "null", "true", '"a string"', "42"]) {
    assert.equal(rejectCode(raw), RPC.INVALID_REQUEST);
  }
});

test("the version member is required AND must be exactly 2.0", () => {
  // An absent member is the same defect as a wrong one. Accepting an absent
  // `jsonrpc` is how a 1.0 client silently receives 2.0-shaped answers.
  assert.equal(rejectCode(line({ id: 1, method: "tools/list" })), RPC.INVALID_REQUEST);
  assert.equal(rejectCode(line({ jsonrpc: "1.0", id: 1, method: "tools/list" })), RPC.INVALID_REQUEST);
  assert.equal(rejectCode(line({ jsonrpc: 2.0, id: 1, method: "tools/list" })), RPC.INVALID_REQUEST);
});

test("an id that is not a string, number or null is refused, and NOT read as a notification", () => {
  // A boolean id is the classic way to make a dispatcher key a Map on `true`.
  // These must be rejections, not notifications -- a notification gets no reply,
  // so treating a malformed id as one would silently swallow the request.
  for (const bad of [true, false, { a: 1 }, [1], { nested: { deep: true } }]) {
    const frame = parseFrame(line({ jsonrpc: "2.0", id: bad, method: "tools/list" }));
    assert.equal(frame.kind, "rejected", `id ${JSON.stringify(bad)} should be refused`);
  }
});

test("a NON-FINITE id cannot survive JSON, and the parser does not invent one", () => {
  // JSON has no NaN and no Infinity: `JSON.stringify` emits `null` for both before
  // the frame is ever a string. So this test cannot deliver an infinite id to the
  // parser, and the honest assertion is the one below -- what arrives is a null id,
  // which is a LEGAL id, and the parser must report it as exactly that rather than
  // manufacturing a number or rejecting a frame the spec permits.
  //
  // The first draft of this test asserted the frame was NOT a request, which would
  // have been asserting a defect: it would have required the parser to reject a
  // null id, and `id: null` is valid JSON-RPC 2.0.
  const encoded = JSON.stringify({ jsonrpc: "2.0", id: Number.POSITIVE_INFINITY, method: "tools/list" });
  assert.equal(encoded.includes("Infinity"), false);

  const frame = parseFrame(encoded);
  assert.equal(frame.kind, "request");
  assert.equal(frame.kind === "request" ? frame.id : "not-null", null);
});

test("an ABSENT id is a notification and an explicit null id is a request", () => {
  // The two are different things. Collapsing them means either replying to a
  // notification or silently dropping a request that asked for a null-id reply.
  const notification = parseFrame(line({ jsonrpc: "2.0", method: "notifications/initialized" }));
  assert.equal(notification.kind, "notification");

  const nullId = parseFrame(line({ jsonrpc: "2.0", id: null, method: "tools/list" }));
  assert.equal(nullId.kind, "request");
  assert.equal(nullId.kind === "request" ? nullId.id : "not-a-request", null);
});

test("params must be structured; a scalar is INVALID PARAMS", () => {
  for (const bad of [5, "text", true]) {
    const frame = parseFrame(line({ jsonrpc: "2.0", id: 1, method: "tools/call", params: bad }));
    assert.equal(frame.kind, "rejected");
    assert.equal(frame.kind === "rejected" ? frame.code : 0, RPC.INVALID_PARAMS);
  }
});

test("a frame over the size limit is refused without being parsed", () => {
  // Oversized first, then parsed: an unbounded body that parses successfully is
  // still an allocation nobody bounded.
  const huge = `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"x":"${"a".repeat(MAX_FRAME_BYTES)}"}}`;
  assert.equal(rejectCode(huge), RPC.INVALID_REQUEST);
});

test("a frame at the limit is still accepted, so the bound is not off by one", () => {
  // The cap is a byte count on the LINE. A guard that refuses everything near the
  // boundary is a guard nobody trusts, so the accepting side of it is pinned too.
  //
  // Built by padding to an exact length rather than by estimating an overhead, so
  // the assertion is about the bound and not about the arithmetic.
  const skeleton = { jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "" } };
  const base = JSON.stringify(skeleton).length;
  const padded = { ...skeleton, params: { pad: "a".repeat(MAX_FRAME_BYTES - base) } };
  const exact = JSON.stringify(padded);
  assert.equal(Buffer.byteLength(exact, "utf8"), MAX_FRAME_BYTES);
  assert.equal(parseFrame(exact).kind, "request");

  // One byte over is refused, which is what makes the previous assertion meaningful.
  const over = JSON.stringify({ ...skeleton, params: { pad: "a".repeat(MAX_FRAME_BYTES - base + 1) } });
  assert.equal(rejectCode(over), RPC.INVALID_REQUEST);
});

test("a notification is NEVER answered, whatever it names", () => {
  // Including one we do not implement. The specification is unambiguous: no id,
  // no response. A server that replies invents a conversation the client never
  // started.
  for (const method of ["notifications/initialized", "notifications/cancelled", "no/such/thing"]) {
    const frame = parseFrame(line({ jsonrpc: "2.0", method }));
    assert.equal(frame.kind, "notification");
  }
});

test("every serialised envelope is exactly one line", () => {
  // Obligation 1. A raw newline inside a frame splits it in two and the reader
  // resynchronises onto garbage -- a failure that surfaces on the HOST's side as a
  // parse error pointing at our code.
  const hostile = { note: "line one\nline two\r\nline three", id: "x" };
  const out = serialise(success("x", hostile));
  assert.equal(out.endsWith("\n"), true);
  assert.equal(out.slice(0, -1).includes("\n"), false);
  // And the payload survives intact rather than being flattened.
  assert.equal((JSON.parse(out) as { result: { note: string } }).result.note, hostile.note);
});

test("an error envelope omits `data` entirely when there is none", () => {
  // Absent and null are different to a JSON-RPC peer, and emitting "data": null on
  // every ordinary refusal collapses them.
  assert.equal("data" in failure(1, RPC.PARSE_ERROR, "no").error, false);
  assert.equal("data" in failure(1, RPC.SCHEMA_REFUSED, "no", { path: "$.id" }).error, true);
});

test("an internal fault never carries its cause outward", () => {
  // The message is fixed and the cause is dropped. An internal error can name
  // files, paths and values, and the reader is an external agent.
  const envelope = failure(1, RPC.INTERNAL_ERROR, "the request did not complete");
  assert.equal(envelope.error.message, "the request did not complete");
  assert.equal(envelope.error.message.includes("/"), false);
});

test("THE PUBLISHED SURFACE IS EXACTLY THREE TOOLS", () => {
  // The array IS the capability surface, so its length is the assertion that
  // matters most. A fourth tool added here is a fourth capability added.
  assert.equal(TOOLS.length, 3);
  assert.deepEqual(
    TOOLS.map((tool) => tool.name).sort(),
    ["get_verdict", "ingest_events", "install_schema"],
  );
});

test("EVERY TOOL REFUSES ADDITIONAL PROPERTIES", () => {
  // The one property that enforces "no tool takes a tenant". A schema that merely
  // documented the rule would be a comment.
  for (const tool of TOOLS) {
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} must refuse unknown keys`);
  }
});

test("no tool's ARGUMENT SCHEMA accepts a tenant, a token, or a credential", () => {
  // Belt to `additionalProperties: false`'s braces: the property must be absent
  // from the PUBLISHED surface, not merely rejected at runtime. An agent reads
  // tools/list and believes it.
  //
  // Scoped to the SCHEMA and not to the whole tool object. The descriptions are
  // prose that legitimately say which tenant a tool answers for -- "this session's
  // tenant" is the whole point of the sentence -- and a bare substring search over
  // the serialised tool would flag the documentation for being accurate.
  for (const tool of TOOLS) {
    const schema = JSON.stringify(tool.inputSchema);
    for (const forbidden of ["tenant", "token", "credential", "provider"]) {
      assert.equal(schema.includes(forbidden), false, `${tool.name} accepts "${forbidden}"`);
    }
  }
});

test("an unknown tool is refused and the surface is NOT echoed", async () => {
  // Naming what exists to something probing for it is reconnaissance, and the
  // portal edge makes the same choice at its 404 for the same reason.
  const outcome = await callTool("delete_everything", ctx(), {});
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, RPC.METHOD_NOT_FOUND);
  assert.equal(JSON.stringify(outcome).includes("install_schema"), false);
});

test("the published names are exactly the implemented ones", () => {
  // A name in TOOLS with no handler behind it advertises a capability that does
  // not exist, and a handler with no name is unreachable. Both are the same bug.
  for (const tool of TOOLS) assert.equal(isTool(tool.name), true);
  for (const candidate of ["get_verdict", "install_schema", "ingest_events", "", "GET_VERDICT"]) {
    assert.equal(isTool(candidate), candidate === "get_verdict" || candidate === "install_schema" || candidate === "ingest_events");
  }
});

test("a TENANT SMUGGLED INTO A TOOL CALL IS REFUSED AT THE SCHEMA EDGE", () => {
  // The negative test ADR-006 section 11.3 asks for. `additionalProperties: false`
  // has to fire before anything reaches the core -- if this were merely ignored,
  // the call would succeed and an agent would believe it had scoped the read.
  return Promise.all([
    assertRejected(getVerdictAt({ tenant: "someone-else" }), RPC.INVALID_PARAMS),
    assertRejected(ingestAt({ events: [{ a: 1 }], tenant: "someone-else" }), RPC.INVALID_PARAMS),
    assertRejected(installAt({ schema: { id: "a" }, tenant: "someone-else" }), RPC.INVALID_PARAMS),
  ]);
});

test("a smuggled tenant names the offending key, because the caller supplied it", async () => {
  // Withholding a key the caller just sent us buys nothing and costs diagnosability.
  const outcome = await callTool("get_verdict", ctx(), { tenant: "someone-else" });
  assert.equal(outcome.ok, false);
  assert.deepEqual(outcome.data, { unknown: "tenant" });
});

test("get_verdict takes NO arguments at all", async () => {
  // The strongest available statement that it cannot choose a tenant: there is no
  // parameter to smuggle one through.
  const outcome = await callTool("get_verdict", ctx(), { anything: "at all" });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, RPC.INVALID_PARAMS);
});

test("get_verdict FORWARDS a live snapshot, and LABELS the provenance itself", async () => {
  // The core's LiveSnapshot has no `source` member (portal-routes.ts:441), so the
  // embassy adds it. It can, because provenance here is a fact about the ROUTE it
  // called rather than a claim about the body -- see the note in `getVerdict`.
  const snapshot = stubFetch({ at: "2026-10-04T14:32:05.000Z", provider: "pega", enabled: true, verdict: { records: 20_000 }, throughput: null });
  const outcome = await callTool("get_verdict", ctx(snapshot), {});
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.result, {
    source: "live",
    at: "2026-10-04T14:32:05.000Z",
    provider: "pega",
    verdict: { records: 20_000 },
    throughput: null,
  });
});

test("a core that DECLARES a non-live source is refused rather than overwritten", async () => {
  // The defensive half of the guard: if the core ever grows its own discriminator
  // and it disagrees, two authorities are arguing about what a verdict is and the
  // embassy must not paper over it by stamping "live" on the answer.
  const disagreeing = stubFetch({ at: "x", verdict: null, source: "record" });
  const outcome = await callTool("get_verdict", ctx(disagreeing), {});
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, RPC.INTERNAL_ERROR);
});

test("an idle core (connected, no verdict yet) is NOT an error", async () => {
  // `verdict: null` is the documented "connected but idle" state. Refusing it would
  // make a healthy gateway look broken, which is the exact confusion ADR-003
  // exists to prevent.
  const idle = stubFetch({ at: "x", provider: "pega", enabled: true, verdict: null, throughput: null });
  const outcome = await callTool("get_verdict", ctx(idle), {});
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.result, { source: "live", at: "x", provider: "pega", verdict: null, throughput: null });
});

test("get_verdict REFUSES a body that is not an object", async () => {
  // A proxy page, an array, a bare string: none of them is a snapshot, and passing
  // one through would hand an agent something to "interpret".
  return callTool("get_verdict", ctx(stubFetch([1, 2, 3])), {}).then((outcome) => {
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, RPC.INTERNAL_ERROR);
  });
});

test("a RECORDED verdict is refused by get_verdict, even if the core sends one", async () => {
  // The two-truths guard with teeth: a core that answered `source: "record"`
  // through a tool named get_verdict would be the exact defect ADR-005 forbids,
  // and a model reading it would report a stored figure as current.
  const recorded = stubFetch({ source: "record", verdict: { records: 20_000 } });
  const outcome = await callTool("get_verdict", ctx(recorded), {});
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, RPC.INTERNAL_ERROR);
});

test("ingest_events refuses an empty array rather than reporting success", async () => {
  // An empty array is not a no-op; it is an unanswered question about whether the
  // call worked.
  const outcome = await callTool("ingest_events", ctx(), { events: [] });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, RPC.INVALID_PARAMS);
});

test("ingest_events refuses more than the core's own limit", async () => {
  // MAX_INGEST_EVENTS = 1000, portal-routes.ts:466. Stated so an obviously
  // oversized call is refused without crossing the wire.
  const outcome = await callTool("ingest_events", ctx(), { events: new Array(1001).fill({ a: 1 }) });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, RPC.LIMIT_EXCEEDED);
});

test("a PARTIAL accept is reported whole, not rounded to success", async () => {
  // refused: 100 alongside accepted: 900 is a true and useful answer. Collapsing
  // it would hide the refusal from the only party that could act on it.
  const partial = stubFetch({ accepted: 900, refused: 100, provider: "pega" }, 200);
  const outcome = await callTool("ingest_events", ctx(partial), { events: [{ a: 1 }] });
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.result, { accepted: 900, refused: 100, provider: "pega" });
});

test("a core 401 becomes TENANT_REFUSED and is not reported as a transport fault", async () => {
  // The core's answer is the authority on who the caller is. An embassy that
  // turned a 401 into "something went wrong" would hide the one fact that matters.
  const refused = stubFetch({ error: "no credential presented" }, 401);
  const outcome = await callTool("get_verdict", ctx(refused), {});
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, RPC.TENANT_REFUSED);
});

test("a core 400 keeps the validator's issue paths, because the author can act on them", async () => {
  const refused = stubFetch({ error: "schema refused", issues: [{ path: "$.rules[0].kind" }] }, 400);
  const outcome = await callTool("install_schema", ctx(refused), { schema: { id: "a" } });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, RPC.SCHEMA_REFUSED);
  assert.deepEqual((outcome.data as { issues: unknown }).issues, [{ path: "$.rules[0].kind" }]);
});

test("THE CREDENTIAL IS SENT AS THE HEADER, AND NEVER IN A URL OR BODY", async () => {
  // The One-Door boundary, asserted on the wire rather than described. A token in
  // a URL lands in every access log between here and the core.
  const seen: { url: string; init: Record<string, unknown> }[] = [];
  const spy: CoreFetch = async (url, init) => {
    seen.push({ url, init: init as unknown as Record<string, unknown> });
    return { status: 200, text: async () => JSON.stringify({ at: "x", verdict: null, throughput: null }) };
  };
  await callTool("get_verdict", ctx(spy), {});
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.url.includes("tok_"), false);
  assert.equal(seen[0]?.url, `http://core.test${CORE_PATHS.live}`);
  const headers = seen[0]?.init["headers"] as Record<string, string>;
  assert.equal(headers["x-gateway-token"], "tok_secret");
});

test("config is refused unless BOTH the token and the core origin are set", () => {
  // One of the two alone is a misconfiguration, and starting anyway would produce
  // a server that fails on first use with a much worse message.
  assert.equal(readConfig({}), undefined);
  assert.equal(readConfig({ NEUROFEBRIC_EMBASSY_TOKEN: "t" }), undefined);
  assert.equal(readConfig({ NEUROFEBRIC_CORE_ORIGIN: "http://c" }), undefined);
  assert.equal(readConfig({ NEUROFEBRIC_EMBASSY_TOKEN: "  ", NEUROFEBRIC_CORE_ORIGIN: "http://c" }), undefined);
  assert.notEqual(readConfig({ NEUROFEBRIC_EMBASSY_TOKEN: "t", NEUROFEBRIC_CORE_ORIGIN: "http://c" }), undefined);
});

test("a trailing slash on the origin cannot produce a doubled path separator", () => {
  // `origin + path` is concatenation, and `http://h//api/portal/live` is a
  // different path to a different handler on some servers.
  const config = readConfig({ NEUROFEBRIC_EMBASSY_TOKEN: "t", NEUROFEBRIC_CORE_ORIGIN: "http://core.test///" });
  assert.equal(config?.endpoint.origin, "http://core.test");
});

test("an absurd timeout is clamped rather than honoured", () => {
  const config = readConfig({
    NEUROFEBRIC_EMBASSY_TOKEN: "t",
    NEUROFEBRIC_CORE_ORIGIN: "http://c",
    NEUROFEBRIC_CORE_TIMEOUT_MS: "999999999",
  });
  assert.equal(config?.endpoint.timeoutMs, 60_000);
});

test("a garbage timeout falls back to the default rather than becoming NaN", () => {
  // `setTimeout` with NaN fires immediately, which would turn a typo in the
  // environment into "the core never answers" for every single call.
  const config = readConfig({
    NEUROFEBRIC_EMBASSY_TOKEN: "t",
    NEUROFEBRIC_CORE_ORIGIN: "http://c",
    NEUROFEBRIC_CORE_TIMEOUT_MS: "soon",
  });
  assert.equal(config?.endpoint.timeoutMs, 5_000);
});

// --- helpers -----------------------------------------------------------------

function ctx(fetchImpl?: CoreFetch) {
  return {
    endpoint: { origin: "http://core.test", timeoutMs: 1000 },
    credential: "tok_secret",
    fetchImpl,
  };
}

/** A core that answers with `body` at `status`, recording nothing. */
function stubFetch(body: unknown, status = 200): CoreFetch {
  return async () => ({ status, text: async () => JSON.stringify(body) });
}

const getVerdictAt = (args: Record<string, unknown>) => callTool("get_verdict", ctx(), args);
const ingestAt = (args: Record<string, unknown>) => callTool("ingest_events", ctx(), args);
const installAt = (args: Record<string, unknown>) => callTool("install_schema", ctx(), args);

async function assertRejected(outcome: Promise<{ ok: boolean; code?: number }>, code: number): Promise<void> {
  const settled = await outcome;
  assert.equal(settled.ok, false);
  assert.equal(settled.code, code);
}

// RESPONSES, WHICH THE PRECHECK DEPENDS ON.

test("A RESPONSE IS A RESPONSE, not a methodless frame", () => {
  // The precheck sends an `elicitation/create` REQUEST to the client, so the
  // client's answer arrives here as a RESPONSE: an id, a result, and NO method.
  // The parser used to require a method string, so every approval would have been
  // refused as an invalid request and every pending read would have timed out --
  // a gate that looks correctly fail-closed while being entirely non-functional.
  const frame = parseFrame(line({ jsonrpc: "2.0", id: 3, result: { action: "accept" } }));

  assert.equal(frame.kind, "response");
  if (frame.kind === "response") {
    assert.equal(frame.id, 3);
    assert.deepEqual(frame.result, { action: "accept" });
    assert.equal(frame.error, undefined);
  }
});

test("AN ERROR RESPONSE IS A RESPONSE, and its code survives", () => {
  const frame = parseFrame(line({ jsonrpc: "2.0", id: "e1", error: { code: RPC.METHOD_NOT_FOUND, message: "no such method" } }));

  assert.equal(frame.kind, "response");
  if (frame.kind === "response") {
    assert.equal(frame.id, "e1");
    assert.equal(frame.error?.code, RPC.METHOD_NOT_FOUND);
    assert.equal(frame.error?.message, "no such method");
  }
});

test("A RESPONSE WITH NO id IS REFUSED, because there is nothing to answer", () => {
  assert.equal(rejectCode(line({ jsonrpc: "2.0", result: { action: "accept" } })), RPC.INVALID_REQUEST);
});

test("A RESPONSE WITH AN UNUSABLE id IS REFUSED, and carries no id to answer on", () => {
  // `id: true` is the classic way to make a dispatcher key a map on a boolean and
  // collide every later lookup. A response must be refused the same way a request
  // with the same id is, rather than being special-cased into acceptance.
  const frame = parseFrame(line({ jsonrpc: "2.0", id: true, result: {} }));

  assert.equal(frame.kind, "rejected");
  if (frame.kind === "rejected") assert.equal(frame.id, null);
});

test("AN ERROR RESPONSE WITH A NON-NUMERIC code IS REFUSED, rather than believed", () => {
  const frame = parseFrame(line({ jsonrpc: "2.0", id: 4, error: { code: "boom", message: "no" } }));

  assert.equal(frame.kind, "rejected");
});

test("A FRAME WITH AN id BUT NEITHER METHOD, RESULT NOR ERROR IS STILL REJECTED", () => {
  // The classification must not become a loophole: adding result recognition
  // cannot turn every methodless frame into a response.
  assert.equal(rejectCode(line({ jsonrpc: "2.0", id: 3 })), RPC.INVALID_REQUEST);
});

test("A FRAME CARRYING BOTH A METHOD AND A RESULT IS STILL A REQUEST", () => {
  // The method is what makes it a request. A stray result member is not a
  // response wearing a request's clothes, and answering it as one would let a
  // caller smuggle an answer past the correlation check.
  const frame = parseFrame(line({ jsonrpc: "2.0", id: 5, method: "tools/list", result: { action: "accept" } }));

  assert.equal(frame.kind, "request");
  assert.equal(frame.kind === "request" ? frame.method : null, "tools/list");
});

test("A RESPONSE IS NOT A NOTIFICATION, because it expects an answer and carries an id", () => {
  const frame = parseFrame(line({ jsonrpc: "2.0", id: 6, result: {} }));

  assert.notEqual(frame.kind, "notification");
});
