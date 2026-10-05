import test from "node:test";
import assert from "node:assert/strict";

import { SseAccumulator, readAlert, type SseItem } from "./sse-frames.ts";

/**
 * === WHY THIS FILE EXISTS AT ALL ===
 *
 * The triage client parses an event stream by hand, inline, and every other test in
 * the project drove that code through a real socket where a real hub produced a
 * real frame -- so the parser was only ever exercised in the one shape that arrives
 * when everything works.
 *
 * A stream is the one transport where the DELIMITER, not the payload, is the thing
 * that breaks. The socket decides where a chunk ends: a frame can be cut between
 * the two newlines of its terminator, cut in the middle of a JSON string, cut
 * mid-UTF-8-sequence, and a proxy can rewrite the line endings on the way past.
 * None of those are exotic. All of them are what a chunk boundary IS.
 *
 * So this suite feeds the parser byte-level splits rather than tidy strings. Every
 * case here is one a real socket can produce and the previous implementation could
 * not survive.
 *
 * === THE INVARIANT UNDER ALL OF IT ===
 *
 * The parser must never turn "I could not read this" into "nothing happened".
 *
 * That matters more here than usual because the stream is the client's only
 * evidence of a breach. A parser that silently drops a malformed frame reports a
 * clean system at 2am, and a clean system is the single most expensive thing this
 * agent can be wrong about.
 */

const ALERT = 'data: {"id":"alt-1","kind":"latency"}';

/** Feed raw text as one chunk, the way a socket delivers an unbroken write. */
function one(wire: string): SseItem[] {
  return new SseAccumulator().push(Buffer.from(wire, "utf8"));
}

/**
 * Feed text one BYTE at a time.
 *
 * The worst case the socket can produce, and the one a string-based test cannot
 * express: it splits every multi-byte character, every field, and every delimiter
 * simultaneously. If the parser survives this it survives the network.
 */
function byByte(wire: string): SseItem[] {
  const acc = new SseAccumulator();
  const items: SseItem[] = [];
  for (const byte of Buffer.from(wire, "utf8")) items.push(...acc.push(Uint8Array.of(byte)));
  return items;
}

/** The events only, so an assertion about the stream is not about diagnostics. */
function events(items: readonly SseItem[]): string[] {
  return items.filter((item) => item.kind === "event").map((item) => (item.kind === "event" ? item.value.data : ""));
}

test("A FRAME DELIVERED WHOLE IS ONE EVENT", () => {
  const items = one(`id: alt-1\nevent: alert\n${ALERT}\n\n`);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, "event");
  const value = items[0]?.kind === "event" ? items[0].value : undefined;
  assert.equal(value?.event, "alert");
  assert.equal(value?.id, "alt-1");
  assert.equal(value?.data, '{"id":"alt-1","kind":"latency"}');
});

test("A CHUNK BOUNDARY INSIDE THE TERMINATOR IS NOT A BOUNDARY AT ALL", () => {
  // The frame arrives as "...data\n" then "\n". A parser that looks for "\n\n" in
  // one buffer and then resets will see neither, and will hold a complete alert
  // forever.
  const acc = new SseAccumulator();
  const first = acc.push(Buffer.from(`id: alt-1\nevent: alert\n${ALERT}\n`, "utf8"));
  assert.deepEqual(first, [], "the first half is not yet a frame, and must not be invented");

  const second = acc.push(Buffer.from("\n", "utf8"));
  assert.equal(second.length, 1);
  assert.equal(second[0]?.kind, "event");
  assert.equal(second[0]?.kind === "event" ? second[0].value.event : "", "alert");
});

test("A CHUNK BOUNDARY INSIDE THE PAYLOAD IS NOT A BOUNDARY AT ALL", () => {
  const acc = new SseAccumulator();
  const wire = `id: alt-1\nevent: alert\n${ALERT}\n\n`;
  const cut = wire.indexOf('"latency"') + 3;
  assert.deepEqual(acc.push(Buffer.from(wire.slice(0, cut), "utf8")), []);
  const rest = acc.push(Buffer.from(wire.slice(cut), "utf8"));
  assert.equal(events(rest).length, 1);
});

test("A MULTIBYTE CHARACTER CUT IN HALF IS NOT CORRUPTED", () => {
  // The decoder has to hold its partial sequence across chunks. Decoding each chunk
  // independently turns one alert into U+FFFD on both sides of the split.
  const acc = new SseAccumulator();
  const wire = 'id: alt-1\nevent: alert\ndata: {"note":"breach — confirmed"}\n\n';
  const bytes = Buffer.from(wire, "utf8");
  const at = bytes.indexOf(Buffer.from("—", "utf8")) + 1;
  const items = [...acc.push(bytes.subarray(0, at)), ...acc.push(bytes.subarray(at))];
  assert.equal(items.length, 1);
  assert.equal(events(items)[0], '{"note":"breach — confirmed"}');
});

