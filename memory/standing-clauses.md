# Standing Clauses

Four clauses that bind every future session in this repository. They are
standing rules, not decisions: no ruling is recorded here, and none should
be. Dated decisions live in **[docs/DECISIONS.md](../docs/DECISIONS.md)**,
which is the single canonical record. This file exists because
[decisions.md](decisions.md) is a pointer and states that new material does
not belong there.

Established by the floor-repair PR, 2026-09-28.

---

## 1. FIXTURE

`platform/pi/policy-port.test.ts:35` (`LEGACY_RULES`) is **protected by
ruling**. It retains the un-scoped third entry of the write-pattern list by
design and is **never synchronized** with the committed config.

It is an engine-behavior fixture. It is consumed by tests 3a, 3b, 3c, 3d, and
6, and it pins deny-on-write / allow-on-read-search semantics against the
maximally-strict legacy shape, independent of what the committed config
scopes. Reading it as a stale copy of the config and "fixing" it to match is
a defect, not a cleanup. Provenance for the ruling: PR #21.

## 2. WRITE-LANE

A denial is **never routed around on the agent's own initiative**. The only
permitted path is operator-directed, verbatim, and disclosed. "I worked
around it" is itself the violation, and a disclosure offered after the fact
does not convert it.

Operator-supplied commands use the **least-destructive sufficient form**.

Guard false positives on documentation prose are remedied **only by operator
ruling** — either a rewording under the S6 concession, or a channel
correction under an explicit grant. Never by agent initiative. A second
denial in a granted channel ends the work at operator hands.

## 3. COMMIT-SUBJECT

Commit subjects are **72 characters or fewer**.

The enforcement is the pi/bash **guard layer**, not a git hook — so a
longer subject is caught late, at commit time, after the work is staged.
Operator-supplied subjects are **pre-counted before issuance**; the executor
verifies independently with `wc -c` before committing. Count, do not
estimate.

## 4. LOCAL-TEST GATE

**No push without local green on the touched suite.**

Origin: an operator-supplied replacement placed a colon outside a string
literal. That is a valid JSON key shape and invalid in the TypeScript array
literal the pin lives in. It passed every diff gate — the edit was
byte-for-byte what was specified — and surfaced only in CI, one cycle later.

The lesson, stated plainly: **diff verification proves the edit is the one
specified; only execution proves the specification is correct.** A green
diff is not a green test.
