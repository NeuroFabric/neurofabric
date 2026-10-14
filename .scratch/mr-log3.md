Session log for the priority-insert run.

A real bug found in main by the operator: start-ui.mjs referenced WEDGE_PORT with no import and no definition. Confirmed, fixed in !93, plus a checkJs entry-script gate wired into typecheck that PROVES it (deleting the import gives TS2304) and found a second real defect on its first run.

My own earlier receipt for that line was green -- the environment flattered the code. Now the standing rule: the environment that verifies must not be the environment that flatters.

B1 fixed in the SCRIPT, not the CI config. MRs !87 to !96, nine ready, merge !93 first.

Also identifies boot.js, boot.mjs and builds/ and recommends gitignoring the first two rather than deleting them.
