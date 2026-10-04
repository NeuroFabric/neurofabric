import type { MemoryStore } from "./store.ts";

/**
 * BOOT RECONCILIATION. Step 1B, built to ADR-005 §2 and §7.3.
 *
 * === WHY THIS EXISTS, IN ONE PARAGRAPH ===
 *
 * A restart that quietly discards a change is worse than a crash: the crash tells
 * you something is wrong, and the quiet reload tells you everything is fine while
 * your records are in another place. This is the class of bug this project exists
 * to refuse, and this file is the place it is refused.
 *
 * === WHY THE FIVE LEGAL DISAGREEMENTS ARE ENUMERATED ===
 *
 * Because a reconciliation that can report ANYTHING is one nobody reads. If every
 * difference looks possible, the operator learns to skim, and the day a genuine
 * corruption appears they skim past it.
 *
 * So there are exactly five shapes of disagreement that are EXPECTED, each with a
 * stated reason, and everything else is **corruption** — which is reported as an
 * alarm, separately, and never folded into the same list.
 *
 * === WHAT THIS DOES NOT DO ===
 *
 * It does not repair anything, and it does not choose. Every difference is
 * presented with the operator as the resolver. A system that silently migrates a
 * customer's records on boot is making a claim about their data that nobody asked
 * it to make — and in the one case where it would be *wrong*, it would be
 * unfalsifiable.
 */

/** The five legal shapes. Anything else is corruption. */
export type DifferenceKind =
  /** 1. The grammar tightened after this schema was written. */
  | "schema-not-accepted-now"
  /** 2. Expected between a restart and the first reading. */
  | "no-live-window-yet"
  /** 3. The wedge was pointed somewhere new. */
  | "provider-not-in-record"
  /** 4. Migration pending or interrupted. */
  | "record-version-behind-code"
  /** 5. The live window was reset; history is ahead. Expected. */
  | "verdict-newer-than-live";

/** One recognised difference. Carries enough to act on without opening a database. */
export interface Difference {
  readonly kind: DifferenceKind;
  readonly tenant: string;
  /** What it is about: an agent id, a provider, or the record as a whole. */
  readonly subject: string;
  /** What the record has. */
  readonly recorded: string;
  /** What the running system has. */
  readonly live: string;
  /** What the operator can DO about it, in one sentence. */
  readonly whatToDo: string;
}

/** Corruption is NOT a difference. It is an alarm, and it is counted separately. */
export interface Corruption {
  readonly subject: string;
  readonly what: string;
}

/** What the running system believes right now. Compared against the record. */
export interface LiveState {
  readonly providers: readonly string[];
  readonly agentIds: readonly string[];
  /** Per agent: the newest live reading, if any. */
  readonly latest: Readonly<Record<string, number>>;
  /** The code's expected record version. */
  readonly expectedVersion: number;
  /**
   * Can this agent still be registered? A false here produces difference 1 rather
   * than corruption, because a tightened grammar is the LEGITIMATE reason a
   * recorded schema is no longer acceptable.
   */
  readonly accepts?: (document: unknown) => boolean;
}

export interface Reconciliation {
  readonly differences: readonly Difference[];
  readonly corruptions: readonly Corruption[];
  /** True when nothing at all needs the operator's attention. */
  readonly clean: boolean;
}

/**
 * THE IDENTITY OF ONE DIFFERENCE, AND IT LIVES HERE ON PURPOSE.
 *
 * An acknowledgement is durable, so it has to outlive the process that computed
 * the difference it refers to. That means the key cannot be an array index or a
 * render position: it has to be derivable from the difference alone, identically,
 * in the reconciler, in the HTTP route that stores the acknowledgement, and in
 * the component that draws the button.
 *
 * Three definitions of this string would be three chances to disagree, and the
 * failure would be silent and permanent -- an acknowledgement filed against a key
 * that no longer exists, which reads as "never acknowledged" forever.
 *
 * `kind` is first because it is the coarse identity: the same subject can
 * disagree in more than one way over time, and collapsing those into one row
 * would overwrite the earlier reason with the later one.
 */
export function differenceKey(difference: Pick<Difference, "kind" | "subject">): string {
  return `${difference.kind}|${difference.subject}`;
}

