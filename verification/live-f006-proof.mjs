// Live proof for F-006 structured recovery diagnostics.
// Drives the real KernelAdapter recovery path and the real recovery decision
// function. No model, no gateway, no network: everything below is the
// production code path that a tool failure travels in production.
import { pathToFileURL } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";

const ROOT = path.resolve(import.meta.dirname, "..");
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const { KernelAdapter } = await imp("platform/pi/kernel-adapter.ts");
const { toolDescriptorFromPi } = await imp("platform/pi/tool-adapter.ts");
const { chooseRecovery, chooseRecoveryDetailed, classifyFailure } = await imp("platform/core/recovery.ts");
const { CoreError } = await imp("platform/core/errors.ts");

const LIMITS = { maxToolRetries: 2, maxReplans: 2, maxRecoveryDepth: 3, maxExecutionTimeMs: 1000 };

let checks = 0;
const failures = [];
function check(label, fn) {
  checks += 1;
  try {
    fn();
    console.log("   ok   " + label);
  } catch (err) {
    failures.push(label + " :: " + err.message);
    console.log("   FAIL " + label + " :: " + err.message);
  }
}

const mk = async () => {
  const k = new KernelAdapter();
  k.registerTools([toolDescriptorFromPi({ name: "edit", description: "edit a file" })]);
  k.registerTools([toolDescriptorFromPi({ name: "read", description: "read a file" })]);
  await k.beginTask("live F-006 proof");
  return k;
};
const events = (k, type) => k.recentEvents(500).filter((e) => e.type === type);
const last = (k, type) => events(k, type).at(-1)?.payload;
const failOnce = async (k, i) => {
  const bound = await k.beginToolExecution("call-" + i, "edit");
  assert.ok(bound, "execution " + i + " must be admitted before it can fail");
  await k.recordToolResult("call-" + i, "edit", undefined, true);
};

// --- 1. a real structured tool failure reaches recovery as TOOL_FAILURE ---
console.log("1. structured tool failure reaches recovery (not UNKNOWN):");
const k1 = await mk();
await failOnce(k1, 1);
const p1 = last(k1, "RECOVERY_STARTED");
console.log("   RECOVERY_STARTED payload: " + JSON.stringify(p1));
check("failure category is TOOL_FAILURE, not UNKNOWN", () => {
  assert.equal(p1.failure, "TOOL_FAILURE");
  assert.notEqual(p1.failure, "UNKNOWN");
});
check("the event carries a structured reason", () => {
  assert.equal(typeof p1.reason, "string");
  assert.ok(p1.reason.length > 0, "reason must be a non-empty code");
});
check("the event carries the budgets as they stood at the decision", () => {
  assert.equal(p1.retryCount, 0, "a deterministic failure spends no retry budget");
  assert.equal(p1.replanCount, 0);
  assert.equal(p1.recoveryDepth, 1, "this is the first recovery round");
});
check("the retryable flag of the CoreError is honoured by classification", () => {
  // The adapter raises CoreError(TOOL_ERROR, retryable:false). The flag is
  // consumed by classifyFailure, which is what the event records.
  assert.equal(classifyFailure(new CoreError("TOOL_ERROR", "t", { retryable: false })), "TOOL_FAILURE");
  assert.equal(classifyFailure(new CoreError("TOOL_ERROR", "t", { retryable: true })), "TRANSIENT");
  assert.equal(classifyFailure(new Error("plain")), "UNKNOWN", "a plain Error is still UNKNOWN");
});

// --- 2. deterministic non-retryable failures never select RETRY -----------
console.log("");
console.log("2. deterministic non-retryable failures never select RETRY:");
for (const failure of ["PERMISSION", "INVALID_INPUT", "TOOL_FAILURE", "VALIDATION_FAILURE", "DEPENDENCY_FAILURE"]) {
  check(failure + " never selects RETRY across depths, replans and idempotency", () => {
    for (let depth = 0; depth <= 3; depth += 1) {
      for (let replanCount = 0; replanCount <= 2; replanCount += 1) {
        for (let retryCount = 0; retryCount <= 2; retryCount += 1) {
          for (const idempotency of ["IDEMPOTENT", "NON_IDEMPOTENT"]) {
            const d = chooseRecoveryDetailed({ failure, limits: LIMITS, retryCount, replanCount, depth, idempotency });
            assert.notEqual(d.strategy, "RETRY", failure + " must not be retried");
          }
        }
      }
    }
  });
}
check("PERMISSION and INVALID_INPUT fail closed with ESCALATE", () => {
  for (const failure of ["PERMISSION", "INVALID_INPUT"]) {
    for (const idempotency of ["IDEMPOTENT", "NON_IDEMPOTENT"]) {
      const d = chooseRecoveryDetailed({ failure, limits: LIMITS, retryCount: 0, replanCount: 0, depth: 0, idempotency });
      assert.equal(d.strategy, "ESCALATE", failure + " must escalate");
      assert.equal(d.reason, failure === "PERMISSION" ? "PERMISSION_FAILURE_ESCALATED" : "INVALID_INPUT_ESCALATED");
    }
  }
});

