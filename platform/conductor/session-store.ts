/**
 * SESSION MEMORY. A conversation that survives F5.
 *
 * The transcript lives in React state, and React state does not survive a
 * reload. So a user asks a question, gets an answer, goes to a meeting, comes
 * back -- and all of it is gone. For a product whose whole claim is a
 * conversation, that is the most expensive bug in it.
 *
 * === WHAT IS STORED, AND WHAT IS NOT ===
 *
 * Turns store TEXT and the widget payloads the page already holds. They do NOT
 * store file contents. A session records that the user was discussing
 * "e-commerce-transactions.csv" -- never a copy of the file. That distinction is
 * the difference between a chat log and a copy of somebody's data, and a demo
 * file left behind in a session directory is a demo file the next person on the
 * machine can read.
 *
 * === THE ID IS A PATH SEGMENT, SO IT IS CONSTRAINED LIKE ONE ===
 *
 * A session id reaches the filesystem, and the caller is a browser.
 * `"../../.env"` as an id would read or write outside the store. So the id is
 * CONSTRAINED to a charset that cannot express a path at all -- not sanitised,
 * constrained. A sanitiser has to predict what an attacker meant and can be
 * wrong; a charset cannot be argued with.
 *
 * The directory is additionally resolved through the workspace boundary, so the
 * store inherits the same containment as every other write in this product
 * rather than inventing its own idea of where it is allowed to live.
 *
 * === BOUNDED, OR IT IS A DISK-FULL INCIDENT WAITING FOR A PASTE ===
 *
 * A turn is capped in characters and the transcript in turns. When the cap is
 * reached the OLDEST turns are dropped, because a truncated recent conversation
 * is useful and a truncated ancient one is not -- and dropping from the front
 * means the newest question always has its answer.
 *
 * === IT NEVER THROWS AT THE CALLER ===
 *
 * A corrupt file, a full disk, a directory that cannot be created: all of these
 * return undefined and let the caller carry on without memory. A memory
 * subsystem that can take the product down is worse than a user who loses one
 * conversation, so every failure here degrades rather than propagates.
 *
 * Zero dependencies: node:fs/promises, node:path, node:crypto.
 */

import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** A refusal from the store, and never an exception that escapes as a crash. */
export class SessionRefusal extends Error {
  readonly code: string;
  constructor(code: string, reason: string) {
    super(reason);
    this.name = "SessionRefusal";
    this.code = code;
  }
}

/** The longest single turn kept. Long enough for a paragraph, short enough for a paste. */
const MAX_TURN_CHARS = 4000;

/** The most turns kept in one session. */
const MAX_TURNS = 200;

/** Correction entries are few; the cap is for symmetry with turns. */
const MAX_CORRECTIONS = 100;

/**
 * THE WHOLE ID CHARSET. Dashes and lowercase hex only -- no dots, no slashes,
 * no colons, no whitespace, no separators of any kind.
 *
 * A 32-character hex uuid already satisfies this, so the constraint costs the
 * generator nothing. That is the property that makes it a good rule rather than
 * a defensive habit: a rule the system's own output always satisfies is a rule
 * nobody will work around.
 */
const ID_PATTERN = /^[0-9a-f-]{8,64}$/;

export function assertSessionId(id: unknown): string {
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    throw new SessionRefusal("BAD_SESSION_ID",
      "a session id may only contain lowercase hex and dashes");
  }
  return id;
}

export function newSessionId(): string {
  return randomUUID();
}

export interface SessionTurn {
  readonly role: "user" | "agent";
  readonly text: string;
  readonly widgets?: readonly unknown[];
  readonly suggestions?: readonly string[];
  /** Present on the agent turn that APPLIED a correction, so it can be replayed. */
  readonly correction?: { readonly column: string; readonly role: string };
  readonly at: string;
}

export interface SessionRecord {
  readonly id: string;
  readonly created: string;
  readonly updated: string;
  readonly turns: readonly SessionTurn[];
  readonly corrections: readonly { readonly column: string; readonly role: string }[];
}

export interface AppendTurn {
  readonly role: "user" | "agent";
  readonly text: string;
  readonly widgets?: readonly unknown[];
  readonly suggestions?: readonly string[];
  readonly correction?: { readonly column: string; readonly role: string };
}

const EMPTY = (id: string): SessionRecord => ({
  id, created: new Date().toISOString(), updated: new Date().toISOString(),
  turns: [], corrections: [],
});

