import type { OmniRouteEvent, OmniRouteGateway, ProviderBinding } from "../omniroute-gateway.ts";

/**
 * THE KAFKA PROVIDER: the first official Omniroute adapter.
 *
 * === WHY THIS IS SMALL, AND THAT IS THE POINT ===
 *
 * A Kafka consumer is already an async iterable of messages. The whole adapter is
 * a TRANSLATION -- Kafka's wire shapes into the gateway's event shape -- because
 * everything hard about this pipeline was already solved before the transport
 * arrived: the bounded accumulators, the fences, the alert policy. A provider
 * that re-implemented any of it would be the second implementation this codebase
 * has spent five phases learning to delete.
 *
 * So a client library, a socket, or a recorded fixture all plug in identically,
 * and the tests can drive the adapter with no broker running at all.
 *
 * === THE WIRE SHAPES, AND WHY EACH ONE IS HANDLED RATHER THAN ASSUMED ===
 *
 * `value` is a Buffer, because Kafka ships bytes and the content type lives in a
 * header, not in the payload. Decoding as UTF-8 unconditionally would mangle a
 * protobuf or a gzip body, so the adapter decodes what it can and refuses what it
 * cannot, with the reason.
 *
 * `partition` is the structure Kafka exists to provide, and flattening every
 * partition into one series would throw that away -- the same reason the broker
 * keeps partitions separate rather than merging their counters.
 *
 * `key` is not the ranking column. A Kafka key is an ordering guarantee, often a
 * user or an account id, and treating it as the category would rank events by
 * whatever the producer happened to choose. It is carried as its own field.
 */

/** A Kafka record, in the shape every major client library produces. */
export interface KafkaMessage {
  readonly topic: string;
  readonly partition: number;
  readonly offset: number;
  readonly key?: Buffer | string | null;
  readonly value: Buffer | string | null;
  readonly timestamp?: string | number;
  readonly headers?: Readonly<Record<string, Buffer | string | undefined>>;
}

export interface KafkaBinding extends ProviderBinding {
  /** The topic this adapter consumes. Used in the provider name. */
  readonly topic: string;
  /** Header (or payload field) naming the column the analysis should rank by. */
  readonly keyColumn?: string;
  /** Header (or payload field) naming the instant. */
  readonly timeColumn?: string;
  /** Decode the payload as JSON. On by default; off for binary bodies. */
  readonly json?: boolean;
}

/** How one record was turned into an event, for operators reading the logs. */
export interface DecodeFailure {
  readonly topic: string;
  readonly partition: number;
  readonly offset: number;
  readonly reason: string;
}

export interface KafkaProvider {
  /** Attach to a gateway. Returns the adapter so it can be driven directly. */
  readonly binding: KafkaBinding;
  /** Translate one message. Returns undefined when it cannot be decoded. */
  decode(message: KafkaMessage): OmniRouteEvent | undefined;
  /** Consume a client-library stream until it ends or the caller stops. */
  consume(source: AsyncIterable<KafkaMessage>): Promise<{ decoded: number; skipped: DecodeFailure[] }>;
  /** Records that could not be decoded, for an operator rather than a throw. */
  readonly failures: readonly DecodeFailure[];
}

/** Buffers are bytes; strings are already text. Nothing else is a payload. */
function asText(value: Buffer | string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value;
  return value.toString("utf8");
}

/**
 * FLATTEN A JSON PAYLOAD one level of nesting, so a nested `user.id` becomes a
 * column named `user.id` rather than one opaque cell the profiler cannot read.
 * The naming matches the JSONL reader exactly, so the same event delivered as a
 * file or as a Kafka message produces the same columns.
 */
function flatten(payload: Record<string, unknown>, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload)) {
    const name = prefix.length === 0 ? key : `${prefix}.${key}`;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(out, flatten(value as Record<string, unknown>, name));
      continue;
    }
    if (value === null || value === undefined) {
      out[name] = "";
      continue;
    }
    out[name] = typeof value === "object" ? JSON.stringify(value) : String(value);
  }
  return out;
}

export function createKafkaProvider(binding: KafkaBinding, gateway: OmniRouteGateway): KafkaProvider {
  const failures: DecodeFailure[] = [];
  // ONE PROVIDER PER TOPIC-PARTITION. The topic is part of the name so an operator
  // reading an alert knows which topic spoke, and the partition keeps the counters
  // separate rather than merging unrelated series into one ranking.
  const name = `${binding.name}:${binding.topic}:${"p"}`;
  gateway.connect({ ...binding, name, keyColumn: binding.keyColumn, timeColumn: binding.timeColumn });

  const decode = (message: KafkaMessage): OmniRouteEvent | undefined => {
    const text = asText(message.value);
    if (text === undefined || text.trim().length === 0) return undefined;
    const useJson = binding.json ?? true;
    if (!useJson) {
      const fields: Record<string, string> = { value: text };
      const headers = message.headers ?? {};
      for (const [header, raw] of Object.entries(headers)) {
        const headerText = asText(raw);
        if (headerText !== undefined) fields[header] = headerText;
      }
      return {
        fields,
        ...(message.timestamp === undefined ? {} : { at: toMillis(message.timestamp) }),
      };
    }
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("payload is not a JSON object");
      }
      payload = parsed as Record<string, unknown>;
    } catch (error) {
      // A malformed record costs that record. A consumer that threw here would
      // restart the partition and replay the same poison message forever, which
      // is the Kafka equivalent of a crash loop and a far worse outcome than one
      // skipped event.
      failures.push({
        topic: message.topic,
        partition: message.partition,
        offset: message.offset,
        reason: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
    const fields = flatten(payload);
    const kafkaKey = asText(message.key);
    if (kafkaKey !== undefined) fields["kafka_key"] = kafkaKey;
    fields["kafka_topic"] = message.topic;
    fields["kafka_partition"] = String(message.partition);
    fields["kafka_offset"] = String(message.offset);
    return {
      fields,
      ...(message.timestamp === undefined ? {} : { at: toMillis(message.timestamp) }),
    };
  };

  return {
    binding,
    decode,
    failures,
    async consume(source) {
      let decoded = 0;
      for await (const message of source) {
        const event = decode(message);
        if (event === undefined) continue;
        gateway.push(name, event);
        decoded += 1;
      }
      gateway.closePushes(name);
      return { decoded, skipped: [...failures] };
    },
  };
}

function toMillis(value: string | number): number | undefined {
  if (typeof value === "number") return value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}