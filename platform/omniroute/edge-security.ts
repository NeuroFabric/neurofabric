import { createHash, timingSafeEqual, randomBytes } from "node:crypto";

/**
 * THE EDGE. Where a stranger becomes a caller.
 *
 * === WHY A DECISION FUNCTION RATHER THAN MIDDLEWARE ===
 *
 * The gateway has no transport. It is called from a webhook handler, from a Kafka
 * loop, from a test, and from whatever the operator put in front of it. So the
 * security decision is a PURE FUNCTION over a request-shaped object, and the HTTP
 * plumbing is a thin adapter that maps its result onto a status code. A rule that
 * lives in the transport is a rule a second transport will not have, and the
 * second transport is the one nobody remembers to protect.
 *
 * === ZERO TRUST, MEANING SOMETHING SPECIFIC ===
 *
 * Not a presence check. Each property below is a way a naive check fails:
 *
 *   - THE CREDENTIAL IS PROVEN, NOT PRESENT. Comparison is constant-time over
 *     SHA-256 digests. A plain equality test leaks the value's length and its
 *     prefix through timing, and an attacker with a stopwatch does not need the
 *     value to make millions of attempts.
 *   - A CREDENTIAL NAMES ITS PROVIDERS. One valid for `payments` cannot push to
 *     `telemetry`. A single shared value is the whole attack surface the moment
 *     one partner is compromised, and "we will rotate it later" is not a control.
 *   - ABSENCE IS A 401, NOT A 400. The client did nothing wrong; it presented
 *     nothing. Collapsing the two teaches a caller which half of a guess was
 *     right.
 *   - NOTHING ECHOES THE VALUE. Not in the reason, not in the log line, not in a
 *     thrown error. An error message is the most widely-read log entry a service
 *     has.
 *   - THE CHECK IS BEFORE THE MATH. A rejected payload must not reach the broker,
 *     because a broker that has already counted it has already paid for it -- and
 *     a flood of unverified events is a CPU attack whether or not it is stored.
 *
 * === WHERE THE CREDENTIAL LIST COMES FROM ===
 *
 * The list used to be a hardcoded array, which meant the values that decide who
 * may push events lived in the repository, in every fork of it, in every image
 * built from it. So provisioning is now a `VaultProvider` -- an interface, so an
 * environment variable in development and an external credential store in
 * production are
 * the same call site -- and the rules the loading obeys are stated where the
 * loading is, not where the caller reads about them. See the vault section below.
 *
 * === ONE HEADER, AND WHY ===
 *
 * A single dedicated header carries the value. A deployment that fronts this with
 * some other scheme it already speaks -- a signed request, mutual TLS, a gateway
 * of its own -- maps that scheme to this header at the edge, and keeps one set of
 * rules here. Two accepted shapes inside this module would mean two code paths to
 * keep in step, and the second one is the one nobody remembers.
 */

/** The header the value arrives in. One name, one code path. */
export const CREDENTIAL_HEADER = "x-gateway-token";

/** What the caller presents. Shaped like headers so an adapter is trivial. */
export interface EdgeRequest {
  /** Header names, any casing; matched case-insensitively. */
  readonly headers?: Readonly<Record<string, string | undefined>>;
  /** The provider the caller claims to be pushing to. */
  readonly provider: string;
  /** How many events this request carries. One event unless stated. */
  readonly events?: number;
  /** Path or topic, for scoping beyond the provider. Optional. */
  readonly scope?: string;
}

/** A provisioned caller. The value is write-once at issuance and never readable. */
export interface GatewayToken {
  readonly id: string;
  /** The presented value. Compared by digest, never by string equality. */
  readonly credential: string;
  /** The providers this credential may push to. An empty list means none. */
  readonly providers: readonly string[];
  /** Optional extra scoping, e.g. a topic. */
  readonly scope?: string;
  readonly revoked?: boolean;
}

export interface EdgeDecision {
  readonly ok: boolean;
  /** 401 no proof, 403 proof but not permitted, 429 throttled. */
  readonly status?: number;
  /** A reason safe to show a caller AND to log. Never contains the value. */
  readonly reason?: string;
  /** Seconds to wait, set only on a 429. */
  readonly retryAfterSeconds?: number;
  /** The credential that was proven. Present only on success. */
  readonly tokenId?: string;
}

const UNAUTHENTICATED = (reason: string): EdgeDecision => ({ ok: false, status: 401, reason });
const FORBIDDEN = (reason: string): EdgeDecision => ({ ok: false, status: 403, reason });
const THROTTLED = (reason: string, retryAfterSeconds: number): EdgeDecision =>
  ({ ok: false, status: 429, reason, retryAfterSeconds });

