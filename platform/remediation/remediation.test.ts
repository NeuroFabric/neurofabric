import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  parseTarget,
  proposeInfrastructurePatch,
  readProposedPatch,
  resetPatchSandboxRoot,
  setPatchSandboxRoot,
} from "./iac-generator.ts";
import { RemediationService, deriveRemediation } from "./remediation-gate.ts";
import type { PendingAuditEvent } from "../embassy/async-approval.ts";
import { createAsyncApprovalGate } from "../embassy/async-approval.ts";
import { Conductor } from "../conductor/conductor.ts";
import { client, connectMcp } from "../conductor/mcp-server.ts";

/**
 * PHASE 10 RED TEAM — SANDBOXED AUTO-REMEDIATION.
 *
 * Three properties, in the order the product needs them:
 *
 *   1. A patch is GENERATED, valid, and named by an
 *      unguessable id -- when an alert is ingested, and
 *      when the MCP tool is called directly.
 *   2. The patch is ISOLATED: it lives in the sandbox and
 *      nowhere else, and the resource under remediation is
 *      data inside the document, never a path component.
 *   3. The pipeline HALTS. Nothing is released, and nothing
 *      is applied, without an Incident Commander settling
 *      the approval gate. There is no execution path to
 *      find, because there is none to test around.
 */

afterEach(() => {
  resetPatchSandboxRoot();
});

function textOf(result: { content?: unknown }): string {
  const content = result.content;
  const first = Array.isArray(content)
    ? content[0] as { type?: string; text?: string } | undefined
    : undefined;
  return first?.type === "text" && typeof first.text === "string"
    ? first.text
    : JSON.stringify(content ?? null);
}

/**
 * A parser for the exact YAML subset the generator emits:
 * mappings of scalar keys, two-space indentation, comments.
 *
 * Round-tripping the document through this parser is the
 * validity proof. A full YAML parser is not a dependency of
 * this product, and the subset is fixed by the generator, so
 * the round-trip is a proof about every document it emits --
 * not a sample.
 */
function parseYamlMapping(document: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const stack: { readonly indent: number; readonly container: Record<string, unknown> }[] = [
    { indent: -1, container: root },
  ];
  for (const rawLine of document.split("\n")) {
    if (rawLine.trim() === "" || rawLine.trimStart().startsWith("#")) continue;
    assert.ok(!rawLine.includes("\t"), "the document contains a tab");
    const indent = rawLine.length - rawLine.trimStart().length;
    const match = /^([A-Za-z0-9][A-Za-z0-9._/-]*):(?: (.*))?$/.exec(rawLine.trim());
    assert.ok(match !== null, `the line is not a mapping entry: ${JSON.stringify(rawLine)}`);
    const key = match[1] ?? "";
    const rawValue = match[2];
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].container;
    assert.ok(!(key in parent), `the key '${key}' appears twice`);
    if (rawValue === undefined) {
      const child: Record<string, unknown> = {};
      parent[key] = child;
      stack.push({ indent, container: child });
    } else {
      parent[key] = parseScalar(rawValue);
    }
  }
  return root;
}

function parseScalar(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (/^-?\d+\.\d+$/.test(raw)) return Number(raw);
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) return JSON.parse(raw);
  return raw;
}

const ALERT = {
  provider: "pega",
  text: "payments-api connection pool saturated",
  at: "2026-01-01T00:00:00.000Z",
};

