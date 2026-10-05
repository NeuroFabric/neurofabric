/**
 * === READING AN EVENT STREAM WITHOUT LYING ABOUT IT ===
 *
 * A byte-oriented reader for the alert stream, split from the triage client so it
 * can be tested against the things a socket actually does.
 *
 * The whole file exists because of one failure mode: a stream parser that quietly
 * drops what it cannot read turns "I lost the alert" into "there was no alert". At
 * 2am, against a system whose only purpose is to tell you something is wrong, that
 * is the most expensive wrong answer available, and it is the one an unwatched
 * `try { ... } catch { /* ignore *\/ }` produces.
 *
 * === WHAT A SOCKET DOES TO A STREAM ===
 *
 * Chunk boundaries are chosen by the network, not by the sender or the receiver.
 * All four of these happen on ordinary connections:
 *
 *   - a boundary inside the two newlines that terminate a frame
 *   - a boundary inside a JSON string
 *   - a boundary inside a multi-byte UTF-8 sequence
 *   - a boundary anywhere in a stream the socket chose to flush whole
 *
 * and a fifth thing happens that is not a boundary at all: a proxy rewrites line
 * endings. `\r\n\r\n` does not contain `\n\n`, so a reader that searches for the
 * newline pair waits forever on a stream that is arriving perfectly.
 *
 * Therefore the rules here, and each one is pinned by a test:
 *
 *   - Line endings are NORMALISED on read, never searched for. A frame ends at a
 *     blank line, whichever two characters spell it.
 *   - Text is decoded with a STREAMING decoder, so a character cut in half is held
 *     until the rest of it arrives rather than becoming two replacement marks.
 *   - Several `data:` lines join back into one payload, because that is how the hub
 *     keeps a payload containing a newline inside one event.
 *   - The event name is a FIELD. A payload that mentions the string "event: alert"
 *     is not an alert.
 *   - At end of stream the tail is either a complete frame (delivered) or a
 *     half-written line (reported). Neither is silence.
 *
 * === WHAT IT DELIBERATELY DOES NOT DO ===
 *
 * It does not interpret the payload. Framing and meaning are separate problems and
 * the second one is a policy decision, so it lives in `readAlert` below with its
 * own outcome type -- because "this frame is not for us" and "this frame is for us
 * and we cannot read it" are different answers and a triage agent must not confuse
 * them.
 */

/** A frame, as the specification defines one. */
export interface SseEvent {
  /** The event name. `""` when nothing has named one. Never a substring match. */
  readonly event: string;
  /** Every `data:` line, joined with newlines. Not trimmed: whitespace is data. */
  readonly data: string;
  /** The last `id:` seen, which survives into later frames. */
  readonly id: string;
}

export type SseItem =
  | { readonly kind: "event"; readonly value: SseEvent }
  /**
   * The stream ended, or broke, with something buffered that is not a frame.
   *
   * `preview` is bounded. This text is printed for an operator at 2am, and a
   * diagnostic that can be as large as whatever the peer sent is a diagnostic that
   * will eventually fill a terminal.
   */
  | { readonly kind: "unreadable"; readonly because: string; readonly preview: string };

/** The ceiling on a diagnostic. Long enough to identify the frame, short enough to read. */
const PREVIEW_LIMIT = 512;

export class SseAccumulator {
  readonly #decoder = new TextDecoder();
  #buffer = "";
  /** Per the specification these two persist across dispatches and are not reset. */
  #eventName = "";
  #lastId = "";

  /**
   * Feed whatever the socket just handed over. BYTES, not text.
   *
   * The boundary is where the argument is deliberately byte-typed: accepting a
   * string here would let a caller decode first and split second, which is exactly
   * the order that corrupts a character spanning two chunks. The accumulator owns
   * the decoder so it can be told the chunk is unfinished.
   */
  push(chunk: Uint8Array): SseItem[] {
    if (chunk.length === 0) return [];
    this.#buffer += this.#decoder.decode(chunk, { stream: true });
    return this.#drain();
  }