export function reconcile(store: MemoryStore, tenant: string, live: LiveState): Reconciliation {
  const differences: Difference[] = [];
  const corruptions: Corruption[] = [];

  /* --- 4. The record's version is behind the code's. ------------------- */
  const recordVersion = store.version();
  if (recordVersion < live.expectedVersion) {
    differences.push({
      kind: "record-version-behind-code",
      tenant,
      subject: "the record itself",
      recorded: `version ${recordVersion}`,
      live: `this build expects version ${live.expectedVersion}`,
      whatToDo: "Run the migration. It is safe to re-run; nothing has been applied twice.",
    });
  }

  const schemas = store.schemasFor(tenant);
  const verdicts = store.verdictsFor(tenant);
  const accepts = live.accepts;

  /* --- 1. A recorded schema the CURRENT validator refuses. -------------- */
  for (const schema of schemas) {
    if (accepts === undefined) continue;
    let ok = true;
    try {
      ok = accepts(schema.document);
    } catch {
      // A validator that throws is not a refusal, and treating it as one would
      // report every schema as invalid the first time a validator changed shape.
      corruptions.push({ subject: `schema ${schema.id}`, what: "the validator threw rather than returning a verdict" });
      continue;
    }
    if (!ok) {
      differences.push({
        kind: "schema-not-accepted-now",
        tenant,
        subject: `agent ${schema.id}`,
        recorded: `version ${schema.version}`,
        live: "this build's rules refuse it",
        whatToDo: "The rules tightened after this agent was written. Update it or retire it; nothing has been changed for you.",
      });
    }
  }

  /* --- 2. A recorded agent with no live window yet. --------------------- */
  for (const schema of schemas) {
    const composite = `${tenant}/${schema.id}`;
    if (!Object.prototype.hasOwnProperty.call(live.latest, composite)) {
      differences.push({
        kind: "no-live-window-yet",
        tenant,
        subject: `agent ${schema.id}`,
        recorded: "registered",
        live: "nothing observed yet",
        whatToDo: "Nothing to do unless it stays this way — then the agent is registered but its stream is not arriving.",
      });
    }
  }

  /* --- 3. A live provider the record has never seen. -------------------- */
  for (const provider of live.providers) {
    const known = verdicts.some((verdict) => verdict.provider === provider);
    if (!known) {
      differences.push({
        kind: "provider-not-in-record",
        tenant,
        subject: `provider ${provider}`,
        recorded: "never seen in this record",
        live: "connected now",
        whatToDo: "This is a new source. Its history starts from now; earlier readings exist under a different provider.",
      });
    }
  }

  /* --- 5. A recorded verdict NEWER than anything live. ------------------- */
  for (const verdict of verdicts) {
    const liveAt = live.latest[verdict.agentId];
    if (liveAt === undefined) continue;
    if (verdict.at > liveAt) {
      differences.push({
        kind: "verdict-newer-than-live",
        tenant,
        subject: `agent ${verdict.agentId}`,
        recorded: new Date(verdict.at).toISOString(),
        live: new Date(liveAt).toISOString(),
        whatToDo: "Expected after a restart: the record is ahead because the live window starts empty. The two are not in conflict.",
      });
    }
  }

  /* --- CORRUPTION, and only these four shapes. -------------------------- */
  for (const schema of schemas) {
    if (isCorruptDocument(schema.document)) {
      corruptions.push({ subject: `schema ${schema.id}`, what: "the stored document is not readable JSON" });
    }
  }
  for (const verdict of verdicts) {
    if (isCorruptDocument(verdict.document)) {
      corruptions.push({ subject: `verdict ${verdict.agentId}`, what: "the stored document is not readable JSON" });
    }
  }
  // A recorded agent that the RUNNING registry knows nothing about, with a live
  // reading for it, is not one of the five. That is a record and a live system
  // describing the same agent differently, and nothing in the record says which.
  for (const agentId of Object.keys(live.latest)) {
    const bare = agentId.startsWith(`${tenant}/`) ? agentId.slice(tenant.length + 1) : agentId;
    const known = schemas.some((schema) => schema.id === bare);
    if (!known) {
      corruptions.push({
        subject: `agent ${agentId}`,
        what: "the live system is reporting an agent that is not in the record, and no legal difference explains it",
      });
    }
  }

  return { differences, corruptions, clean: differences.length === 0 && corruptions.length === 0 };
}

/** A document that came back as the parse-failure sentinel, or is not an object. */
function isCorruptDocument(document: unknown): boolean {
  if (typeof document !== "object" || document === null) return true;
  if (Array.isArray(document)) return true;
  return "__unparseable" in (document as Record<string, unknown>);
}

/**
 * THE ONE-LINE SUMMARY an operator reads first.
 *
 * Corruption is named FIRST and separately, because it is the only category that
 * means something is wrong rather than something changed. Burying it in a list of
 * "differences" is how it becomes something nobody reads.
 */
export function summarise(reconciliation: Reconciliation): string {
  const { corruptions, differences } = reconciliation;
  if (corruptionCount(corruptions) > 0) {
    return `${corruptions.length} problem(s) need attention before this record can be trusted.`;
  }
  if (differences.length === 0) return "Nothing has changed since you were last here.";
  return `${differences.length} difference(s) to look at. Nothing has been changed for you.`;
}

function corruptionCount(corruptions: readonly Corruption[]): number {
  return corruptions.length;
}