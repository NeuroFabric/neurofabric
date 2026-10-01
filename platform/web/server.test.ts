import test, { after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readdir } from "node:fs/promises";

import { startWedgeServer, type RunningWedge } from "./server.ts";
import { makeTempWorkspace, writeFixture, pathExists } from "../test-support/temp-workspace.ts";

/**
 * TASK 2 — THE WEDGE'S SECURITY BOUNDARY. Red first.
 *
 * A browser is a much easier thing to aim at a kernel than a command line is,
 * because the person clicking has no idea a kernel is there. So the property
 * under test is not "the server validates paths" -- it is that the server has no
 * validation of its own to get wrong, and every refusal is the KERNEL'S refusal,
 * carried out with the kernel's own tier.
 *
 * That is why these tests assert on `POLICY_DENIED` / `POLICY_VIOLATION` events
 * and on `kernelReasonCode`. A hand-rolled check in the server that returned 403
 * would pass a test written against a status code, and would prove nothing about
 * the boundary. If the kernel stops refusing, these fail.
 */

const CSV = `_time,source_host,alertType,alert_code,elapsed_time,threshold
2026-09-30 12:00:00.000,host-web,performance,PEGA0001,1200,1000
2026-09-30 12:01:00.000,host-bg,performance,PEGA0028,800,1000
2026-09-30 12:02:00.000,host-web,performance,PEGA0001,2500,1000`;

/**
 * TEARDOWN, WHICH A FAILING ASSERTION CANNOT SKIP.
 *
 * These tests each opened a listening server and closed it as the LAST LINE of
 * the test body. That is not teardown, it is a courtesy call: the moment an
 * assertion throws, control never reaches the close, and the server stays
 * listening. Five red tests left five listening sockets, the event loop never
 * emptied, and the runner sat there for 37 minutes with every result already
 * printed. The hang was the failure mode of the harness, so the harness is what
 * changed.
 *
 * So ownership is tracked here and closed in one place, where a throw cannot
 * reach past it. The per-test `close()` calls stay as the ordinary path; this is
 * the backstop that runs when one was skipped.
 */
const openServers = new Set<{ close: () => Promise<void> }>();

/** A close that is safe to call twice and forgets itself once used. */
function trackClose(close: () => Promise<void>): { close: () => Promise<void> } {
  let closed = false;
  const handle = {
    close: async () => {
      if (closed) return;
      closed = true;
      openServers.delete(handle);
      await close();
    },
  };
  openServers.add(handle);
  return handle;
}

after(async () => {
  await Promise.allSettled([...openServers].map((server) => server.close()));
});

