# Default merge request template

Applies to every merge request in this project unless a more specific template is
selected.

## Why the "CI status" table is not a checkbox

Because **`skipped` is not `green`, and `pending` is not `green`.**

This project has just had its first pipeline run. Four jobs failed on a runner
shell that did not exist; after that was fixed, the next run failed because `npm`
was not on the service's `PATH`. Both times the *tests* had never executed, and
both times a summary of "CI failed" would have said nothing useful while a
reader assumed the code had been judged.

A job table copied in verbatim costs the author thirty seconds and tells the
reader exactly which claims have evidence behind them. A tick in a box tells them
nothing they cannot get wrong.

## Why "What could break" is mandatory

Written **before** the merge rather than reconstructed after the incident.

The instinct under time pressure is to leave it empty, and an empty section reads
as "nothing" — which is almost never true, and is the sentence that later becomes
the postmortem. If the honest answer is genuinely "nothing", write that, and name
what you checked to be sure.

## Why "How to verify" wants one command

Not a checklist, not a description of the change. **One command a reviewer runs.**

`npm test` is not a verification. `npm run test:ts`, plus what a green run
actually proves, is one. The difference is that the first can be typed without
reading anything, and the second cannot be faked by accident.

## Ordering

One concern per merge request. Two commits in one MR is a normal review. Two
*concerns* in one MR means neither can be reverted, and the coupling survives
every future cherry-pick.

When a branch genuinely must stack on another, **say so in the first line of
"What changes"**, with the branch name. Stacking that is declared is manageable.
Stacking that is discovered during review is the !77/!78 coupling.

## Assignee

The operator merges everything. Assign the operator by default — they are the
merge authority and the holder of credentials and hardware.