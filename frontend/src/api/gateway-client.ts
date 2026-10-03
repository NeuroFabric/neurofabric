import {
  readIssueList,
  validateAgentRoster,
  validatePortalEnvelope,
  validateSchemaEnvelope,
  validateSchemaInstall,
  type AgentRoster,
  type AgentSchema,
  type PortalConfig,
  type SchemaInstall,
  type ShapeIssue,
} from "./contracts";
import { validateLiveSnapshot, type LiveSnapshot } from "./live-contracts";

/**
 * THE GATEWAY CLIENT.
 *
 * One `fetch` wrapper, no dependencies, no caching, no retries, no global state.
 * Everything the UI needs to talk to the portal API goes through here, which is
 * the only reason there is exactly one place where a credential, a timeout and
 * an error message are decided.
 *
 * === THE CREDENTIAL TRAVELS IN A HEADER CALLED x-gateway-token ===
 *
 * This mirrors `CREDENTIAL_HEADER` in `platform/omniroute/edge-security.ts`
 * exactly. The token is attached per request and never placed in a URL, a query
 * string or a log line: URLs end up in browser history, proxy logs and
 * `Referer` headers, and a credential in any of those is a credential on a
 * postcard. `credentials: "omit"` is set for the same reason in the other
 * direction -- this client has no business carrying ambient cookies to the API.
 *
 * === WHY THIS FILE NEVER THROWS THE CREDENTIAL, EVEN BY ACCIDENT ===
 *
 * Every message that can carry server-supplied text is passed through
 * `redact()` first, and `GatewayError.toJSON()` is defined so that logging an
 * error -- the single most common thing an application does with one -- cannot
 * serialise the token. A token leaked into a log is a token leaked into a log
 * aggregator, a support ticket and a developer's terminal scrollback, and none
 * of those are places a credential can be recalled from.
 *
 * === WHY NO RETRY ===
 *
 * A retry is a policy decision, and policy decisions belong where the operator
 * can see them. An automatic retry here would silently double the load on a
 * server that may have refused the request for exactly the reason the retry
 * would hit again -- a throttle, a full store, a schema conflict. Callers that
 * want a retry decide it, having seen the error kind.
 *
 * === WHY EVERY FAILURE IS A TYPED ERROR AND NOT A STATUS NUMBER ===
 *
 * A caller that must distinguish "your portal credential was refused, sign in"
 * from "the stored config is invalid, this is our bug" from "the network is
 * down" from "the server took too long" cannot do it from `status >= 400`. Those
 * four want four different screens. The `kind` discriminator is that decision,
 * made once here and readable everywhere else.
 */

/** The header the platform reads the gateway credential from. Mirrors the backend. */
export const CREDENTIAL_HEADER = "x-gateway-token";

/** The four routes this client speaks to. Mirrors `portal-routes.ts`. */
export const PORTAL_PATHS = {
  config: "/api/portal/config",
  agents: "/api/portal/agents",
  schema: "/api/portal/schema",
  live: "/api/portal/live",
} as const;

export type GatewayFailure =
  /** 401 / 403. The credential is absent, wrong, or not permitted. */
  | "refused"
  /** 429. The edge's token bucket refused, and said for how long. */
  | "throttled"
  /** 404. No such resource, or no agent with that id. */
  | "not-found"
  /** 409. The registry refused the write for a non-validation reason. */
  | "conflict"
  /** 400. The document was refused, and the body carries field-named issues. */
  | "invalid"
  /** 5xx. The server's problem. */
  | "server"
  /** Another status the client does not model. */
  | "unexpected-status"
  /** The client refused to be built without a credential. */
  | "misconfigured"
  /** The request did not complete within the configured budget. */
  | "timeout"
  /** The request never reached a server: DNS, refused connection, offline. */
  | "network"
  /** A response arrived but was not the JSON document the contract promises. */
  | "malformed";