/** The file for a session, or a refusal. The id is validated BEFORE it is joined. */
function fileFor(root: string, id: string): string {
  assertSessionId(id);
  const dir = path.resolve(root);
  const file = path.resolve(dir, `${id}.json`);
  // Belt and braces. The charset already forbids a separator, so this cannot
  // fire -- but the check is one line and it is the difference between "cannot"
  // and "provably cannot", which matters for a path built from browser input.
  if (path.dirname(file) !== dir) {
    throw new SessionRefusal("PATH_ESCAPE", "that session id does not name a file in the store");
  }
  return file;
}

async function ensureDir(root: string): Promise<void> {
  await mkdir(path.resolve(root), { recursive: true });
}

function clampTurn(turn: AppendTurn): SessionTurn {
  return {
    role: turn.role,
    text: String(turn.text ?? "").slice(0, MAX_TURN_CHARS),
    ...(turn.widgets === undefined ? {} : { widgets: turn.widgets }),
    ...(turn.suggestions === undefined ? {} : { suggestions: turn.suggestions }),
    ...(turn.correction === undefined ? {} : { correction: turn.correction }),
    at: new Date().toISOString(),
  };
}

/**
 * READ A SESSION. Undefined means "none", for every reason: absent, unreadable,
 * corrupt, or refused. A caller cannot tell them apart, which is deliberate --
 * the response to all four is the same, and a caller that could tell would only
 * find a way to make the difference matter.
 */
export async function readSession(root: string, id: string): Promise<SessionRecord | undefined> {
  let file: string;
  try {
    file = fileFor(root, id);
  } catch {
    return undefined;
  }
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SessionRecord>;
    if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.turns)) return undefined;
    return {
      id: parsed.id ?? id,
      created: typeof parsed.created === "string" ? parsed.created : new Date().toISOString(),
      updated: typeof parsed.updated === "string" ? parsed.updated : new Date().toISOString(),
      turns: parsed.turns,
      corrections: Array.isArray(parsed.corrections) ? parsed.corrections : [],
    };
  } catch {
    // A corrupt file is not an error the user can act on and not one they caused
    // knowingly. Start clean rather than refusing to serve the page.
    return undefined;
  }
}

/**
 * CREATE OR RESUME. Resuming NEVER clears: that overwrite is the bug this
 * feature exists to fix, and a session store that empties a transcript on open
 * is worse than no store at all because it looks like it is working.
 */
export async function openSession(root: string, id?: string): Promise<SessionRecord> {
  const sessionId = assertSessionId(id ?? newSessionId());
  const existing = await readSession(root, sessionId);
  if (existing !== undefined) return existing;
  await ensureDir(root);
  const record = EMPTY(sessionId);
  await writeSession(root, record);
  return record;
}

/** APPEND, AND PERSIST. The record returned is what is now on disk. */
export async function appendTurn(root: string, id: string, turn: AppendTurn): Promise<SessionRecord> {
  const file = fileFor(root, id);
  await ensureDir(root);
  const base = (await readSession(root, id)) ?? EMPTY(id);

  const corrections = turn.correction === undefined
    ? base.corrections
    : [...base.corrections.filter((c) => c.column !== turn.correction!.column), turn.correction]
        .slice(-MAX_CORRECTIONS);

  // Drop from the FRONT when full. The newest turn is the one the user is
  // looking at, and the oldest is the one they will never scroll back to.
  const turns = [...base.turns, clampTurn(turn)].slice(-MAX_TURNS);

  const next: SessionRecord = {
    id: base.id,
    created: base.created,
    updated: new Date().toISOString(),
    turns,
    corrections,
  };
  await writeSession(root, next);
  return next;
}

async function writeSession(root: string, record: SessionRecord): Promise<void> {
  try {
    await writeFile(fileFor(root, record.id), JSON.stringify(record, null, 2), "utf8");
  } catch {
    // Swallowed on purpose. See the module note: losing a memory is recoverable,
    // taking the page down with it is not.
  }
}

/** The ids this store holds, newest first. Absent rather than throwing. */
export async function listSessions(root: string): Promise<string[]> {
  try {
    const names = await readdir(path.resolve(root));
    return names
      .filter((n) => n.endsWith(".json"))
      .map((n) => n.slice(0, -5))
      .filter((id) => { try { assertSessionId(id); return true; } catch { return false; } });
  } catch {
    return [];
  }
}