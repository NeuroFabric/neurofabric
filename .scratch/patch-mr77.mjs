/**
 * Rewrites the !77 description. Quarantined in `.scratch/`: a one-shot patch, never
 * a deliverable, and not worth a place in the test glob.
 *
 * It exists as a file rather than an inline command because the text contains
 * backticks, and a backtick inside a shell argument is a command substitution.
 * The first attempt at this ran `start-ui.mjs` and `routes.routes.length` as
 * commands. Writing the script out is the fix; quoting harder is not.
 */
import { readFileSync, writeFileSync } from "node:fs";

const path = process.argv[2];
if (path === undefined) throw new Error("usage: node .scratch/patch-mr77.mjs <file.md>");

let text = readFileSync(path, "utf8");

const RATIONALE_OLD =
  "**4. Port 8080, not 3000.** Omniroute is a separate product already bound to 3000 on this machine. The Vite proxy targets 8080.";

const RATIONALE_NEW = [
  "**4. Port 8080, not 3000.** *Rationale corrected after merge.* This originally read: \"Omniroute is a separate product already bound to 3000 on this machine.\"",
  "",
  "That was wrong, and a plausible false story costs more than no story at all. **Nothing was bound to 3000.** The listener that had been on 3000 was this repository's own wedge, started by hand on its own default port -- the same process, not a second service. So \"two services fighting over a port\" was not a risk that existed.",
  "",
  "The change to 8080 stands. What it actually buys is one declared address: 8080 is the wedge contract, and the follow-up MR moves the `start-ui.mjs` default from 3000 to 8080 so the proxy target and the server default are the same number rather than two that can drift. That drift is what produced a proxy pointing at a port with nothing behind it. The Vite proxy targets 8080.",
].join("\n");

const COUNTS_OLD = [
  "- **Backend: 1461 pass, 0 fail, 2 skipped** (1441 TS + 22 MJS) - 10 new meter tests, 7 new mount tests".replace(" - ", " — "),
  "- **Frontend: 207 pass, 0 fail** (was 187)",
].join("\n");

const COUNTS_NEW = [
  "- **Backend: 1458 tests / 1456 pass / 0 fail / 2 skipped** on the follow-up branch (`test:mjs` 22/22, `test:ts` 1456 pass) - re-measured, since this block previously reported 1461 pass, a figure that counted the `routes.routes.length === 4` assertion as passing while it was in fact failing for an unrelated reason".replace(" - ", " — "),
  "- **Frontend: 251 tests / 245 pass / 6 skipped / 0 fail** on the follow-up branch (was 207), plus an opt-in live suite of 7/7 green against a running wedge",
].join("\n");

for (const [label, needle] of [
  ["rationale", RATIONALE_OLD],
  ["test counts", COUNTS_OLD],
]) {
  if (!text.includes(needle)) throw new Error(`anchor not found: ${label}`);
}

text = text.replace(RATIONALE_OLD, RATIONALE_NEW).replace(COUNTS_OLD, COUNTS_NEW);
writeFileSync(path, text);
console.log(`rewrote ${path}: ${text.length} chars`);