export class GatewayError extends Error {
  readonly kind: GatewayFailure;
  /** The HTTP status, when there was a response at all. */
  readonly status?: number;
  /** Field-named validation issues, when the server supplied them. */
  readonly issues: readonly ShapeIssue[];
  /** Seconds to wait, for a throttled response. */
  readonly retryAfterSeconds?: number;
  /**
   * The edge's own machine code for a refusal, e.g. `UNAUTHENTICATED`.
   *
   * Carried because `kind` is the CLIENT's classification and this is the
   * SERVER's, and the disagreement is useful: a 401 the edge calls
   * `UNAUTHENTICATED` while the client calls the failure `refused` is a signal,
   * not a bug to be smoothed over.
   */
  readonly code: string;
  /**
   * The edge's prose for a refusal, redacted.
   *
   * === WHY THIS FIELD EXISTS ===
   *
   * Two 401s used to be indistinguishable to every caller, and they are not the
   * same event: "no credential presented" means nothing arrived, and "the
   * credential presented is not recognised" means something arrived and it was
   * wrong. Only the second one is fixed by a person typing something. The
   * difference is in the prose and nowhere else, so the prose has to survive to
   * the caller. `credentialStateOf` classifies on it.
   *
   * Defaults to the empty string rather than being optional so no consumer has
   * to null-check before calling `.toLowerCase()` on it.
   */
  readonly reason: string;

  constructor(
    kind: GatewayFailure,
    message: string,
    detail: {
      readonly status?: number;
      readonly issues?: readonly ShapeIssue[];
      readonly retryAfterSeconds?: number;
      readonly code?: string;
      readonly reason?: string;
    } = {},
  ) {
    super(message);
    this.name = "GatewayError";
    this.kind = kind;
    if (detail.status !== undefined) this.status = detail.status;
    this.issues = detail.issues ?? [];
    if (detail.retryAfterSeconds !== undefined) this.retryAfterSeconds = detail.retryAfterSeconds;
    // Assigned unconditionally, unlike the rest: both default to empty rather
    // than being absent, so the shape is the same for every error thrown here.
    this.code = detail.code ?? "";
    this.reason = detail.reason ?? "";
  }

  /**
   * Explicitly safe to log.
   *
   * `message` and `issues` have already been redacted by the client, and no field
   * on this error holds the credential. That is asserted by a test rather than
   * assumed, because "we are careful" is not a control -- see the repo's standard
   * for one: declared, wired, reachable, enforced, observable, tested.
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      kind: this.kind,
      message: this.message,
      // The reason is already redacted -- it passed through `snippet()` in
      // `#statusError` -- so it is safe here, and it is included because a log
      // with the status and not the reason is the log that sends somebody
      // looking in the wrong place.
      ...(this.reason === "" ? {} : { reason: this.reason }),
      ...(this.code === "" ? {} : { code: this.code }),
      ...(this.status === undefined ? {} : { status: this.status }),
      issues: this.issues.map((issue) => ({ ...issue })),
      ...(this.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: this.retryAfterSeconds }),
    };
  }
}

/* -------------------------------------------------------------------------- */
/* CONFIGURATION                                                               */
/* -------------------------------------------------------------------------- */

export interface GatewayClientOptions {
  /**
   * The gateway credential.
   *
   * Named for what it is in this platform's vocabulary. In a deployment it comes
   * from the vault and is handed to the browser by whatever performs the sign-in
   * -- it is never compiled into a bundle and never written to this repository.
   */
  readonly gatewayToken: string;
  /** Prefixed to every path. Empty for same-origin, which is what the dev proxy provides. */
  readonly baseUrl?: string;
  /** Per-request budget. Default 8000ms. */
  readonly timeoutMs?: number;
  /** Injected for tests. Defaults to the platform `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 8000;

/** How much of an unparseable body is quoted back. Bounded because it is hostile input. */
const SNIPPET_LIMIT = 180;

/**
 * Remove the credential from any text that will end up in a message.
 *
 * Applied to EVERY server-supplied string, on the reasoning that a server which
 * can see the credential can echo it back in an error, and a client that quotes
 * the server is a client that re-broadcasts whatever the server said.
 */
function redact(text: string, gatewayToken: string): string {
  if (gatewayToken === "") return text;
  return text.split(gatewayToken).join("[withheld]");
}

function snippet(text: string, gatewayToken: string): string {
  const flattened = redact(text, gatewayToken).replace(/\s+/g, " ").trim();
  return flattened.length <= SNIPPET_LIMIT
    ? flattened
    : `${flattened.slice(0, SNIPPET_LIMIT)}...[truncated]`;
}

/* -------------------------------------------------------------------------- */
/* THE CLIENT                                                                  */
/* -------------------------------------------------------------------------- */

export class GatewayClient {
  readonly #token: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #fetchImpl: typeof fetch;

