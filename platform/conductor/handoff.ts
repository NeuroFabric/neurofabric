/**
 * CONTEXT HANDOFF: ONE AGENT ASSUMES AN INCIDENT ANOTHER ONE HAS ALREADY OPENED.
 *
 * === THE PROBLEM, IN ONE SENTENCE ===
 *
 * An incident is recognised by one specialist and has to be worked by another. An
 * SRE sees `auth.login.failed` and knows the SecOps agent needs to be looking at the
 * same incident, with the same already-approved credential — and NOT a second
 * human, because the approval for that incident already exists and asking again
 * spends a person's attention on a decision they have already made.
 *
 * === THE TWO THINGS THIS MUST NOT DO ===
 *
 * **1. Never carry a credential.** There is no field on `ContextHandoff` that a
 * credential can be put in. What travels is names, an exposure, an incident id and
 * a bounded list of observations. The value itself is reachable only through the
 * approval gate, by the agent the handoff was addressed to, once.
 *
 * **2. Never ask the human twice.** The handoff carries an INHERITED approval, not a
 * new one. Nothing here mints, extends or re-approves anything: `offer` refuses a
 * token that was not already approved, so there is no path by which this protocol
 * can widen somebody's grant.
 *
 * === WHY THE SUBJECT COMES FROM THE TOKEN AND NEVER FROM THE SENDER ===
 *
 * The obvious implementation has agent A fill in `tenant`, `credentialName` and
 * `exposure` and hand them to B. That is a request for one credential with the
 * authority of an approval for a different one, and any bug in A becomes a
 * cross-tenant read in B.
 *
 * So the request carries a TOKEN and nothing else about the subject. The router
 * resolves the subject from the approval the token refers to, and the sender's
 * asserted subject is not merely untrusted — it does not exist.
 *
 * === AND WHY THE TOKEN IS NOT SERIALISED ===
 *
 * The token is a bearer for an approved result. `ContextHandoff` is an in-process
 * structure between two agents in one process; handing the token to B in memory is
 * not "in transit". Crossing a process boundary it WOULD be, so nothing here
 * serialises a handoff, `handoffId` is not derived from the token, and the token is
 * held in a private map rather than being a field anybody can log by accident.
 *
 * === THE OBSERVATIONS ARE A TRUST BOUNDARY, AND SAYING SO IS THE POINT ===
 *
 * `observations` is free text written by an agent, and this router does NOT pretend
 * it can detect a credential in it. No heuristic can: a key looks like any other
 * 40-character string. It is bounded in length and count and screened for control
 * characters, which stops an accident, and it is documented as free text, which is
 * what stops a design that assumes otherwise.
 *
 * The guarantee this module makes is that IT never adds a credential. What a
 * registered agent writes into a text field is between that agent and the operator
 * reading the transcript.
 */

import { randomBytes } from "node:crypto";

import type { SwarmDispatcher } from "./swarm-dispatcher.ts";

/** What an agent says when it wants another to take over. */
export interface ContextHandoffRequest {
  /** The agent giving up the incident. Must be registered. */
  readonly from: string;
  /** The agent taking it on. Must be registered. */
  readonly to: string;
  /** Correlation for the incident, not for the handoff. */
  readonly incidentId: string;
  /**
   * The approval agent A is inheriting.
   *
   * A bearer for an approved result. NOT a credential, and not authorisation on its
   * own: it resolves to a decision a human already made, and this router refuses it
   * unless such a decision exists.
   */
  readonly taskToken: string;
  /**
   * Free text. Bounded and control-character-screened, NOT scanned for secrets.
   *
   * See the header: no heuristic detects a credential in a string, and pretending
   * otherwise would be worse than saying so. The typed channel is clean; this field
   * is the agent's own responsibility.
   */
  readonly observations?: readonly string[];
}

/**
 * WHAT AGENT B RECEIVES.
 *
 * There is no credential field here and there cannot be one, which is the property
 * worth stating: the protocol has no place to put one.
 */
export interface ContextHandoff {
  readonly handoffId: string;
  readonly incidentId: string;
  readonly from: string;
  readonly to: string;
  readonly subject: {
    readonly tenant: string;
    readonly credentialName: string;
    readonly exposure: string;
    readonly tool: string;
  };
  /**
   * THE INHERITED APPROVAL.
   *
   * `inherited: true` is not decoration — it tells B that nobody is going to be
   * asked, so B knows not to prompt. It is a fact about this record, not a claim the
   * receiver should have to verify independently.
   */
  readonly approval: {
    readonly inherited: true;
    readonly approvedBy?: string;
    readonly decidedAt: string;
    /** Only the addressed agent receives this, and only while the handoff is unclaimed. */
    readonly taskToken: string;
  };
  readonly observations: readonly string[];
  readonly createdAt: string;
}