async function harness() {
  const cwd = await makeTempWorkspace("nf-wedge-");
  await writeFixture(cwd, "pega.csv", CSV);
  const started = await startWedgeServer({ cwd, port: 0 });
  const server: RunningWedge = { ...started, ...trackClose(started.close) };
  const post = async (body: unknown) => {
    const response = await fetch(`${server.url}/api/report`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  return { cwd, server, post };
}

const asFailure = (body: Record<string, unknown>) => body.failure as { code?: string; reason?: string; kernelReasonCode?: string } | undefined;
const eventTypes = (body: Record<string, unknown>) =>
  (body.kernelEvents as { type: string }[] | undefined)?.map((e) => e.type) ?? [];

// === 1. The page =========================================================

test("GET / serves one self-contained page with a dropzone and no outside script", async () => {
  const { server } = await harness();
  const response = await fetch(`${server.url}/`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /<input[^>]*type="file"/, "there is a file input to drop onto");
  assert.match(html, /drop/i, "and the drop is handled");
  // Self-contained: no CDN, no remote origin. A report about someone else's
  // infrastructure should not phone a third party to be displayed.
  assert.ok(!/<script[^>]+src=/.test(html), "no external script");
  assert.ok(!/https?:\/\//.test(html.replace(/<html[^>]*>/, "")), "no absolute URL is embedded in the page");
  await server.close();
});

// === 2. The control: the governed loop actually delivers ===================

test("a CSV inside the workspace returns a Markdown report produced through the kernel", async () => {
  const { cwd, server, post } = await harness();
  const { status, body } = await post({ path: "pega.csv" });

  assert.equal(status, 200, `body=${JSON.stringify(body)}`);
  assert.equal(body.status, "DELIVERED");
  const markdown = String(body.markdown ?? "");
  assert.match(markdown, /^# /m, "it is a Markdown report");
  assert.match(markdown, /PEGA0001/, "and it names the leading category");
  // The proof that this went through the kernel rather than around it.
  const types = eventTypes(body);
  for (const required of ["TASK_CREATED", "TOOL_EXECUTION_STARTED", "TOOL_COMPLETED", "TASK_COMPLETED"]) {
    assert.ok(types.includes(required), `the kernel never emitted ${required}; saw ${types.join(", ")}`);
  }
  assert.equal(await pathExists(path.join(cwd, "workspace", "bottleneck-report.md")), true,
    "the report artifact was written where the run said it would be");
  await server.close();
});

// === 3. Paths outside the workspace =======================================

test("a relative escape is refused by the kernel, as a SOFT_REFUSE", async () => {
  const { server, post } = await harness();
  const { status, body } = await post({ path: "../../secrets.csv" });

  assert.notEqual(status, 200, "an out-of-workspace path must not produce a report");
  assert.equal(asFailure(body)?.kernelReasonCode, "SOFT_REFUSE",
    `expected the kernel's own tier, got ${JSON.stringify(asFailure(body))}`);
  assert.match(asFailure(body)?.reason ?? "", /boundary/i, "and the kernel's own reason travels");
  assert.ok(eventTypes(body).includes("POLICY_DENIED"), `saw ${eventTypes(body).join(", ")}`);
  await server.close();
});

test("an absolute path outside the workspace is refused the same way", async () => {
  const { server, post } = await harness();
  const outside = path.join(path.sep === "\\" ? "C:\\Windows" : "/etc", "system.csv");
  const { status, body } = await post({ path: outside });

  assert.notEqual(status, 200);
  assert.equal(asFailure(body)?.kernelReasonCode, "SOFT_REFUSE",
    `an absolute path must meet the same boundary, got ${JSON.stringify(asFailure(body))}`);
  await server.close();
});

test("an escape hidden behind an in-workspace prefix is still refused", async () => {
  const { server, post } = await harness();
  // The shape that fools naive prefix checks: it starts with the workspace.
  const { status, body } = await post({ path: "sub/../../escape.csv" });
  assert.notEqual(status, 200);
  assert.equal(asFailure(body)?.kernelReasonCode, "SOFT_REFUSE",
    `got ${JSON.stringify(asFailure(body))}`);
  await server.close();
});

// === 4. Malicious payloads ===============================================

test("a destructive payload in the path is refused by the kernel as a HARD_DENY", async () => {
  const { server, post } = await harness();
  const { status, body } = await post({ path: "rm -rf.csv" });

  assert.notEqual(status, 200);
  assert.equal(asFailure(body)?.kernelReasonCode, "HARD_DENY",
    `a destructive string is a hazard, not a boundary question: ${JSON.stringify(asFailure(body))}`);
  assert.ok(eventTypes(body).includes("POLICY_VIOLATION"), `saw ${eventTypes(body).join(", ")}`);
  await server.close();
});

test("a credential file is refused by the kernel as a HARD_DENY", async () => {
  const { server, post } = await harness();
  const { status, body } = await post({ path: ".env.csv" });
  assert.notEqual(status, 200);
  assert.equal(asFailure(body)?.kernelReasonCode, "HARD_DENY",
    `got ${JSON.stringify(asFailure(body))}`);
  await server.close();
});

test("a script tag in the filename is never reflected into the response", async () => {
  const { server, post } = await harness();
  const { body } = await post({ path: "<script>alert(1)</script>.csv" });
  const serialised = JSON.stringify(body);
  assert.ok(!serialised.includes("<script>alert(1)</script>"),
    `the raw filename was reflected: ${serialised.slice(0, 300)}`);
  assert.ok(!serialised.includes("<script>"), "no raw script tag in any field");
  await server.close();
});

// === 5. The server writes nothing of its own ==============================

test("a refused request creates no file anywhere in the workspace", async () => {
  const { cwd, server, post } = await harness();
  const before = await readdir(cwd);
  await post({ path: "../../escape.csv" });
  await post({ path: "rm -rf.csv" });
  const after = await readdir(cwd);
  assert.deepEqual(after.sort(), before.sort(),
    "a refusal must not leave a partial artifact behind");
  await server.close();
});

test("a body that is not JSON is refused without touching the conductor", async () => {
  const { server } = await harness();
  const response = await fetch(`${server.url}/api/report`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{ not json",
  });
  assert.equal(response.status, 400);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.status, "FAILED");
  assert.ok(asFailure(body)?.reason, "and it says why");
  await server.close();
});

test("the server binds to loopback only", async () => {
  const { server } = await harness();
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/,
    "a local tool that listens on every interface is a remote shell with extra steps");
  await server.close();
});
