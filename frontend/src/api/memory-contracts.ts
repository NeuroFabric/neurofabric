import type { ShapeIssue } from "./contracts";

/**
 * THE DIFF, AS THE BROWSER RECEIVES IT.
 *
 * === WHY THIS FILE EXISTS AT ALL, GIVEN THE TYPE ALREADY DESCRIBES IT ===
 *
 * Because a TypeScript type is erased. `const diff: ReconciliationDiff =
 * JSON.parse(text)` moves a string into a variable and labels it; if the server
 * grew a field, renamed one, or answered with a refusal body where a document
 * was promised, the program keeps running and renders `undefined.length`.
 *
 * That is not hypothetical here in the way it is elsewhere. **This is the one
 * screen whose whole job is to be believed when other things are wrong.** A diff
 * panel that silently renders an empty list because a field moved is the most
 * expensive possible failure for this product: it reports "nothing has changed"
 * precisely when the operator needs to know something did.
 *
 * So the envelope is validated at the boundary, and a failure to validate is a
 * REFUSAL to render rather than an empty list.
 *
 * === UNKNOWN FIELDS ARE IGNORED, MISSING ONES ARE NOT ===
 *
 * Same rule as `contracts.ts`, and for the same reason: the server owns the shape
 * and may grow it, so an unrecognised key is not an error. But every field the
 * panel DRAWS is required, because each one is load-bearing for a promise made in
 * words -- `source` is what says which half is being shown, `at` is what stops a
 * stale comparison reading as current, and `acknowledged` is what separates "seen"
 * from "not seen".
 */

/** The five legal disagreements. Mirrors `platform/memory/reconcile.ts`. */
export type DifferenceKind =
  | "schema-not-accepted-now"
  | "no-live-window-yet"
  | "provider-not-in-record"
  | "record-version-behind-code"
  | "verdict-newer-than-live";

const KIND_SET: ReadonlySet<DifferenceKind> = new Set<DifferenceKind>([
  "schema-not-accepted-now",
  "no-live-window-yet",
  "provider-not-in-record",
  "record-version-behind-code",
  "verdict-newer-than-live",
]);

/**
 * PLAIN WORDS FOR THE FIVE, AND THE WORDS ARE THE FEATURE.
 *
 * A reconciliation that reports "schema-not-accepted-now" has told an operator
 * nothing they can act on. Each entry says what happened in a sentence a person
 * would use, and each one says it in the product's own honest register rather
 * than in the register of a validation library.
 *
 * A kind added to the backend without an entry here renders as a raw token -- and
 * that is deliberate rather than a gap. `DIFFERENCE_WORDS` is typed
 * `Record<DifferenceKind, string>`, so the type gate fails when the union grows,
 * which is what stops an un-translated label from reaching an operator.
 */
export const DIFFERENCE_WORDS: Record<DifferenceKind, { readonly title: string; readonly because: string }> = {
  "schema-not-accepted-now": {
    title: "An agent this build's rules no longer accept",
    because: "The rules tightened after this agent was written. Nothing has been changed for you.",
  },
  "no-live-window-yet": {
    title: "A registered agent with nothing arriving yet",
    because: "Expected straight after a restart. It matters only if it stays this way.",
  },
  "provider-not-in-record": {
    title: "A source the record has never seen",
    because: "The wedge is pointed somewhere new. Its history starts from now.",
  },
  "record-version-behind-code": {
    title: "The record is behind this build",
    because: "A migration is pending or was interrupted. It is safe to re-run.",
  },
  "verdict-newer-than-live": {
    title: "The record is ahead of the live window",
    because: "The window starts empty after a restart, so history leads. The two are not in conflict.",
  },
};

export interface MemoryDifference {
  readonly key: string;
  readonly kind: DifferenceKind;
  readonly subject: string;
  /** What the record has. */
  readonly recorded: string;
  /** What the running system has. */
  readonly live: string;
  /** What the operator can DO. Never empty, never a repair the system performed. */
  readonly whatToDo: string;
  /** True once a person has looked at THIS difference. Not "resolved". */
  readonly acknowledged: boolean;
  /** When they looked. Null while unacknowledged. Pairs with the boolean. */
  readonly acknowledgedAt: number | null;
  /** How many times this difference has come back and been looked at again. */
  readonly seenCount: number;
}