export type HandoffRefusalCode =
  | "NOT_AN_OBJECT"
  | "MISSING_FIELD"
  | "BAD_FIELD"
  | "UNKNOWN_SENDER"
  | "UNKNOWN_RECIPIENT"
  | "SELF_HANDOFF"
  | "NO_APPROVAL"
  | "ALREADY_CLAIMED"
  | "NOT_THE_RECIPIENT"
  | "UNKNOWN_HANDOFF"
  | "NOTHING_PENDING"
  | "TOO_MANY_OBSERVATIONS";

export type HandoffOutcome =
  | { readonly ok: true; readonly handoffId: string }
  | { readonly ok: false; readonly code: HandoffRefusalCode; readonly reason: string };

/**
 * THE APPROVAL PORT.
 *
 * Deliberately narrow and deliberately NOT the concrete gate. Two reasons: the gate
 * lives on a branch this is not merged against, and a handoff protocol coupled to a
 * concrete approval implementation would be untestable without one — and would have
 * to be rewritten, not reconfigured, if the gate changed.
 *
 * `resolve` must return undefined for anything that is not a REAL, currently
 * approved decision. That single method is the whole of this protocol's authority,
 * and it is the only thing standing between a forged token and an inherited
 * approval.
 */
export interface ApprovalLookup {
  resolve(token: string):
    | {
        readonly subject: {
          readonly tenant: string;
          readonly credentialName: string;
          readonly exposure: string;
          readonly tool: string;
        };
        readonly approvedBy?: string;
        readonly decidedAt: number;
      }
    | undefined;
}

export interface HandoffRouterOptions {
  /** Registry membership is checked here, so a handoff cannot address a void. */
  readonly dispatcher: SwarmDispatcher;
  readonly approvals: ApprovalLookup;
  readonly now?: () => number;
  /** Bound on unclaimed handoffs. A flood of offers must not grow this forever. */
  readonly maxPending?: number;
  readonly maxObservations?: number;
  readonly maxObservationLength?: number;
  readonly onRefused?: (code: HandoffRefusalCode, reason: string) => void;
}

const DEFAULT_MAX_PENDING = 256;
const DEFAULT_MAX_OBSERVATIONS = 16;
const DEFAULT_MAX_OBSERVATION_LENGTH = 512;

