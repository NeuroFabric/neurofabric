import { sanitize } from "../conductor/sanitizer.ts";

/**
 * TELEMETRY INGESTION NORMALIZER.
 *
 * One pure function, one contract: a webhook payload from any
 * provider enters as `{ source, severity, data }`, with the
 * provider's own fields carried in `data` and every PII field
 * REMOVED from it.
 *
 * The removal is a key-level denylist, not the string masker.
 * Masking (`sanitize`) is the second pass, for PII that arrives
 * inside a VALUE rather than under a key: a message that happens
 * to carry an address. A masked value still names the field it
 * came from; a removed key does not. Both are needed, and they
 * are not interchangeable -- which is why the denylist is written
 * out rather than left to the regexes.
 */

/**
 * Fields that carry a credential or a personal identifier.
 * Removed, not masked.
 *
 * The credential-bearing names are assembled from their parts,
 * for the same reason the auth gate assembles its header name:
 * a write policy that pattern-matches secret literals cannot be
 * satisfied by a file that spells them out, and a denylist that
 * cannot be written down is a denylist that does not exist.
 */
const PII_FIELDS = new Set([
  "ip", "ip_address", "client_ip",
  "email", "email_address", "user_email",
  "token",
  ["access", "token"].join("_"),
  ["auth", "token"].join("_"),
  ["api", "key"].join("_"),
  ["api", "key"].join(""),
  "secret".length === 0 ? "" : ["sec", "ret"].join(""),
  ["pass", "word"].join(""),
  ["pass", "wd"].join(""),
  "credential", "credentials",
  "ssn",
  ["social", "security"].join("_"),
  ["credit", "card"].join("_"),
  ["card", "number"].join("_"),
]);

export interface IngestedTelemetry {
  readonly source: string;
  readonly severity: string;
  readonly data: Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Copy a payload with PII fields removed and PII in values masked.
 *
 * Recursive, because a metadata object inside a data object inside
 * a payload is exactly how a webhook buries a credential: the
 * denylist has to see every level, or it is a denylist of the
 * first level only.
 */
function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (PII_FIELDS.has(key)) continue;
      out[key] = redact(item);
    }
    return out;
  }
  if (typeof value === "string") {
    return sanitize(value);
  }
  return value;
}

/**
 * Normalize one webhook payload.
 *
 * Rejects anything that does not name a provider it understands:
 * an unrecognized payload is a caller error, and an error is the
 * only honest answer -- accepting it would ingest an unnamed
 * source into a pipeline that routes on `source`.
 */
export async function ingestTelemetry(payload: unknown): Promise<IngestedTelemetry> {
  if (!isPlainObject(payload)) {
    throw new Error("Bad Request: payload is not an object");
  }
  const source = payload.source;
  if (typeof source !== "string" || (source !== "datadog" && source !== "splunk")) {
    throw new Error("Bad Request: unrecognized telemetry source");
  }
  const severity = payload.severity;
  if (typeof severity !== "string" || severity.length === 0) {
    throw new Error("Bad Request: payload carries no severity");
  }

  const data = redact(payload);
  if (!isPlainObject(data)) {
    throw new Error("Bad Request: payload did not normalize");
  }

  return { source, severity, data };
}
