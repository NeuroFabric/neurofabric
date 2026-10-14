// Prove the handover tests are non-vacuous: remove the overwrite and they must fail.
// A test that passes with the credential still in memory is worse than no test,
// because it reads as coverage.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const READER = "platform/vault/reader.ts";
const original = readFileSync(READER, "utf8");

const mutations = [
  {
    name: "overwrite removed from the reference path",
    from: "      const reference = referenceFor(claims, credentialName, outcome.value);\n      wipe(outcome.value);",
    to: "      const reference = referenceFor(claims, credentialName, outcome.value);\n      void outcome.value;",
  },
  {
    name: "overwrite removed from the raw path",
    from: "        const value = outcome.value.toString(\"utf8\");\n        wipe(outcome.value);",
    to: "        const value = outcome.value.toString(\"utf8\");",
  },
  {
    name: "overwrite made a no-op (wipe body emptied)",
    from: "function wipe(value: Buffer): void {\n  randomFillSync(value);\n}",
    to: "function wipe(value: Buffer): void {\n  void value;\n}",
  },
];

const run = () =>
  spawnSync(
    "node",
    ["--experimental-strip-types", "--test", "platform/vault/store.test.ts"],
    { stdio: "ignore" },
  ).status;

for (const m of mutations) {
  if (!original.includes(m.from)) {
    console.log(`SKIP    ${m.name}: anchor not found`);
    continue;
  }
  writeFileSync(READER, original.replace(m.from, m.to));
  const detected = run() !== 0;
  console.log(`${detected ? "DETECTED" : "NOT DETECTED"}  ${m.name}`);
  writeFileSync(READER, original);
}

console.log("restored");