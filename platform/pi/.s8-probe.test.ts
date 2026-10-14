SPENT SCRATCH — verification artefact, not a test and not a fixture.

Used on 2026-10-01 to measure the F006 §5 item 8 sibling path directly: bind two
executions as siblings, refuse one mid-execution, succeed the other, and print
the resulting task status and event trace.

Its finding is not lost. It is pinned by
platform/pi/f006-sibling-refusal-kill.test.ts (S8.1, S8.1b) and by the
inverted BRIDGE.C2 in platform/pi/f006-denial-certificate-shape.test.ts.
Nothing depends on this file.

Its most useful output was a correction to the probe I had written first, and it
is recorded here because a scratch file that quietly contradicts a commit is
worse than no file: `recordToolResult`'s 4th parameter is `isError`, not the
payload, and the 6th (`denialReason`) IS the refusal signal — passing a message
there turns a genuine tool fault into a POLICY_DENIED, which silently made the
"genuine fault" guard test the wrong thing.

Overwritten rather than removed, because the deletion guard refuses removals and
docs/POLICY_PORT.md names overwriting as the correct response to a refusal.
Dot-prefixed, so the suite glob `platform/pi/*.test.ts` does not match it. The
operator may delete it.
