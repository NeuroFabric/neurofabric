import {
  KafkaConnection,
  Reader,
  decodeRecordBatch,
  KAFKA_API,
  writeInt16,
  writeInt32,
  writeInt64,
  writeVarint,
} from "./kafka-wire.ts";

/**
 * A CONSUMER GROUP: who owns which partition, and what happens when that changes.
 *
 * === THE ONE RULE THAT MAKES THIS CORRECT ===
 *
 * A topic is split into partitions, and a partition is read by exactly ONE member
 * at a time. That is what gives Kafka its ordering guarantee. Get it wrong in one
 * direction and events are processed twice; get it wrong in the other and they are
 * dropped. Nothing in the protocol detects either -- the broker will happily let
 * two members fetch the same partition, and it will happily leave a partition
 * unowned -- so correctness here is entirely the consumer's responsibility.
 *
 * === WHY THE LEADER COMPUTES THE ASSIGNMENT ===
 *
 * Every member reports the partitions it can serve, and one member -- the leader,
 * which is the first member id in the sorted list -- writes the assignment. If
 * each member decided for itself they would disagree the moment the member list
 * changed, and a disagreement means two members reading one partition. The
 * assignment is therefore computed in ONE place from the FULL member list, and
 * every member obeys the result.
 *
 * === THE RANGE ALGORITHM, AND WHY NOT STICKY ===
 *
 * Ranges are contiguous, which is what makes offset commits per partition
 * meaningful and keeps one consumer's work on one set of partitions. The sticky
 * assignor trades that for fewer partition movements on rebalance; it is the right
 * default at scale and the wrong one here, because a member that keeps its
 * partitions after a rebalance is a member that keeps fetching from a partition it
 * may no longer own for the length of the rebalance timeout. Contiguous and
 * boring beats sticky and clever when the failure is silent double-consume.
 */

export interface BrokerAddress {
  readonly host: string;
  readonly port: number;
}

export interface TopicPartition {
  readonly topic: string;
  readonly partition: number;
  readonly leader: number;
}

export interface ConsumerGroupConfig {
  readonly brokers: readonly BrokerAddress[];
  readonly topic: string;
  readonly groupId: string;
  readonly clientId: string;
  /** Maximum bytes per fetch. Bounded so a partition cannot balloon the heap. */
  readonly maxBytes?: number;
  /** Wait time handed to the broker. Long polls keep idle partitions cheap. */
  readonly fetchWaitMs?: number;
  /** Members with no heartbeat for this long are evicted from the group. */
  readonly sessionTimeoutMs?: number;
  readonly onAssignment?: (partitions: TopicPartition[]) => void;
}

export interface FetchedRecord {
  readonly topic: string;
  readonly partition: number;
  readonly offset: number;
  readonly key: Buffer | null;
  readonly value: Buffer | null;
  readonly headers: Record<string, Buffer | null>;
  readonly timestamp: number;
}

export interface GroupMember {
  readonly memberId: string;
  /** The topics this member can serve. */
  readonly topics: string[];
}

export class ConsumerGroup {
  private readonly connections = new Map<string, KafkaConnection>();
  private memberId: string | undefined;
  private assignment: TopicPartition[] = [];
  private readonly offsets = new Map<string, number>();

  private readonly config: ConsumerGroupConfig;
  constructor(config: ConsumerGroupConfig) {
    this.config = config;
  }

  /** The partitions this member currently owns. Empty until it has joined. */
  get assigned(): readonly TopicPartition[] {
    return this.assignment;
  }

  /** True when this member leads the group and therefore writes the assignment. */
  get isLeader(): boolean {
    return this.members()[0] === this.memberId;
  }

