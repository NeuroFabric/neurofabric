import { readFileSync, writeFileSync } from "node:fs";

/** ONE-OFF sweep for F1 + F4. Applies exact replacements; refuses if an anchor is missing. */
const changes = [
  {
    file: "frontend/src/App.tsx",
    from: "<DynamicDashboard config={state} />",
    to: "<DynamicDashboard config={state} readings={readings} />",
    all: true,
    note: "F1: the rule panel was never wired. `readings` defaulted to [] so `measured`\nwas always undefined and every rule read 'no reading yet' next to a live BREACH.",
  },
  {
    file: "frontend/src/components/AlertCenter.tsx",
    from: "From the live verdict, not a dispatched alert.",
    to: "Measured directly from the data in view.",
    note: "F4: 'not a dispatched alert' is a sentence about the system's internals.\nThe operator enumerated it. What the reader needs is where the number\ncame from, and 'from the data in view' is both shorter and true.",
  },
  {
    file: "frontend/src/components/LivenessStrip.tsx",
    from: '<abbr title="Records in the last snapshot. A count, not a rate.">recs</abbr>',
    to: '<span title="Events in the current window. A count, not a rate.">events</span>',
    note: "F4: 'recs' is an abbreviation of internal vocabulary. 'events' is the word\nthe operator already uses, and the title keeps the count-vs-rate distinction\nthis project cares about.",
  },
];

for (const change of changes) {
  let text = readFileSync(change.file, "utf8");
  if (!text.includes(change.from)) throw new Error(`anchor missing in ${change.file}: ${change.from.slice(0, 60)}`);
  const count = change.all === true ? text.split(change.from).length - 1 : 1;
  text = text.split(change.from).join(change.to);
  writeFileSync(change.file, text);
  console.log(`${change.file}: ${count} replacement(s) — ${change.note.split("\n")[0]}`);
}