/**
 * A TOKEN BUCKET, per provider.
 *
 * Why a bucket and not a fixed window: a fixed window lets a caller spend its
 * whole allowance at the end of one window and its whole allowance again at the
 * start of the next -- twice the intended rate, delivered in a burst that is
 * precisely what the limit exists to prevent. A bucket refills continuously, so a
 * burst is bounded by what the caller has actually earned.
 *
 * Why it counts EVENTS and not requests: a caller allowed "a thousand requests a
 * second" can put a million events in one of them. The unit that costs the engine
 * is the event, so the unit that is limited is the event.
 *
 * === THE LIMIT IS PER REPLICA, AND THAT IS NOT A FOOTNOTE ===
 *
 * This state is in-process. A fleet of N replicas admits N times the configured
 * rate, and a caller balanced across all of them is never throttled. It is stated
 * here rather than left for an operator to discover, because a limit whose scope
 * is unknown is worse than no limit at all: it looks like a control and is not
 * one.
 *
 * A shared store was rejected deliberately. It puts a network round trip on the
 * hot path to defend a process that is already single-threaded, and its failure
 * mode is a dependency outage becoming an outage. When a genuinely global limit is
 * wanted, the honest shape is a shared store PLUS this local floor, so a store
 * outage degrades to per-replica limiting rather than to no limiting.
 *
 * The clock is injectable so the refill arithmetic is testable without waiting.
 */
export class TokenBucket {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly now: () => number;

  constructor(capacity: number, refillPerSecond: number, now: () => number = Date.now) {
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    this.now = now;
  }

  /** Take `events` tokens for a provider. False means throttled. */
  take(provider: string, events: number): boolean {
    const stamp = this.now();
    const existing = this.buckets.get(provider) ?? { tokens: this.capacity, updatedAt: stamp };
    const elapsed = Math.max(0, (stamp - existing.updatedAt) / 1000);
    const refilled = Math.min(this.capacity, existing.tokens + elapsed * this.refillPerSecond);
    if (refilled < events) {
      // The remaining capacity is KEPT, not discarded. A throttled caller can
      // still send a small batch it has earned; zeroing the bucket would punish it
      // twice for one burst.
      this.buckets.set(provider, { tokens: refilled, updatedAt: stamp });
      return false;
    }
    this.buckets.set(provider, { tokens: refilled - events, updatedAt: stamp });
    return true;
  }

  /** How long until this provider could send `events` again. */
  retryAfterSeconds(provider: string, events: number): number {
    const existing = this.buckets.get(provider);
    if (existing === undefined) return 0;
    const deficit = events - existing.tokens;
    if (deficit <= 0) return 0;
    return Math.ceil(deficit / this.refillPerSecond);
  }
}

/**
 * A constant-time comparison.
 *
 * Both sides are hashed first, which solves the two practical problems at once:
 * `timingSafeEqual` throws on a length mismatch -- leaking length through an
 * exception -- and hashing first means the comparison is over two fixed-size
 * digests regardless of how long the value is.
 */
function credentialEquals(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

function readHeader(
  headers: Readonly<Record<string, string | undefined>> | undefined,
  name: string,
): string | undefined {
  if (headers === undefined) return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    return value === undefined || value.trim().length === 0 ? undefined : value.trim();
  }
  return undefined;
}

/** PULL THE VALUE OUT OF A REQUEST, or undefined when none was presented. */
export function readCredential(request: EdgeRequest): string | undefined {
  return readHeader(request.headers, CREDENTIAL_HEADER);
}

/**
 * PROVE ONE REQUEST.
 *
 * Pure and side-effect free, so it is trivially testable and safe on a hot path.
 * The token list is walked in full rather than looked up in a Map: a Map lookup
 * returns early on a hit and runs to the end on a miss, which is a timing oracle
 * over WHICH value was guessed. With a handful of tokens the cost is nil, and with
 * many the hashing dominates anyway.
 */
