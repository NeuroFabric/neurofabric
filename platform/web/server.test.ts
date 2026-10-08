import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { mkdir, readFile, readdir } from "node:fs/promises";

import { startWedgeServer, type RunningWedge } from "./server.ts";
import { incidentCommanderHeaders } from "./auth-middleware.ts";
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
 * That is why these tests assert on `SOFT_REFUSAL_CONTINUED` /
 * `POLICY_VIOLATION` events and on `kernelReasonCode`. A hand-rolled check in
 * the server that returned 403 would pass a test written against a status
 * code, and would prove nothing about the boundary. If the kernel stops
 * refusing, these fail.
 *
 * ON THE EVENT NAMES. These are the kernel's own, and they were wrong here
 * before they were asserted. `POLICY_DENIED` is a RECOVERY CATEGORY and a
 * failure code, not an event type: a soft refusal is recorded as
 * `SOFT_REFUSAL_CONTINUED` after recovery, and a hazard as `POLICY_VIOLATION`.
 * The earlier assertion named an event the kernel can never emit, so it was
 * not a weak test, it was an unsatisfiable one -- red for a reason that had
 * nothing to do with the boundary it claimed to cover.
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

async function seedApprovalLedger(cwd: string): Promise<void> {
  const workspace = path.join(cwd, "workspace");
  await mkdir(workspace, { recursive: true });
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(path.join(workspace, "gate.db"));
  db.exec(`
    CREATE TABLE approval_tasks (
      task_token TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'refused', 'expired', 'consumed')),
      subject_json TEXT NOT NULL,
      result_json TEXT,
      decided_at INTEGER,
      approved_by TEXT,
      reason TEXT,
      result_expires_at INTEGER,
      collected_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )
  `);
  const insert = db.prepare(`
    INSERT INTO approval_tasks
      (task_token, status, subject_json, decided_at, approved_by, reason,
       result_expires_at, collected_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run("pending-token", "pending", JSON.stringify({ action: "read" }), null, null, null, null, null, 100);
  insert.run("consumed-token", "consumed", JSON.stringify({ action: "write" }), "2024-01-02T03:04:05.000Z", "operator", null, 1_704_200_000, 1_704_100_000, 200);
  insert.run("expired-token", "expired", JSON.stringify({ action: "execute" }), 1_704_000_000, null, "expired", 1_704_003_600, null, 300);
  db.close();
}

const asFailure = (body: Record<string, unknown>) => body.failure as { code?: string; reason?: string; kernelReasonCode?: string } | undefined;
const eventTypes = (body: Record<string, unknown>) =>
  (body.kernelEvents as { type: string }[] | undefined)?.map((e) => e.type) ?? [];

// === API integration: real SQLite, multipart bytes, and Conductor dispatch ===

test("GET /api/v1/governance/ledger returns ordered SQLite rows as a JSON array", async () => {
  const { cwd, server } = await harness();
  await seedApprovalLedger(cwd);

  const response = await fetch(`${server.url}/api/v1/governance/ledger`);
  const ledger = await response.json() as {
    token: string;
    status: string;
    subject: unknown;
    decidedAt: string | null;
    createdAt: string | null;
  }[];

  assert.equal(response.status, 200);
  assert.ok(Array.isArray(ledger), "the endpoint returns an array, not a wrapper object");
  assert.deepEqual(ledger.map((row) => row.token), ["expired-token", "consumed-token", "pending-token"]);
  assert.deepEqual(ledger.map((row) => row.status), ["expired", "consumed", "pending"]);
  assert.deepEqual(ledger[0]?.subject, { action: "execute" });
  assert.equal(ledger[0]?.decidedAt, new Date(1_704_000_000 * 1000).toISOString());
  assert.equal(ledger[1]?.decidedAt, "2024-01-02T03:04:05.000Z", "legacy ISO timestamps remain readable");
  assert.equal(ledger[2]?.decidedAt, null);
  assert.equal(ledger[0]?.createdAt, new Date(300 * 1000).toISOString());

  // The verdict writer uses the same epoch-second storage convention and the
  // ledger projects it back to ISO without throwing on the row it just changed.
  const verdictResponse = await fetch(`${server.url}/api/v1/governance/verdict`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task_token: "pending-token", status: "approved" }),
  });
  const verdict = await verdictResponse.json() as { decided_at?: string };
  assert.equal(verdictResponse.status, 200);
  assert.ok(verdict.decided_at);

  const refreshedResponse = await fetch(`${server.url}/api/v1/governance/ledger`);
  const refreshed = await refreshedResponse.json() as typeof ledger;
  const updated = refreshed.find((row) => row.token === "pending-token");
  assert.equal(updated?.status, "approved");
  assert.equal(updated?.decidedAt, verdict.decided_at);
  await server.close();
});

test("POST /api/v1/workspace/ingest stores multipart file bytes and returns their SHA-256", async () => {
  const { cwd, server } = await harness();
  const contents = "event_id,value\n1,alpha\n2,beta\n";
  const form = new FormData();
  form.append("file", new Blob([contents], { type: "text/csv" }), "ingested-data.csv");

  const response = await fetch(`${server.url}/api/v1/workspace/ingest`, {
    method: "POST",
    body: form,
  });
  const result = await response.json() as { path: string; name: string; size: number; sha256: string };

  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.path, "workspace/ingested-data.csv");
  assert.equal(result.name, "ingested-data.csv");
  assert.equal(result.size, Buffer.byteLength(contents));
  assert.equal(result.sha256, createHash("sha256").update(contents).digest("hex"));
  assert.equal(await readFile(path.join(cwd, "workspace", "ingested-data.csv"), "utf8"), contents,
    "the exact uploaded file bytes are written under the sandbox");
  await server.close();
});

test("POST /api/v1/agent/task runs the Conductor omni workflow", async () => {
  const { cwd, server } = await harness();
  await writeFixture(
    cwd,
    "sales.csv",
    "customer,revenue,status\nA,10,signed\nB,25,trial\nC,40,signed\nD,5,trial\nE,55,signed\n",
  );

  const response = await fetch(`${server.url}/api/v1/agent/task`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspacePath: "sales.csv", prompt: "stage4 omni pilot package" }),
  });
  const result = await response.json() as Record<string, unknown>;

  assert.equal(response.status, 200, JSON.stringify(result).slice(0, 500));
  assert.equal(result.status, "DELIVERED");
  assert.ok(eventTypes(result).includes("TASK_CREATED"), "the run traversed the Conductor kernel");
  assert.ok(await pathExists(path.join(cwd, "workspace", "task-output")), "the omni output directory was produced");
  await server.close();
});

// === 1. The page =========================================================

test("GET / serves one self-contained page with a dropzone and no outside script", async () => {
  const { server } = await harness();
  const response = await fetch(`${server.url}/`, { headers: incidentCommanderHeaders() });
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
  assert.ok(eventTypes(body).includes("SOFT_REFUSAL_CONTINUED"), `saw ${eventTypes(body).join(", ")}`);
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

test("a destructive string in a FILENAME is governed, not executed, and not a hazard", async () => {
  const { server, post } = await harness();
  const { status, body } = await post({ path: "rm -rf.csv" });

  assert.notEqual(status, 200);
  // WHAT THIS FILE IS NOT, and why. An earlier version of this test asserted
  // HARD_DENY for this filename and it was red for a reason that had nothing to
  // do with the wedge.
  //
  // The destructive rules match COMMAND text, and `extractCommandText`
  // deliberately excludes file content, because quoting a dangerous command in
  // a document is not running it. A FILENAME is not a command, so
  // "rm -rf.csv" is an ordinary, in-workspace name: the governed read is
  // attempted and the filesystem answers ENOENT. That is the frozen policy's
  // deliberate position, not a gap in the server.
  //
  // So the property pinned here is the one that is actually true and actually
  // matters: the attempt is GOVERNED and VISIBLE, and nothing is executed or
  // created on the way to failing.
  assert.ok(eventTypes(body).includes("TASK_CREATED"), "the kernel saw the request at all");
  assert.ok(eventTypes(body).includes("TOOL_EXECUTION_STARTED"), "and the read was a governed call");
  assert.equal(body.status, "FAILED");
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

// === 6. The bad-request contract =========================================

/**
 * THE UI HAS NOWHERE TO ASK A QUESTION.
 *
 * The CLI answers a clarification by typing at it. A browser cannot: there is
 * one dropzone and one request, so a run that needs to ask cannot ask. That is
 * not an error path, it is the ordinary path for anything the conductor cannot
 * resolve on its own, and it has one correct shape:
 *
 *   a 400, and the question, in the body, verbatim.
 *
 * 400 rather than 403, because the distinction is who has to act. A 400 means
 * the caller has something to supply and the request may succeed once they do.
 * A 403 means the kernel will not permit it however it is answered. A refusal
 * dressed as a question would send the owner looking for a file that is not
 * the problem, and a question dressed as a refusal would hide a boundary.
 *
 * These were previously only covered by accident, by a test that happened to
 * trip the same path on its way to asserting something else. That is coverage
 * of a neighbour, not of this contract, so it is pinned directly here.
 */

test("an unanswerable request is a 400 carrying the exact clarification prompt", async () => {
  const { server, post } = await harness();
  // A name the filesystem cannot hold, so no input can be located and the
  // conductor has nothing to work with. This is the browser's real situation:
  // there is no second turn in which to supply an answer.
  const { status, body } = await post({ path: "a<b>.csv" });

  assert.equal(status, 400, `an unanswerable run is a bad request: ${JSON.stringify(body).slice(0, 200)}`);
  assert.equal(body.status, "CLARIFY_EXHAUSTED");
  assert.equal(asFailure(body)?.code, "CLARIFY_EXHAUSTED");

  const questions = body.questions as { code: string; question: string }[] | undefined;
  assert.ok(Array.isArray(questions) && questions.length > 0,
    "the body carries the question, because there is no other channel to ask on");
  assert.equal(questions[0].code, "MISSING_INPUT_FILE");
  assert.equal(questions[0].question, "Which CSV file should I read?",
    "the prompt travels verbatim, so the UI shows what the conductor actually asked");

  // It asked and stopped. It did not retry forever and it did not fall over:
  // the server is still serving after a run that could not proceed.
  const after = await fetch(`${server.url}/`, { headers: incidentCommanderHeaders() });
  assert.equal(after.status, 200, "the server survived a run it could not complete");
  await after.text();
  await server.close();
});

test("a malformed CSV is a 400 that names the problem, not a crash", async () => {
  const { cwd, server, post } = await harness();
  // Ragged: the header declares three columns and the row supplies five.
  await writeFixture(cwd, "ragged.csv", `_time,source_host,alert_code
2026-09-30 12:00:00.000,host-web,PEGA0001,extra,more`);
  const { status, body } = await post({ path: "ragged.csv" });

  assert.equal(status, 400, `a file the reader calls malformed is a bad request: ${JSON.stringify(body).slice(0, 200)}`);
  assert.equal(body.status, "CLARIFY_EXHAUSTED");
  const questions = body.questions as { code: string; question: string }[] | undefined;
  assert.equal(questions?.[0]?.code, "AMBIGUOUS_CSV");
  assert.match(questions?.[0]?.question ?? "", /malformed/i,
    "the prompt says what is wrong with the file, not merely that something is");
  await server.close();
});

test("ambiguity is a 400 and a policy refusal is a 403, and they stay distinct", async () => {
  const { server, post } = await harness();
  // Same endpoint, two different reasons for saying no. If these ever collapse
  // into one status, the UI can no longer tell "tell me more" from "you may
  // not", which is the whole reason the distinction exists.
  const ambiguous = await post({ path: "a<b>.csv" });
  const refused = await post({ path: "../../secrets.csv" });

  assert.equal(ambiguous.status, 400, "the caller has something to supply");
  assert.equal(refused.status, 403, "the kernel will not permit it however it is answered");
  assert.equal(refused.body.status, "FAILED");
  assert.equal(asFailure(refused.body)?.kernelReasonCode, "SOFT_REFUSE",
    "and the refusal still carries the kernel's own tier");
  assert.equal(ambiguous.body.failure === undefined || asFailure(ambiguous.body)?.kernelReasonCode === undefined, true,
    "an ambiguity is not dressed up as a refusal");
  await server.close();
});
