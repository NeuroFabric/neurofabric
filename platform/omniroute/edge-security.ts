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
 * THE WHOLE EDGE, in one call.
 *
 * One function rather than a chain callers must remember to order correctly. The
 * ordering that matters lives inside `authenticate`: every provisioned token is
 * compared before scope is considered, so a caller cannot learn which providers
 * exist by timing a value it does not hold.
 */
export function guard(request: EdgeRequest, tokens: readonly GatewayToken[]): EdgeDecision {
  return authenticate(request, tokens);
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