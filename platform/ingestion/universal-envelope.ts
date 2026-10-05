/**
 * THE UNIVERSAL TELEMETRY ENVELOPE: ONE SHAPE, WHATEVER ARRIVED.
 *
 * === WHAT PROBLEM THIS SOLVES ===
 *
 * This repository already reads CSV, JSONL, PDF and SQLite, and every one of them
 * produces a DIFFERENT record shape, so every downstream accumulator has to know
 * which source it came from. Add a Kafka firehose to that list and the problem
 * stops being a parsing problem: it becomes that `metricName` means `Name` in one
 * profile, `p95_latency` in another, and a dashboard silently aggregates across
 * sources that were never comparable.
 *
 * So the envelope is fixed and every source is translated into it. One shape means
 * one set of accumulators, and a number from a Kafka topic and a number from a CSV
 * export are the same kind of thing by construction rather than by luck.
 *
 * === AGNOSTIC IS A CONSTRAINT, NOT A LACK OF FEATURES ===
 *
 * There is no `source` field. There is no `provider`. Nothing in this interface
 * names the tool that produced the event, and that is deliberate: the moment the
 * envelope carries a source discriminator, every consumer grows a branch on it, and
 * the shape stops being universal while still looking universal.
 *
 * Source-specific detail goes in `metadata`, which is opaque to everything that
 * reads it. A Datadog tag, an OpenTelemetry resource attribute, a Pega case id --
 * all of them fit, none of them is promoted into the contract, and none of them can
 * be used to fork the pipeline.
 *
 * === WHY `value` IS A NUMBER AND NOT A UNION ===
 *
 * A telemetry metric that might be a string is a telemetry metric nobody can sum.
 * `value: number` is restrictive and it is the restriction that makes aggregation
 * correct. Anything that is genuinely not numeric belongs in `metadata`, where it
 * is labelled by being non-numeric instead of by convention.
 *
 * `NaN` and `Infinity` are REFUSED. They are representable in a JavaScript number
 * and not in JSON, so they can only arrive from a bug upstream, and a NaN that
 * propagates into an average poisons it silently and permanently. The single most
 * common way to destroy a time series is to let one of these in.
 *
 * === AND WHY THIS VALIDATION IS NOT A UNIFORM REFUSAL, WHICH IS THE OPPOSITE OF
 * THE VAULT'S RULE ===
 *
 * `store.ts` and the vault worker answer every refusal identically, because a
 * caller holding one valid capability could otherwise learn which entry names are
 * real. Uniformity there is a security property: it removes an oracle.
 *
 * Here the opposite is correct, and the difference is the whole reason this file
 * exists. A telemetry event carries **no secrets**, so there is nothing for a
 * distinct error to leak. Meanwhile the failure mode we are actually defending
 * against is a producer shipping a broken shape for an hour: if every rejection
 * said only "rejected", the operator's only tool is a counter, and the correct
 * response -- stop the producer, fix the schema, replay the partition -- never
 * happens. Making the failure legible is worth more here than making it uniform.
 *
 * So refusals here carry distinct codes and distinct reasons. That is a considered
 * departure from the vault's posture, not an inconsistency in it.
 *
 * === METADATA IS OPAQUE AND STILL BOUNDED ===
 *
 * "Opaque" means nothing downstream may interpret it. It does not mean unbounded,
 * and it must not be: this consumer is fed a firehose, which is an untrusted
 * firehose, and an attacker who can publish to a topic controls the size and shape
 * of every metadata record in it. Keys, depth, count and string length are all
 * capped below. Unbounded metadata on an untrusted stream is a memory exhaustion
 * primitive wearing a data-model.
 */

/** Fields the envelope itself defines. Anything else at the top level is refused. */
export const ENVELOPE_FIELDS = ["eventId", "timestamp", "metricName", "value", "metadata"] as const;

/* -------------------------------------------------------------------------- */
/* THE BOUNDS. EVERY ONE OF THESE IS AN ATTACK, NOT A STYLE CHOICE.             */
/* -------------------------------------------------------------------------- */

