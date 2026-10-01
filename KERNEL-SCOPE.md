# Kernel Scope — Freeze Declaration (2026-10-01)

The Neurofebric kernel is FEATURE-FROZEN as of this date, with one exception: D4B-class correctness fixes (recovery classification, metadata propagation).

## Genuinely enforced controls (the real list)

- maxToolRetries = 2
- maxReplans = 2
- maxRecoveryDepth = 3
- maxExecutionTimeMs
- maxArtifactBytes
- Tool-call budget: hard denial at 40 calls; 75% / 90% warnings are ADVISORY telemetry only (per-task warning suppression/reset).
- Policy evaluation: fail-closed; POLICY_DENIED = non-retryable, non-replan-worthy, TERMINATE, denialReason preserved.
- Task lifecycle: generation/identity guards, stale-task protection, terminal-state re-entry protection, re-entrancy safety (F-003).
- Security scanning: bounded-scan truncation state; truncation → DENY, never interpreted as "nothing found."

## Frozen / deferred (do not build without owner approval)

- New scanners, new limits, new policy types.
- Speculative hardening not driven by real product use.
- Documentation of any limit not actually enforced (phantom guarantees).

## Standard for any future control

declared → wired → reachable → enforced → observable → tested → adversarially tested → delivered. All eight, or it is not a control.

---

## ⚠ OWNER DECISION REQUIRED — one line above contradicts the kernel as it is enforced

Recorded by the implementer, not by the owner. The declaration above is written
verbatim as instructed; this note exists so the file does not become the phantom
guarantee its own last section forbids.

**The line in question**, under "Genuinely enforced controls":

> POLICY_DENIED = non-retryable, non-replan-worthy, TERMINATE, denialReason preserved.

**What the kernel actually does**, as of this commit:

| Clause | Enforced? | Evidence |
|---|---|---|
| non-retryable | yes | `platform/core/recovery.ts`, the `POLICY_DENIED` branch returns before `RETRY_ELIGIBLE` is consulted |
| non-replan-worthy | yes | same branch: no replan is booked, on either path |
| denialReason preserved | yes | `SOFT_REFUSAL_CONTINUED` carries the policy's own words; pinned by `f006-denial-certificate-shape.test.ts` CERT.1 |
| **TERMINATE** | **NO** | a refusal returns `CONTINUE` / `POLICY_SOFT_REFUSED` |

Three of the four clauses hold exactly. The fourth was reversed by the owner on
**2026-10-01** (ledger entry D1, commits `927fdb1`, `54074db`) on the reasoning
that a refusal is an ANSWER, not a fault, and only a fault may kill a task.
That reversal is newer than this declaration, and the work order for this
session restated the older semantic from memory.

**The two are not reconcilable**, and this session did not reconcile them: D4B's
requirement "D1 semantics preserved" is satisfied by leaving the ratified
behaviour untouched, and the ratified behaviour is `CONTINUE`. Re-terminating on
a denial would have reverted an owner ruling, broken the D1 suite, and made the
ordinary-failure fix look bought by killing the task on the first refusal.

**What the owner must decide**, before Stage 1 depends on it:

1. keep the reversal — the declaration line is edited to `CONTINUE` and this
   note is deleted; or
2. re-instate termination — a further decision, with its own red tests, and the
   `abort`-on-violation path audited again because the two interact.

Until that decision is recorded, treat `TERMINATE` in the declaration as
**unverified**, and the enforced behaviour as `CONTINUE`.