  private connectionFor(broker: number, brokers: readonly BrokerAddress[]): KafkaConnection {
    const key = String(broker);
    const existing = this.connections.get(key);
    if (existing !== undefined) return existing;
    const address = brokers[broker];
    if (address === undefined) throw new Error(`kafka: broker ${broker} is not in the configured list`);
    const connection = new KafkaConnection({
      host: address.host,
      port: address.port,
      clientId: this.config.clientId,
    });
    this.connections.set(key, connection);
    return connection;
  }

  /** Every member this consumer knows about, from its last JoinGroup response. */
  private knownMembers: GroupMember[] = [];

  private members(): string[] {
    return this.knownMembers.map((member) => member.memberId).sort();
  }

  /** METADATA: which brokers lead which partitions of the topic. */
  async discoverPartitions(brokers = this.config.brokers): Promise<TopicPartition[]> {
    const seed = brokers[0];
    if (seed === undefined) throw new Error("kafka: no brokers configured");
    const connection = this.connectionFor(0, brokers);
    await connection.connect();

    const body = Buffer.concat([
      writeInt32(1),
      int16Value(this.config.topic.length),
      Buffer.from(this.config.topic, "utf8"),
    ]);
    const response = await connection.send(KAFKA_API.METADATA, 1, body);
    const reader = new Reader(response);
    const brokerCount = reader.arrayLength();
    for (let i = 0; i < brokerCount; i += 1) {
      reader.int32(); // node id
      reader.string(); // host
      reader.int32(); // port
    }
    const topicCount = reader.arrayLength();
    const partitions: TopicPartition[] = [];
    for (let i = 0; i < topicCount; i += 1) {
      const name = reader.string();
      reader.int8(); // is internal
      const partitionCount = reader.arrayLength();
      for (let p = 0; p < partitionCount; p += 1) {
        const partitionError = reader.int16();
        const partition = reader.int32();
        const leader = reader.int32();
        reader.array(() => { reader.int32(); reader.int32(); reader.int32(); }); // replicas
        reader.array(() => { reader.int32(); reader.int32(); reader.int32(); }); // isr
        if (partitionError !== 0) {
          throw new Error(`kafka: partition ${name}-${partition} is unavailable (error ${partitionError})`);
        }
        partitions.push({ topic: name, partition, leader });
      }
    }
    return partitions;
  }

  /** FIND_COORDINATOR: which broker runs the group protocol for this group. */
  async findCoordinator(brokers = this.config.brokers): Promise<number> {
    const connection = this.connectionFor(0, brokers);
    await connection.connect();
    const body = Buffer.concat([
      int16Value(1), // group key type: "consumer"
      int16Value(this.config.groupId.length),
      Buffer.from(this.config.groupId, "utf8"),
    ]);
    const response = await connection.send(KAFKA_API.FIND_COORDINATOR, 0, body);
    const reader = new Reader(response);
    const errorCode = reader.int16();
    if (errorCode !== 0) throw new Error(`kafka: no coordinator for group ${this.config.groupId} (error ${errorCode})`);
    return reader.int32();
  }