export function authenticate(request: EdgeRequest, tokens: readonly GatewayToken[]): EdgeDecision {
  const presented = readCredential(request);
  if (presented === undefined) {
    return UNAUTHENTICATED(`no credential presented: send the ${CREDENTIAL_HEADER} header`);
  }

  let matched: GatewayToken | undefined;
  for (const token of tokens) {
    // Every token is compared, every time. Short-circuiting on the first match
    // would make the time to answer depend on the token's position in the list.
    if (credentialEquals(presented, token.credential) && matched === undefined) matched = token;
  }

  if (matched === undefined) return UNAUTHENTICATED("the credential presented is not recognised");
  if (matched.revoked === true) return UNAUTHENTICATED("that credential has been revoked");

  // ZERO TRUST MEANS SCOPED TRUST: proving who you are is the first question, not
  // the only one.
  if (!matched.providers.includes(request.provider)) {
    return FORBIDDEN(`this credential is not permitted to push to provider ${request.provider}`);
  }
  if (matched.scope !== undefined && matched.scope !== request.scope) {
    return FORBIDDEN("this credential is not permitted for that scope");
  }
  return { ok: true, tokenId: matched.id };
}

/**
 * THE WHOLE EDGE, in one call: prove the caller, then throttle it.
 *
 * The order is load-bearing. Proving first means an unauthenticated flood never
 * reaches the bucket's bookkeeping, so an attacker cannot exhaust a legitimate
 * caller's allowance by sending rubbish under their name -- and throttling a
 * request nobody has paid for is work we would be doing on their behalf.
 *
 * The bucket is per PROVIDER, so one noisy partner cannot spend another's
 * allowance. That fairness is a direct consequence of authenticating first: the
 * provider name is only trustworthy because the credential was proven against it.
 */
export function guard(
  request: EdgeRequest,
  tokens: readonly GatewayToken[],
  limiter?: TokenBucket,
): EdgeDecision {
  const identity = authenticate(request, tokens);
  if (!identity.ok) return identity;
  if (limiter === undefined) return identity;
  const events = request.events === undefined ? 1 : Math.max(1, Math.floor(request.events));
  if (!limiter.take(request.provider, events)) {
    return THROTTLED(
      `provider ${request.provider} is above its rate limit; slow down`,
      limiter.retryAfterSeconds(request.provider, events),
    );
  }
  return identity;
}

/** Issue a credential. The value is returned ONCE, because it is never recoverable. */
export function issueToken(id: string, providers: readonly string[], scope?: string): GatewayToken {
  return {
    id,
    credential: randomBytes(32).toString("base64url"),
    providers,
    ...(scope === undefined ? {} : { scope }),
  };
}

/**
 * THE ADAPTER: a decision as an HTTP response.
 *
 * Deliberately tiny and deliberately the ONLY place a status code appears. Every
 * rule is in `guard`, so a second transport cannot hold a different one.
 */
export function httpResponse(decision: EdgeDecision): {
  status: number;
  body: { status: "FAILED" | "OK"; failure?: { code: string; reason: string } };
  headers: Record<string, string>;
} {
  if (decision.ok) return { status: 200, body: { status: "OK" }, headers: {} };
  // Typed explicitly: the empty branch infers `{ "retry-after"?: undefined }`,
  // which is not assignable to an index signature that promises a string.
  const headers: Record<string, string> = decision.retryAfterSeconds === undefined
    ? {}
    : { "retry-after": String(decision.retryAfterSeconds) };
  return {
    status: decision.status ?? 401,
    body: {
      status: "FAILED",
      failure: {
        code: decision.status === 429
          ? "RATE_LIMITED"
          : decision.status === 403 ? "FORBIDDEN" : "UNAUTHENTICATED",
        reason: decision.reason ?? "refused",
      },
    },
    headers,
  };
}

/* ==================================================================== */
/* THE VAULT: WHERE THE ACTIVE CREDENTIAL LIST COMES FROM               */
/* ==================================================================== */

