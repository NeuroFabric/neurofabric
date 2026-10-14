// Document the digest separator. The file already contains the escape sequence
// `"\u0000"`; this only inserts the explanation above it.
import { readFileSync, writeFileSync } from "node:fs";

const path = "platform/vault/reader.ts";
const anchor = 'const FIELD_SEP = "\\u0000";';

const doc = `/**
 * THE SEPARATOR BETWEEN HASHED FIELDS, AND WHY IT IS A NUL.
 *
 * A space would be ambiguous. Tenant "acme eu" with entry "key" and tenant "acme"
 * with entry "eu key" would digest identically, so two different credentials could
 * share a reference -- and a reference is a thing an agent holds and cites, so a
 * collision means it can be holding a handle to the wrong credential.
 *
 * NUL cannot occur inside a tenant id, an entry name or a value, so joining on it is
 * unambiguous by construction.
 *
 * It sat in this file as a RAW NUL BYTE for several commits before anybody noticed,
 * and the only symptom was that tooling classified the source as binary. It is an
 * escape now, and documented, so the next reader sees a decision rather than an
 * artefact.
 */
`;

const source = readFileSync(path, "utf8");
if (!source.includes(anchor)) throw new Error("anchor not found");
writeFileSync(path, source.replace(anchor, doc + anchor));
console.log("documented");