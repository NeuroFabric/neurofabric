import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * TASK MEMORY V2. The engine guesses; a person says no; the guess is gone.
 *
 * The generic profiler reads a file nobody has seen and proposes a mapping. Some
 * of those proposals will be wrong, and until this existed the only way to fix
 * one was to hand-edit a JSON file. That is an acceptable answer for a developer
 * and a dead end for everyone else, which means the profiler's mistakes were
 * permanent in practice and a wrong guess quietly became the truth.
 *
 * THE CORRECTION IS AN ARCHIVE ENTRY, NEVER AN EDIT TO THE SHIPPED BASELINE.
 * configs/default-schemas.json holds mappings verified against real exports by a
 * person. A guess about one stranger's CSV does not belong beside them, and a
 * user correcting their own file must not be able to alter what every other
 * checkout believes. The archive is per-checkout and gitignored for the same
 * reason.
 *
 * A CORRECTION IS STILL A HYPOTHESIS. Naming a column "duration" tells the
 * engine which column the user means. It does not make the unit known, and the
 * report must not start claiming milliseconds because somebody asserted a role,
 * so the learned mapping is reported as learned and the domain vocabulary stays
 * exactly where it was.
 *
 * THE COLUMN IS A NAME, NOT A PATH. The value arrives from an HTTP request, so
 * it is checked against the file's own header list and refused if it is not one
 * of them. That is not a formality: a column name is written into a file, and a
 * name like a traversal is a name that becomes a filename one refactor later.
 */

export interface FeedbackResult {
  readonly ok: boolean;
  /** Always populated, on success and on refusal. A refusal a user cannot read is a refusal they retry forever. */
  readonly reason: string;
  readonly applied?: { readonly column: string; readonly role: string };
  /** What the mapping looks like afterwards, so the UI can show the new state. */
  readonly roles?: Readonly<Record<string, string>>;
}

/** The roles the engine actually knows. Anything else is a typo, not a request. */
const KNOWN_ROLES: ReadonlySet<string> = new Set([
  "category", "time", "source", "duration", "threshold", "alias", "status", "message",
]);

const ARCHIVE_RELATIVE = path.join(".session-archive", "schema-memory.json");

/**
 * Read the archive, tolerating anything.
 *
 * A corrupt file is replaced rather than propagated, because this is the one
 * moment the user is actively trying to help the product and the worst possible
 * outcome is telling them their correction could not be saved. A previous
 * archive that is unreadable is also unreadable as a source of truth, so nothing
 * is salvaged from it and the user is told in the reason.
 */
async function readArchive(cwd: string): Promise<{ roles: Record<string, string>; replaced: boolean }> {
  const file = path.resolve(cwd, ARCHIVE_RELATIVE);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return { roles: {}, replaced: false };
  }
  try {
    const parsed = JSON.parse(text) as Array<{ id?: string; roles?: Record<string, string> }> | { schemas?: Array<{ id?: string; roles?: Record<string, string> }> };
    const entries = Array.isArray(parsed) ? parsed : (parsed.schemas ?? []);
    const first = entries[0];
    if (first === undefined || typeof first.roles !== "object" || first.roles === null) {
      return { roles: {}, replaced: true };
    }
    return { roles: { ...first.roles }, replaced: false };
  } catch {
    return { roles: {}, replaced: true };
  }
}

/**
 * RECORD A CORRECTION.
 *
 * Validation happens before anything is written, so a refused correction leaves
 * no trace: a half-written archive is worse than none, because the next reader
 * cannot tell a refused request from a saved one.
 */
export async function applyFeedback(input: {
  readonly cwd: string;
  readonly defaultsRoot?: string;
  readonly headers: readonly string[];
  readonly rows: ReadonlyArray<Record<string, string>>;
  readonly column: unknown;
  readonly role: unknown;
}): Promise<FeedbackResult> {
  if (typeof input.column !== "string" || input.column.trim().length === 0) {
    return { ok: false, reason: "no column was supplied" };
  }
  const column = input.column.trim();
  if (typeof input.role !== "string" || input.role.trim().length === 0) {
    return { ok: false, reason: `no role was supplied for column ${column}` };
  }
  const role = input.role.trim().toLowerCase();

  if (!KNOWN_ROLES.has(role)) {
    return { ok: false, reason: `"${role}" is not a role this engine knows; expected one of ${[...KNOWN_ROLES].join(", ")}` };
  }
  if (!input.headers.includes(column)) {
    return { ok: false, reason: `column "${column}" is not in this file; it has ${input.headers.join(", ")}` };
  }

  const archive = await readArchive(input.cwd);
  const roles = { ...archive.roles, [role]: column };

  try {
    await mkdir(path.resolve(input.cwd, ".session-archive"), { recursive: true });
    await writeFile(
      path.resolve(input.cwd, ARCHIVE_RELATIVE),
      JSON.stringify([{ id: "user-corrections", roles }], null, 2),
      "utf8",
    );
  } catch (error) {
    return { ok: false, reason: `the correction could not be saved: ${error instanceof Error ? error.message : String(error)}` };
  }

  return {
    ok: true,
    reason: archive.replaced
      ? `${column} is now the ${role}; the previous memory was unreadable and has been replaced`
      : `${column} is now the ${role}`,
    applied: { column, role },
    roles,
  };
}