/**
 * PROVISIONING, AS AN INTERFACE.
 *
 * === WHAT THIS REPLACES AND WHY AN INTERFACE RATHER THAN AN ENV READ ===
 *
 * The list was a hardcoded array. That is a specific and serious problem, not a
 * tidiness one: the values that decide WHO MAY PUSH EVENTS lived in the
 * repository, so they lived in every clone, every branch, every image built from
 * it, and in the history of all of them. Rotating meant a code change, and a code
 * change means a review, and a review is a place a credential ends up written
 * down.
 *
 * So the list is loaded, not declared. The interface exists so that a deployment
 * reading an environment variable and a deployment reading an external credential store
 * are the SAME call site: the gateway asks a `VaultProvider` for tokens and never
 * learns which one it got. A second provider is then a new file rather than a
 * fork of the gateway.
 *
 * === FOUR RULES, EACH OF WHICH IS A FAILURE MODE ALREADY NAMED ===
 *
 *  1. READ ONCE, AT STARTUP. Not per request. An environment read on the hot
 *     path is a syscall per event, and worse, it means a variable changed
 *     mid-flight silently changes who is admitted -- a token that would have been
 *     refused at 09:00 starts being honoured at 09:01 with nothing in the logs
 *     to say why. `loadTokens` memoises, and rotation is therefore a restart,
 *     which is a decision an operator can see they made.
 *
 *  2. A BAD ENTRY IS REPORTED, NEVER SILENTLY DROPPED. Dropping it is the safe
 *     direction (the token simply does not exist) and it is also how a partner is
 *     locked out at three in the morning with a configuration that LOOKS
 *     correct. So every rejected entry is counted and described -- by index and
 *     by reason, never by value -- and `strict` turns any rejection into a
 *     thrown error for a deployment that would rather not start.
 *
 *  3. UNKNOWN KEYS ARE A REJECTION, NOT A PASS-THROUGH. A typo'd `provider`
 *     would otherwise produce a well-formed credential that admits nobody, and
 *     the symptom is a partner being refused with an error that says their key
 *     is wrong. Failing on the typo is the only version that finds itself.
 *
 *  4. EMPTY IS NOT AN ERROR. A missing variable yields NO tokens, and no tokens
 *     means this gateway refuses everything -- which is the direction
 *     `GatewayOptions` already documents as the safe default. An environment
 *     that fails to boot because nobody configured a partner is a platform that
 *     is down, and being down is worse than being closed.
 */

/** The variable read when a caller does not name one. */
export const DEFAULT_TOKEN_VARIABLE = "NEUROFEBRIC_GATEWAY_TOKENS";

/** A provisioner. Two implementations ship; a third needs no change here. */
export interface VaultProvider {
  /** For logs and diagnostics. Names the SOURCE, never a value. */
  readonly name: string;
  load(): Promise<VaultSnapshot>;
}

/** An entry that was refused, described without describing its value. */
export interface VaultRejection {
  /** Position in the document, so an operator can find the offending entry. */
  readonly index: number;
  /** Why it was refused. Names the FIELD, never its content. */
  readonly reason: string;
}

export interface VaultSnapshot {
  readonly tokens: readonly GatewayToken[];
  readonly rejections: readonly VaultRejection[];
  /** ISO instant the values were read, so staleness is visible rather than assumed. */
  readonly loadedAt: string;
  readonly source: string;
}

/** The keys a provisionable entry may carry. Anything else is a typo, per rule 3. */
const TOKEN_FIELDS = new Set(["id", "credential", "providers", "scope", "revoked"]);

/**
 * AN EMPTY LIST, WHICH MEANS "REFUSES EVERYTHING".
 *
 * Named so that every path which has nothing to offer returns the same honest
 * value rather than inventing a permissive default. A vault that cannot read
 * anything must not accidentally admit someone.
 */
function closedVault(source: string): VaultSnapshot {
  return { tokens: [], rejections: [], loadedAt: new Date().toISOString(), source };
}

/**
 * PARSE A DOCUMENT OF ENTRIES, REPORTING RATHER THAN DROPPING.
 *
 * Each entry is validated in its own right: one malformed partner does not
 * invalidate the other partners, because the alternative is a single typo taking
 * the entire ingress offline.
 */
export function parseTokenDocument(raw: string, source: string): VaultSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      tokens: [], rejections: [{ index: -1, reason: "the document is not valid JSON" }],
      loadedAt: new Date().toISOString(), source,
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      tokens: [], rejections: [{ index: -1, reason: "the document is not an array of entries" }],
      loadedAt: new Date().toISOString(), source,
    };
  }

  const tokens: GatewayToken[] = [];
  const rejections: VaultRejection[] = [];

  parsed.forEach((entry, index) => {
    const problem = validateEntry(entry);
    if (problem !== undefined) {
      rejections.push({ index, reason: problem });
      return;
    }
    tokens.push(entry as GatewayToken);
  });

  return { tokens, rejections, loadedAt: new Date().toISOString(), source };
}

/** Why this entry is unusable, or undefined when it is fine. Names fields only. */
function validateEntry(entry: unknown): string | undefined {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return "the entry is not an object";
  }
  const record = entry as Record<string, unknown>;

  for (const field of Object.keys(record)) {
    if (!TOKEN_FIELDS.has(field)) return `unrecognised field "${field}"`;
  }
  if (typeof record.id !== "string" || record.id.trim() === "") return "id is missing or empty";
  if (typeof record.credential !== "string" || record.credential.trim() === "") {
    return "credential is missing or empty";
  }
  if (!Array.isArray(record.providers)) return "providers must be a list of strings";
  for (const provider of record.providers) {
    // An EMPTY providers list is allowed and means none: `GatewayToken` documents
    // it, and a credential that admits nobody is a legitimate thing to hold.
    if (typeof provider !== "string" || provider.trim() === "") {
      return "a provider name is empty or is not a string";
    }
  }
  if (record.scope !== undefined && typeof record.scope !== "string") return "scope must be a string";
  if (record.revoked !== undefined && typeof record.revoked !== "boolean") return "revoked must be a boolean";
  return undefined;
}