// eslint-disable-next-line no-control-regex -- screening for these IS the check
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export class ContextHandoffRouter {
  readonly #dispatcher: SwarmDispatcher;
  readonly #approvals: ApprovalLookup;
  readonly #now: () => number;
  readonly #maxPending: number;
  readonly #maxObservations: number;
  readonly #maxObservationLength: number;
  readonly #onRefused: ((code: HandoffRefusalCode, reason: string) => void) | undefined;

  /**
   * Keyed by handoff id. The token lives here and NOT on the record handed around,
   * so logging a `ContextHandoff` cannot leak a bearer by accident.
   */
  #pending = new Map<string, { readonly handoff: ContextHandoff; claimed: boolean }>();
  #offered = 0;
  #delivered = 0;
  #refused = 0;

  constructor(options: HandoffRouterOptions) {
    this.#dispatcher = options.dispatcher;
    this.#approvals = options.approvals;
    this.#now = options.now ?? (() => Date.now());
    this.#maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
    this.#maxObservations = options.maxObservations ?? DEFAULT_MAX_OBSERVATIONS;
    this.#maxObservationLength = options.maxObservationLength ?? DEFAULT_MAX_OBSERVATION_LENGTH;
    this.#onRefused = options.onRefused;
  }

  offer(input: unknown): HandoffOutcome {
    this.#offered += 1;
    const refusal = this.#refuse.bind(this);

    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return refusal("NOT_AN_OBJECT", "a handoff must be an object");
    }
    const request = input as Record<string, unknown>;

    for (const field of ["from", "to", "incidentId", "taskToken"]) {
      if (!Object.prototype.hasOwnProperty.call(request, field)) {
        return refusal("MISSING_FIELD", `a handoff needs ${field}`);
      }
    }
    for (const field of ["from", "to", "incidentId", "taskToken"] as const) {
      const value = request[field];
      if (typeof value !== "string" || value.length === 0 || value.length > 256) {
        return refusal("BAD_FIELD", `${field} is unusable`);
      }
    }

    const from = request["from"] as string;
    const to = request["to"] as string;

    if (from === to) return refusal("SELF_HANDOFF", "an agent cannot hand an incident to itself");

    /**
     * BOTH ENDS MUST EXIST IN THE REGISTRY.
     *
     * A handoff addressed to an unregistered agent is a note passed into the void,
     * and the sender has every reason to believe the receiver is working on it. The
     * sender is checked too: an unregistered agent cannot inherit an approval it was
     * never given.
     */
    if (!this.#dispatcher.hasAgent(from)) return refusal("UNKNOWN_SENDER", `${from} is not a registered agent`);
    if (!this.#dispatcher.hasAgent(to)) return refusal("UNKNOWN_RECIPIENT", `${to} is not a registered agent`);

    const observations = this.#readObservations(request["observations"]);
    if (typeof observations === "string") return refusal("BAD_FIELD", observations);

    /**
     * THE AUTHORITY. Everything above this line checked that the request is
     * well-formed; this line checks that it is TRUE.
     *
     * A token with no approval behind it is refused, which is what makes this
     * protocol incapable of widening a grant: it can only ever carry forward a
     * decision that already exists and has not yet been spent.
     */
    const approval = this.#approvals.resolve(request["taskToken"] as string);
    if (approval === undefined) {
      return refusal("NO_APPROVAL", "that token does not refer to an approval this deployment made");
    }

    if (this.#pending.size >= this.#maxPending) {
      // Bounded. Nobody is claiming their incidents, and this map is growing.
      return refusal("TOO_MANY_OBSERVATIONS", `there are already ${this.#pending.size} unclaimed handoffs`);
    }

    const handoffId = `ho_${randomBytes(12).toString("hex")}`;
    // Deliberately NOT derived from the token: an id that were would let anyone
    // holding a handoffId confirm a guess about a token.
    const handoff: ContextHandoff = {
      handoffId,
      incidentId: request["incidentId"] as string,
      from,
      to,
      subject: {
        tenant: approval.subject.tenant,
        credentialName: approval.subject.credentialName,
        exposure: approval.subject.exposure,
        tool: approval.subject.tool,
      },
      approval: {
        inherited: true,
        ...(approval.approvedBy === undefined ? {} : { approvedBy: approval.approvedBy }),
        decidedAt: new Date(approval.decidedAt).toISOString(),
        taskToken: request["taskToken"] as string,
      },
      observations,
      createdAt: new Date(this.#now()).toISOString(),
    };

    this.#pending.set(handoffId, { handoff, claimed: false });
    return { ok: true, handoffId };
  }

  /**
   * AGENT B TAKES THE INCIDENT.
   *
   * Single use, and addressed. Claiming twice fails, so a handoff cannot be replayed
   * into a second agent; claiming as anyone other than `to` fails, so a third agent
   * cannot pick up an incident it was never given.
   */
  claim(handoffId: string, as: string): ContextHandoff | undefined {
    const entry = this.#pending.get(handoffId);
    if (entry === undefined) {
      this.#refuse("UNKNOWN_HANDOFF", "that handoff id is not one this router issued");
      return undefined;
    }
    if (entry.claimed) {
      this.#refuse("ALREADY_CLAIMED", "that handoff was already claimed");
      return undefined;
    }
    if (entry.handoff.to !== as) {
      // Cross-agent and cross-tenant both fall out of this one comparison.
      this.#refuse("NOT_THE_RECIPIENT", `that handoff was addressed to ${entry.handoff.to}`);
      return undefined;
    }
    entry.claimed = true;
    // Removed on claim, so a second claim cannot find it at all rather than being
    // refused by a flag.
    this.#pending.delete(handoffId);
    this.#delivered += 1;
    return entry.handoff;
  }

  /** Unclaimed handoffs. Administrative; the records carry no token in this view. */
  pending(): readonly Omit<ContextHandoff, "approval">[] {
    return [...this.#pending.values()].map(({ handoff }) => ({
      ...handoff,
      approval: { ...handoff.approval, taskToken: "" },
    }));
  }

  stats(): { offered: number; delivered: number; refused: number; pending: number } {
    return {
      offered: this.#offered,
      delivered: this.#delivered,
      refused: this.#refused,
      pending: this.#pending.size,
    };
  }

  /** Drop everything unclaimed. A handoff nobody took is not an incident. */
  abandon(): void {
    this.#pending.clear();
  }

  /** Returns an error string on failure, or the observations array. */
  #readObservations(value: unknown): readonly string[] | string {
    if (value === undefined) return [];
    if (!Array.isArray(value)) return "observations must be an array";
    if (value.length > this.#maxObservations) {
      return this.#refuse2("TOO_MANY_OBSERVATIONS", `more than ${this.#maxObservations} observations`);
    }
    for (const entry of value) {
      if (typeof entry !== "string") return "an observation must be a string";
      if (entry.length > this.#maxObservationLength) {
        return this.#refuse2("TOO_MANY_OBSERVATIONS", "an observation is too long");
      }
      // Screens an ACCIDENT: a newline in a note corrupts the transcript it is
      // quoted into. It does not screen for a credential, and does not claim to.
      if (CONTROL_CHARACTERS.test(entry)) return "an observation contains a control character";
    }
    return value as readonly string[];
  }

  #refuse2(code: HandoffRefusalCode, reason: string): string {
    this.#refuse(code, reason);
    return reason;
  }

  #refuse(code: HandoffRefusalCode, reason: string): HandoffOutcome {
    this.#refused += 1;
    this.#onRefused?.(code, reason);
    return { ok: false, code, reason };
  }
}

export function createContextHandoffRouter(options: HandoffRouterOptions): ContextHandoffRouter {
  return new ContextHandoffRouter(options);
}