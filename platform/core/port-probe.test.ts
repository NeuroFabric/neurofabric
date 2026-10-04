import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";

import { describePort, inspectPort, isPortFree } from "./port-probe.ts";

/**
 * THE PORT PROBE. It reports; it never stops.
 *
 * === THE TEST THAT MATTERS MOST IS THE ONE THAT IS NOT HERE ===
 *
 * There is no test that kills a process, and there must never be one. The module
 * has no code path that terminates anything, and that is a property a reader has
 * to be able to confirm -- so the absence is stated here rather than left as an
 * assumption, because "it does not kill things" is exactly the kind of claim that
 * stops being true when nobody checks.
 */

test("a port nothing is listening on is reported free", async () => {
  // Port 0 asks the OS for any free port, so this is a real probe of this
  // machine now, not a fixture. A probe that could itself be stale would make the
  // check a new source of the confusion it removes.
  const free = await isPortFree(0);
  assert.equal(free, true);

  const report = await inspectPort(0);
  assert.equal(report.free, true);
  assert.equal(report.process, undefined);
  assert.match(describePort(report), /port 0 is free/);
});

test("a port that IS taken is reported busy, and names the holder", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  assert.ok(port > 0);

  try {
    const report = await inspectPort(port);
    assert.equal(report.free, false, "a bound port must not report free");

    const message = describePort(report);
    // The whole point: not `EADDRINUSE`, but WHO.
    if (report.process !== undefined) {
      assert.equal(report.process.pid, String(process.pid), "on a port this process holds, the PID is ours");
      assert.match(message, /already in use by PID \d+/);
    } else {
      // Busy, but we cannot name it. That is still a real answer and it is
      // reported as `unidentified` rather than as an absence of process.
      assert.equal(report.unidentified, true);
      assert.match(message, /could not be identified/);
    }
  } finally {
    // Closed by the test, explicitly, in a `finally`. A listener left open is the
    // exact shape that has hung this repository's own suite once already.
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("the message says NOTHING WAS STOPPED", () => {
  // The claim a reader most needs verified, because a tool that ends somebody
  // else's process without saying so is the failure this project keeps meeting.
  const busy = {
    port: 8080,
    host: "127.0.0.1",
    free: false,
    process: { pid: "1234", name: "node.exe" },
  };
  const message = describePort(busy);
  assert.match(message, /Nothing has been stopped/);
  assert.match(message, /8080/);
  assert.match(message, /1234/);
  assert.match(message, /node\.exe/);
  // And it tells the reader how to look for themselves, rather than leaving the
  // PID as the only lead with no route from it.
  assert.match(message, /Get-NetTCPConnection|lsof/);
});

test("a free port's message does not raise an alarm", async () => {
  // A warning that fires when nothing is wrong trains people to ignore warnings.
  const message = describePort(await inspectPort(0));
  assert.doesNotMatch(message, /already in use/);
  assert.doesNotMatch(message, /Nothing has been stopped/);
});

test("it probes rather than trusting a cached answer", async () => {
  // Bind, observe busy, release, observe free -- on the SAME port. A check that
  // reported a stale result would pass any single call and fail the real one.
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  assert.equal((await inspectPort(port)).free, false);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.equal((await inspectPort(port)).free, true, "the probe must reflect the port's state NOW");
});