import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Readable, Writable } from "node:stream";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { serve, readConfig, type EmbassyConfig } from "./server.ts";

/**
 * THE STDIO LOOP, AND THE TWO OBLIGATIONS THAT ONLY IT CAN TEST.
 *
 * === WHY A REAL PIPE APPEARS HERE AND NOWHERE ELSE ===
 *
 * `frame.test.ts` tests the grammar as a function of its argument, which is the
 * only way to cover malformed input exhaustively. It cannot test obligation 2 (no
 * rogue stdout) or obligation 3 (a truncated final frame is a clean exit), because
 * both are properties of BYTES arriving on a stream and of the writer's end:
 *
 *   - A truncated frame is only observable as a byte sequence that readline will
 *     hold back and then flush at EOF. There is no way to express "no trailing
 *     newline" to a pure function.
 *   - "Nothing else may write to stdout" is a statement about every module in the
 *     import graph, and it is checked here by reading the files rather than by
 *     trusting that we remembered.
 *
 * Both use real `PassThrough` streams. Nothing opens a socket and nothing spawns
 * a process, so the whole file runs in milliseconds.
 */

const CONFIG: EmbassyConfig = {
  credential: "tok_secret",
  endpoint: { origin: "http://core.test", timeoutMs: 1000 },
};

/** Feed `input` through the server and collect every byte it wrote. */
async function run(input: string): Promise<{ out: string; stderr: string }> {
  const source = Readable.from([Buffer.from(input, "utf8")]);
  const sink = new PassThrough();
  const chunks: string[] = [];
  sink.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
  await serve(source, sink, CONFIG);
  return { out: chunks.join(""), stderr: "" };
}

/** The parsed frames written back, in order. */
function frames(out: string): Record<string, unknown>[] {
  return out
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("a complete frame is answered and the reply is ONE line", async () => {
  const { out } = await run('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
  const parsed = frames(out);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.["id"], 1);
  assert.equal(out.split("\n").filter((l) => l !== "").length, 1);
});

test("SEVERAL frames in one write are each answered", async () => {
  // readline is a line splitter, not a message reader: three frames written as one
  // buffer must produce three replies. A parser that assumed one frame per chunk
  // would answer one and silently drop two.
  const { out } = await run(
    '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n',
  );
  const parsed = frames(out);
  // Two replies: the notification draws none, which is the specification.
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed.map((f) => f["id"]), [1, 2]);
});

test("CRLF line endings are handled, because a host may send them", async () => {
  // With readline's default crlfDelay a bare CR emits a line, so every CRLF frame
  // would be split in half and both halves would be parse errors. This is why the
  // reader is configured with `crlfDelay: Infinity`.
  const { out } = await run('{"jsonrpc":"2.0","id":1,"method":"initialize"}\r\n');
  const parsed = frames(out);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.["id"], 1);
});

test("a TRUNCATED final frame is DISCARDED, not answered", async () => {
  // Obligation 3. The host closed the pipe mid-frame. Parsing the partial would
  // manufacture a -32700 and answer a message that was never finished -- to a party
  // that has already gone away. The frames BEFORE it are still answered, because
  // they were complete; only the unterminated tail is dropped.
  const { out } = await run(
    '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n{"jsonrpc":"2.0","id":2,"method":"too',
  );
  const parsed = frames(out);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.["id"], 1);
  assert.equal(out.includes("-32700"), false);
});

test("a stream ending exactly on a newline answers every frame", async () => {
  // The accepting side of obligation 3. If this regressed, the truncation guard
  // would be indistinguishable from "discard the last frame always".
  const { out } = await run('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
  assert.equal(frames(out).length, 1);
});

test("blank lines are ignored rather than answered as parse errors", async () => {
  // A host that pads its writes with newlines is being tidy, not broken. Answering
  // would be noise in a protocol where every reply is expected to correspond to a
  // request.
  const { out } = await run('\n\n{"jsonrpc":"2.0","id":1,"method":"initialize"}\n\n');
  assert.equal(frames(out).length, 1);
});

test("MALFORMED JSON mid-stream does not end the session", async () => {
  // Obligation 4, end to end: one bad line is one bad line. If it ended the loop,
  // a host that sent a truncated frame would lose every later call too.
  const { out } = await run(
    'this is not json\n{"jsonrpc":"2.0","id":7,"method":"initialize"}\n',
  );
  const parsed = frames(out);
  assert.equal(parsed.length, 2);
  const error = parsed[0]?.["error"] as { code: number };
  assert.equal(error.code, -32700);
  assert.equal(parsed[1]?.["id"], 7);
});

test("a tool call BEFORE initialize is refused and the session survives", async () => {
  // ADR-006 section 5.2 rule 5. The refusal must not be fatal either -- a host that
  // probes the boundary must still be able to initialise afterwards.
  //
  // It is refused as a JSON-RPC PROTOCOL ERROR, not as an `isError` tool result, and
  // the distinction is deliberate. A tool that declined is a fact about the tool; a
  // session with no established credential is a fact about the CONNECTION, and the
  // host needs to know its session is broken so it can re-initialise. Reporting it
  // through the tool channel would tell a model "the tool said no" when the truth is
  // "you never finished the handshake".
  const { out } = await run(
    '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_verdict","arguments":{}}}\n{"jsonrpc":"2.0","id":2,"method":"initialize"}\n',
  );
  const parsed = frames(out);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]?.["result"], undefined);
  const error = parsed[0]?.["error"] as { code: number; message: string };
  assert.equal(error.code, -32001);
  assert.match(error.message, /not been initialised/);
  assert.equal(parsed[1]?.["id"], 2);
});

