import { GatewayError } from "./gateway-client";

/**
 * WHAT THE UI DOES ABOUT A REFUSAL, AND HOW FAST IT ASKS AGAIN.
 *
 * Two decisions that used to be implicit, both of which produced the failure
 * this module exists to stop.
 *
 * === THE FIRST FAILURE: 62 IDENTICAL ERRORS IN 31 SECONDS ===
 *
 * The telemetry hook polled every 500ms with no regard for what the last poll
 * returned. A wrong credential is not a transient fault: it is true on the next
 * request exactly as it was on the last one, and retrying it at 2Hz produces a
 * red console, a load generator pointed at our own server, and no new
 * information. So a credential refusal HALTS polling outright. There is nothing
 * to gain from asking again until a human changes the credential, and a refusal
 * is the one class of fault a retry cannot fix.
 *
 * Everything else -- a server fault, a network blip, a timeout -- DOES back off,
 * exponentially, and the floor matters more than the curve: the first retry
 * waits {@link CREDENTIAL_BACKOFF_FLOOR_MS} regardless of how fast the healthy
 * cadence was. A poll that failed once, for a reason that may already be gone,
 * must not be retried on the next tick.
 *
 * === THE SECOND FAILURE: TWO 401s THAT MEAN DIFFERENT THINGS ===
 *
 * The edge distinguishes them in prose, and the prose is the whole signal:
 *
 *   "no credential presented"    -> nothing arrived. A wiring fault.
 *   "the credential presented is not recognised" -> something arrived and it was
 *                                       wrong. The operator has to retype it.
 *
 * Both arrive as `kind: "refused"`, which is why this was invisible. Classifying
 * by the REASON rather than the status is what turns a wall of identical errors
 * into one line that says what to do. The statuses alone cannot: 401 carries both.
 *
 * === WHY THIS FILE IMPORTS NOTHING REACTIVE ===
 *
 * A backoff schedule is arithmetic and a refusal is a string comparison. Neither
 * needs a DOM, so neither is tested through one. Everything here runs in the
 * `node` test environment with no component rendered, which is what makes "the
 * backoff floors at 5s" an assertion rather than a claim.
 */

/** The states a UI must tell apart. Each one wants a different screen. */
export type CredentialState =
  /** The request succeeded. No credential question is open. */
  | "ok"
  /** Nothing was presented. The client is unwired, not wrong. */
  | "required"
  /** Something was presented and the edge does not know it. Retype it. */
  | "rejected"
  /** Known, and withdrawn. Retyping it cannot help. */
  | "revoked"
  /** Proven, and not permitted for this scope. A different credential, not a new one. */
  | "forbidden"
  /** Routes are mounted but no live gateway is attached. A server-side fault. */
  | "no-gateway"
  /** A refusal this module does not model, or a failure that is not a refusal. */
  | "other";

/**
 * The floor for the first retry, in milliseconds.
 *
 * 5000 rather than "the healthy interval times two". The healthy interval is
 * tuned for a working server and is the wrong number to recover from a broken
 * one: at 500ms the first retry is 1s, at 250ms it is 500ms, and the floor would
 * then be a function of how fast we poll when everything is fine. It is a
 * constant because the thing being prevented -- a refusal retried on every tick
 * -- does not care what the healthy cadence is.
 */
export const CREDENTIAL_BACKOFF_FLOOR_MS = 5_000;

/** The ceiling the doubling stops at. Beyond this, waiting longer buys nothing. */
export const CREDENTIAL_BACKOFF_CEILING_MS = 60_000;

/**
 * The refusals that halt polling.
 *
 * `no-gateway` is deliberately NOT here. A 503 means the server has no live
 * gateway attached, which a server restart with different configuration fixes
 * without anyone touching a credential -- so it backs off rather than stopping,
 * and it renders as a server fault rather than asking for a credential that is
 * not the problem.
 */
const CREDENTIAL_FAULTS: ReadonlySet<CredentialState> = new Set<CredentialState>([
  "required",
  "rejected",
  "revoked",
  "forbidden",
]);

/** True when the fault is one only a new credential can clear. */
export function isCredentialFault(state: CredentialState): boolean {
  return CREDENTIAL_FAULTS.has(state);
}

/**
 * CLASSIFY A FAILURE.
 *
 * Takes `unknown` rather than `GatewayError` because the caller has a `catch`
 * binding and a `throw new Error("...")` from an unwired transport is a real case
 * that must not be mistaken for a successful read.
 *
 * === WHY THE REASON IS MATCHED ON SUBSTRINGS ===
 *
 * The edge's reasons are prose, and pinning this to exact strings would make
 * every reword on the server a client bug: the classification would silently
 * fall through to "other" and the operator would get the generic screen. The
 * substrings are the stable part -- what was presented -- and the classification
 * only depends on that.
 */
