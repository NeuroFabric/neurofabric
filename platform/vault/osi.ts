/**
 * OPERATOR STANDING INSTRUCTIONS.
 *
 * === WHAT THIS IS, AND WHY IT NEEDS FENCES RATHER THAN TRUST ===
 *
 * Every other control in the vault series exists because a PERSON decides whether a
 * credential is read. An OSI removes that person for the cases it covers, which
 * means every question about attribution has to keep its answer in a world where
 * some decisions were made in advance.
 *
 * So it starts from "when may nobody be asked?", and the answer is deliberately
 * narrow. An instruction may authorise only a REDUCED exposure. A live value in a
 * model's context is not something a document signed weeks ago can consent to on
 * behalf of whoever is on call that night, so `raw` is not configurable — refused at
 * PARSE time, and refused again at evaluation time, because a schema that documents
 * a limit is a comment and a config file is exactly where somebody will try it.
 *
 * === THREE THINGS ARE NOT OPTIONAL, AND ALL THREE ARE ENFORCED HERE ===
 *
 *   1. AN EXPIRY. A standing instruction with no window is a permanent waiver signed
 *      by somebody who is not in the room when it is used. The same argument that
 *      made an untimed capability a refusal applies here and applies harder: a
 *      capability expires in minutes; these are expected to last weeks.
 *
 *   2. A NAMED HUMAN. An OSI decision is attributed to the person who WROTE the
 *      instruction, even though nobody was present for the individual read. Without
 *      it the ledger contains a grant attributable to nobody — the exact row shape
 *      ADR-009 §3.3 exists to prevent.
 *
 *   3. A JUSTIFICATION, in prose, that travels into the ledger. "Because policy" is
 *      not an answer an investigator can use.
 *
 * === REJECTED INSTRUCTIONS GRANT NOTHING ===
 *
 * One bad entry does not fall back to a permissive default and does not take the
 * file down with it — it is rejected individually, named, and the rest load. A
 * policy file that fails to parse yields no instructions at all, because "the file
 * was unreadable" and "no standing instructions exist" must never be the same
 * decision made in opposite directions.
 *
 * === PATTERNS ARE PREFIXES, NOT GLOBS ===
 *
 * `payments/*` means "entries under payments/". It does not mean "anything the
 * caller says starts with these characters", so a name like `payments/../../billing/
 * token` cannot be matched by the `payments/*` instruction even though a caller
 * might hope it would be. The entry name is resolved by the vault from the tenant's
 * own listing, so a traversal string matches nothing rather than something else.
 */

/**
 * The exposure vocabulary, declared here rather than imported.
 *
 * `Exposure` lives in `reader.ts` as well, and importing it would make this module
 * depend on the reader for a two-word union. Duplicated deliberately, with a test
 * asserting the two agree -- a shared type would create an import edge from the
 * policy layer into the read layer for no benefit.
 */
export type StandingCeiling = "metadata" | "reference";

/** What a caller may ask for. Mirrors `Exposure` in `reader.ts`. */
export type Exposure = "metadata" | "reference" | "raw";

export interface StandingInstruction {
  readonly id: string;
  readonly tenant: string;
  /** Entry-name prefixes this covers, e.g. `payments/`. */
  readonly credentialPatterns: readonly string[];
  /** The most it may authorise. Never `raw`, and not configurable. */
  readonly maxExposure: StandingCeiling;
  readonly expiresAt: number;
  readonly justification: string;
  /** WHO wrote this. Travels into the ledger on every decision it pre-approves. */
  readonly approvedBy: string;
}

export interface RejectedInstruction {
  readonly id: string;
  /** Why it was refused. Never echoes its contents. */
  readonly reason: string;
}

export interface StandingPolicy {
  readonly instructions: readonly StandingInstruction[];
  readonly rejected: readonly RejectedInstruction[];
}

export interface OsiSubject {
  readonly tenant: string;
  readonly credentialName: string;
  readonly exposure: Exposure;
}

export type OsiVerdict =
  | { readonly applies: false; readonly reason: string }
  | { readonly applies: true; readonly instruction: StandingInstruction };

/** Ordering matters only for "not more than"; metadata is less than reference. */
const CEILING_RANK: Readonly<Record<StandingCeiling, number>> = { metadata: 1, reference: 2 };

/**
 * Parse a policy document.
 *
 * Never throws. A policy file is operator input, and an embassy that will not start
 * because an instruction was malformed is an embassy that cannot be started at all —
 * including to REFUSE credentials, which is the one job it must always be able to do.
 */