test("CRLF LINE ENDINGS ARE THE SAME FRAME, not a stream that never yields", () => {
  // A proxy between the hub and the agent rewrites line endings. "\r\n\r\n" does not
  // CONTAIN "\n\n", so a parser that searches for the literal terminator waits
  // forever -- and reports a healthy system to a 2am operator.
  const items = one(`id: alt-1\r\nevent: alert\r\n${ALERT}\r\n\r\n`);
  assert.equal(items.length, 1);
  assert.equal(events(items).length, 1);
  assert.equal(items[0]?.kind === "event" ? items[0].value.data : "", '{"id":"alt-1","kind":"latency"}');
});

test("MIXED LINE ENDINGS WITHIN ONE STREAM", () => {
  const items = one(`id: a\nevent: alert\ndata: 1\r\n\r\nid: b\r\nevent: alert\rdata: 2\r\n\r\n`);
  assert.deepEqual(events(items), ["1", "2"]);
});

test("TWO FRAMES IN ONE CHUNK ARE TWO EVENTS", () => {
  const items = one(`id: a\nevent: alert\ndata: 1\n\nid: b\nevent: alert\ndata: 2\n\n`);
  assert.deepEqual(events(items), ["1", "2"]);
});

test("A STREAM DELIVERED ONE BYTE AT A TIME YIELDS EVERY EVENT", () => {
  // The whole veracity claim in one assertion: no chunk boundary the socket can
  // choose changes the answer.
  const wire = [
    `id: a\nevent: alert\ndata: {"n":1}\n\n`,
    `: keep-alive\n\n`,
    `id: b\nevent: alert\ndata: {"n":2}\n\n`,
  ].join("");
  assert.deepEqual(events(byByte(wire)), ['{"n":1}', '{"n":2}']);
});

test("A FRAME THE SERVER DID NOT TERMINATE IS STILL DELIVERED", () => {
  // The hub closed the connection immediately after writing. The bytes are all
  // there; only the blank line is missing. Discarding the tail is how a real alert
  // goes missing.
  const acc = new SseAccumulator();
  assert.deepEqual(acc.push(Buffer.from(`id: alt-1\nevent: alert\n${ALERT}\n`, "utf8")), []);
  const flushed = acc.end();
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0]?.kind, "event");
});

test("A FRAME CUT MID-LINE IS REPORTED, NOT SILENTLY DROPPED", () => {
  // The connection died with half a line buffered. There is no complete event here,
  // and the only honest answer is to say so -- silence reads as "no breach".
  const acc = new SseAccumulator();
  acc.push(Buffer.from(`id: alt-1\nevent: alert\ndata: {"n":1`, "utf8"));
  const flushed = acc.end();
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0]?.kind, "unreadable");
  assert.match(flushed[0]?.kind === "unreadable" ? flushed[0].because : "", /mid-line/);
});

test("SEVERAL DATA LINES JOIN BACK INTO ONE PAYLOAD", () => {
  // This is the hub's own contract: `frame()` splits a payload containing a newline
  // across several `data:` lines precisely so the frame stays one event. A reader
  // that takes the first line only truncates the alert -- and a truncated JSON
  // payload fails to parse, so the alert disappears.
  const items = one("id: alt-1\nevent: alert\ndata: line one\ndata: line two\n\n");
  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind === "event" ? items[0].value.data : "", "line one\nline two");
});

test("THE EVENT NAME IS A FIELD, NOT A SUBSTRING", () => {
  // The previous implementation searched the whole frame text for "event: alert".
  // A payload mentioning that string in a note would be acted on as an alert.
  const items = one(`id: alt-1\ndata: {"note":"event: alert was mentioned here"}\n\n`);
  assert.equal(items[0]?.kind === "event" ? items[0].value.event : "", "");
  assert.equal(events(items).length, 1);
});

test("AN EVENT NAME THAT BEGINS WITH 'alert' IS NOT THE alert EVENT", () => {
  const items = one("id: slow-1\nevent: alert-slow\ndata: 1\n\n");
  assert.equal(items[0]?.kind === "event" ? items[0].value.event : "", "alert-slow");
});

test("A FRAME WITH NO DATA DISPATCHES NOTHING", () => {
  // The hub sends `event: slow-consumer` with no payload to say it dropped us. There
  // is no data to read, so there is no event -- and a parser that invents one hands
  // the client `undefined`.
  assert.deepEqual(one("id: slow-1\nevent: slow-consumer\n\n"), []);
  assert.deepEqual(one("retry: 1000\n\n"), []);
});

test("COMMENTS AND UNKNOWN FIELDS ARE IGNORED, NOT MISREAD", () => {
  const items = one(`: keep-alive\nevent: alert\n${ALERT}\nunknown-field: whatever\n\n`);
  assert.equal(items.length, 1);
  assert.equal(events(items)[0], '{"id":"alt-1","kind":"latency"}');
});

test("A FIELD WITH NO SPACE AFTER THE COLON IS STILL THAT FIELD", () => {
  // Only one space is stripped. Stripping more would eat leading whitespace out of a
  // payload and corrupt it; stripping none would leave it on every value.
  const items = one("event:alert\ndata:{\"n\":1}\n\n");
  assert.equal(events(items)[0], '{"n":1}');
});