export function credentialStateOf(cause: unknown): CredentialState {
  if (!(cause instanceof GatewayError)) return "other";

  if (cause.status === 503) return "no-gateway";
  if (cause.status === 403) return "forbidden";

  // `kind === "refused"` alone is not enough, because the client models a 401 and
  // a 403 as one kind. The status is the finer signal and it is checked first.
  if (cause.status !== 401) return "other";

  const reason = cause.reason.toLowerCase();
  // Order matters only in that "no credential presented" also contains
  // "credential"; the revoked and not-recognised checks are on text that cannot
  // appear in the others.
  if (reason.includes("revoked")) return "revoked";
  if (reason.includes("no credential") || reason.includes("without a credential")) return "required";
  return "rejected";
}

/**
 * THE RETRY SCHEDULE.
 *
 * Mutable, single-consumer, and deliberately not a React hook: a hook would tie
 * the arithmetic to a render, and this arithmetic is exactly what has to be
 * provable without one.
 *
 * Usage is two calls per poll -- `fail` or `succeed` -- and the returned delay
 * is what the scheduler should wait. `null` means do not schedule at all.
 */
export class PollPolicy {
  #attempts = 0;
  #halted = false;
  #ceilingMs: number;

  constructor(options: { readonly ceilingMs?: number } = {}) {
    this.#ceilingMs = options.ceilingMs ?? CREDENTIAL_BACKOFF_CEILING_MS;
  }

  /** Consecutive failures since the last success. Zero after `succeed`. */
  get attempts(): number {
    return this.#attempts;
  }

  /** True when polling has stopped pending a credential change. */
  get halted(): boolean {
    return this.#halted;
  }

  /**
   * Record a failure and return when to ask again.
   *
   * `null` means the caller must not schedule anything. That is the whole point:
   * the caller cannot accidentally keep a timer alive, because the only place a
   * delay is produced is the one that just decided there should not be one.
   */
  fail(state: CredentialState): number | null {
    if (isCredentialFault(state)) {
      // Halted, but the attempt count is KEPT. A run of refusals followed by a
      // credential change and a further refusal should not come back at the
      // floor as though nothing had happened.
      this.#halted = true;
      return null;
    }
    this.#attempts += 1;
    return this.delayFor(this.#attempts);
  }

  /** Record a success. The next failure starts from the floor again. */
  succeed(): void {
    this.#attempts = 0;
    this.#halted = false;
  }

  /**
   * Clear a halt. Called when a human supplies a new credential.
   *
   * The attempt count is cleared too, deliberately: a person who has just typed a
   * credential is not served by a schedule that still remembers the last twenty
   * refusals and opens at the ceiling.
   */
  resume(): void {
    this.#attempts = 0;
    this.#halted = false;
  }

  /**
   * Doubling, from the floor.
   *
   * `Math.min(ceiling, floor * 2^(attempts-1))`, written so the exponent cannot
   * overflow into `Infinity` on a long session: the doubling stops contributing
   * once it passes the ceiling, rather than once it passes the float range.
   */
  delayFor(attempts: number): number {
    if (attempts <= 0) return CREDENTIAL_BACKOFF_FLOOR_MS;
    const shift = Math.min(attempts - 1, 32);
    return Math.min(this.#ceilingMs, CREDENTIAL_BACKOFF_FLOOR_MS * 2 ** shift);
  }
}

/**
 * The one line an operator needs, per state.
 *
 * Kept beside the classification rather than in a component, because the strings
 * are the thing most likely to drift from the states and the easiest to assert
 * on. A state with no screen of its own is a state nobody will notice.
 */
export function describeCredentialState(state: CredentialState): string {
  switch (state) {
    case "ok":
      return "Connected.";
    case "required":
      return "No gateway credential reached the portal. The client is unwired.";
    case "rejected":
      return "The portal does not recognise this gateway credential. Enter the one the server was started with.";
    case "revoked":
      return "That gateway credential was withdrawn. A new one is needed; the same value will not work.";
    case "forbidden":
      return "That gateway credential is not permitted for this scope. A different credential is needed.";
    case "no-gateway":
      return "The portal routes are mounted but no live gateway is attached to that process.";
    case "other":
      return "The last request failed for a reason that is not a credential refusal.";
  }
}

/**
 * The question the screen asks, per state.
 *
 * Separate from {@link describeCredentialState} because the two answer different
 * questions and conflating them produces a sentence that is true of neither: the
 * state sentence says what happened, this one says what to do about it. Asking a
 * withdrawn credential to be "entered again" is the failure -- the same value
 * cannot work, so the loop is the operator's own time.
 */
export function describeCredentialLead(state: CredentialState): string {
  switch (state) {
    case "ok":
      return "Connected.";
    case "required":
      return "The portal has no credential from this browser. Enter one to reach the portal API.";
    case "rejected":
      return "The portal refused the credential this command center is presenting. Enter the one the server was started with.";
    case "revoked":
      return "That credential was withdrawn. Enter a current one; the same value will be refused again.";
    case "forbidden":
      return "That credential is proven but not permitted here. A credential with this scope is needed.";
    case "no-gateway":
      return "The portal routes are mounted, but that process has no live gateway attached. This is a server-side fault, not a credential one.";
    case "other":
      return "The last request failed. The server's own words are below.";
  }
}