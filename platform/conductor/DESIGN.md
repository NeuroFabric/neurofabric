# Conductor — minimal design (v0, 2026-10-01)

30-minute design, written inline because there is no lane design to implement to.
This file is the reasoning, not the contract; the contract is
`platform/conductor/conductor.test.ts`.

## The one rule

**The kernel is a black box.** The Conductor never reaches into the kernel's
recovery table, never edits a limit, never decides what policy means. It drives
the kernel through exactly the sequence the Pi bridge drives, and it reads
telemetry out of the event stream. If the Conductor needs a kernel change to do
its job, the Conductor is wrong.

That is why every Conductor state below is either a kernel state or a state the
kernel does not have and does not need to have.

## States

| Conductor state | Kernel state it maps to | What it means |
|---|---|---|
| `ASK` | — | A user turn exists. No kernel task yet: a task that has not been planned must not be created and abandoned. |
| `CLARIFY` | — | Product-side only. The kernel has no opinion about questions; it governs actions, not conversation. |
| `PLAN` | `UNDERSTANDING → PLANNING` | `beginTask` is called. The kernel owns everything after this point. |
| `EXECUTE` | `PLAN_VALIDATION → EXECUTING` | Each capability runs as a real, governed tool call: precheck → bind → result. |
| `DELIVER` | `COMPLETED` | `finishTask` with the artifact. |
| `ITERATE` | — | The user asks again. A new task, fresh budgets, no inherited state. |

`CLARIFY` is the only state with no kernel counterpart, and that is deliberate:
the kernel's job is to govern what the agent DOES, and a question to a human is
not an action.

## The loop

```
ask → clarify(≤3 rounds) → plan → execute(through kernel) → deliver → iterate
```

Clarify is bounded at 3 because the product says so (`PRODUCT.md`), not because
a limit exists. When the bound is reached with the ambiguity still open, the
Conductor ends with `CLARIFY_EXHAUSTED` and the actual question — a structured
failure, never a silent death. That is stop condition S4 made into behaviour.

## Progress

The Conductor subscribes to the kernel's event stream and re-emits it. It does
not compute progress, invent percentages, or infer state — everything a caller
sees is an event the kernel actually emitted. The same is true of the refusal
loop count from Ruling 3: the Conductor reads the count and decides when to ask
a human; the kernel only makes it countable.

## Capabilities

Two, and only two, because the acceptance scenario needs only two:

- `csv_read` — READ_ONLY, IDEMPOTENT. Reads a CSV inside the workspace.
- `render_page` — WRITE, IDEMPOTENT. Writes one self-contained HTML page.

Both are ordinary kernel tools. Adding a capability adds a descriptor and an
implementation; it adds no policy, no limit and no kernel code.

## The honest limitation

v0's planner is **deterministic and rule-based**. There is no model in this
loop: "read a CSV, draw a chart" is compiled straight into a task tree. That is
enough for the Stage 1 acceptance test, and it is enough to find out whether the
kernel survives real product work — which is the whole point of Stage 1. The
seam where a model replaces the planner is `Conductor`'s `clarify`/`plan`
strategy parameter, so the swap does not rewrite the loop.