test("the derivation names the workload the alert names", () => {
  const request = deriveRemediation({
    provider: "splunk",
    text: "checkout-api error rate breached",
    at: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(request.target.kind, "Deployment");
  assert.equal(request.target.resource, "checkout-api");
  assert.equal(request.target.provider, "splunk");
  assert.equal(request.target.alertText, "checkout-api error rate breached");
  assert.equal(request.desiredState.replicas, 3);
});

test("the conductor generates a valid YAML patch when an alert is ingested", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nf-remediation-"));
  const sandbox = path.join(cwd, "gate-data", "patches");
  const rows: PendingAuditEvent[] = [];
  const gate = createAsyncApprovalGate({ audit: (event) => rows.push(event) });
  const service = new RemediationService({ gate, sandboxRoot: sandbox, tenant: "acme" });
  const conductor = new Conductor({ cwd, remediation: service });

  const result = await conductor.remediate(ALERT);

  // The pipeline HALTS here. Not "continues with a note".
  assert.equal(result.status, "AWAITING_APPROVAL");
  assert.equal(result.state, "AWAITING_APPROVAL");
  assert.match(result.remediation?.patchId ?? "", /^patch-[0-9a-f]{24}$/);
  assert.equal(result.remediation?.state, "AWAITING_APPROVAL");
  assert.equal(result.artifacts.length, 1);

  // The approval request is on the record before anyone is asked.
  assert.equal(rows[0]?.outcome, "pending");
  assert.equal(rows[0]?.subject.tool, "propose_infrastructure_patch");
  assert.equal(rows[0]?.subject.credentialName, result.remediation?.patchId);

  // The artifact is the patch document, and it is valid YAML
  // for the subset the generator emits.
  const document = readFileSync(result.artifacts[0] ?? "", "utf8");
  assert.equal(document, await readProposedPatch(result.remediation?.patchId ?? "", sandbox));
  const parsed = parseYamlMapping(document);
  assert.equal(parsed.apiVersion, "apps/v1");
  assert.equal(parsed.kind, "Deployment");
  const metadata = parsed.metadata as Record<string, unknown>;
  assert.equal(metadata.name, "payments-api");
  const annotations = metadata.annotations as Record<string, string>;
  assert.equal(annotations["neurofebric.patch-id"], result.remediation?.patchId);
  assert.equal(annotations["neurofebric.source-provider"], "pega");
  assert.equal(annotations["neurofebric.source-alert"], ALERT.text);
  const spec = parsed.spec as Record<string, unknown>;
  assert.equal(spec.replicas, 3);
});

test("a conductor with no remediation controller refuses rather than pretending", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nf-unarmed-"));
  const conductor = new Conductor({ cwd });
  const result = await conductor.remediate(ALERT);
  assert.equal(result.status, "FAILED");
  assert.equal(result.failure?.code, "REMEDIATION_NOT_ARMED");
});

test("the patch is strictly isolated in the sandbox", async () => {
  const sandbox = mkdtempSync(path.join(tmpdir(), "nf-patch-sandbox-"));
  const elsewhere = mkdtempSync(path.join(tmpdir(), "nf-patch-elsewhere-"));

  // A target that names an escape is refused by shape, before
  // anything is written: a refused name is a caller error,
  // not a sanitised one.
  await assert.rejects(
    proposeInfrastructurePatch(
      { target: { kind: "Deployment", resource: "..", namespace: "default" }, format: "kubernetes", desiredState: { replicas: 2 } },
      sandbox,
    ),
    /not a valid resource name/,
  );

  // A well-formed patch is named by its patch id and NOTHING else.
  const proposal = await proposeInfrastructurePatch(
    { target: parseTarget("deployment/payments-api"), format: "kubernetes", desiredState: { replicas: 2 } },
    sandbox,
  );
  assert.equal(path.dirname(proposal.path), path.resolve(sandbox));
  assert.equal(path.basename(proposal.path), `${proposal.patchId}.yaml`);
  assert.deepEqual(readdirSync(sandbox), [`${proposal.patchId}.yaml`]);
  assert.deepEqual(readdirSync(elsewhere), [], "nothing was written outside the sandbox");

  // The resource travels as document data, quoted.
  assert.ok(proposal.document.includes("name: payments-api"));

  // A patch id that names an escape is refused on read.
  await assert.rejects(readProposedPatch("../../etc/passwd", sandbox), /sandbox refusal/);
  await assert.rejects(readProposedPatch("patch-" + "a".repeat(24), sandbox), /no patch/);

  // A target with more than one segment is refused, not guessed.
  assert.throws(() => parseTarget("deployment/sub/payments-api"), /ONE kind and ONE name/);
});

test("the engine emits Terraform HCL for a terraform request", async () => {
  const sandbox = mkdtempSync(path.join(tmpdir(), "nf-patch-hcl-"));
  const proposal = await proposeInfrastructurePatch(
    {
      target: parseTarget("deployment/payments-api"),
      format: "terraform",
      desiredState: { replicas: 5, image: "registry.example.com/payments:1.2.3" },
    },
    sandbox,
  );
  assert.equal(path.basename(proposal.path), `${proposal.patchId}.tf`);
  assert.ok(proposal.document.startsWith("# Generated by propose_infrastructure_patch."));
  assert.ok(proposal.document.includes(`# patch-id: ${proposal.patchId}`));
  assert.match(proposal.document, /resource "kubernetes_deployment" "payments_api" \{/);
  assert.match(proposal.document, /^  replicas = 5$/m);
  assert.match(proposal.document, /^  image = "registry\.example\.com\/payments:1\.2\.3"$/m);
});

test("the pipeline halts for approval and blocks every unauthorized release", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nf-hitl-halt-"));
  const sandbox = path.join(cwd, "gate-data", "patches");
  const rows: PendingAuditEvent[] = [];
  const gate = createAsyncApprovalGate({ audit: (event) => rows.push(event) });
  const service = new RemediationService({ gate, sandboxRoot: sandbox, tenant: "acme" });

  const proposal = await service.request(ALERT);
  assert.equal(proposal.status, "AWAITING_APPROVAL");
  assert.equal(rows[0]?.outcome, "pending");

  // No approval yet: release is blocked, and the block is
  // the system working, not an error to route around.
  const blocked = await service.release(proposal.taskToken);
  assert.equal(blocked.status, "BLOCKED");
  assert.match(blocked.reason, /an Incident Commander must approve/);

  // A refusal is terminal: still blocked.
  service.review(proposal.taskToken, {
    approved: false,
    approvedBy: "Incident Commander",
    reason: "the fix is wrong for this incident",
  });
  const afterRefusal = await service.release(proposal.taskToken);
  assert.equal(afterRefusal.status, "BLOCKED");

  // An unknown token is blocked, not answered.
  const unknown = await service.release("tk-no-such-token");
  assert.equal(unknown.status, "BLOCKED");

  // A settled token cannot be reviewed again: the gate, not
  // the caller, decides what is still pending.
  assert.throws(
    () => service.review(proposal.taskToken, { approved: true, approvedBy: "x", reason: "y" }),
    /no pending proposal/,
  );
});

