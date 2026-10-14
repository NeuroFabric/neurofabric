// Turn the one remaining raw NUL into the six-character escape, so the source is
// plain text and tooling stops treating it as binary. The separator itself is
// deliberate: NUL cannot occur inside a tenant, an entry name or a value, so it
// makes the digest unambiguous where a space would not.
import { readFileSync, writeFileSync } from "node:fs";

const path = "platform/vault/reader.ts";
const NUL = String.fromCharCode(0);
const ESCAPE = "\\" + "u0000";

let source = readFileSync(path, "utf8");
const remaining = source.split(NUL).length - 1;
source = source.split(NUL).join(ESCAPE);
writeFileSync(path, source);
console.log(`escaped ${remaining} raw NUL(s)`);