/** An id longer than this is not an id, it is a payload wearing a label. */
export const MAX_EVENT_ID_BYTES = 128;
/** Metric names are compared by string equality across sources; keep them short. */
export const MAX_METRIC_NAME_BYTES = 256;
/** Distinct keys in one metadata record. */
export const MAX_METADATA_KEYS = 64;
/** Nesting depth. Deep metadata is a stack-depth and allocation problem. */
export const MAX_METADATA_DEPTH = 4;
export const MAX_METADATA_KEY_BYTES = 128;
export const MAX_METADATA_STRING_BYTES = 1024;

/**
 * A CONTROL CHARACTER in an identifier or a metadata string is refused.
 *
 * Newlines and NULs in a metric name break log lines, break CSV writers downstream,
 * and are how a value gets smuggled past a reviewer reading a dashboard. The same
 * rule as `FIELD_SEP` in the vault, for the same reason: a separator you cannot
 * represent inside a field is a separator you can join on safely.
 */
// eslint-disable-next-line no-control-regex -- the control range is the point
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** Anything that will pass through a metric-name lookup table unchanged. */
const METRIC_NAME_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

/* -------------------------------------------------------------------------- */
/* THE ENVELOPE                                                                */
/* -------------------------------------------------------------------------- */

/** A nested metadata record. Depth-capped; see `MAX_METADATA_DEPTH`. */
export interface TelemetryMetadata {
  readonly [key: string]: TelemetryMetadataValue;
}

/**
 * Metadata values: scalars and nested records. No arrays.
 *
 * Arrays are refused rather than ignored because a homogeneous list of numbers is a
 * metric, and the correct response to "I have a list of numbers" is to emit `value`
 * per item. Carrying it as metadata means the aggregator meets an array where it
 * expects a scalar and has to guess, and the guess is always sum.
 */
export type TelemetryMetadataValue =
  | string
  | number
  | boolean
  | null
  | TelemetryMetadata;

/**
 * ONE EVENT, AND THE WHOLE OF THE CONTRACT.
 *
 * Five fields, all required, none optional. Optionality is where envelope drift
 * begins: one source that omits `metricName` for half an hour, and the field
 * becomes nullable in every consumer, permanently.
 */
export interface UniversalTelemetryEvent {
  /** Producer-assigned. Stable, and unique enough to deduplicate a replay. */
  readonly eventId: string;
  /**
   * ISO-8601 with an explicit timezone offset. Required, and validated as a real
   * instant -- `2026-13-45T99:99:99Z` parses in some libraries and is not a time.
   *
   * A local time with no offset is refused rather than assumed to be UTC. Assuming
   * is how a pipeline ends up with two hours of data that nobody can explain, and
   * it is unrecoverable after the fact because the offset that was missing is gone.
   */
  readonly timestamp: string;
  readonly metricName: string;
  /** Finite. `NaN` and `Infinity` are refused; see the header. */
  readonly value: number;
  /** Opaque to every consumer, bounded by this file. Never carries a credential. */
  readonly metadata: TelemetryMetadata;
}

/* -------------------------------------------------------------------------- */
/* REFUSALS                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * DISTINCT CODES, AND WHY THAT IS THE POINT HERE RATHER THAN A LEAK.
 *
 * See the header: nothing in a telemetry event is secret, and a producer emitting
 * `value: "banana"` for an hour needs to be told so in a way that names the field.
 */
export type TelemetryInvalidCode =
  | "NOT_AN_OBJECT"
  | "MISSING_FIELD"
  | "UNKNOWN_FIELD"
  | "EVENT_ID_INVALID"
  | "TIMESTAMP_INVALID"
  | "METRIC_NAME_INVALID"
  | "VALUE_INVALID"
  | "METADATA_INVALID"
  | "METADATA_TOO_DEEP"
  | "METADATA_TOO_MANY_KEYS";

export type TelemetryValidation =
  | { readonly ok: true; readonly event: UniversalTelemetryEvent }
  | {
      readonly ok: false;
      readonly code: TelemetryInvalidCode;
      /** Names the offending field. Never echoes the value -- see the note below. */
      readonly reason: string;
    };

