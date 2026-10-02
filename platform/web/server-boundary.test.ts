import test, { after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";

import { startWedgeServer, type RunningWedge } from "./server.ts";
import { PAGE_HTML } from "./page.ts";

/**
 * THE WEDGE SWEEP. One hole, and it is the one the file's own header says
 * cannot exist.
 *
 * `server.ts` opens with a claim: it performs NO validation of its own, hands
 * every path to the Conductor, and therefore "there is nothing here to bypass".
 * The `/api/report` route keeps that claim. The `/api/feedback` route does not:
 * it calls `readCsvFor(path.resolve(cwd, target))`, which is a direct
 * `readFile` with no boundary check anywhere on the way to it. So the claim is
 * false for one of the two routes, and a file outside the workspace can be read
 * by a POST to a server that binds only to 127.0.0.1.
 *
 * That is worse than the read. The read is the kind of thing a local tool does.
 * The problem is the DOCUMENTED INVARIANT being false in one branch: a reviewer
 * who has read the header will not look for validation in this file, because the
 * header says there is none to find. A control that is claimed to be absent is
 * still a control, and claiming absence is how the next one gets introduced.
 */

/** Teardown that runs even when an assertion throws -- see server.test.ts. */
const openServers = new Set<RunningWedge>();
after(async () => {
  await Promise.all([...openServers].map((s) => s.close().catch(() => undefined)));
});

const CLEAN_CSV = "alpha,beta\n1,2\n3,4\n";

test("FINDING 4: the feedback route reads a file outside the workspace", async () => {
  // A valid CSV OUTSIDE the workspace. Valid matters: if the file were
  // malformed, the route would return 400 whether or not it was read, and the
  // test would pass for the wrong reason -- the trap the connector sweep notes.
  const outside = await mkdtemp(path.join(os.tmpdir(), "nf-weboutside-"));
  const victim = path.join(outside, "victim.csv");
  await writeFile(victim, CLEAN_CSV, "utf8");

  const workspace = await mkdtemp(path.join(os.tmpdir(), "nf-webws-"));
  const server = await startWedgeServer({ cwd: workspace });
  openServers.add(server);

  const response = await fetch(`${server.url}/api/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // A relative traversal, which is the spelling that works on every host.
    body: JSON.stringify({
      path: path.relative(workspace, victim),
      column: "alpha",
      role: "category",
    }),
  });
  const body = (await response.json()) as Record<string, unknown>;

  // THE DISCRIMINATOR. A refusal before the read returns no `feedback` key at
  // all. If the file was read, `applyFeedback` succeeded on its headers and the
  // response carries the correction -- whatever the Conductor then decides.
  // Asserting on the status code alone would NOT catch this, because the
  // Conductor refuses the same path afterwards and returns 403 either way.
  assert.equal(body.feedback, undefined,
    "the file outside the workspace was read and a correction was applied to it");
  // 403, not 400, and deliberately: `/api/report` returns 403 for the same path,
  // so the two routes must not be distinguishable by whether they check. The
  // assertion that matters is the one above -- a 403 alone would also be what a
  // route that read the file and was then refused downstream returned.
  assert.equal(response.status, 403, "and the route must refuse the request, not carry on");
});

test("and the same traversal against the report route is still the kernel's refusal", async () => {
  // The control case. /api/report hands the path to the Conductor and gets a
  // governed answer, so the two routes must not look the same -- and this is
  // what proves the fix below routed the correction through the same boundary
  // rather than merely adding a 403 to the wrong place.
  const outside = await mkdtemp(path.join(os.tmpdir(), "nf-weboutside2-"));
  const victim = path.join(outside, "victim2.csv");
  await writeFile(victim, CLEAN_CSV, "utf8");
  const workspace = await mkdtemp(path.join(os.tmpdir(), "nf-webws2-"));
  const server = await startWedgeServer({ cwd: workspace });
  openServers.add(server);

  const response = await fetch(`${server.url}/api/report`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: path.relative(workspace, victim) }),
  });
  assert.ok(response.status === 403 || response.status === 400,
    `an escaping path must not deliver, got ${response.status}`);
});

test("a correction INSIDE the workspace still works, so the fix is a filter and not a wall", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "nf-webws3-"));
  await writeFile(path.join(workspace, "orders.csv"), "_time,region,total\n2026-09-30,EMEA,10\n", "utf8");
  const server = await startWedgeServer({ cwd: workspace });
  openServers.add(server);

  const response = await fetch(`${server.url}/api/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "orders.csv", column: "region", role: "category" }),
  });
  const body = (await response.json()) as Record<string, unknown>;
  assert.ok(body.feedback !== undefined, "a legitimate correction must still be applied");
});

// === THE LOOPBACK DEFAULT MUST SURVIVE CONTAINERISATION =================

