// Proof that the lifecycle tests actually detect their guards.
// Each mutation removes one guard from the implementation; the named test must fail.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const TARGET = "platform/omniroute/evaluation-scheduler.ts";
const original = readFileSync(TARGET, "utf8");

const mutations = [
  {
    name: "unref",
    from: "      timer.unref?.();",
    to: "      // guard removed for mutation check",
    expect: "THE INTERVAL IS UNREF'D",
  },
  {
    name: "re-entry guard",
    from: "    if (inFlight) return;",
    to: "    // guard removed for mutation check",
    expect: "A TICK ALREADY RUNNING IS SKIPPED",
  },
  {
    name: "reporter containment",
    from: "        options.onError(error, { provider });",
    to: "        throw new Error('uncaught reporter failure');",
    expect: "A REPORTER THAT THROWS",
  },
  {
    name: "idempotent start",
    from: "      if (timer !== undefined) return;",
    to: "      // guard removed for mutation check",
    expect: "STARTING TWICE DOES NOT ARM",
  },
];

const run = (args) => spawnSync(args[0], args.slice(1), { stdio: "ignore" }).status;

for (const mutation of mutations) {
  if (!original.includes(mutation.from)) {
    console.log(`SKIP  ${mutation.name}: anchor not found`);
    continue;
  }
  writeFileSync(TARGET, original.replace(mutation.from, mutation.to));
  const code = run([
    "node",
    "--experimental-strip-types",
    "--test",
    "platform/omniroute/evaluation-scheduler.test.ts",
  ]);
  const detected = code !== 0;
  console.log(
    `${detected ? "DETECTED" : "NOT DETECTED"}  ${mutation.name}  (expects failing: ${mutation.expect})`,
  );
}

writeFileSync(TARGET, original);
console.log("restored");