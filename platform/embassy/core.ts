/**
 * THE CORE GATEWAY. The only way the embassy reaches Neurofebric.
 *
 * === WHAT CHANGED FROM ADR-006, AND WHY IT IS SAFE ===
 *
 * ADR-006 section 6 decided the embassy would run in the SAME process and read
 * the synchronous `LiveGateway` by injection, and it rejected a separate process
 * for one specific reason: "the two-truths contract would gain a THIRD truth --
 * what the kernel remembers versus what the embassy last saw."
 *
 * This implementation is a separate process talking HTTP, which is the shape
 * section 6 refused. The reversal is sound for exactly one reason, and the reason
 * is the operator's word in the brief: **STATELESSNESS.**
 *
 * The objection was never to the process boundary. It was to a second copy of the
 * verdict. A proxy that holds no cache, keeps no subscription, and forwards every
 * read has nothing to disagree with -- there is no "what the embassy last saw",
 * because there is no last. The third truth is dissolved rather than avoided, and
 * the remaining cost is a serialisation boundary, which is cheap and honest.
 *
 * That is the whole justification. It does not generalise: a future embassy that
 * caches a verdict to answer quickly would reintroduce the exact defect section 6
 * named, and the cache would need its own ADR rather than a line in this one.
 *
 * === THE TENANT IS NEVER CHOSEN HERE. THAT IS THE WHOLE POINT. ===
 *
 * `platform/api/portal-routes.ts:633` says it in three lines:
 *
 *     // THE TENANT IS THE PROVEN TOKEN ID. Nothing in the request chose it, and it
 *     // arrived from the one door rather than from four lines repeated here.
 *     const tenant = proven.tokenId;
 *
 * So this file does not compute a tenant, does not accept one, does not cache one,
 * and cannot pass one. It forwards a CREDENTIAL and lets the core derive the
 * tenant from its own proof. That is why there is no `tenant` field on any tool
 * argument: not because the schema forbids it by convention, but because there is
 * no code here that would use it.
 *
 * If this proxy ever grew a way to name a tenant, the One-Door guarantee would be
 * gone and no test in this repository could restore it.
 */

import { CREDENTIAL_HEADER } from "../omniroute/edge-security.ts";

/** Where the core listens. The embassy never guesses a default at runtime. */
export interface CoreEndpoint {
  /** Scheme and authority, e.g. `http://127.0.0.1:8080`. No trailing slash. */
  readonly origin: string;
  /**
   * How long a single core call may take before it is abandoned.
   *
   * Bounded because the embassy holds no other work: a hung core call with no
   * ceiling would leave the dispatcher awaiting a promise that never settles, and
   * the host agent's connection would sit there with it. The core applies its own
   * limits; this is the client-side backstop so a core that never answers cannot
   * become an embassy that never answers.
   */
  readonly timeoutMs: number;
}

/** The paths the embassy is allowed to reach, named so a typo cannot invent one. */
export const CORE_PATHS = {
  live: "/api/portal/live",
  schema: "/api/portal/schema",
  ingest: "/api/portal/ingest",
} as const;

/** What a core call produced. Never a thrown error. */
export type CoreOutcome =
  | { readonly ok: true; readonly status: number; readonly body: unknown }
  | { readonly ok: false; readonly status: number; readonly message: string; readonly body?: unknown };

/** The injected request function, so tests never open a socket. */
export type CoreFetch = (
  url: string,
  init: {
    readonly method: "GET" | "POST";
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly signal: AbortSignal;
  },
) => Promise<{ readonly status: number; readonly text: () => Promise<string> }>;

/**
 * Read the body as JSON when it parses, and as a short string when it does not.
 *
 * A core that answers `text/plain` with a proxy error page must not become a
 * JSON.parse exception in the middle of the dispatcher -- that is a transport
 * fault being reported as a domain fault, which is how an operator ends up
 * chasing a schema problem that is really a load balancer.
 */
async function readBody(response: { text: () => Promise<string> }): Promise<unknown> {
  const raw = await response.text();
  if (raw.trim() === "") return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw.length > 400 ? `${raw.slice(0, 400)}...` : raw;
  }
}

/**
 * Call the core once, presenting `credential` at the one door.
 *
 * NEVER THROWS. Every failure -- a refused connection, a timeout, an unparseable
 * body -- is an `ok: false` value, because obligation 4 of ADR-006 section 3.2
 * says an error is returned rather than thrown, and a transport fault that
 * escaped here would end the process and take the host agent's session with it.
 */
export async function callCore(
  endpoint: CoreEndpoint,
  credential: string,
  path: string,
  method: "GET" | "POST",
  body?: unknown,
  fetchImpl: CoreFetch = globalThis.fetch as unknown as CoreFetch,
): Promise<CoreOutcome> {
  // A finite ceiling is set before the call rather than after, so a core that
  // accepts the connection and then goes quiet is still bounded.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), endpoint.timeoutMs);

  try {
    const response = await fetchImpl(`${endpoint.origin}${path}`, {
      method,
      // THE AUTH HEADER, AND THE ONLY PLACE IT IS SET. The token is presented as
      // the credential the core already knows how to prove; it is never appended
      // to a URL, never placed in a body field, and never echoed into a response.
      headers: {
        [CREDENTIAL_HEADER]: credential,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    return { ok: true, status: response.status, body: await readBody(response) };
  } catch (error) {
    // The underlying message is not forwarded. It can contain the request URL,
    // which for an auth refusal can contain a token in a query string on some
    // servers, and the party reading it is an external agent.
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      status: aborted ? 504 : 502,
      message: aborted
        ? "the core did not answer within the configured time limit"
        : "the core could not be reached",
    };
  } finally {
    // Cleared in every path including the refusal. A timer that outlives the call
    // keeps the event loop alive, and this process is one a host agent waits on.
    clearTimeout(timer);
  }
}
