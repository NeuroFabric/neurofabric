import { Buffer } from "node:buffer";

/**
 * ALERT DISPATCH OVER SERVER-SENT EVENTS.
 *
 * === WHY SSE AND NOT WEBSOCKET OR LONG POLLING ===
 *
 * From ADR-005 §5, and the reasoning is worth repeating because it is the reason
 * this file is small: the platform RAISES alerts and does not receive them, so
 * the transport only has to go one way. SSE is that transport, it is plain HTTP,
 * and plain HTTP means **the credential guard that already exists applies
 * unchanged** -- there is no second authentication path to get wrong, and an
 * alert cannot cross a tenant boundary by a transport detail.
 *
 * `node:http` because the platform already uses it. Zero dependencies FOLLOWS
 * from the choice rather than preceding it.
 *
 * === THE THREE RULES, AND WHERE EACH ONE LIVES IN THIS FILE ===
 *
 *  1. **Authenticate at connect, never per event** (§THE TENANT IS FIXED).
 *  2. **A slow consumer is disconnected, never buffered** (§BACK-PRESSURE IS A
 *     REFUSAL). The buffer size below is the whole mechanism.
 *  3. **The subscription is not the record** -- enforced one layer up, in
 *     `OmniRouteGateway.onDecision`, which persists before this file is ever
 *     reached. That is why a dropped subscriber here loses a *notification* and
 *     never an alert.
 *
 * === WHAT THIS FILE DELIBERATELY DOES NOT DO ===
 *
 * It does not replay. A consumer that connects receives alerts raised from that
 * moment, and nothing before it. Sending history down this socket would make the
 * stream indistinguishable from the record, and the two are supposed to be
 * different things (ADR-005 §9). The record is reachable at `/api/memory/diff`,
 * with the same credential, on demand.
 */

/**
 * THE MOST ONE CONSUMER MAY FALL BEHIND. In bytes, and small on purpose.
 *
 * **THIS NUMBER IS THE ENTIRE BACK-PRESSURE POLICY.** When a consumer's socket
 * buffer exceeds it, the consumer is disconnected with an explanation. It is not
 * queued into an array "for later", because:
 *
 *   - a queue that grows is a memory leak with an alert-shaped payload;
 *   - when it eventually drains, it delivers stale alerts AS THOUGH THEY WERE
 *     NEW, which is worse than losing them: the operator acts on a four-hour-old
 *     breach believing it is happening now;
 *   - and the failure is invisible. A silently buffered consumer looks exactly
 *     like a healthy one until the moment it matters.
 *
 * Losing a notification is honest and recoverable -- the alert is in the record,
 * and the operator can read it. Delivering it late and unmarked is neither.
 *
 * 64 KiB is roughly a thousand alerts of this size. A consumer that cannot hold a
 * thousand is not slow, it is gone, and reconnecting is the correct response.
 */
export const MAX_CONSUMER_BACKLOG_BYTES = 64 * 1024;

/**
 * THE TENANT IS FIXED FOR THE LIFE OF ONE CONNECTION.
 *
 * A stream cannot be re-scoped mid-flight, so the tenant is resolved once at
 * connect and carried in a `readonly` closure. There is no code path by which a
 * second tenant's alert reaches this consumer: `publish` filters by the captured
 * tenant before it looks at the socket at all.
 */
export interface Subscription {
  readonly tenant: string;
  readonly send: (frame: string) => void;
}

export interface HubOptions {
  /** Called when a consumer is disconnected for falling behind. */
  readonly onSlowConsumer?: (tenant: string) => void;
}

export class AlertHub {
  readonly #subscribers = new Set<Subscription>();
  readonly #onSlowConsumer: ((tenant: string) => void) | undefined;
  /** Every consumer dropped for falling behind, so the boot log can say so. */
  readonly #disconnected: { readonly tenant: string; readonly at: string }[] = [];

  constructor(options: HubOptions = {}) {
    this.#onSlowConsumer = options.onSlowConsumer;
  }

