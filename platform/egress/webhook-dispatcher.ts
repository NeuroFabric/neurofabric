import { createHmac } from "node:crypto";

import type { SwarmAlert } from "../omniroute/omniroute-gateway.ts";
import type { LiveVerdict } from "../conductor/live-anomaly.ts";

/**
 * EGRESS. The engine has an opinion and now it can tell somebody.
 *
 * === WHY THIS IS A SEPARATE DIRECTORY ===
 *
 * `platform/omniroute` is INGRESS: strangers arriving, each one untrusted, each
 * one proved before it costs the engine anything. This module is the exact
 * mirror of that and shares none of its rules, because the two directions have
 * opposite failure modes and a shared abstraction would have to pretend they do
 * not.
 *
 *   - Ingress fails by ACCEPTING something it should have refused. The cost is a
 *     CPU attack and the control is the caller.
 *   - Egress fails by OMITTING something it should have sent. The cost is a
 *     silent blind spot: the platform looks healthy because nothing ever failed
 *     loudly enough to be noticed. There is no caller to protect here, so there
 *     is no credential to present and none is invented.
 *
 * === THE ONE RULE: A DELIVERY ATTEMPT IS NEVER THROWN AWAY ===
 *
 * A dispatcher that logs a failure and returns is a dispatcher whose failure
 * nobody sees, and an alert that was never delivered is indistinguishable, from
 * the outside, from an alert that was never generated. So every attempt is
 * returned -- the status, the attempt number, the delay before the next try, and
 * the endpoint it went to -- and `delivered` counts endpoints rather than
 * attempts so a caller cannot mistake three retries for three alerts.
 *
 * === RETRY IS NOT "TRY AGAIN UNTIL IT WORKS" ===
 *
 * Three classes, deliberately separated, because lumping them is how a dispatcher
 * turns a partner's outage into a self-inflicted one:
 *
 *   - TRANSIENT (network error, 408, 425, 429, 5xx): the request might succeed
 *     later, so it is retried with exponential backoff.
 *   - PERMANENT (any other 4xx): the endpoint rejected this alert and will reject
 *     the identical one forever. Retrying is not persistence, it is a request to
 *     be ignored. Attempted ONCE, then reported as failed.
 *   - SUCCESS (2xx): done.
 *
 * A 429 is transient but is NOT retried blindly -- the endpoint has told us when
 * it will be ready, and backoff that ignores a stated Retry-After is slower than
 * the partner asked for while appearing to comply.
 *
 * === WHY THE CLOCK AND THE FETCH ARE INJECTED ===
 *
 * Exponential backoff is the entire content of this module, and backoff cannot be
 * tested by waiting for it. A test that sleeps four seconds to observe three
 * retries is a test nobody runs, so `sleep` and `fetchImpl` are parameters: the
 * retry ladder is asserted in microseconds and the maths stays honest.
 *
 * === WHAT IT DELIBERATELY DOES NOT DO ===
 *
 * It does not decide WHETHER to alert. That is the gateway's `firstObservation`
 * policy, and a second opinion here would mean two components disagreeing about
 * when a breach is news. This module is given an alert and delivers it.
 *
 * It does not queue durably. A process that dies mid-retry loses what it was
 * holding, which is stated here rather than implied away: this is retry-within-a-
 * process, not a delivery guarantee. The honest upgrade is an outbox the operator
 * can inspect, and that is a design decision rather than a bug.
 */

/** Where one alert goes. Several, and one failing must not stop the others. */
export interface WebhookEndpoint {
  readonly url: string;
  /** Static headers, e.g. a routing key. Not proof of identity; see `hmacKey`. */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * HMAC-SHA256 key for the body, sent as `x-neurofebric-signature`.
   *
   * Preferred over a bearer credential because a shared key is verifiable by the
   * RECEIVER without this platform ever being able to replay an inbound call
   * against its own egress, and because a signature covers the body whereas a
   * header proving the sender alone does not.
   */
  readonly hmacKey?: string;
}