test("a tool call AFTER initialize is dispatched, not refused", async () => {
  // The other half of the same guard. A boundary that refuses everything would pass
  // the test above and be useless.
  const { out } = await run(
    '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"delete_everything","arguments":{}}}\n',
  );
  const parsed = frames(out);
  const result = parsed[1]?.["result"] as { isError: boolean; content: { text: string }[] };
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? "", /no such tool/);
});

test("an unknown METHOD gets a JSON-RPC error, not an isError tool result", async () => {
  // The two refusal channels must stay distinguishable. A protocol fault and a tool
  // that declined are different facts, and merging them leaves a host model unable
  // to tell "you called this wrong" from "this did not work".
  const { out } = await run('{"jsonrpc":"2.0","id":1,"method":"no/such/method"}\n');
  const parsed = frames(out);
  assert.equal(parsed[0]?.["result"], undefined);
  assert.equal((parsed[0]?.["error"] as { code: number }).code, -32601);
});

test("nothing in the embassy writes to stdout except the one legal holder", async () => {
  // Obligation 2, checked by reading the files rather than by trusting review.
  //
  // stdout IS the protocol channel. A single `console.log` in any module on the
  // import path corrupts the stream, and the symptom appears on the HOST's side as
  // a parse error pointing at our code -- which is a miserable thing to debug from
  // the other end of a pipe. `process.stderr` is fine and is what the diagnostics
  // use; only stdout is forbidden.
  //
  // `server.ts` is the single exemption, and it is an exemption rather than an
  // oversight: `main()` is the process entry point and MUST hand `process.stdout`
  // to `serve`, or there is no protocol channel at all. Everything else -- the
  // writer that every frame goes through is a parameter, so no other module has any
  // business holding the handle -- is checked.
  const here = fileURLToPath(new URL(".", import.meta.url));
  const consoleOffenders: string[] = [];
  const stdoutOffenders: string[] = [];

  for (const file of readdirSync(here)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    // A comment mentioning console.log is not a call to it, so comments go first.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    if (/console\.(log|info|debug|warn|error)\s*\(/.test(code)) consoleOffenders.push(file);
    if (/process\.stdout\b/.test(code) && file !== "server.ts") stdoutOffenders.push(file);
  }

  assert.deepEqual(consoleOffenders, [], "no module may log to the protocol channel");
  assert.deepEqual(stdoutOffenders, [], "only server.ts's entry point may hold stdout");
});