  /** Open a subscription for a tenant. Returns the close function. */
  open(tenant: string, send: (frame: string) => void): () => void {
    const subscription: Subscription = { tenant, send };
    this.#subscribers.add(subscription);
    return () => {
      this.#subscribers.delete(subscription);
    };
  }

  /** Live subscribers for one tenant. Read for tests and for the boot log. */
  subscribersFor(tenant: string): number {
    let count = 0;
    for (const subscriber of this.#subscribers) {
      if (subscriber.tenant === tenant) count += 1;
    }
    return count;
  }

  /** Total live subscribers, across tenants. */
  get size(): number {
    return this.#subscribers.size;
  }

  /** The consumers this hub has disconnected for falling behind. */
  disconnected(): readonly { readonly tenant: string; readonly at: string }[] {
    return [...this.#disconnected];
  }

  /**
   * PUBLISH ONE ALERT, to that tenant's subscribers only.
   *
   * Returns how many were told, and how many were dropped for falling behind --
   * because a publish that silently lost a consumer would report "1" and let the
   * caller believe a notification reached somebody.
   */
  publish(tenant: string, frame: string): { readonly told: number; readonly dropped: number } {
    let told = 0;
    let dropped = 0;
    // Snapshot first: a `send` may disconnect, and mutating the set while
    // iterating it is how a consumer ends up notified twice or not at all.
    for (const subscriber of [...this.#subscribers]) {
      // THE TENANT FILTER IS FIRST, and it is the whole reason SSE was chosen:
      // it is not a transport detail that can be got wrong later, it is the
      // capture from connect time.
      if (subscriber.tenant !== tenant) continue;
      if (!this.#subscribers.has(subscriber)) continue;
      try {
        subscriber.send(frame);
        told += 1;
      } catch {
        this.#subscribers.delete(subscriber);
        dropped += 1;
        this.#disconnected.push({ tenant, at: new Date().toISOString() });
        this.#onSlowConsumer?.(tenant);
      }
    }
    return { told, dropped };
  }
}

/**
 * FRAME ONE EVENT, in the SSE wire format.
 *
 * Hand-rolled and tiny rather than assembled by a string template at the call
 * site, because the format has three separate escaping rules and getting one of
 * them wrong produces a frame a client parses as TWO events.
 *
 * `id:` is set to the alert's own id -- the same deterministic id the webhook
 * carries and the record stores -- so a client that reconnects can send
 * `Last-Event-ID` and know exactly what it already had.
 */
export function frame(id: string, event: string, data: unknown): string {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  // A value containing a newline would be read as the start of another field.
  // JSON.stringify already escapes newlines inside strings, so the split below
  // only has to cope with a hand-passed string.
  const lines = payload.split(/\r\n|\r|\n/);
  const body = lines.map((line) => `data: ${line}`).join("\n");
  return `id: ${oneLine(id)}\nevent: ${oneLine(event)}\n${body}\n\n`;
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/** BYTES, not characters. The buffer is measured the way the socket holds it. */
export function bytesOf(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * THE RESPONSE HEADERS, in one place.
 *
 * `Cache-Control: no-store` is not optional: without it a proxy is free to
 * buffer an event stream and deliver alerts at its own convenience, which is the
 * silent-buffering failure this whole file exists to prevent, reintroduced by a
 * well-meaning middlebox.
 */
export const SSE_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store, no-transform",
  connection: "keep-alive",
  // The Command Center is served from its own origin; a stream it cannot read is
  // a stream that never connects.
  "x-content-type-options": "nosniff",
};

/**
 * A KEEP-ALIVE COMMENT. Sent on a timer with no event payload.
 *
 * Not decoration. Proxies and browsers close an idle connection, and a stream
 * that is closed silently looks to the operator like a feed that is merely quiet
 * -- which is the distinction ADR-005 §6 says must never blur. A quiet feed and a
 * stopped connection are different facts, and this is what keeps them different.
 */
export function keepAliveFrame(): string {
  return ": keep-alive\n\n";
}
