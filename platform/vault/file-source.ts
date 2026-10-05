/**
 * A FILE-BACKED SECRET SOURCE, FOR DEPLOYMENTS THAT HAVE NO VAULT SERVICE.
 *
 * === AND AN HONEST STATEMENT OF WHAT IT IS ===
 *
 * This adapter exists so the embassy can run end to end today. It is the weakest
 * adapter that satisfies the port, and two of its properties should be read before
 * it is trusted with anything real:
 *
 *   1. THE WHOLE FILE IS READ to answer either question, because a JSON document
 *      has no query planner. So while `describe` returns no values and the store
 *      never sees one, the bytes DO pass through this adapter's read. The guarantee
 *      `store.describe` provides is that a credential is never handed to the store,
 *      the reader or the model -- not that a file-backed source never touches it.
 *      A database source selecting named columns gets the stronger property, and
 *      the port is shaped so that source can exist without changing anything else.
 *
 *   2. VALUES ARE STORED IN PLAINTEXT HERE. That is the adapter's whole nature and
 *      it is why this is not the production answer. It is mitigated by the file
 *      living outside the workspace and by ADR-017 remaining as it is; it is not
 *      fixed by this module.
 *
 * === WHY IT EXISTS ANYWAY ===
 *
 * Because an untested capability is an unknown one, and a demo that cannot run is
 * not a demo. This makes the triage client in `scripts/` a real end-to-end path --
 * client, embassy subprocess, HTTP, wedge, SQLite -- rather than a mock, while
 * leaving the seam where the real adapter goes.
 */

import { readFileSync } from "node:fs";

import type { SecretSet, SecretSetMetadata, SecretSource } from "./store.ts";

/**
 * THE FILE SHAPE.
 *
 * `value` is OPTIONAL, and that is not a convenience: a deployment that only ever
 * wants metadata can keep values out of the file entirely, which turns the weaker
 * guarantee in the header into a real one for that deployment.
 */
interface VaultFile {
  readonly credentials?: readonly {
    readonly name: string;
    readonly value?: string;
    readonly rotatedAt?: string;
  }[];
}

const UNKNOWN_ROTATION = "unknown";

export function createFileSecretSource(path: string): SecretSource {
  const read = (): VaultFile => {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("the vault file is not an object");
    }
    const entries = (parsed as VaultFile).credentials;
    return { ...(entries === undefined ? {} : { credentials: entries }) };
  };

  return {
    async load(tenant: string): Promise<SecretSet | undefined> {
      const file = read();
      const entries = (file.credentials ?? []).filter((entry) => typeof entry.value === "string");
      return {
        tenant,
        secrets: entries.map((entry) => ({
          name: entry.name,
          value: entry.value as string,
          rotatedAt: entry.rotatedAt ?? UNKNOWN_ROTATION,
        })),
      };
    },

    async describe(tenant: string): Promise<SecretSetMetadata | undefined> {
      const file = read();
      return {
        tenant,
        entries: (file.credentials ?? []).map((entry) => ({
          name: entry.name,
          rotatedAt: entry.rotatedAt ?? UNKNOWN_ROTATION,
          // Present means "this deployment has a value for it". A metadata-only file
          // therefore answers `false` for everything, which is the honest answer
          // rather than a claim that something exists when nothing can be read.
          present: typeof entry.value === "string",
        })),
      };
    },
  };
}