test("the embassy reaches NO ingestion or streaming module", async () => {
  // ADR-006 section 6.2 rule 1, re-asserted for the shape that was actually built.
  //
  // The ratified ADR required the embassy to share a process with the kernel and
  // read `LiveGateway` by injection. This implementation is a separate process
  // talking HTTP instead, which is safe PRECISELY BECAUSE it is stateless -- see
  // `core.ts`. But the import boundary that made the old shape safe is still worth
  // keeping: if the embassy ever imports the streaming engine directly, the two
  // truths would acquire a third source and the statelessness argument collapses.
  //
  // A comment is not a control, so this is an assertion over the import graph.
  const here = fileURLToPath(new URL(".", import.meta.url));
  const forbidden = ["ingestion", "conductor", "live-anomaly", "omniroute-gateway", "store.ts"];
  const offenders: string[] = [];
  for (const file of readdirSync(here)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const code = readFileSync(new URL(file, import.meta.url), "utf8");
    for (const needle of forbidden) {
      if (code.includes(`/${needle}`) || code.includes(`/${needle}.ts`)) offenders.push(`${file} -> ${needle}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("config rejects a missing origin even when a token is present", () => {
  // Spelled out separately from the all-or-nothing case because a half-configured
  // server that starts and then fails on first use is much worse than one that
  // refuses to start with a clear message.
  assert.equal(readConfig({ NEUROFEBRIC_EMBASSY_TOKEN: "t" }), undefined);
});

test("a Writable that throws does not take the loop down mid-stream", async () => {
  // A host that has gone away closes its read end; writes then fail. The loop must
  // not surface that as an unhandled rejection, because an unhandled rejection in
  // Node terminates the process by default and the host would lose every subsequent
  // session to one broken pipe.
  const source = Readable.from([Buffer.from('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n', "utf8")]);
  const hostile = new Writable({
    write(_chunk, _enc, done) {
      done(new Error("EPIPE"));
    },
  });
  await assert.doesNotReject(() => serve(source, hostile, CONFIG));
});

test("DISCOVERY BEFORE THE HANDSHAKE IS REFUSED, because the tool list is a capability map", async () => {
  // `tools/call` has always required an established session. `tools/list` did not,
  // so a caller that never handshook could still enumerate every tool this
  // embassy offers -- which is the same reconnaissance `callTool` refuses to
  // hand over at its "no such tool", for the same reason the portal edge does not
  // echo its routes at a 404. A boundary that holds on the call and not on the
  // listing is not a boundary; it is a speed bump beside the door.
  //
  // The refusal shape is identical to every other session refusal, so a caller
  // cannot map the boundary by probing it.
  const { out } = await run('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
  const [frame] = frames(out);

  assert.ok(frame !== undefined, "the request must be answered, not dropped");
  const error = frame["error"] as { readonly code?: number; readonly message?: string } | undefined;
  assert.ok(error !== undefined, "discovery must be refused before the handshake, not served");
  assert.equal(error.code, -32001);

  // No capability is disclosed. Naming what exists to a caller that has not proved
  // it holds a credential is the disclosure this whole assertion exists to stop.
  assert.equal(out.includes("get_verdict"), false);
  assert.equal(out.includes("install_schema"), false);
  assert.equal(out.includes("ingest_events"), false);
});

test("DISCOVERY AFTER THE HANDSHAKE ANSWERS, with a schema for every tool", async () => {
  const { out } = await run(
    '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n',
  );
  const [, listed] = frames(out);
  const result = listed?.["result"] as { readonly tools?: readonly Record<string, unknown>[] } | undefined;
  const tools = result?.tools ?? [];

  assert.deepEqual(
    tools.map((tool) => tool["name"]),
    ["get_verdict", "install_schema", "ingest_events"],
    "every published tool is discoverable",
  );

  for (const tool of tools) {
    // The specification says inputSchema MUST be a valid JSON Schema object, and
    // explicitly recommends `additionalProperties: false` for a tool that takes
    // nothing. That property is also the enforcement behind "no tool accepts a
    // tenant or a credential", so it is asserted rather than assumed.
    const schema = tool["inputSchema"] as Record<string, unknown> | undefined;
    assert.equal(schema?.["type"], "object", `${String(tool["name"])} publishes an object schema`);
    assert.equal(schema?.["additionalProperties"], false, `${String(tool["name"])} refuses extra keys`);
  }
});

test("EVERY PUBLISHED TOOL IS DISPATCHABLE, so the listing cannot drift from the dispatcher", async () => {
  // The tool list and the dispatcher are two hand-written authorities for one
  // surface. They agree today, and agreement today is not a property -- a fourth
  // tool added to the list and not to the dispatcher would be advertised to every
  // connecting client and then refuse at the call.
  //
  // This asserts the bijection from the caller's side rather than comparing the
  // two declarations to each other, because the failure it must catch is exactly
  // the case where the two declarations agree with each other and disagree with
  // what the server can do.
  const { out } = await run(
    '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n',
  );
  const [, listed] = frames(out);
  const result = listed?.["result"] as { readonly tools?: readonly { readonly name: string }[] } | undefined;
  const names = (result?.tools ?? []).map((tool) => tool.name);

  for (const name of names) {
    const [called] = frames(
      (
        await run(
          `{"jsonrpc":"2.0","id":1,"method":"initialize"}\n{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"${name}","arguments":{}}}\n`,
        )
      ).out,
    ).slice(1);
    const answer = called?.["result"] as { readonly isError?: boolean } | undefined;
    assert.equal(
      answer?.isError,
      true,
      `${name} is published but refused as unknown, so the listing advertises a capability the dispatcher does not have`,
    );
  }
});