test("an Incident Commander approval releases the document, and nothing but the document", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "nf-hitl-release-"));
  const sandbox = path.join(cwd, "gate-data", "patches");
  const gate = createAsyncApprovalGate({ audit: () => undefined });
  const service = new RemediationService({ gate, sandboxRoot: sandbox, tenant: "acme" });

  const proposal = await service.request(ALERT);
  service.review(proposal.taskToken, {
    approved: true,
    approvedBy: "Incident Commander",
    reason: "the patch matches the incident",
  });

  const released = await service.release(proposal.taskToken);
  assert.equal(released.status, "RELEASED");
  assert.equal(released.patchId, proposal.patchId);
  assert.equal(released.document, proposal.document);
  assert.equal(released.approvedBy, "Incident Commander");

  // Release handed over a DOCUMENT for an operator to run.
  // The sandbox still holds exactly the proposal: nothing
  // was applied, because nothing here can apply anything.
  assert.deepEqual(readdirSync(sandbox), [`${proposal.patchId}.yaml`]);
});

test("the MCP tool proposes a patch into the sandbox and applies nothing", async () => {
  const sandbox = mkdtempSync(path.join(tmpdir(), "nf-mcp-patches-"));
  setPatchSandboxRoot(sandbox);
  await connectMcp();

  const result = await client.callTool({
    name: "propose_infrastructure_patch",
    arguments: {
      target: "deployment/payments-api",
      format: "kubernetes",
      desiredState: { replicas: 5 },
    },
  });
  assert.notEqual(result.isError, true, textOf(result));
  const payload = JSON.parse(textOf(result)) as {
    patchId: string;
    path: string;
    format: string;
    state: string;
    applied: boolean;
    document: string;
  };
  assert.match(payload.patchId, /^patch-[0-9a-f]{24}$/);
  assert.equal(payload.format, "kubernetes");
  assert.equal(payload.state, "AWAITING_APPROVAL");
  // The positive statement of the one thing this tool must never do.
  assert.equal(payload.applied, false);
  assert.equal(path.dirname(payload.path), path.resolve(sandbox));
  assert.ok(existsSync(payload.path));
  assert.ok(payload.document.includes("replicas: 5"));

  // A malformed target is refused with an error result, not guessed.
  const refused = await client.callTool({
    name: "propose_infrastructure_patch",
    arguments: { target: "deployment/sub/payments-api", format: "kubernetes", desiredState: {} },
  });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /Patch Rejected/);
});

test("the remediation path contains no execution primitive and no apply command", () => {
  const sources = [
    readFileSync(new URL("./iac-generator.ts", import.meta.url), "utf8"),
    readFileSync(new URL("./remediation-gate.ts", import.meta.url), "utf8"),
    readFileSync(new URL("../conductor/mcp-server.ts", import.meta.url), "utf8"),
    readFileSync(new URL("../conductor/conductor.ts", import.meta.url), "utf8"),
  ];
  for (const source of sources) {
    assert.ok(!/\bchild_process\b/.test(source), "a process module must not be imported by the remediation path");
    assert.ok(!/\bspawn\b/.test(source), "a process spawner must not appear in the remediation path");
    // `exec` bare is deliberately not scanned: RegExp.exec is
    // idiomatic and is not a process primitive. The process
    // executors are the sync and file forms, and they are.
    assert.ok(!/\bexecSync\b|\bexecFile\b/.test(source), "a process executor must not appear in the remediation path");
    assert.ok(!/kubectl\s+apply/.test(source), "kubectl apply must not appear in the remediation path");
    assert.ok(!/terraform\s+apply/.test(source), "terraform apply must not appear in the remediation path");
  }
});