/**
 * THE ENVIRONMENT PROVISIONER.
 *
 * One variable holding a JSON array, because a per-token variable scheme means the
 * credential list length is decided by whoever edited the deployment manifest,
 * and adding a partner becomes a change to an infrastructure file.
 */
export function environmentVault(
  env: Readonly<Record<string, string | undefined>> = process.env,
  variable: string = DEFAULT_TOKEN_VARIABLE,
): VaultProvider {
  return {
    name: `environment:${variable}`,
    async load(): Promise<VaultSnapshot> {
      const raw = env[variable];
      if (raw === undefined || raw.trim() === "") return closedVault(`environment:${variable}`);
      return parseTokenDocument(raw, `environment:${variable}`);
    },
  };
}

/**
 * AN IN-MEMORY PROVISIONER, for tests and for programmatic issuance.
 *
 * It exists so that `issueToken` and a test do not need an environment, and so
 * that a deployment which mints its own credentials can hand the result to the
 * same call site. It is not a default: a caller has to choose it.
 */
export function staticVault(tokens: readonly GatewayToken[], name = "static"): VaultProvider {
  return {
    name,
    async load(): Promise<VaultSnapshot> {
      return { tokens: [...tokens], rejections: [], loadedAt: new Date().toISOString(), source: name };
    },
  };
}

/**
 * A provisioner that DECORATES another, and can veto what it returns.
 *
 * This is the seam an external credential store plugs into: it reads through to the
 * provider underneath, and its hook can reject the whole snapshot -- a store that
 * returned a truncated read, for instance, is not a store that returned no
 * entries, and the difference decides whether the gateway boots closed or open.
 */
export function filteredVault(
  inner: VaultProvider,
  check: (snapshot: VaultSnapshot) => VaultSnapshot | Promise<VaultSnapshot>,
): VaultProvider {
  return {
    name: `${inner.name}+filtered`,
    async load(): Promise<VaultSnapshot> {
      return check(await inner.load());
    },
  };
}

/**
 * ONE READ PER VAULT, AND THE ONLY WAY TO GET THE LIST.
 *
 * The memo table is keyed on the provider object, so two gateways sharing a vault
 * share one read, and dropping the provider drops its cached values -- there is
 * no module-level cache that outlives the thing it describes.
 */
const SNAPSHOTS = new WeakMap<VaultProvider, Promise<VaultSnapshot>>();

/**
 * LOAD THE ACTIVE LIST, ONCE.
 *
 * `strict` makes any rejected entry fatal. That is the right setting for a
 * deployment whose manifest is expected to be correct and whose silence would be
 * indistinguishable from success; the permissive setting is right for one that
 * expects partial provisioning and reads the rejection count at startup.
 */
export async function loadTokens(
  vault: VaultProvider,
  options: { strict?: boolean } = {},
): Promise<readonly GatewayToken[]> {
  const existing = SNAPSHOTS.get(vault);
  const pending = existing ?? vault.load();
  if (existing === undefined) SNAPSHOTS.set(vault, pending);

  const snapshot = await pending;
  const rejected = snapshot.rejections;
  if (options.strict === true && rejected.length > 0) {
    // Thrown, not logged-and-continued: a start-up that cannot load what it was
    // given should not proceed into a state where it refuses every partner.
    throw new Error(
      `${snapshot.source}: ${rejected.length} credential entr${rejected.length === 1 ? "y was" : "ies were"} rejected `
      + rejected.map((rejection) => `[${rejection.index}] ${rejection.reason}`).join("; "),
    );
  }
  return snapshot.tokens;
}

/** Diagnostics a caller can log at start-up. Carries no credential material. */
export function describeVault(snapshot: VaultSnapshot): string {
  const parts = [`${snapshot.source}: ${snapshot.tokens.length} active`];
  if (snapshot.rejections.length > 0) parts.push(`${snapshot.rejections.length} rejected`);
  parts.push(`read at ${snapshot.loadedAt}`);
  return parts.join(", ");
}