  /**
   * JOIN_GROUP, then SYNC_GROUP.
   *
   * Both halves are needed: JoinGroup is how the broker collects the membership
   * and elects a leader, SyncGroup is how the leader's assignment reaches the
   * followers. A consumer that stops after JoinGroup knows it is a member of a
   * group and owns nothing.
   */
  async join(brokers = this.config.brokers): Promise<TopicPartition[]> {
    const coordinatorId = await this.findCoordinator(brokers);
    const connection = this.connectionFor(coordinatorId, brokers);
    await connection.connect();

    const sessionTimeout = this.config.sessionTimeoutMs ?? 30_000;
    // JOIN_GROUP v0: group id FIRST, then timeout, then the member id, then the
    // protocol. The ordering is not a detail -- v1 inserts a generation id and a
    // protocol name ahead of the member id, and reading v1 bytes with a v0 layout
    // yields a member id made of the generation id.
    const joinBody = Buffer.concat([
      writeInt16(this.config.groupId.length > 0 ? this.config.groupId.length : 0),
      Buffer.from(this.config.groupId, "utf8"),
      writeInt32(sessionTimeout),
      ...(this.memberId === undefined
        ? [Buffer.from([255, 255, 255, 255])] // -1: a member that has never joined
        : [int32Value(Buffer.byteLength(this.memberId)), Buffer.from(this.memberId, "utf8")]),
      int16Value(1), // protocol name length
      Buffer.from("range", "utf8"),
      writeInt32(1), // one protocol metadata blob
      writeVarint(this.config.topic.length),
      Buffer.from(this.config.topic, "utf8"),
    ]);
    const joinResponse = await connection.send(KAFKA_API.JOIN_GROUP, 0, joinBody);
    const joinReader = new Reader(joinResponse);
    const joinError = joinReader.int16();
    if (joinError !== 0) throw new Error(`kafka: join group failed (error ${joinError})`);
    this.memberId = joinReader.string();
    const leaderId = joinReader.string();
    const memberCount = joinReader.arrayLength();
    this.knownMembers = [];
    for (let i = 0; i < memberCount; i += 1) {
      const id = joinReader.string();
      joinReader.nullableBytes(); // client id
      joinReader.nullableBytes(); // client host
      joinReader.nullableBytes(); // member metadata
      this.knownMembers.push({ memberId: id, topics: [this.config.topic] });
    }

    const sortedMembers = this.members();
    const partitions = await this.discoverPartitions(brokers);
    // The leader computes the ranges. Followers receive whatever it writes, which
    // is the whole reason two members cannot disagree.
    const assignment = leaderId === this.memberId
      ? Buffer.from(this.rangeAssignment(sortedMembers, partitions))
      : Buffer.alloc(0);

    // SYNC_GROUP v0: group id, timeout, member id, then the assignment blob.
    const syncBody = Buffer.concat([
      int16Value(this.config.groupId.length),
      Buffer.from(this.config.groupId, "utf8"),
      writeInt32(sessionTimeout),
      int32Value(Buffer.byteLength(this.memberId)),
      Buffer.from(this.memberId, "utf8"),
      int32Value(Buffer.byteLength(assignment)),
      assignment,
    ]);
    const syncResponse = await connection.send(KAFKA_API.SYNC_GROUP, 0, syncBody);
    const syncReader = new Reader(syncResponse);
    const syncError = syncReader.int16();
    if (syncError !== 0) throw new Error(`kafka: sync group failed (error ${syncError})`);
    const memberAssignment = syncReader.nullableBytes();

    this.assignment = memberAssignment === null ? [] : this.parseAssignment(memberAssignment);
    this.config.onAssignment?.(this.assignment);
    return this.assignment;
  }

  /**
   * CONTIGUOUS RANGES, in the broker's own default scheme.
   *
   * Partitions are sorted by id and dealt out in blocks, so each member owns a
   * contiguous run. Exported as a pure function because it is the piece most worth
   * testing directly: get it wrong and the group still forms, still fetches, and
   * silently double-consumes.
   */
  rangeAssignment(memberIds: readonly string[], partitions: readonly TopicPartition[]): string {
    const sorted = [...partitions].sort((a, b) => a.partition - b.partition);
    const members = [...memberIds].sort();
    const perMember = Math.ceil(sorted.length / Math.max(members.length, 1));
    const out: string[] = [];
    for (let m = 0; m < members.length; m += 1) {
      const slice = sorted.slice(m * perMember, (m + 1) * perMember);
      if (slice.length === 0) continue;
      out.push(`${members[m]}:${slice.map((p) => `${p.topic}:${p.partition}`).join(",")}`);
    }
    return out.join("|");
  }

