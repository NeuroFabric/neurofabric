# Neurofebric — Product Definition (v0)

## What we are building

A governed agent-execution runtime with a product loop on top: user asks → agent clarifies (max 3 rounds) → plans as task tree → executes through the Neurofebric kernel (policy, limits, recovery) → delivers a real artifact → user iterates.

## The kernel is the moat

Every action is policy-checked with preserved deny reasons, hard cost/time/output budgets per task, terminal certificates as audit trail, and bounded recovery. Consumer AI tools cannot offer this. Enterprises need it.

## The wedge (first sellable thing)

Small businesses upload a sales CSV → get a live dashboard + summary report. Not "build anything." One painful workflow, one audience, real users.

## Stage 1 acceptance test (the gate for all future work)

"Here is a CSV — make me a one-page dashboard" runs end-to-end: zero manual steps, live progress visible, every tool call passes through policy.

## Roadmap

- Stage 0 (done today): kernel freeze + D4B closure.
- Stage 1 (next): Conductor loop — clarify → plan → execute → deliver.
- Stage 2: Ingestion plane — CSV, read-only SQLite/Postgres, PDF, as governed tools.
- Stage 3: Skills + artifacts — chart, table-query, landing-page, report, app scaffold.
- Stage 4: Wedge pilot — 5 real users, charge money or signed LOIs.

## Non-goals (for now)

- No new kernel limits/scanners.
- No speculative hardening.
- No generic "AI builds anything" positioning.
- Master Scenario Phases 2–5 are a regression suite, not the roadmap.