# ADR-001 — Minimalism as the audit trail

- **Status:** accepted
- **Date:** 2026-10-04
- **Supersedes:** nothing. This is the thesis document; read it first.
- **Relates to:** D-018 (zero runtime dependencies), `.gitlab-ci.yml`, `AGENTS.md`

---

## Context

Neurofebric is an edge inference platform: it authenticates a caller, accepts
events, evaluates them against registered agent schemas, and emits a verdict and
an alert. Nothing about that problem requires a control plane.

Most systems of this shape accumulate one anyway, because each piece arrives with
a good reason. An agent framework, because someone wanted subagents. An MCP
server, because a tool integration existed once. A plugin registry, because a
future extension point was anticipated. Each is individually defensible, and the
sum is a system whose behaviour is the composition of behaviours nobody chose.

This project's stated thesis is the opposite: **Git, tests, and human oversight
are the entire control plane.** Every feature must survive one question —
*"can a human audit this in one diff?"* — and the answer is permitted to be no.

That is a thesis about **auditability**, not about capability. It is worth being
precise about the difference, because the wrong reading produces a cult of
minimalism that deletes things a platform needs.

---

## Options considered

### Option A — Adopt an agent framework and an MCP surface

**For:** standard tooling, faster iteration, an ecosystem of integrations; the
capability is genuinely larger.

**Against, and specifically:** an agent framework's behaviour is defined by a
prompt file and a dependency tree. The prompt is not versioned in any sense a
diff can review, the dependency tree is not auditable without reading someone
else's repository, and the composition of the two is where the actual risk lives.
**The central question cannot be answered about any of it.** Not "is it bad" —
is it *auditable in one diff*.

### Option B — Adopt both selectively, behind interfaces

**For:** keeps the option open; interfaces mean the choice is reversible.

**Against:** this is the option that looks most responsible and is most likely to
produce an unauditable system. An interface around a tool you do not control is a
promise, not a boundary. The interface gets written, the boundary is never tested
because there is nothing to test against, and a year later the diff being reviewed
is the *adapter*, which is trivially small. **Minimalism inverted: the small diff
is where the risk moved, not where the risk was removed.**

### Option C — No subagents, no MCP, no framework. Git, tests, oversight

**For:** every behaviour is in a file someone wrote and a reviewer read. The test
suite is the specification and it runs in CI. A revert is `git revert`. There is
no state outside the repository that a reviewer must trust.

**Against, honestly:** slower to extend, and some integrations will be harder or
impossible without a tool protocol. We accept that. The cost is real and it is
paid deliberately.

---

## Decision

**Option C.** Neurofebric ships no subagent framework, no MCP server, and no
runtime dependency.

Concretely, and each of these is already true and load-bearing:

- **Zero runtime dependencies** (D-018). The kernel runs on bare node. `npm ci`
  at the root installs two packages, both dev-only static tooling. This is why a
  serving image has no third-party code to compromise and no lockfile to drift.
- **The test suite is the specification**, and it is executable rather than
  descriptive. Every gate in `.gitlab-ci.yml` runs the same commands a person
  runs by hand.
- **The decision log is part of the repository**, not a wiki. `docs/DECISIONS.md`
  and this file.

---

## Consequences

### What this makes cheap

- **Review.** A reviewer reads source, tests, and a decision record. There is no
  fourth artefact whose behaviour cannot be shown in a diff.
- **Revert.** Any change is one commit. No migration, no state to unwind.
- **Trust.** The supply chain is empty because there is nothing in it.

### What this makes expensive

- **Integration.** Anything requiring a tool protocol needs a first-class HTTP
  route and an explicit auth decision — which is slower than calling an MCP method
  and is *supposed* to be.
- **Iteration speed.** A capability that a framework would give free will be built
  slowly or not at all. This is the accepted cost, not an oversight.
- **Onboarding is on us.** There is no abstraction to learn, so the documentation
  has to be genuinely good instead. That obligation is recorded in the README
  mandate rather than dismissed.

### The failure mode to watch

**Minimalism can be performed rather than practised.** The observable symptom is a
repository that is small because nothing was built, defended with the vocabulary
of this document. Two guards against it, both already in force:

1. **"Can a human audit this in one diff?" is about the thing, not the diff size.**
   A 900-line diff of clearly-written code passes. A three-line wrapper around an
   opaque dependency fails, and is exactly the Option B trap.
2. **A rejected feature must be recorded, not dropped.** Option B above is a
   record. If we do not write down what we declined and why, this document becomes
   a claim rather than a history, and the next person re-litigates it.

---

## Verification

This ADR is not code and has no gate. It is falsified by the repository itself:
if a merge request ever adds a runtime dependency, a subagent framework, or an MCP
server without a decision record superseding this one, this ADR is wrong and must
be reopened rather than quietly disregarded.

The standing check is the root `package.json` `dependencies` field: it is absent,
and adding it is the change this ADR exists to make someone argue for.