export function parseStandingInstructions(raw: string, source: string, now: number): StandingPolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { instructions: [], rejected: [{ id: source, reason: "the policy file is not valid JSON" }] };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { instructions: [], rejected: [{ id: source, reason: "the policy file is not an object" }] };
  }

  const entries = (parsed as { standingInstructions?: unknown }).standingInstructions;
  if (!Array.isArray(entries)) {
    return { instructions: [], rejected: [{ id: source, reason: "the policy declares no instruction list" }] };
  }

  const instructions: StandingInstruction[] = [];
  const rejected: RejectedInstruction[] = [];

  for (const [index, entry] of entries.entries()) {
    const label = `entry ${index}`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      rejected.push({ id: label, reason: "the entry is not an object" });
      continue;
    }
    const record = entry as Record<string, unknown>;
    const id = typeof record["id"] === "string" && record["id"] !== "" ? record["id"] : label;

    /**
     * RAW FIRST, and first on purpose.
     *
     * Checked before the field types so that `maxExposure: "raw"` is refused as the
     * specific thing it is, rather than being accepted as a string and then failing
     * some later comparison where the reason would be "invalid type" and the operator
     * would go looking for a schema problem rather than a policy one.
     */
    if (record["maxExposure"] === "raw") {
      rejected.push({ id, reason: "an instruction may not stand in for a person approving a raw value" });
      continue;
    }

    const tenant = record["tenant"];
    const patterns = record["credentialPatterns"];
    const ceiling = record["maxExposure"];
    const expiresAt = record["expiresAt"];
    const justification = record["justification"];
    const approvedBy = record["approvedBy"];

    if (typeof tenant !== "string" || tenant.trim() === "") {
      rejected.push({ id, reason: "an instruction must name one tenant" });
      continue;
    }
    if (!Array.isArray(patterns) || patterns.length === 0 || !patterns.every((p) => typeof p === "string" && p !== "")) {
      rejected.push({ id, reason: "an instruction must name at least one entry pattern" });
      continue;
    }
    if (typeof ceiling !== "string" || !(ceiling in CEILING_RANK)) {
      rejected.push({ id, reason: "an instruction may only authorise metadata or a reference" });
      continue;
    }
    if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
      rejected.push({ id, reason: "an instruction must carry a numeric expiry" });
      continue;
    }
    if (expiresAt <= now) {
      rejected.push({ id, reason: "the instruction has already expired" });
      continue;
    }
    if (typeof approvedBy !== "string" || approvedBy.trim() === "") {
      rejected.push({ id, reason: "an instruction must name the human who approved it" });
      continue;
    }
    if (typeof justification !== "string" || justification.trim() === "") {
      rejected.push({ id, reason: "an instruction must state its justification" });
      continue;
    }

    instructions.push({
      id,
      tenant,
      credentialPatterns: patterns as readonly string[],
      maxExposure: ceiling as StandingCeiling,
      expiresAt,
      justification,
      approvedBy: approvedBy.trim(),
    });
  }

  return { instructions, rejected };
}

/**
 * IS THIS A WELL-FORMED ENTRY NAME AT ALL?
 *
 * A name that walks upwards or is rooted is not a credential anybody provisioned, so
 * it must not be treated as one -- and in particular it must not be PRE-APPROVED by
 * an instruction that covers the `payments/` prefix. `payments/../../billing/token`
 * starts with `payments/`, so a bare prefix test would wave it through and pre-approve
 * a request nobody ever approved.
 *
 * The read itself would still resolve to nothing, because the vault only answers to
 * names it actually holds. This is about not letting a request that is obviously not
 * a credential skip the approval step on the way to finding that out.
 */
function isEntryName(name: string): boolean {
  if (name === "" || name.startsWith("/") || name.includes("..")) return false;
  return name.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** A pattern is a PREFIX. A caller cannot make `payments/*` match a traversal. */
function matchesPattern(name: string, pattern: string): boolean {
  if (pattern.endsWith("*")) return name.startsWith(pattern.slice(0, -1));
  return name === pattern;
}

/**
 * Does an instruction cover this request?
 *
 * The reasons are returned rather than logged, because the caller writes the decision
 * and an investigator reading the ledger later needs to know WHY nobody was asked.
 */
export function evaluateStandingInstruction(
  instructions: readonly StandingInstruction[],
  subject: OsiSubject,
  now: number,
): OsiVerdict {
  if (subject.exposure === "raw") {
    return { applies: false, reason: "no instruction may pre-approve a raw value" };
  }
  if (!isEntryName(subject.credentialName)) {
    return { applies: false, reason: "the requested entry name is not a well-formed entry" };
  }

  let reason = "no standing instruction covers this request";
  for (const instruction of instructions) {
    if (instruction.tenant !== subject.tenant) {
      reason = "the covering instruction names another tenant";
      continue;
    }
    if (instruction.expiresAt <= now) {
      reason = "the covering instruction has expired";
      continue;
    }
    if (!instruction.credentialPatterns.some((pattern) => matchesPattern(subject.credentialName, pattern))) {
      reason = "the covering instruction does not name this entry";
      continue;
    }
    if (CEILING_RANK[instruction.maxExposure] < CEILING_RANK[subject.exposure as StandingCeiling]) {
      reason = "the covering instruction is not permitted to authorise this exposure";
      continue;
    }
    return { applies: true, instruction };
  }

  return { applies: false, reason };
}