test("PAYLOAD WHITESPACE IS PRESERVED, because JSON NEEDS IT", () => {
  const items = one("event: alert\ndata: { \"n\": 1 }\n\n");
  assert.equal(events(items)[0], '{ "n": 1 }');
});

test("A PAYLOAD THAT IS NOT JSON IS AN UNREADABLE ALERT, not a dropped one", () => {
  // The consumer decides what an unreadable alert means. Silently dropping it is the
  // same as saying there was no alert -- and this is the third outcome, distinct
  // from "the event was not an alert" and from "the stream broke".
  const [item] = one("event: alert\ndata: {not json\n\n");
  const read = readAlert(item);
  assert.equal(read.kind, "unreadable");
  assert.match(read.kind === "unreadable" ? read.because : "", /JSON/);
});

test("A JSON PAYLOAD THAT IS NOT AN ALERT OBJECT IS UNREADABLE", () => {
  // `1` parses. It is still not an alert, and handing it back as one would put a
  // number where the caller expects a record to read `id` off.
  for (const payload of ["1", "null", '"text"', "[1,2]"]) {
    const [item] = one(`event: alert\ndata: ${payload}\n\n`);
    assert.equal(readAlert(item).kind, "unreadable", `${payload} is not an alert`);
  }
});

test("A REAL ALERT IS READ, with its id carried alongside it", () => {
  const [item] = one(`id: alt-7\nevent: alert\n${ALERT}\n\n`);
  const read = readAlert(item);
  assert.equal(read.kind, "alert");
  assert.deepEqual(read.kind === "alert" ? read.alert : {}, { id: "alt-1", kind: "latency" });
  assert.equal(read.kind === "alert" ? read.id : "", "alt-7");
});

test("A FRAME WE DO NOT ACT ON IS IGNORED, AND ITS DATA IS NEVER PARSED", () => {
  // `slow-consumer` is the hub saying it dropped us. It is worth seeing and not
  // worth failing on, so it is a third outcome rather than an error -- and its
  // payload is not JSON at all, so a reader that parsed before routing would report
  // a corrupt stream where the hub sent a correct notice.
  const [item] = one("id: slow-1\nevent: slow-consumer\ndata: the notification only\n\n");
  assert.equal(readAlert(item).kind, "ignored");
});

test("THE EVENT NAME SURVIVES A FRAME THAT NAMED NONE", () => {
  // Per the specification the event-type buffer is not reset by dispatch, so a
  // `data:`-only frame is still labelled by the previous frame. Our hub always names
  // every event, so this cannot mislabel our own traffic; pinned because the
  // behaviour is invisible until it is depended on.
  const items = one("event: alert\ndata: 1\n\ndata: 2\n\n");
  assert.equal(items[0]?.kind === "event" ? items[0].value.event : "", "alert");
  assert.equal(items[1]?.kind === "event" ? items[1].value.event : "", "alert");
});

test("THE LAST EVENT ID SURVIVES A FRAME THAT NAMED NONE", () => {
  // The reason the id matters at all: a reconnecting consumer resumes from it.
  const items = one("id: alt-9\nevent: alert\ndata: 1\n\ndata: 2\n\n");
  assert.equal(items[0]?.kind === "event" ? items[0].value.id : "", "alt-9");
  assert.equal(items[1]?.kind === "event" ? items[1].value.id : "", "alt-9");
});

test("AN ID CONTAINING A NUL IS IGNORED, because the specification says so", () => {
  const items = one("id: a\u0000b\nevent: alert\ndata: 1\n\n");
  assert.equal(items[0]?.kind === "event" ? items[0].value.id : "", "");
});

test("A STREAM-LEVEL FAILURE IS UNREADABLE WHEN IT REACHES THE READER", () => {
  const acc = new SseAccumulator();
  acc.push(Buffer.from("event: alert\ndata: {\"n\":1", "utf8"));
  const read = readAlert(acc.end()[0]);
  assert.equal(read.kind, "unreadable");
});

test("THE DIAGNOSTIC CARRIES A BOUNDED PREVIEW, because it is printed", () => {
  const acc = new SseAccumulator();
  acc.push(Buffer.from(`event: alert\ndata: ${"x".repeat(5000)}\n\nend`, "utf8"));
  const flushed = acc.end();
  const preview = flushed[0]?.kind === "unreadable" ? flushed[0].preview : "";
  assert.ok(preview.length > 0, "an operator needs to see SOMETHING");
  assert.ok(preview.length <= 512, `the preview is bounded, not the whole frame (was ${preview.length})`);
});

test("EMPTY CHUNKS ARE NOT EVENTS", () => {
  const acc = new SseAccumulator();
  assert.deepEqual(acc.push(new Uint8Array(0)), []);
  assert.deepEqual(acc.push(Buffer.from("", "utf8")), []);
  assert.deepEqual(acc.end(), []);
});

test("A LEADING BLANK LINE IS NOT AN EMPTY EVENT", () => {
  // Servers that emit a padding newline before the first frame are common enough.
  assert.deepEqual(one("\n\n"), []);
});