  constructor(options: GatewayClientOptions) {
    const token = options.gatewayToken;
    // Fail closed at CONSTRUCTION rather than at first request. A client that
    // builds successfully and then refuses every call is a bug report that starts
    // "the API is broken"; a client that refuses to be built says why immediately.
    if (typeof token !== "string" || token.trim() === "") {
      throw new GatewayError("misconfigured", "a gateway credential is required to build a client");
    }
    this.#token = token;
    this.#baseUrl = (options.baseUrl ?? "").replace(/\/+$/, "");
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * `GET /api/portal/agents` -- the roster of ACTIVE SCHEMAS.
   *
   * NAMING NOTE, because the surface here is not what the brief assumed. There
   * is no route that lists raw schema documents. The platform's unit of a
   * registered schema is an AGENT, and `/agents` returns one descriptor per
   * registered agent -- id, title, domain, maturity, version, capabilities --
   * which is exactly "the schemas currently active for this tenant", minus the
   * rule bodies.
   *
   * The rule bodies are deliberately NOT fanned out into per-id requests here.
   * The response does not say how many ids there are, so doing that means N
   * round trips with N unknowable in advance against an endpoint that already
   * returns a roster in one. `fetchSchema(id)` is available for the case where a
   * caller genuinely needs one schema's rules -- an editor, an export -- and a
   * caller needs to choose when.
   *
   * So the name from the brief is kept because it is defensible -- the roster IS
   * the active schemas -- but the return type is `AgentRoster`, which is what it
   * honestly is, rather than a `PortalConfig`-shaped guess.
   */
  async fetchActiveSchemas(): Promise<AgentRoster> {
    const body = await this.#request("GET", PORTAL_PATHS.agents);
    const verdict = validateAgentRoster(body);
    if (!verdict.ok) throw this.#malformed("the agent roster", verdict.issues);
    return verdict.value;
  }

  /**
   * `GET /api/portal/live` -- the live verdict and the MEASURED rate.
   *
   * The route returns an ENVELOPE: `{ at, provider, enabled, verdict,
   * throughput }`. Validating the envelope as though it were the verdict would
   * refuse every real response, which is the exact bug `fetchSchema` shipped with
   * in the first version of this client.
   *
   * Polled by `useLiveTelemetry`. The throughput half is null until the server
   * holds two observations, which is not an error -- it is the honest answer to
   * "how fast", given one point in time.
   */
  async fetchLive(): Promise<LiveSnapshot> {
    const body = await this.#request("GET", PORTAL_PATHS.live);
    const verdict = validateLiveSnapshot(body);
    if (!verdict.ok) throw this.#malformed("the live snapshot", verdict.issues);
    return verdict.value;
  }

  /** `GET /api/portal/config` -- the tenant's portal, derived if none is stored. */
  async fetchPortalConfig(): Promise<{ derived: boolean; config: PortalConfig }> {
    const body = await this.#request("GET", PORTAL_PATHS.config);
    const verdict = validatePortalEnvelope(body);
    if (!verdict.ok) throw this.#malformed("the portal config", verdict.issues);
    return verdict.value;
  }

  /** `GET /api/portal/schema/:id` -- one raw schema, for an editor or an export. */
  async fetchSchema(id: string): Promise<AgentSchema> {
    if (typeof id !== "string" || id.trim() === "") {
      throw new GatewayError("misconfigured", "a schema id is required");
    }
    // Encoded, because the id is caller-supplied and is otherwise a path
    // injection: an id of "../../vault" would address a different resource.
    const body = await this.#request("GET", `${PORTAL_PATHS.schema}/${encodeURIComponent(id)}`);
    // The route wraps the document: `{ schema }`. Validating the envelope as
    // though it were the schema would refuse every real response, which is
    // exactly what the first version of this method did.
    const verdict = validateSchemaEnvelope(body);
    if (!verdict.ok) throw this.#malformed(`the schema for ${id}`, verdict.issues);
    return verdict.value;
  }

  /**
   * `POST /api/portal/schema` -- install or replace an agent.
   *
   * The document is sent as-is. It is NOT validated client-side, and that is a
   * deliberate omission rather than a shortcut: the registry owns the rule
   * grammar (pattern limits, nested-quantifier rejection, per-schema caps), and
   * a second copy of those rules in TypeScript would drift and then refuse
   * documents the server would have accepted. The server's 400 carries
   * field-named issues, which this surfaces on `GatewayError.issues` for the
   * editor to point at.
   */
  async uploadSchema(document: unknown): Promise<SchemaInstall> {
    if (document === undefined || document === null || typeof document !== "object") {
      throw new GatewayError("misconfigured", "a schema document must be an object");
    }
    const body = await this.#request("POST", PORTAL_PATHS.schema, JSON.stringify(document));
    const verdict = validateSchemaInstall(body);
    if (!verdict.ok) throw this.#malformed("the install result", verdict.issues);
    return verdict.value;
  }

  /* ------------------------------------------------------------------ */

  #malformed(what: string, issues: readonly ShapeIssue[]): GatewayError {
    return new GatewayError(
      "malformed",
      `${what} did not match the expected shape`,
      { issues: issues.map((issue) => ({ path: issue.path, reason: redact(issue.reason, this.#token) })) },
    );
  }

  async #request(method: "GET" | "POST", path: string, payload?: string): Promise<unknown> {
    const url = `${this.#baseUrl}${path}`;
    const headers: Record<string, string> = {
      [CREDENTIAL_HEADER]: this.#token,
      accept: "application/json",
    };
    if (payload !== undefined) headers["content-type"] = "application/json";

    const controller = new AbortController();
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      controller.abort();
    }, this.#timeoutMs);

    let response: Response;
    try {
      response = await this.#fetchImpl(url, {
        method,
        headers,
        ...(payload === undefined ? {} : { body: payload }),
        signal: controller.signal,
        // No ambient cookies. This client authenticates with the header or not
        // at all, and inheriting a session cookie would make a 401 ambiguous:
        // was the credential refused, or was a cookie silently satisfying it?
        credentials: "omit",
      });
    } catch (error) {
      // A timeout and a user-initiated cancel both arrive as an AbortError, so
      // the flag set before aborting is what distinguishes them. Without it an
      // aborted-by-timeout request would be reported as a generic network
      // failure and the caller would retry a request that merely needs longer.
      if (expired) {
        throw new GatewayError("timeout", `no response within ${this.#timeoutMs}ms from ${method} ${path}`);
      }
      throw new GatewayError(
        "network",
        `could not reach the gateway for ${method} ${path}: ${snippet(describeError(error), this.#token)}`,
      );
    } finally {
      // Cleared on EVERY path, success and failure. A timer left running outlives
      // its request, holds the event loop open, and is the exact shape of the
      // handle that hung this repository's own suite once already.
      clearTimeout(timer);
    }

    return this.#readBody(method, path, response);
  }

  async #readBody(method: string, path: string, response: Response): Promise<unknown> {
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      // The status arrived but the body did not. Still a response, still typed by
      // its status, so the caller gets the more useful half of the answer rather
      // than a bare "network error" for a request that demonstrably connected.
      if (!response.ok) throw this.#statusError(response, "");
      throw new GatewayError(
        "malformed",
        `the response body for ${method} ${path} could not be read: ${snippet(describeError(error), this.#token)}`,
        { status: response.status },
      );
    }