  /**
   * The stream ended. Flush the decoder, then account for whatever is left.
   *
   * Called exactly once, and it is not optional: a stream that ends mid-line has
   * lost an event, and the only honest report of a lost event is that it was lost.
   *
   * Two tails, and they mean different things:
   *
   *   - nothing buffered, but a frame in progress -> the server closed without
   *     writing the blank line. Every field arrived whole, so the frame is
   *     delivered. Discarding it would lose a real alert to a missing newline.
   *   - text buffered with no line terminator -> a field was cut off mid-write.
   *     Its value may be truncated in a way no amount of guessing can repair, and
   *     delivering it would put a half-written payload in front of a caller that
   *     cannot tell it apart from a whole one.
   */
  end(): SseItem[] {
    this.#buffer += this.#decoder.decode();
    const items = this.#drain();
    const partial = this.#buffer;
    this.#buffer = "";

    if (partial.trim() !== "") {
      items.push({
        kind: "unreadable",
        because: "the stream ended mid-line, so the last field may be truncated",
        preview: preview(partial),
      });
      return items;
    }
    return [...items, ...this.#dispatch()];
  }

  /** Take every complete frame out of the buffer, and keep the remainder. */
  #drain(): SseItem[] {
    const items: SseItem[] = [];
    for (;;) {
      const boundary = nextLineBreak(this.#buffer);
      if (boundary === undefined) break;
      const line = this.#buffer.slice(0, boundary.at);
      this.#buffer = this.#buffer.slice(boundary.after);

      // A blank line ends an event. Anything else is a field of the one in progress.
      if (line === "") {
        items.push(...this.#dispatch());
        continue;
      }
      this.#field(line);
    }
    return items;
  }

  /** One `name: value` line, and the two things the specification says to ignore. */
  #field(line: string): void {
    // A comment. `:` with no name. Used as a keep-alive, and carrying nothing else.
    if (line.startsWith(":")) return;

    const colon = line.indexOf(":");
    const name = colon === -1 ? line : line.slice(0, colon);
    // No colon means the field's value is empty, and ONE space is stripped -- no
    // more, or leading whitespace in a payload would be eaten.
    const value = colon === -1 ? "" : stripOneSpace(line.slice(colon + 1));

    if (name === "event") {
      this.#eventName = value;
      return;
    }
    if (name === "id") {
      // A NUL in an id is ignored by the specification, because the id is a resume
      // cursor and a corrupt one is worse than none.
      if (!value.includes("\0")) this.#lastId = value;
      return;
    }
    // `data` is accumulated into the pending payload; `retry` needs nothing this
    // reader reconnects with, since it does not reconnect.
    if (name === "data") this.#pending.push(value);
  }

  readonly #pending: string[] = [];

  /**
   * Emit the frame in progress, if there is one.
   *
   * A frame with no `data:` line is NOT dispatched. The hub sends
   * `event: slow-consumer` with no body to say it dropped us; there is no payload to
   * hand a caller, and inventing an empty one would put `undefined` where a record
   * is expected.
   */
  #dispatch(): SseItem[] {
    const data = this.#pending.splice(0);
    if (data.length === 0) return [];
    return [{ kind: "event", value: { event: this.#eventName, data: data.join("\n"), id: this.#lastId } }];
  }
}

function stripOneSpace(value: string): string {
  return value.startsWith(" ") ? value.slice(1) : value;
}

/**
 * The next line break, accepting all three spellings.
 *
 * `\r\n` is checked as a unit and consumed as a unit. Checking `\n` first would
 * leave the `\r` on the front of the next line, which is harmless for `data` and
 * not harmless for anything that compares field values exactly.
 */
function nextLineBreak(text: string): { at: number; after: number } | undefined {
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\n") return { at: i, after: i + 1 };
    if (ch === "\r") return text[i + 1] === "\n" ? { at: i, after: i + 2 } : { at: i, after: i + 1 };
  }
  return undefined;
}

function preview(text: string): string {
  return text.length <= PREVIEW_LIMIT ? text : `${text.slice(0, PREVIEW_LIMIT)}...`;
}

// === FROM A FRAME TO AN ALERT =============================================

export type AlertReading =
  | { readonly kind: "alert"; readonly alert: Record<string, unknown>; readonly id: string }
  /** A frame that arrived intact and is simply not an alert. Not an error. */
  | { readonly kind: "ignored"; readonly event: string }
  /** A frame that arrived and cannot be read. Never the same as "no alert". */
  | { readonly kind: "unreadable"; readonly because: string; readonly preview: string };

/**
 * Turn one item into the one answer the triage agent may act on.
 *
 * The point of three outcomes rather than two: the previous client collapsed
 * everything that was not an alert into nothing, so a frame that arrived malformed
 * and a frame that never arrived produced the same behaviour -- move on. Splitting
 * them is what lets the client tell an operator "the stream broke" instead of
 * "the system is quiet".
 */
export function readAlert(item: SseItem): AlertReading {
  if (item.kind === "unreadable") return { kind: "unreadable", because: item.because, preview: item.preview };

  // Routing happens on the NAME, before the payload is touched. `slow-consumer`
  // carries prose rather than JSON, so parsing first would report a corrupt stream
  // for a message the hub sent correctly.
  if (item.value.event !== "alert") return { kind: "ignored", event: item.value.event };

  let parsed: unknown;
  try {
    parsed = JSON.parse(item.value.data);
  } catch {
    return { kind: "unreadable", because: "the alert payload is not valid JSON", preview: preview(item.value.data) };
  }
  // Parses, and is still not an alert. A number or an array would be handed back as
  // a record and every field read off it would be undefined.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "unreadable", because: "the alert payload is not a record", preview: preview(item.value.data) };
  }
  return { kind: "alert", alert: parsed as Record<string, unknown>, id: item.value.id };
}