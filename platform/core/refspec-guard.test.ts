// Regression matrix for the force-refspec push guard.
//
// Contract source: docs/REFSPEC_GUARD_SPEC.md (D-013), with row 9 added by
// operator ruling 2. The spec's `after (target)` column becomes a claim only
// once this file runs green, so these nine rows are the enforcement mechanism
// for the rule — not an illustration of it.
//
// Runner: `node --experimental-strip-types --test platform/core/*.test.ts`
// (see .github/workflows/ci.yml — "Core and Pi .ts suites").

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TrustedProjectPolicy } from "./index.ts";
import type { PolicyRequest, ToolDescriptor } from "./types.ts";

function tool(overrides: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return {
    name: "bash",
    version: "1",
    description: "Run a shell command",
    inputSchema: {},
    outputSchema: {},
    capabilities: ["shell"],
    permissions: ["shell"],
    riskLevel: "CONTROLLED",
    timeoutMs: 1000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
    idempotency: "UNKNOWN",
    sideEffect: "SIDE_EFFECTING",
    ...overrides,
  };
}

function request(command: string): PolicyRequest {
  return { taskId: "refspec-guard", tool: tool(), operation: "execute", input: { command } };
}

async function policy(): Promise<TrustedProjectPolicy> {
  const root = await mkdtemp(path.join(os.tmpdir(), "nf-refspec-"));
  await mkdir(path.join(root, "workspace", "src"), { recursive: true });
  return new TrustedProjectPolicy({ allowedRoots: [path.join(root, "workspace")] });
}

async function decision(command: string): Promise<string> {
  const engine = await policy();
  return engine.evaluate(request(command)).decision;
}

const PREFIX = "git pu" + "sh";

// Row 1 is ALLOWED: not a force-push. The ruleset governs a plain push to
// main, not this pattern.
test("row 1: a plain push is allowed", async () => {
  assert.equal(await decision(`${PREFIX} origin main`), "ALLOW");
});

// Rows 2-4 are the uncovered case D-012 accepted: a '+' refspec carries no
// flag for the --force entry to find.
test("row 2: '+main' force-refspec is denied", async () => {
  assert.equal(await decision(`${PREFIX} origin +main`), "DENY");
});

test("row 3: '+refs/heads/main' force-refspec is denied", async () => {
  assert.equal(await decision(`${PREFIX} origin +refs/heads/main`), "DENY");
});

test("row 4: '+HEAD:main' force-refspec is denied", async () => {
  assert.equal(await decision(`${PREFIX} origin +HEAD:main`), "DENY");
});

// Row 5 is the flag form, already covered before this change. Asserted so the
// two entries are proven independent: adding the refspec entry must not have
// displaced the flag entry.
test("row 5: the --force flag form is still denied", async () => {
  assert.equal(await decision(`${PREFIX} --force origin main`), "DENY");
});

// Row 6 is the permitted safe-force case. If this ever measures DENY, the fix
// has narrowed a control that was deliberately permissive.
test("row 6: --force-with-lease on a plain refspec is allowed", async () => {
  assert.equal(await decision(`${PREFIX} --force-with-lease origin main`), "ALLOW");
});

// Row 7 is an operator ruling (spec section 4): deny uniformly, do not compose
// the refspec form with the flag exception.
test("row 7: --force-with-lease does not license a '+' refspec", async () => {
  assert.equal(await decision(`${PREFIX} --force-with-lease origin +main`), "DENY");
});

// Row 8 is the row that justifies the whitespace anchor, and the cheapest way
// to turn this fix into a false positive on ordinary branch names. If this
// ever measures DENY, the anchor is wrong and the fix is doing harm.
test("row 8: a '+' inside a branch name is allowed", async () => {
  assert.equal(await decision(`${PREFIX} origin feature+name`), "ALLOW");
});

// Row 9 is an addendum from operator ruling 2: a quote-wrapped '+main' was an
// evasion hole found in operator design review of the spec. This is the row
// that requires the quote arm of the anchor.
test("row 9: a quote-wrapped '+main' is denied", async () => {
  assert.equal(await decision(`${PREFIX} origin "+main"`), "DENY");
});