export interface MemoryCorruption {
  readonly subject: string;
  readonly what: string;
}

/** What the record believes. The other half of the two-truths contract. */
export interface RecordedVerdict {
  readonly agentId: string;
  readonly at: string;
  readonly provider: string;
  readonly records: number;
  readonly breached: boolean;
}

export interface RecordedAlert {
  readonly id: string;
  readonly agentId: string;
  readonly raisedAt: string;
  readonly severity: string;
  readonly acknowledged: boolean;
}

export interface ReconciliationDiff {
  /** When the comparison was made. Half of what follows is a moving window. */
  readonly at: string;
  /** Always "the record". Present so the panel can SAY which half it shows. */
  readonly source: string;
  readonly tenant: string;
  readonly recordVersion: number;
  readonly expectedVersion: number;
  readonly summary: string;
  readonly differences: readonly MemoryDifference[];
  /** Separate on purpose: corruption is WRONG, a difference merely CHANGED. */
  readonly corruptions: readonly MemoryCorruption[];
  readonly recorded: {
    readonly verdicts: readonly RecordedVerdict[];
    readonly alerts: readonly RecordedAlert[];
  };
}

/** What an acknowledgement is. Deliberately smaller than "resolved". */
export interface Acknowledgement {
  readonly key: string;
  readonly kind: string;
  readonly subject: string;
  readonly at: number;
  readonly actor: string;
  readonly seenCount: number;
}

export interface AcknowledgeResult {
  readonly acknowledged: Acknowledgement | null;
  /** The server says, in the response, that the difference is still open. */
  readonly stillOpen: boolean;
  readonly subject: string;
  readonly whatToDo: string;
}

/* ------------------------------------------------------------------ */

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function issue(issues: ShapeIssue[], path: string, reason: string): void {
  issues.push({ path, reason });
}

function text(input: unknown, path: string, issues: ShapeIssue[]): string {
  if (typeof input !== "string") {
    issue(issues, path, "a string is required");
    return "";
  }
  return input;
}

function count(input: unknown, path: string, issues: ShapeIssue[]): number {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    issue(issues, path, "a number is required");
    return 0;
  }
  return input;
}

function flag(input: unknown, path: string, issues: ShapeIssue[]): boolean {
  if (typeof input !== "boolean") {
    issue(issues, path, "true or false is required");
    return false;
  }
  return input;
}

function list(input: unknown, path: string, issues: ShapeIssue[]): unknown[] {
  if (!Array.isArray(input)) {
    issue(issues, path, "a list is required");
    return [];
  }
  return input;
}

function validateDifference(input: unknown, path: string, issues: ShapeIssue[]): MemoryDifference | null {
  if (!isRecord(input)) {
    issue(issues, path, "a difference must be an object");
    return null;
  }
  const kind = input.kind;
  if (typeof kind !== "string" || !KIND_SET.has(kind as DifferenceKind)) {
    // AN UNRECOGNISED KIND IS REFUSED, NOT IGNORED. Every other validator in
    // this directory ignores what it does not recognise, and this one must not --
    // because an unknown kind is a difference the platform cannot explain, and
    // rendering it as an unlabelled row is exactly the skimming ADR-005 warns
    // about. Refusing makes the gap visible instead of hiding it.
    issue(issues, `${path}.kind`, `"${String(kind)}" is not one of the five legal differences`);
    return null;
  }
  return {
    key: text(input.key, `${path}.key`, issues),
    kind: kind as DifferenceKind,
    subject: text(input.subject, `${path}.subject`, issues),
    recorded: text(input.recorded, `${path}.recorded`, issues),
    live: text(input.live, `${path}.live`, issues),
    whatToDo: text(input.whatToDo, `${path}.whatToDo`, issues),
    acknowledged: flag(input.acknowledged, `${path}.acknowledged`, issues),
    // `acknowledgedAt` is nullable rather than optional: "not acknowledged" is a
    // STATE and the client branches on it, so it must be PRESENT as null instead
    // of absent -- the same missing-is-not-undefined rule `contracts.ts` states.
    acknowledgedAt: input.acknowledgedAt === null ? null : count(input.acknowledgedAt, `${path}.acknowledgedAt`, issues),
    seenCount: count(input.seenCount, `${path}.seenCount`, issues),
  };
}

