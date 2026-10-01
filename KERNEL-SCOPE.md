# Kernel Scope — Freeze Declaration (2026-10-01)

The Neurofebric kernel is FEATURE-FROZEN as of this date, with one exception: D4B-class correctness fixes (recovery classification, metadata propagation).

## Genuinely enforced controls (the real list)

- maxToolRetries = 2
- maxReplans = 2
- maxRecoveryDepth = 3
- maxExecutionTimeMs
- maxArtifactBytes
- Tool-call budget: hard denial at 40 calls; 75% / 90% warnings are ADVISORY telemetry only (per-task warning suppression/reset). **REFUSED CALLS COST NO BUDGET** (Ruling 3, verified) but ARE counted per (task, tool, input) as repeats, so a refusal loop is a number rather than an impression.
- Policy evaluation: fail-closed; refusals are TWO TIERS (Ruling 1, 2026-10-01):
  - **SOFT_REFUSE → CONTINUE.** Scope and authority questions: a read outside the workspace roots, an unapproved tool, an exhausted budget. The agent adapts or asks the user.
  - **HARD_DENY → TERMINATE.** Hazards in themselves: destructive commands and tokens, secret/credential access, a write that escapes the workspace, a scan that could not complete (truncation → never "nothing found").
  - Both tiers are **non-retryable, non-replan-worthy, and reason-preserving**; the policy's own words reach the trace and the terminal certificate. An ABSENT tier is read as SOFT, so every engine that does not classify keeps the 2026-10-01 D1 reversal exactly.
- Task lifecycle: generation/identity guards, stale-task protection, terminal-state re-entry protection, re-entrancy safety (F-003).
- Security scanning: bounded-scan truncation state; truncation → DENY, never interpreted as "nothing found."

## Frozen / deferred (do not build without owner approval)

- New scanners, new limits, new policy types.
- Speculative hardening not driven by real product use.
- Documentation of any limit not actually enforced (phantom guarantees).

## Deferred decisions

- **Recovery budgets stay TASK-CUMULATIVE** (Ruling 2, 2026-10-01). `maxToolRetries` and `maxReplans` bound a whole task, not a single attempt, so a long run can exhaust them across the run rather than in one burst. Per-attempt funds are **deferred until the first real product run shows where budgets actually bind** — changing them now would be a guess dressed as a fix. D4B's own residual is pinned by `d4b-recovery-classification.test.ts` T5.1c, so the current bound is documented rather than merely implemented.
- **Refusal-loop escalation threshold.** Ruling 3 makes refusals countable; it does not decide when a human is asked. That threshold is a product rule (the clarify budget in `PRODUCT.md`), and the Conductor owns it — the kernel exposes the count and nothing more.

## Standard for any future control

declared → wired → reachable → enforced → observable → tested → adversarially tested → delivered. All eight, or it is not a control.

---

## ⚠ RESOLVED 2026-10-01 (Ruling 1) — the two tiers

The ruling below is superseded. "POLICY_DENIED = … TERMINATE" was one answer to
a question that has two, and the owner has now given both. **The freeze line is
amended above** to codify `SOFT_REFUSE → CONTINUE` and `HARD_DENY → TERMINATE`.

Both clauses of the original line that hold — non-retryable, non-replan-worthy,
denialReason preserved — are true of both tiers and are enforced. The `TERMINATE`
clause is true only of `HARD_DENY`, and is enforced there.

Enforcement and evidence: `platform/core/configured-policy.ts` and
`platform/core/policy.ts` classify at the rule site; `platform/core/recovery.ts`
decides at the single point where the task's fate is decided; the tier travels
kernel → bridge → session trace. Pinned by `platform/pi/d1-refusal-tiers.test.ts`
and, end to end through the real extension, by
`platform/pi/d4b-bridge-metadata.test.ts` T4.2 / T4.2c.

**Consequence worth stating plainly:** a credential-file read was the canonical
example in the D1 reversal's evidence file, and is now a HARD deny. That file's
fixture is an out-of-root read instead — same bridge path, same attribution
evidence, SOFT tier — and the hazard-class refusals are pinned where they belong,
asserting that they terminate.