# Stage 2 — Direction

**Status: BLOCKED pending owner input. No direction is chosen.**

## Why this page has no recommendation

The Stage 2 brief supplies its candidate list from the owner. That list arrived
**empty**. Four criteria cannot be scored against nobody, and the failure mode
here is not an inconclusive analysis — it is manufacturing a customer to have
something to analyse. A framework applied to an invented user produces a
confident page that is worthless, because its confidence would be manufactured
rather than earned.

So this page states the criteria, states what each one disqualifies, and states
exactly what is needed to unblock. Nothing further.

## What Stage 1 actually established

Worth restating, because Stage 2 must not re-litigate it. The CSV → one-page
dashboard loop is **demonstrated end to end**, with a clean file and with a
malformed one. That is the whole of Stage 1: the loop works, and it fails
honestly rather than silently. What it has *not* established is that anyone
wants it. Those are different claims, and only the first is proven.

## The four criteria

A candidate serves the loop **first** only if it clears all four. They are
ordered by how cheaply they can be checked, not by importance.

### 1. The data already exists as CSVs

Not "could be exported as CSV" — *already is*, today, without a project to get
there. This is the strictest filter and it should be applied first, because it
is the one that cannot be argued around later.

The reason is mechanical. The loop's entire value is collapsing the distance
between a file someone already has and a picture they can look at. If the data
lives in a database, a SaaS tool, or an inbox, then the first session is a data
extraction project wearing a dashboard's clothes, and the dashboard is the part
that gets cut when the week runs out.

**Disqualifies:** anything whose first step is an integration.

### 2. The pain recurs

A one-off is served by a person spending twenty minutes. Recurrence is what makes
a repeated loop worth automating at all, and it is what makes a second session
possible — which is the only evidence that can inform Stage 3.

Weekly or better is the realistic bar. Monthly is arguable.

**Disqualifies:** anything described as "sometimes" or "whenever I get a chance".

### 3. The person is reachable

One named human who will actually run this, and who can be asked what they were
looking at. Without this there is no session to learn from, and criterion 4 has
nothing to be checked against.

This is a hard gate, and it is the criterion most likely to be quietly skipped
by treating a segment as a person.

**Disqualifies:** "operations teams" as a category rather than a named
individual.

### 4. A dashboard-shaped output is plausible

The loop answers "what happened, compared to what". It does not answer "what
should I do", "who owes whom", or "tell me the one number". Output that reduces
to a single figure, or that is fundamentally a list needing a search, is a poor
fit — and a poor fit discovered after building is the expensive kind.

Note this is a claim about *shape*, not about value. A dashboard can be low-value
and correctly shaped; it can be high-value and wrongly shaped. Only the second
failure is ours to avoid at this stage.

**Disqualifies:** work whose natural output is an action, an alert, or a queue.

## What one real session must teach us

Stage 1 taught us the loop runs. Stage 2's first session with a real person is
not for validating that — it is already validated. It is for answering the
questions a synthetic acceptance test structurally cannot:

- **What they actually open the dashboard to decide.** Criterion 4 is a guess
  about shape until someone has looked at a real one and reached for something
  else.
- **Which file they reach for first.** Not the file they named when asked; the
  one they went looking for. This is the strongest available evidence against
  criterion 1 being satisfied in practice rather than on paper.
- **Whether they open it once or repeatedly.** Criterion 2 is the difference
  between a one-off automation and a habit, and only repetition reveals it.
- **What they do when it is wrong.** A dashboard they cannot trust is worse than
  no dashboard, and the failure mode is visible only when a real person hits it.

## To unblock

One candidate, named, meeting criteria 1–3. Criterion 4 can be argued in the
session itself. With that, this page gets a recommendation; without it, Stage 2
stays blocked and the honest state is that nobody has yet been asked.