/** One alert, in the wire shape. A body a partner can parse without our docs. */
export interface AlertPayload {
  /** Stable id, so a receiver can deduplicate a redelivery it asked for. */
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly severity: "info" | "warning" | "critical";
  readonly source: string;
  readonly at: string;
  readonly summary: {
    readonly records: number;
    readonly open: boolean;
    readonly breachedColumns: number;
    readonly partitions: number;
  };
  /** One entry per breached column, consolidated, never one per partition. */
  readonly columns: readonly {
    readonly column: string;
    readonly partitions: number;
    readonly max: number | null;
    readonly fenceUpper: number | null;
    readonly multiple: number | null;
    readonly breachedEverywhere: boolean;
  }[];
}

export interface DispatchAttempt {
  readonly url: string;
  /** 1-based. */
  readonly attempt: number;
  readonly ok: boolean;
  readonly status?: number;
  /** Present when the failure had no HTTP status at all: DNS, TLS, timeout. */
  readonly error?: string;
  /** True when the outcome will never change, so no further attempt was made. */
  readonly permanent?: boolean;
  /** Milliseconds waited AFTER this attempt, when another was scheduled. */
  readonly waitedMs?: number;
}

export interface DispatchResult {
  readonly alertId: string;
  /** Endpoints that accepted the alert. Never attempts. */
  readonly delivered: number;
  readonly failed: number;
  readonly attempts: readonly DispatchAttempt[];
}

export interface DispatcherOptions {
  readonly endpoints: readonly WebhookEndpoint[];
  /** Total tries per endpoint, including the first. Default 4. */
  readonly maxAttempts?: number;
  /** First backoff step; doubles per attempt. Default 250ms. */
  readonly baseDelayMs?: number;
  /** Ceiling on the backoff, so attempt 8 does not sleep for an hour. Default 30s. */
  readonly maxDelayMs?: number;
  /** Per-attempt ceiling. Default 5s. A partner that never answers must not hang us. */
  readonly timeoutMs?: number;
  /**
   * Jitter, as a fraction of the computed delay. Default 0.2.
   *
   * Present because every replica retrying in lockstep against one partner's
   * restart is how a recovering endpoint is knocked over a second time.
   */
  readonly jitter?: number;
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Called for every attempt, for logging. Must not throw into the retry loop. */
  readonly onAttempt?: (attempt: DispatchAttempt) => void;
}

const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_JITTER = 0.2;

/** Header carrying the body signature. One name, one format. */
export const SIGNATURE_HEADER = "x-neurofebric-signature";
/** Header carrying the alert id, so a receiver can dedupe without parsing JSON. */
export const ALERT_ID_HEADER = "x-neurofebric-alert-id";

/**
 * IS THIS STATUS WORTH WORRYING ABOUT AGAIN?
 *
 * Kept as a named predicate rather than inlined, because it is the one rule in
 * this module that decides whether a partner's outage becomes our load.
 */
export function isTransientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * THE ALERT, AS JSON.
 *
 * The severity is derived from the CONSOLIDATED verdict rather than from the
 * count of breached columns, because a column breached in one partition out of
 * forty is not the same event as one breached in all forty -- and "critical"
 * attached to the first is how an on-call rotation learns to ignore the word.
 * `breachedEverywhere` is the difference between restarting a replica and paging
 * the fleet, so it travels with the number.
 */