test("the server binds loopback by DEFAULT, which is the security property", async () => {
  // `startWedgeServer` binds 127.0.0.1 on purpose: "this process can read the
  // user's files; a listener on every interface turns a local tool into a
  // remote one." Containerising is the moment that decision is most likely to be
  // quietly reversed, because a container publishing a port cannot be reached
  // through a loopback bind and the obvious fix is to open the bind. So the
  // default is pinned here, and the container opts in EXPLICITLY.
  const workspace = await mkdtemp(path.join(os.tmpdir(), "nf-host-"));
  const server = await startWedgeServer({ cwd: workspace });
  openServers.add(server);
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/,
    "the default must remain loopback; widening it is a deliberate, separate change");
});

test("a container may opt into 0.0.0.0 explicitly, because a port publish cannot reach loopback", async () => {
  // Inside a container, `server.listen(port, "127.0.0.1")` binds the container's
  // own loopback and Docker's published port -- which forwards to the container
  // interface -- is refused. The fix is to widen the bind INSIDE the container
  // while keeping the published port bound to the host's loopback, so the
  // reachable surface is identical to the non-container case. This test is the
  // opt-in; the compose file is the other half, and it publishes to 127.0.0.1.
  const workspace = await mkdtemp(path.join(os.tmpdir(), "nf-host2-"));
  const server = await startWedgeServer({ cwd: workspace, host: "0.0.0.0" });
  openServers.add(server);
  assert.match(server.url, /^http:\/\/0\.0\.0\.0:\d+$/);
  // And it must actually answer on the container interface, not just claim to.
  const response = await fetch(`http://127.0.0.1:${server.port}/`);
  assert.equal(response.status, 200, "the opt-in bind must really listen");
});

// === CONFIRMED CLEAN, NOW PINNED ==========================================

test("the report renderer escapes hostile content before it transforms it", () => {
  // page.ts is the third named target and it is CLEAN. Escape-first, then a
  // fixed transform set, and no raw-HTML path. That is a claim, so it gets a
  // test: `I read the regex and it looked right` is not evidence.
  //
  // This deliberately does NOT rebuild the page's script and run it. The
  // earlier attempt to reconstruct `render` in a `new Function` was a parse
  // error waiting to happen, and a test that fails because of a quoting mistake
  // in the harness is not a test of the thing under test. So the two properties
  // are checked separately: `esc` is EXTRACTED AND RUN (behaviour), and the
  // order is checked STRUCTURALLY (shape).
  const escBody = /function esc\(text\) \{([\s\S]*?)\n  \}/.exec(PAGE_HTML)?.[1];
  assert.ok(escBody !== undefined, "the page must still define esc, or this test is vacuous");
  const esc = new Function(`return function esc(text) {${escBody}\n  }`)() as (t: unknown) => string;

  for (const payload of [
    '<img src=x onerror="alert(1)">',
    "<script>alert(1)</script>",
    "<svg onload=alert(1)>",
    "<iframe src=javascript:alert(1)>",
    "a & b",
    "'quoted' and \"double\"",
  ]) {
    const out = esc(payload);
    assert.ok(!out.includes("<"), `a raw < survived escaping: ${payload}`);
    assert.ok(!out.includes(">"), `a raw > survived escaping: ${payload}`);
    assert.ok(!out.includes('"'), `a raw double quote survived escaping: ${payload}`);
    assert.ok(!out.includes("'"), `a raw single quote survived escaping: ${payload}`);
    // NOT idempotent, and it must not be: `esc` rewrites `&` first, so a second
    // pass turns `&lt;` into `&amp;lt;`. That is correct -- it renders as the
    // literal text `&lt;` and still contains no raw `<`. What matters is that
    // escaping is MONOTONICALLY SAFER, not that it is a fixed point.
    const twice = esc(esc(payload));
    assert.ok(!twice.includes("<") && !twice.includes(">"),
      `a second escape pass reintroduced markup: ${payload}`);
  }

  // THE ORDER, structurally. `render` must consume an already-escaped string,
  // which is the whole safety property: no transform can re-introduce markup
  // because markup was never present to begin with.
  const renderBody = /function render\(markdown\) \{([\s\S]*?)\n  \}\n\n  function say/.exec(PAGE_HTML)?.[1];
  assert.ok(renderBody !== undefined, "render must still exist");
  assert.match(renderBody, /esc\(markdown\)/,
    "render must escape its input first; a transform-then-escape order is a hole");

  // AND NO RAW-HTML PATH. Every write to innerHTML must go through render, or a
  // future edit could assign unescaped content and still pass the test above.
  const writes = [...PAGE_HTML.matchAll(/innerHTML\s*=\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.ok(writes.length > 0, "the page should assign innerHTML somewhere");
  for (const value of writes) {
    assert.match(value, /^render\(/,
      `innerHTML is assigned from something other than render(): ${value}`);
  }

  // NOTE ON WHAT IS DELIBERATELY NOT ASSERTED HERE: an earlier draft also
  // enumerated the tags the page emits and checked them against an allow-list.
  // It failed, because the page's own explanatory comment contains an escaped
  // `<img>` example, and it was matching prose rather than behaviour. A check
  // that scans a whole file for angle brackets and asserts on what it finds is a
  // check that breaks when a COMMENT changes, and once someone deletes it to
  // make the suite green it has taught the codebase nothing. The three
  // properties above -- escape, order, and a single innerHTML sink -- are the
  // actual safety argument. This one was decoration.
});