export function validateReconciliationDiff(input: unknown): { ok: true; value: ReconciliationDiff } | { ok: false; issues: readonly ShapeIssue[] } {
  const issues: ShapeIssue[] = [];
  if (!isRecord(input)) {
    issue(issues, "$", "the diff must be an object");
    return { ok: false, issues };
  }

  const differences = list(input.differences, "differences", issues)
    .map((entry, index) => validateDifference(entry, `differences[${index}]`, issues))
    .filter((entry): entry is MemoryDifference => entry !== null);

  const corruptions = list(input.corruptions, "corruptions", issues)
    .filter(isRecord)
    .map((entry, index) => ({
      subject: text(entry.subject, `corruptions[${index}].subject`, issues),
      what: text(entry.what, `corruptions[${index}].what`, issues),
    }));

  const recordedRaw = isRecord(input.recorded) ? input.recorded : {};
  if (!isRecord(input.recorded)) issue(issues, "recorded", "the record's own view must be present as an object");

  // EVERY REQUIRED FIELD IS EXTRACTED BEFORE THE VERDICT IS TAKEN.
  //
  // The first version checked `issues` and only then read `at`, `source` and the
  // rest -- so a response missing its own timestamp PASSED validation and then
  // rendered with `at: ""`, which is the one field the panel uses to stop a stale
  // comparison reading as current. A validator that runs after its own verdict is
  // a validator that has already agreed.
  const at = text(input.at, "at", issues);
  const source = text(input.source, "source", issues);
  const tenant = text(input.tenant, "tenant", issues);
  const recordVersion = count(input.recordVersion, "recordVersion", issues);
  const expectedVersion = count(input.expectedVersion, "expectedVersion", issues);
  const summary = text(input.summary, "summary", issues);

  const verdicts = list(recordedRaw.verdicts, "recorded.verdicts", issues)
    .filter(isRecord)
    .map((entry, index) => ({
      agentId: text(entry.agentId, `recorded.verdicts[${index}].agentId`, issues),
      at: text(entry.at, `recorded.verdicts[${index}].at`, issues),
      provider: text(entry.provider, `recorded.verdicts[${index}].provider`, issues),
      records: count(entry.records, `recorded.verdicts[${index}].records`, issues),
      breached: flag(entry.breached, `recorded.verdicts[${index}].breached`, issues),
    }));

  const alerts = list(recordedRaw.alerts, "recorded.alerts", issues)
    .filter(isRecord)
    .map((entry, index) => ({
      id: text(entry.id, `recorded.alerts[${index}].id`, issues),
      agentId: text(entry.agentId, `recorded.alerts[${index}].agentId`, issues),
      raisedAt: text(entry.raisedAt, `recorded.alerts[${index}].raisedAt`, issues),
      severity: text(entry.severity, `recorded.alerts[${index}].severity`, issues),
      acknowledged: flag(entry.acknowledged, `recorded.alerts[${index}].acknowledged`, issues),
    }));

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    value: { at, source, tenant, recordVersion, expectedVersion, summary, differences, corruptions, recorded: { verdicts, alerts } },
  };
}

export function validateAcknowledgeResult(input: unknown): { ok: true; value: AcknowledgeResult } | { ok: false; issues: readonly ShapeIssue[] } {
  const issues: ShapeIssue[] = [];
  if (!isRecord(input)) {
    issue(issues, "$", "the acknowledgement result must be an object");
    return { ok: false, issues };
  }
  const raw = input.acknowledged;
  const acknowledged = isRecord(raw)
    ? {
        key: text(raw.key, "acknowledged.key", issues),
        kind: text(raw.kind, "acknowledged.kind", issues),
        subject: text(raw.subject, "acknowledged.subject", issues),
        at: count(raw.at, "acknowledged.at", issues),
        actor: text(raw.actor, "acknowledged.actor", issues),
        seenCount: count(raw.seenCount, "acknowledged.seenCount", issues),
      }
    : null;
  if (raw !== null && acknowledged === null) issue(issues, "acknowledged", "an acknowledgement must be an object or null");

  const stillOpen = flag(input.stillOpen, "stillOpen", issues);
  const subject = text(input.subject, "subject", issues);
  const whatToDo = text(input.whatToDo, "whatToDo", issues);

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: { acknowledged, stillOpen, subject, whatToDo } };
}
