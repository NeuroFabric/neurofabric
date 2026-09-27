# Refspec force-push guard — fix specification

- **Status:** PROPOSED. Not implemented. No code change accompanies this
  document.
- **Decision:** D-013 (rulings 1–3), D-012 (ruling 1, accepted and open)
- **Target file (for the implementer, not this change):**
  `platform/core/policy.ts` — the `DESTRUCTIVE_PATTERNS` array
- **Baseline measured:** 2026-09-27, same session as this document, by
  importing the exported `DESTRUCTIVE_PATTERNS` array directly and testing
  each command. One run, throwaway script, not committed, since removed.

## 1. The gap

The force-push control today is a single entry:

```
\bgit\s+push\b.*--force(?!-with-lease)
```

It matches on the `--force` flag and nothing else. Git also expresses a
force-push as a `+` refspec prefix, and that form carries no flag for this
pattern to find. The result is that the `+` forms pass the guard — not because
they were considered and permitted, but because they were never matched.

D-012 accepted this as a real hole. It matters more than a single missed
string because the ruleset's bypass actor is set to `always`, so platform
protection does not constrain the agent identity on this path. The TypeScript
pattern is the only force-push control acting on the agent identity.

## 2. Proposed anchor

Add a second entry to `DESTRUCTIVE_PATTERNS` that matches a `+` which is
**preceded by whitespace and begins a refspec argument**, rather than matching
the flag.

Proposed shape:

```
\bgit\s+push\b[^|]*(?:\s)\+[^\s]
```

Design points the implementer should preserve:

- **Whitespace-preceded, not merely present.** This is what separates a real
  refspec prefix from a `+` embedded in a branch name such as
  `feature+name`. Anchoring on the presence of `+` alone would deny a branch
  name that is not a force-push at all.
- **The `[^|]*` guard** keeps the match inside the command portion of the line,
  so a `+` appearing after a shell pipe is not attributed to the push.
- **It does not modify or relax the existing `--force` entry.** The two are
  independent: the new one covers the `+` form, the old one continues to
  cover the flag form, and the existing with-lease negative lookahead is left
  exactly as it is.

The implementer owns the final regex. This document proposes an anchor and a
reasoning; it does not certify a pattern.

## 3. Behavior matrix

`before` is the measured current state. `after` is the **target**, and is not
implemented.

| # | Command | before (measured) | after (target) | Rationale |
|---|---------|-------------------|----------------|-----------|
| 1 | `git push origin main` | ALLOWED | ALLOWED | Not a force-push. The ruleset, not this pattern, is what governs a plain push to `main`. |
| 2 | `git push origin +main` | ALLOWED | **DENIED** | Force-push by refspec. The uncovered case. |
| 3 | `git push origin +refs/heads/main` | ALLOWED | **DENIED** | Same form, fully-qualified ref. |
| 4 | `git push origin +HEAD:main` | ALLOWED | **DENIED** | Same form, symbolic source. |
| 5 | `git push --force origin main` | DENIED | DENIED | Already covered. Unchanged. |
| 6 | `git push --force-with-lease origin main` | ALLOWED | ALLOWED | Lease makes the force safe: it refuses when the remote moved. |
| 7 | `git push --force-with-lease origin +main` | ALLOWED | **DENIED** | Operator ruling. See §4. |
| 8 | `git push origin feature+name` | ALLOWED | ALLOWED | A `+` inside a branch name, not a refspec prefix. Must not be denied. |

Row 8 is the row that justifies the whitespace anchor. It is the cheapest way
to turn this fix into a false positive on ordinary branch names.

## 4. Row 7 — operator ruling

**DENY, uniformly.** The reasoning is that the `+` refspec form is denied
whenever it is whitespace-preceded and begins a refspec, regardless of
whether a lease flag is also present.

- A lease cannot make a `+` refspec safe, because the refspec form is what
  this new pattern matches, and the decision is to deny the form rather than
  to compose it with the flag exception.
- The with-lease exception in row 6 exists for the **flag** form, where the
  lease is the only thing standing between the push and a lost commit. The
  safe-force case is already covered there.
- **Simplicity over permissiveness.** One rule, uniformly applied, is
  auditable by reading. A conditional exception is not.

Row 7 is the only row where the target is deliberately stricter than a
narrow reading of the safety argument would require, and it is recorded as an
operator decision rather than left implicit.

## 5. Implementer protocol — after-column

The `after` column is a **target, not a measurement**. It becomes a claim only
when someone measures it.

1. Add the pattern to `DESTRUCTIVE_PATTERNS`. Change nothing else in the file.
2. Re-run the same eight-row evaluation used for the `before` column, against
   the exported array, in the same shape: one run, a throwaway script that is
   not committed.
3. Record the measured results as a new `after (measured)` column alongside
   the `after (target)` column.
4. Add all eight rows to `platform/core/policy.test.ts` as assertions, so the
   matrix is enforced by the suite rather than by this document.
5. Run the core and Pi suites and record the counts.

**Stop conditions.** Any of the following is a halt, not something to work
around:

- The measured column disagrees with the target column on any row.
- Row 8 measures DENIED. The anchor is wrong and the fix is doing harm.
- Row 1 or row 6 measures DENIED. The fix has narrowed a control that was
  deliberately permissive.

If the target column turns out to be wrong, the fix to the spec comes first
and the code change does not proceed against a spec that has not been
corrected. That is the same rule that governs a policy amendment.

## 6. Rollback

The change is one added array entry. Rollback is removing that entry, which
restores the current behavior exactly: rows 2, 3, 4, and 7 return to ALLOWED.

Rollback is a re-opening of a known, accepted hole, and should be recorded as
such rather than treated as a neutral revert. No data or state is at risk in
either direction — this pattern gates commands, it does not mutate anything.

## 7. Note on the merge lane

The fix pull request will be the **first code change gated by the
auto-merge lane** rather than by an operator pressing the button. Every prior
change to this repository's control code has been a docs-only change since the
lane was mechanized.

Two consequences worth stating before it happens:

- The merge will wait on `platform test suites`, so a regression in the
  pattern surfaces as a red check and an unmerged pull request, not as a
  landed defect. That is the lane doing its job.
- The matrix in §3 becomes load-bearing at merge time rather than advisory.
  If the assertions in step 4 are not present, the required check cannot
  actually detect the failure this spec is about.
