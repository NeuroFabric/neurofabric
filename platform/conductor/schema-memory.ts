import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * SCHEMA MEMORY (Task 1 ruling).
 *
 * Two stores, one order, and the order is the decision:
 *
 *   1. `.session-archive/schemas.json` — what THIS checkout has learned. Per
 *      checkout, gitignored, never shipped. A user's own correction outranks
 *      anything we ship, because it is the only one of the two that was
 *      checked against the file in front of them.
 *   2. `configs/default-schemas.json` — core VERIFIED schemas, tracked in git,
 *      shipped with the product. The Pega mapping was established against a real
 *      export in Stage 2; re-deriving it by name-matching on every install would
 *      throw away a verified result and, worse, would re-run the R9 trap on a
 *      customer instead of on a fixture.
 *
 * So: archive first, defaults as the fallback. "Fallback" in that sentence means
 * it applies only when the archive yields nothing usable for THIS file.
 *
 * A remembered schema is applied only when the columns it names are actually
 * present. A stored mapping is a claim about a shape; applying it to a different
 * shape would rank on `undefined` and print a confident empty table, which is
 * the specific failure mode the whole R9 work exists to prevent.
 *
 * Never throws. A corrupt or absent archive degrades to the shipped defaults,
 * because a memory subsystem that can take the product down is worse than one
 * that forgets.
 */

export type SchemaSource = "SESSION_ARCHIVE" | "DEFAULT";

export interface ResolvedSchema {
  readonly id: string;
  readonly roles: Record<string, string>;
  /** Which store answered. Reported, never hidden: a mapping is only as good as its provenance. */
  readonly source: SchemaSource;
  /** Roles whose column came from the per-checkout archive. The override list. */
  readonly learnedRoles: readonly string[];
  /** Columns a store named but this file does not have. Dropped, not applied. */
  readonly absent: readonly string[];
  /** Roles the store had no column for. Named rather than left to look complete. */
  readonly unresolved: readonly string[];
}

interface StoredSchema {
  id: string;
  roles: Record<string, string | null>;
  match?: { allOf?: string[] };
}

interface SchemaFile {
  schemas: StoredSchema[];
}

const ARCHIVE_RELATIVE = path.join(".session-archive", "schemas.json");
const DEFAULT_RELATIVE = path.join("configs", "default-schemas.json");

/** Roles the product actually asks for. A schema that cannot fill these is not a match. */
const REQUIRED_ROLES = ["category", "time", "source"] as const;

function readJsonFile(file: string): Promise<SchemaFile | undefined> {
  // Synchronous-by-promise is the honest shape: an absent or malformed store is
  // a fact, not an error, and returning undefined is what makes the fallback work.
  return import("node:fs/promises")
    .then((fs) => fs.readFile(file, "utf8"))
    .then((text): SchemaFile | undefined => {
      const parsed = JSON.parse(text) as SchemaFile | StoredSchema[];
      // BOTH shapes are accepted on purpose. The shipped config is an object so
      // it can carry a version and a comment; `.session-archive/schemas.json` is
      // a file a person edits by hand, and the shortest thing that works is a
      // bare array. Rejecting the short form would teach people that memory
      // "did not work" rather than that they used the wrong shape.
      const schemas = Array.isArray(parsed) ? parsed : parsed.schemas;
      return Array.isArray(schemas) ? { schemas } : undefined;
    })
    .catch(() => undefined);
}

/** The first stored schema whose declared columns are all present, else the best partial one. */
function select(schemas: StoredSchema[], headers: readonly string[]): StoredSchema | undefined {
  const present = new Set(headers);
  const declared = schemas.filter((s) => typeof s.id === "string" && typeof s.roles === "object" && s.roles !== null);
  const matched = declared.filter((s) => (s.match?.allOf ?? []).every((c) => present.has(c)));
  if (matched.length > 0) return matched[0];
  // No declared match. Fall back to the schema with the most of its roles
  // actually present, and only if that is enough to be worth applying.
  const scored = declared
    .map((s) => ({ s, hits: Object.values(s.roles).filter((c): c is string => typeof c === "string" && present.has(c)).length }))
    .filter((e) => e.hits > 0)
    .sort((a, b) => b.hits - a.hits);
  return scored[0]?.s;
}

/** The roles one store can supply for this file, and the columns it named in vain. */
function rolesFrom(schema: StoredSchema, headers: readonly string[]): { roles: Record<string, string>; absent: string[] } {
  const present = new Set(headers);
  const roles: Record<string, string> = {};
  const absent: string[] = [];
  for (const [role, column] of Object.entries(schema.roles)) {
    if (typeof column !== "string" || column.length === 0) continue;
    if (!present.has(column)) { absent.push(column); continue; }
    roles[role] = column;
  }
  return { roles, absent };
}

export interface ResolveOptions {
  /** The project root. `.session-archive` is read from here. */
  cwd: string;
  /** The header row of the file being analysed. */
  headers: readonly string[];
  /**
   * Where the shipped defaults live. Defaults to `<cwd>/configs`, which is the
   * product layout; tests and the web server override it so a temporary
   * workspace does not have to carry a copy of the product's configs.
   */
  defaultsRoot?: string;
}

/**
 * Merge the two stores role by role: the archive first, the shipped defaults
 * filling only what the archive left empty.
 *
 * Merging rather than choosing is what makes both halves of the ruling true at
 * once. A checkout that corrected ONE role keeps that correction and still gets
 * the verified mapping for the other five; picking a whole store or the other
 * would mean either losing the correction or losing the shipped schema.
 */
export async function resolveSchemaMemory(options: ResolveOptions): Promise<ResolvedSchema | undefined> {
  const headers = options.headers;

  const archive = await readJsonFile(path.resolve(options.cwd, ARCHIVE_RELATIVE));
  const learned = archive === undefined ? undefined : select(archive.schemas, headers);
  const defaults = await readJsonFile(path.resolve(options.defaultsRoot ?? options.cwd, DEFAULT_RELATIVE));
  const core = defaults === undefined ? undefined : select(defaults.schemas, headers);

  const fromArchive = learned === undefined ? { roles: {}, absent: [] } : rolesFrom(learned, headers);
  const fromCore = core === undefined ? { roles: {}, absent: [] } : rolesFrom(core, headers);

  const roles = { ...fromCore.roles, ...fromArchive.roles };
  // A schema that cannot fill a REQUIRED role is not applied. Half a mapping is
  // not a schema; it is a report with holes that nobody labelled.
  const unresolved = REQUIRED_ROLES.filter((role) => roles[role] === undefined);
  if (unresolved.length > 0) return undefined;

  const learnedRoles = Object.keys(fromArchive.roles);
  return {
    id: learned?.id ?? core?.id ?? "unresolved",
    roles,
    source: learnedRoles.length > 0 ? "SESSION_ARCHIVE" : "DEFAULT",
    learnedRoles,
    absent: [...fromArchive.absent, ...fromCore.absent],
    unresolved,
  };
}
