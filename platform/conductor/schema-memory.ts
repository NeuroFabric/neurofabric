import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * SCHEMA MEMORY.
 *
 * The Conductor worked out how to read the Pega alerts export once, by hand,
 * with the owner's rulings attached. Nothing about that should have to be
 * rediscovered on the next run — and more to the point, nothing about it should
 * have to be re-GUESSED. A guess that lands differently next time is worse than
 * no memory at all, because it looks like knowledge.
 *
 * Three rules, each of which is a pin in schema-memory.test.ts:
 *
 *   1. MATCH BY CONTAINMENT. An entry matches when every column of its signature
 *      is present. Keying on set equality would break the first time an export
 *      gains a column, which is exactly when recognition is worth having.
 *
 *   2. A MEMORY IS A CANDIDATE, NOT AN AUTHORITY. Before it is applied, every
 *      column it names must actually be present. A memory naming a column the
 *      file no longer has is STALE, and obeying it would rank by a column that
 *      does not exist and print an empty table that looks like a finding.
 *
 *   3. OWNER RULINGS LIVE HERE TOO. R10 and R11 were established by a person,
 *      not inferred from a header. Re-deriving them on every run would quietly
 *      discard a ruling the first time the file was needed.
 *
 * The file lives under .session-archive, which is GIT-IGNORED. That is correct
 * for a cache — it must never be a second source of truth that disagrees with
 * the code — but it also means the memory is per-checkout and does not travel
 * with the repository. A fresh clone starts knowing nothing, which is a real
 * limitation of this design and not a rounding error.
 */

export interface MemoryEntry {
  /** Columns whose presence together identify this schema. */
  readonly signature: readonly string[];
  /** The few columns worth printing when this entry is recalled. */
  readonly marker: readonly string[];
  /** role -> column, as resolved once and confirmed by testing. */
  readonly roles: Readonly<Record<string, string>>;
  /** Where it was learned. Provenance, for the human who reads this file. */
  readonly learnedFrom: string;
  /** False until a person has said the roles are right. */
  confirmedByOwner?: boolean;
}

export interface SchemaMemory {
  version: 1;
  rulings: { durationUnit?: string; timeZone?: string };
  entries: MemoryEntry[];
  /** True when the file existed but could not be read. Never silently empty. */
  corrupt?: boolean;
}

const EMPTY: SchemaMemory = { version: 1, rulings: {}, entries: [] };

export function schemaMemoryPath(root: string): string {
  return path.join(root, ".session-archive", "schema-memory.json");
}

export async function loadSchemaMemory(file: string): Promise<SchemaMemory> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    // Absent is the normal first-run case, not a problem.
    return { ...EMPTY, entries: [] };
  }
  try {
    const parsed = JSON.parse(text) as Partial<SchemaMemory>;
    if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.entries)) {
      return { version: 1, rulings: {}, entries: [], corrupt: true };
    }
    return {
      version: 1,
      rulings: parsed.rulings ?? {},
      entries: parsed.entries,
      ...(parsed.corrupt === true ? { corrupt: true } : {}),
    };
  } catch {
    // Corrupt is reported rather than swallowed. Treating unreadable memory as
    // empty would silently discard the rulings stored beside it.
    return { version: 1, rulings: {}, entries: [], corrupt: true };
  }
}

/**
 * Find a remembered mapping for these headers, or null.
 *
 * Every column named by the entry must be present in the file. That single check
 * is what keeps a stale memory from being obeyed.
 */
export function recallMapping(memory: SchemaMemory, headers: readonly string[]): MemoryEntry | null {
  const present = new Set(headers);
  let best: MemoryEntry | null = null;
  for (const entry of memory.entries) {
    if (!entry.signature.every((column) => present.has(column))) continue;
    if (entry.roles === undefined) continue;
    // Every ROLE must resolve to a column that is actually there.
    const rolesResolve = Object.values(entry.roles).every((column) => present.has(column));
    if (!rolesResolve) continue;
    if (best === null || entry.signature.length > best.signature.length) best = entry;
  }
  return best;
}

export interface RememberInput {
  signature: readonly string[];
  marker: readonly string[];
  roles: Readonly<Record<string, string>>;
  learnedFrom: string;
  /** Owner rulings to persist alongside. R10 and R11 came from a person. */
  rulings?: { durationUnit?: string; timeZone?: string };
}

/** Persist a mapping, replacing any entry with the same signature. */
export async function rememberMapping(file: string, input: RememberInput): Promise<SchemaMemory> {
  const memory = await loadSchemaMemory(file);
  const entry: MemoryEntry = {
    signature: [...input.signature],
    marker: [...input.marker],
    roles: { ...input.roles },
    learnedFrom: input.learnedFrom,
    confirmedByOwner: false,
  };
  const entries = memory.entries.filter(
    (e) => !(e.signature.length === entry.signature.length
      && e.signature.every((c, i) => c === entry.signature[i])),
  );
  const next: SchemaMemory = {
    ...memory,
    version: 1,
    // Rulings accumulate and are never overwritten by a later, weaker write.
    rulings: { ...(input.rulings ?? {}), ...memory.rulings },
    entries: [...entries, entry],
  };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}