  private parseAssignment(payload: Buffer): TopicPartition[] {
    const reader = new Reader(payload);
    const count = reader.arrayLength();
    const out: TopicPartition[] = [];
    for (let i = 0; i < count; i += 1) {
      const spec = reader.string();
      const colon = spec.indexOf(":");
      if (colon < 0) continue;
      for (const pair of spec.slice(colon + 1).split(",")) {
        const [topic, partition] = pair.split(":");
        const parsed = Number(partition);
        if (topic === undefined || !Number.isFinite(parsed)) continue;
        out.push({ topic, partition: parsed, leader: 0 });
      }
    }
    return out;
  }

  /**
   * FETCH FROM EVERY ASSIGNED PARTITION, CONCURRENTLY.
   *
   * One long-poll per partition, in flight together. Serialised, an idle
   * partition's poll would block the partitions that have data, which is how a
   * consumer ends up reading one slow partition at the speed of the slowest.
   *
   * Offsets are tracked per partition in memory and start at 0, meaning "from
   * the beginning". Committing them to the broker is deliberately NOT done here:
   * a committed offset is a promise about what has been durably processed, and
   * this gateway has not processed anything yet -- it has counted it. Committing
   * on receipt would make a restart skip events the analytics never saw.
   */
  async poll(brokers = this.config.brokers): Promise<FetchedRecord[]> {
    if (this.assignment.length === 0) return [];
    const perPartition = await Promise.all(this.assignment.map(async (partition) => {
      const connection = this.connectionFor(partition.leader, brokers);
      await connection.connect();
      const key = `${partition.topic}:${partition.partition}`;
      const offset = this.offsets.get(key) ?? 0;
      const body = Buffer.concat([
        writeInt32(-1), // replica id: a consumer, not a replica follower
        writeInt32(this.config.fetchWaitMs ?? 1_000), // max wait: a long poll
        writeInt32(0), // min bytes: return as soon as anything is available
        writeInt32(1), // one topic
        int16Value(partition.topic.length),
        Buffer.from(partition.topic, "utf8"),
        writeInt32(1), // one partition
        writeInt32(partition.partition),
        writeInt64(offset),
        writeInt32(this.config.maxBytes ?? 1_048_576),
      ]);
      const response = await connection.send(KAFKA_API.FETCH, 0, body);
      const reader = new Reader(response);
      const topicCount = reader.arrayLength();
      const records: FetchedRecord[] = [];
      for (let t = 0; t < topicCount; t += 1) {
        reader.string();
        const partitionCount = reader.arrayLength();
        for (let p = 0; p < partitionCount; p += 1) {
          const id = reader.int32();
          const errorCode = reader.int16();
          const recordBytes = reader.nullableBytes();
          if (errorCode !== 0) {
            throw new Error(`kafka: fetch of partition ${id} failed (error ${errorCode})`);
          }
          if (recordBytes === null || recordBytes.length === 0) continue;
          for (const record of decodeRecordBatch(recordBytes)) {
            records.push({
              topic: partition.topic,
              partition: id,
              offset: record.offset,
              key: record.key,
              value: record.value,
              headers: record.headers,
              timestamp: record.timestamp,
            });
          }
          this.offsets.set(`${partition.topic}:${id}`, offset + 1 + records.filter((r) => r.partition === id).length);
        }
      }
      return records;
    }));
    return perPartition.flat();
  }

  /** The next offset this consumer would request for a partition. */
  nextOffset(topic: string, partition: number): number {
    return this.offsets.get(`${topic}:${partition}`) ?? 0;
  }

  close(): void {
    for (const connection of this.connections.values()) connection.close();
    this.connections.clear();
  }
}

/** A string length prefix, as Kafka encodes non-null strings in these versions. */
function int16Value(value: number): Buffer {
  const out = Buffer.allocUnsafe(2);
  out.writeInt16BE(value, 0);
  return out;
}

/** An int32 from an already-computed value, for nullable length fields. */
function int32Value(value: number): Buffer {
  const out = Buffer.allocUnsafe(4);
  out.writeInt32BE(value, 0);
  return out;
}