export function buildAlertPayload(alert: SwarmAlert): AlertPayload {
  const verdict: LiveVerdict = alert.verdict;
  const breached = verdict.columns.filter((column) => column.breached);
  const universal = breached.length > 0 && breached.every((column) => column.breachedEverywhere);
  const severity: AlertPayload["severity"] =
    breached.length === 0 ? "info" : universal ? "critical" : "warning";
  const partitions = verdict.columns.reduce((widest, column) => Math.max(widest, column.partitions), 0);

  const title = breached.length === 0
    ? `${alert.provider}: snapshot with no breach`
    : `${alert.provider}: ${breached.length} column${breached.length === 1 ? "" : "s"} past the outer fence`;

  return {
    // Deterministic in the alert's own content, so a redelivery after a timeout is
    // the SAME id and a receiver can drop it. A random id would make every retry
    // look like a new incident to the thing we are asking to trust us.
    id: createHmac("sha256", "neurofebric-alert-id")
      .update(`${alert.provider}|${verdict.at}|${breached.map((c) => c.column).join(",")}`, "utf8")
      .digest("hex")
      .slice(0, 32),
    title,
    body: alert.text,
    severity,
    source: alert.provider,
    at: verdict.at,
    summary: {
      records: verdict.records,
      open: verdict.open,
      breachedColumns: verdict.breachedColumns,
      partitions,
    },
    columns: breached.map((column) => ({
      column: column.column,
      partitions: column.partitions,
      max: column.max,
      fenceUpper: column.fenceUpper,
      multiple: column.extremeMultiple,
      breachedEverywhere: column.breachedEverywhere,
    })),
  };
}

/** `Retry-After`, in ms, when the header carried a number of seconds. */
function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (header === null) return undefined;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.ceil(seconds * 1000);
}

/** The signature, computed over the EXACT bytes sent. Nothing is re-serialised. */
function signature(body: string, key: string): string {
  return `sha256=${createHmac("sha256", key).update(body, "utf8").digest("hex")}`;
}

interface AttemptOutcome {
  readonly record: Omit<DispatchAttempt, "attempt">;
  readonly delivered: boolean;
  readonly transient: boolean;
  readonly waitHintMs?: number;
}

export class WebhookDispatcher {
  private readonly options: DispatcherOptions;

  constructor(options: DispatcherOptions) {
    this.options = options;
  }

  /** True when there is somewhere to send. A dispatcher with no endpoints is not an error. */
  get enabled(): boolean {
    return this.options.endpoints.length > 0;
  }

  /**
   * DELIVER ONE ALERT TO EVERY CONFIGURED ENDPOINT.
   *
   * Endpoints are attempted SEQUENTIALLY and independently. Concurrency would be
   * faster and would make one slow partner delay another's delivery by the whole
   * timeout, which is the coupling this is built to avoid.
   */
  async dispatch(alert: SwarmAlert): Promise<DispatchResult> {
    const payload = buildAlertPayload(alert);
    const body = JSON.stringify(payload);
    const attempts: DispatchAttempt[] = [];
    let delivered = 0;

    for (const endpoint of this.options.endpoints) {
      const outcome = await this.deliver(endpoint, body, payload.id);
      attempts.push(...outcome.attempts);
      if (outcome.delivered) delivered += 1;
    }

    return {
      alertId: payload.id,
      delivered,
      failed: this.options.endpoints.length - delivered,
      attempts,
    };
  }

  private async deliver(
    endpoint: WebhookEndpoint,
    body: string,
    alertId: string,
  ): Promise<{ delivered: boolean; attempts: DispatchAttempt[] }> {
    const maxAttempts = Math.max(1, this.options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    const base = this.options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    const ceiling = this.options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    const attempts: DispatchAttempt[] = [];

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const outcome = await this.attempt(endpoint, body, alertId);
      const record: DispatchAttempt = { ...outcome.record, attempt };
      this.report(record);

      if (outcome.delivered) {
        attempts.push(record);
        return { delivered: true, attempts };
      }

      // A permanent refusal is not retried. See the class note at the top.
      if (!outcome.transient) {
        attempts.push({ ...record, permanent: true });
        return { delivered: false, attempts };
      }
      if (attempt === maxAttempts) {
        attempts.push(record);
        return { delivered: false, attempts };
      }

      const waited = outcome.waitHintMs ?? this.backoffMs(attempt, base, ceiling);
      attempts.push({ ...record, waitedMs: waited });
      await this.sleep(waited);
    }
    return { delivered: false, attempts };
  }

