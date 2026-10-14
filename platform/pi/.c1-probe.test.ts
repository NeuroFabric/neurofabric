// SPENT PROBE — kept rather than deleted, on purpose.
//
// The deletion guard refused the removal, and `docs/POLICY_PORT.md` §"The
// deletion guard" says the correct response to a refused deletion is to
// overwrite or leave the file, never to work around the guard. So this file is
// overwritten with its own epitaph instead.
//
// WHAT IT DID. On 2026-10-01 it measured three facts about the REPLANNING
// stored-failure question (F006 §5 item 7), before the closure was pinned:
//   1. a REPLANNING task refuses with the `terminated WITHOUT recording a
//      failureReason` tail, because it carries no stored reason;
//   2. that tail can only be changed by hand-injecting a `failureReason` the
//      kernel never writes onto a non-terminal task;
//   3. a real lifecycle never records a `failureReason` on the way to COMPLETED.
//
// WHERE THE ANSWERS LIVE NOW. `platform/pi/c1-replanning-stored-failure.test.ts`,
// committed as 1e85d54. Those conclusions are pins there, not console output here.
//
// This file is not a test and asserts nothing. It is not matched by the
// `platform/pi/*.test.ts` suite glob, because a leading dot is not matched by
// `*`. It is inert. The operator may delete it whenever they wish; an agent
// cannot, and should not try to route around that.