/**
 * THE REASON NEVER ECHOES THE VALUE.
 *
 * The field NAME is safe and is what makes the error actionable. The value is not:
 * a `metricName` can carry anything an upstream system put in it, and a rejection
 * message is a string that gets logged, shipped, and pasted into a ticket. So this
 * reports where the problem is and never what the problem contained.
 */
const refuse = (code: TelemetryInvalidCode, reason: string): TelemetryValidation => ({
  ok: false,
  code,
  reason,
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A DATE THAT IS A DATE.
 *
 * `Date.parse` accepts a great deal that is not an instant -- bare dates, times
 * without an offset, some two-digit years. The shape is checked first so the only
 * thing `Date.parse` is asked to validate is a string already known to be
 * ISO-8601-with-offset, and then the result is checked for finiteness, because
 * `Date.parse("")` is `NaN` and a NaN timestamp compares false against everything.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

function isValidInstant(candidate: unknown): candidate is string {
  if (typeof candidate !== "string" || !ISO_INSTANT.test(candidate)) return false;
  return Number.isFinite(Date.parse(candidate));
}

/**
 * KEYS THAT CAN REACH `Object.prototype` AND SO MUST NEVER BE COPIED.
 *
 * A metadata key is copied into a freshly built object, and `__proto__` on the right
 * of an assignment is the prototype setter rather than an own-property setter. So
 * `out["__proto__"] = { ... }` does not add a field: it changes what `out` inherits,
 * which is prototype pollution arriving through a telemetry record.
 *
 * This is not hypothetical, and the way in is `JSON.parse`, which creates a real
 * OWN property called `__proto__` where an object LITERAL does not -- so
 * `{ __proto__: "x" }` in a test is inert and would have hidden this entirely. The
 * realistic vector is a JSON payload on a topic, which is exactly what this
 * consumer is fed.
 *
 * Refused outright rather than sanitised: nothing in a telemetry record legitimately
 * needs these names, and a record that uses one is a producer that should be told.
 */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * METADATA, VALIDATED RECURSIVELY AGAINST THE DEPTH CAP.
 *
 * `depth` counts nested records, so a flat metadata object is depth 1 and the cap
 * of 4 admits three levels of nesting beneath it. The cap is checked BEFORE
 * descending, which is what makes it a bound on work rather than a check performed
 * after the damage.
 */
function validateMetadataValue(
  value: unknown,
  depth: number,
  path: string,
): { ok: true; value: TelemetryMetadataValue } | { ok: false; failure: TelemetryValidation } {
  if (value === null) return { ok: true, value: null };

  const kind = typeof value;
  if (kind === "string") {
    const text = value as string;
    if (text.length > MAX_METADATA_STRING_BYTES) {
      return { ok: false, failure: refuse("METADATA_INVALID", `${path} exceeds the string length limit`) };
    }
    return { ok: true, value: text };
  }
  if (kind === "number") {
    if (!Number.isFinite(value as number)) {
      return { ok: false, failure: refuse("METADATA_INVALID", `${path} is not a finite number`) };
    }
    return { ok: true, value: value as number };
  }
  if (kind === "boolean") return { ok: true, value: value as boolean };

  if (!isPlainObject(value)) {
    // Arrays and undefined land here, and are refused rather than coerced.
    return { ok: false, failure: refuse("METADATA_INVALID", `${path} is not a metadata scalar or record`) };
  }

  if (depth >= MAX_METADATA_DEPTH) {
    return { ok: false, failure: refuse("METADATA_TOO_DEEP", `${path} is nested deeper than the limit`) };
  }

  const keys = Object.keys(value);
  if (keys.length > MAX_METADATA_KEYS) {
    return { ok: false, failure: refuse("METADATA_TOO_MANY_KEYS", `${path} has more keys than the limit`) };
  }

  const out: Record<string, TelemetryMetadataValue> = {};
  for (const key of keys) {
    if (FORBIDDEN_KEYS.has(key)) {
      return { ok: false, failure: refuse("METADATA_INVALID", `${path} uses a key that can reach Object.prototype`) };
    }
    if (key.length > MAX_METADATA_KEY_BYTES || CONTROL_CHARACTERS.test(key)) {
      return { ok: false, failure: refuse("METADATA_INVALID", `${path} has an unusable key`) };
    }
    const nested = validateMetadataValue(value[key], depth + 1, `${path}.${key}`);
    if (!nested.ok) return nested;
    // defineProperty rather than assignment: a plain assignment would invoke the
    // `__proto__` setter. The forbidden-key check above is the real guard -- this is
    // the second line, so that the copy is safe even if that list is ever widened.
    Object.defineProperty(out, key, {
      value: nested.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return { ok: true, value: out };
}

/**
 * THE VALIDATOR. TOTAL, NON-THROWING, AND THE ONLY PLACE THESE RULES LIVE.
 *
 * It takes `unknown` because the caller is JSON.parse output and the entire purpose
 * is to establish that it is something else. A validator that accepts a typed
 * argument and returns a boolean has already trusted its input.
 *
 * It throws nothing. Every refusal is a return value, because the caller is a
 * stream consumer that must survive whatever a topic publishes, and a validator
 * that can throw is a consumer that can be stopped by a payload.
 */
export function validateUniversalTelemetryEvent(input: unknown): TelemetryValidation {
  if (!isPlainObject(input)) {
    return refuse("NOT_AN_OBJECT", "the payload is not a JSON object");
  }

  /**
   * UNKNOWN TOP-LEVEL FIELDS ARE REFUSED.
   *
   * This is the strict half of "agnostic", and it is where agnosticism is actually
   * enforced. If unknown fields were carried through, every source-specific field
   * would leak into the envelope, every consumer would learn to tolerate junk, and
   * a producer adding `datadog_tags` would change the contract for everybody.
   *
   * Refusing means the producer learns immediately that source-specific detail
   * belongs in `metadata`, which is where it fits and costs nothing.
   */
  for (const key of Object.keys(input)) {
    if (!(ENVELOPE_FIELDS as readonly string[]).includes(key)) {
      return refuse("UNKNOWN_FIELD", `the payload carries a field the envelope does not define: ${key}`);
    }
  }

  for (const field of ENVELOPE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) {
      return refuse("MISSING_FIELD", `the payload is missing ${field}`);
    }
  }

  const { eventId, timestamp, metricName, value, metadata } = input;

  if (typeof eventId !== "string" || eventId.length === 0) {
    return refuse("EVENT_ID_INVALID", "eventId must be a non-empty string");
  }
  if (eventId.length > MAX_EVENT_ID_BYTES || CONTROL_CHARACTERS.test(eventId)) {
    return refuse("EVENT_ID_INVALID", "eventId exceeds the length limit or contains a control character");
  }

  if (!isValidInstant(timestamp)) {
    return refuse("TIMESTAMP_INVALID", "timestamp must be ISO-8601 with an explicit timezone offset");
  }

  /**
   * The metric name is checked against a SHAPE, not just a length.
   *
   * A metric name is used as a key in a dictionary and printed into dashboards and
   * log lines. Constraining it to identifier characters means it cannot smuggle a
   * separator, a newline, or a prototype-polluting key into anything downstream.
   */
  if (typeof metricName !== "string" || !METRIC_NAME_SHAPE.test(metricName)) {
    return refuse("METRIC_NAME_INVALID", "metricName must be a non-empty identifier of letters, digits, . _ : / -");
  }
  if (metricName.length > MAX_METRIC_NAME_BYTES) {
    return refuse("METRIC_NAME_INVALID", "metricName exceeds the length limit");
  }

  // The single check that protects every downstream average.
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return refuse("VALUE_INVALID", "value must be a finite number");
  }

  if (!isPlainObject(metadata)) {
    return refuse("METADATA_INVALID", "metadata must be a JSON object");
  }
  const checked = validateMetadataValue(metadata, 1, "metadata");
  if (!checked.ok) return checked.failure;

  return {
    ok: true,
    event: {
      eventId,
      timestamp,
      metricName,
      value,
      metadata: checked.value as TelemetryMetadata,
    },
  };
}