// --- 3. preserved semantics: a transient retryable failure retries ---------
console.log("");
console.log("3. transient retryable failures still select RETRY under budget:");
check("TRANSIENT under the retry budget selects RETRY / TRANSIENT_RETRY", () => {
  const d = chooseRecoveryDetailed({ failure: "TRANSIENT", limits: LIMITS, retryCount: 0, replanCount: 0, depth: 0, idempotency: "IDEMPOTENT" });
  assert.equal(d.strategy, "RETRY");
  assert.equal(d.reason, "TRANSIENT_RETRY");
});
check("chooseRecovery keeps its signature and returns RETRY", () => {
  assert.equal(chooseRecovery({ failure: "TRANSIENT", limits: LIMITS, retryCount: 0, replanCount: 0, depth: 0, idempotency: "IDEMPOTENT" }), "RETRY");
});
check("retry budget spent falls through to REPLAN, then TERMINATE", () => {
  assert.equal(chooseRecovery({ failure: "TRANSIENT", limits: LIMITS, retryCount: 2, replanCount: 0, depth: 0, idempotency: "IDEMPOTENT" }), "REPLAN");
  assert.equal(chooseRecovery({ failure: "TRANSIENT", limits: LIMITS, retryCount: 2, replanCount: 2, depth: 0, idempotency: "IDEMPOTENT" }), "TERMINATE");
});
check("non-idempotent transient failures still ESCALATE, never RETRY", () => {
  assert.equal(chooseRecovery({ failure: "TRANSIENT", limits: LIMITS, retryCount: 0, replanCount: 0, depth: 0, idempotency: "NON_IDEMPOTENT" }), "ESCALATE");
});

// --- 4. driven to exhaustion: a specific terminal reason, then refusal ----
console.log("");
console.log("4. driven to exhaustion: specific terminal reason, FAILED, then refused:");
const k4 = await mk();
for (let i = 1; i <= 3; i += 1) await failOnce(k4, i);
const task4 = k4.currentTask;
const reason4 = task4.failureReason;
console.log("   status=" + task4.status);
console.log("   failureReason=" + reason4);
console.log("   TASK_FAILED payload=" + JSON.stringify(last(k4, "TASK_FAILED")));
check("the task is FAILED", () => assert.equal(task4.status, "FAILED"));
check("the terminal reason is specific, not the old generic sentence", () => {
  assert.match(reason4, /REPLAN_BUDGET_EXHAUSTED/);
  assert.match(reason4, /failure=TOOL_FAILURE/);
  assert.match(reason4, /replanCount=2\/2/);
  assert.match(reason4, /retryCount=0\/2/);
  assert.match(reason4, /recoveryDepth=3\/3/);
  assert.doesNotMatch(reason4, /no safe recovery strategy remains/);
});
check("TASK_FAILED carries the structured reasonCode and budgets", () => {
  const p = last(k4, "TASK_FAILED");
  assert.equal(p.reasonCode, "REPLAN_BUDGET_EXHAUSTED");
  assert.equal(p.failure, "TOOL_FAILURE");
  assert.equal(p.strategy, "TERMINATE");
  assert.equal(p.replanCount, 2);
  assert.equal(p.retryCount, 0);
  assert.equal(p.recoveryDepth, 3);
});
check("the spent replan budget is visible on the task", () => {
  assert.equal(task4.replanCount, 2);
  assert.equal(task4.retryCount, 0, "a deterministic failure never consumed the retry budget");
});
const after = await k4.precheckToolCall("read", "execute", { path: "README.md" }, undefined, "after-fail");
console.log("   post-terminal precheck: decision=" + after.decision.decision
  + " refusal=" + after.decision.refusal + " violation=" + (after.decision.violation ?? "<none>"));
check("a later execution attempt is refused with task_terminal, not a violation", () => {
  assert.equal(after.decision.decision, "DENY");
  assert.equal(after.decision.refusal, "task_terminal");
  assert.equal(after.decision.violation, undefined, "a lifecycle refusal is never a policy violation");
});
const bound = await k4.beginToolExecution("after-fail", "read");
check("beginToolExecution returns undefined on a FAILED task", () => {
  assert.equal(bound, undefined, "a FAILED task must admit no further execution");
});
check("diagnostics count the terminal refusal, not a denial", () => {
  assert.equal(k4.diagnostics.terminalRefusalCount, 1);
  assert.equal(k4.diagnostics.denialCount, 0);
});

console.log("");
console.log("transitions: " + k4.transitions.map((t) => t.from + "->" + t.to).join("  "));
console.log("");
console.log(checks + " checks, " + failures.length + " failed");
if (failures.length > 0) {
  for (const f of failures) console.log("  FAILED: " + f);
  process.exit(1);
}
process.exit(0);