    if (!response.ok) throw this.#statusError(response, text);

    if (text.trim() === "") {
      throw new GatewayError("malformed", `${method} ${path} returned an empty body where a document was promised`, {
        status: response.status,
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // `response.json()` would throw a SyntaxError carrying a position in the
      // server's body, which is a fact about OUR wire format that tells an
      // operator nothing. The bounded snippet plus the status says more.
      throw new GatewayError("malformed", `${method} ${path} did not return JSON: ${snippet(text, this.#token)}`, {
        status: response.status,
      });
    }
    return parsed;
  }

  #statusError(response: Response, text: string): GatewayError {
    const { status } = response;
    let body: unknown;
    try {
      body = text.trim() === "" ? undefined : JSON.parse(text);
    } catch {
      body = undefined;
    }

    const issues = readIssueList(body);
    const errorMessage =
      isRecordWithString(body, "error") && body.error !== undefined ? snippet(String(body.error), this.#token) : "";
    const detail = errorMessage === "" ? snippet(text, this.#token) : errorMessage;

    // The edge renders refusals as `{ status: "FAILED", failure: { code, reason } }`.
    // That shape is unpacked here so `reason` survives into the message, which
    // is often the only explanation a developer gets for a 401.
    // Read as a PAIR rather than as a reason alone. `code` says WHAT was refused
    // and `reason` says why, and the classification of a 401 needs both -- see
    // `credentialStateOf`.
    const refusal = readEdgeRefusal(body, this.#token);
    const reason = refusal.reason;

    const kind: GatewayFailure =
      status === 401 || status === 403
        ? "refused"
        : status === 429
          ? "throttled"
          : status === 404
            ? "not-found"
            : status === 409
              ? "conflict"
              : status === 400
                ? "invalid"
                : status >= 500
                  ? "server"
                  : "unexpected-status";

    const retryAfterSeconds = readRetryAfter(response.headers);
    const summary = detail === "" ? `responded ${status}` : `responded ${status}: ${detail}`;
    const suffix = reason === "" ? "" : ` (${reason})`;

    return new GatewayError(kind, `${summary}${suffix}`, {
      status,
      issues,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      ...(refusal.code === "" ? {} : { code: refusal.code }),
      ...(refusal.reason === "" ? {} : { reason: refusal.reason }),
    });
  }
}

/* -------------------------------------------------------------------------- */
/* HELPERS                                                                     */
/* -------------------------------------------------------------------------- */

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function isRecordWithString(value: unknown, key: string): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && key in value;
}

/**
 * Pull the code and the reason out of a refusal, redacted.
 *
 * === WHY TWO BODY SHAPES ARE ACCEPTED ===
 *
 * The edge renders `{ status: "FAILED", failure: { code, reason } }`. That is the
 * shape this client was written against, and it is what the running wedge emits.
 *
 * But an operator reading a browser's network panel sees the flattened
 * `{ code, reason }` -- devtools renders a single-key wrapper that way, and the
 * screenshot that opened this investigation carried it flat -- and a client that
 * recognised only the nested form reads that body as having no reason at all,
 * classifies the 401 as unclassifiable, and shows the generic screen. So both are
 * read, nested first, and the flat form is a fallback rather than an equal
 * alternative. An operator's evidence is not adjusted to fit the parser.
 */
function readEdgeRefusal(body: unknown, token: string): { code: string; reason: string } {
  if (!isRecordWithString(body, "failure")) {
    // Flat form: `{ code, reason }` at the top level.
    const flatCode = readStringField(body, "code");
    const flatReason = readStringField(body, "reason");
    return { code: flatCode, reason: flatReason === "" ? "" : snippet(flatReason, token) };
  }
  const failure = body.failure;
  if (typeof failure !== "object" || failure === null || Array.isArray(failure)) return { code: "", reason: "" };
  const record = failure as Record<string, unknown>;
  const reason = readStringField(record, "reason");
  return { code: readStringField(record, "code"), reason: reason === "" ? "" : snippet(reason, token) };
}

/** A string field, or the empty string. Never a non-string coerced to one. */
function readStringField(value: unknown, key: string): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "";
  const found = (value as Record<string, unknown>)[key];
  return typeof found === "string" ? found : "";
}

/** `retry-after` in whole seconds, or undefined when absent or nonsense. */
function readRetryAfter(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (raw === null) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}