  /**
   * ONE HTTP CALL, with a timeout.
   *
   * The timeout is an abort, not a race, because a raced fetch that loses still
   * holds its socket and its response body until the partner decides to let go.
   */
  private async attempt(endpoint: WebhookEndpoint, body: string, alertId: string): Promise<AttemptOutcome> {
    const doFetch = this.options.fetchImpl ?? fetch;
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, timeoutMs);

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "neurofebric-egress/1",
      [ALERT_ID_HEADER]: alertId,
      ...(endpoint.headers ?? {}),
    };
    if (endpoint.hmacKey !== undefined) headers[SIGNATURE_HEADER] = signature(body, endpoint.hmacKey);

    try {
      const response = await doFetch(endpoint.url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      const ok = response.ok;
      return {
        record: { url: endpoint.url, ok, status: response.status },
        delivered: ok,
        transient: !ok && isTransientStatus(response.status),
        // A partner that told us when it will be ready outranks our own ladder.
        ...(!ok && response.status === 429 ? { waitHintMs: retryAfterMs(response) } : {}),
      };
    } catch (error) {
      // An abort here is OUR timeout, not the partner's refusal, so it is transient
      // by construction: the same alert on the next attempt is a fair bet.
      return {
        record: { url: endpoint.url, ok: false, error: error instanceof Error ? error.message : String(error) },
        delivered: false,
        transient: true,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * EXPONENTIAL BACKOFF, CAPPED, JITTERED.
   *
   * Doubling from a base: 250, 500, 1000... The cap matters more than the shape --
   * an uncapped ladder means attempt nine waits four minutes, by which time the
   * incident is over and the alert is archaeology.
   */
  private backoffMs(attempt: number, base: number, ceiling: number): number {
    const capped = Math.min(ceiling, base * Math.pow(2, Math.max(0, attempt - 1)));
    const jitter = this.options.jitter ?? DEFAULT_JITTER;
    if (jitter <= 0) return Math.round(capped);
    // Jitter is applied AROUND the capped value and re-capped, so jitter can never
    // produce a wait longer than the ceiling it exists to bound.
    const spread = capped * jitter;
    return Math.round(Math.min(ceiling, Math.max(0, capped + (Math.random() * 2 - 1) * spread)));
  }

  private async sleep(ms: number): Promise<void> {
    if (this.options.sleep !== undefined) {
      await this.options.sleep(ms);
      return;
    }
    await new Promise<void>((resolve) => { setTimeout(resolve, ms); });
  }

  /**
   * The attempt logger, which CANNOT break the retry loop.
   *
   * A logging callback that threw would otherwise abort a delivery that had not
   * finished, which is the worst possible place for a diagnostic to have power.
   */
  private report(attempt: DispatchAttempt): void {
    if (this.options.onAttempt === undefined) return;
    try {
      this.options.onAttempt(attempt);
    } catch {
      // Swallowed on purpose, and stated so nobody "fixes" it into a throw.
    }
  }
}

/**
 * Wire a gateway's alert stream straight to the dispatcher.
 *
 * The adapter is here rather than in the gateway so egress is a DECORATION on the
 * gateway rather than a dependency of it: a deployment with no egress configured
 * constructs nothing here, and the gateway is unchanged.
 */
export function attachDispatcher(
  gateway: { subscribe(handler: (alert: SwarmAlert) => void): () => void },
  dispatcher: WebhookDispatcher,
  onError?: (error: unknown) => void,
): () => void {
  return gateway.subscribe((alert) => {
    void dispatcher.dispatch(alert).catch((error: unknown) => {
      if (onError === undefined) return;
      try {
        onError(error);
      } catch {
        // A diagnostic that throws must not become an unhandled rejection.
      }
    });
  });
}
