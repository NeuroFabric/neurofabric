/**
 * WHERE THE LOCAL DOOR IS. One number per port, declared exactly once.
 *
 * === WHY THIS FILE EXISTS ===
 *
 * A live demo failed four times in one session, and **every one of the failures
 * was here, not in the engine**: the ingestion path, the anomaly evaluation and
 * the verdict machinery produced zero failures while a person typed a command.
 *
 * The specific one that cost the most: the !77 migration moved the wedge from
 * 3000 to 8080 and swept the README, `vite.config.ts` and `start-ui.mjs` -- and
 * missed `scripts/generate-synthetic-data.ts`, which still defaulted `--url` to
 * 3000. So the flood refused with "fetch failed" **against a dead port while the
 * wedge ran healthily on 8080**. The failure looked like a broken engine and was
 * a stale literal.
 *
 * A literal duplicated across four files is not a configuration. It is four
 * chances to be wrong, and it is wrong silently: nothing about a wrong port
 * looks wrong until a person watches a demo die on it.
 *
 * So the numbers live here, and everything that needs a port imports them. A
 * second copy of 8080 appearing anywhere else is now a grep hit with a reason,
 * rather than an incident.
 *
 * === WHY NOT A CONFIG FILE ===
 *
 * A JSON file is a second thing to keep in step, and the drift here was never
 * that the number was configurable -- it was that the number was copied. A module
 * the type gate covers is the smallest thing that cannot drift.
 *
 * OVERRIDES, in precedence order: an explicit `--port`/`PORT` at the call site,
 * then `$WEDGE_PORT`, then these defaults. An override is always someone's
 * deliberate act, and the defaults are what make the un-overridden case correct.
 */

/** The wedge's declared contract port. The dev proxy targets this. */
export const WEDGE_PORT = 8080;

/** The dev UI (vite). Fixed by the frontend's own config; named so it can be printed. */
export const UI_PORT = 5173;

/** Where a locally started wedge is reachable. Loopback only, always. */
export const WEDGE_URL = `http://127.0.0.1:${WEDGE_PORT}`;

/** Where the command center is served. */
export const UI_URL = `http://127.0.0.1:${UI_PORT}`;

/** The provider the derived portal reports on, and the flood pushes to by default. */
export const DEFAULT_PROVIDER = "pega";

/**
 * The endpoint a local command should talk to.
 *
 * `$WEDGE_URL` wins over the default so an operator who ran the wedge elsewhere
 * sets it once rather than passing `--url` to every command. That is the whole
 * reason this function exists: the flag stays available, but the common case no
 * longer needs it, and a command that no longer needs a flag cannot be typed
 * wrongly.
 */
export function wedgeUrl(explicit?: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.WEDGE_URL;
  if (explicit !== undefined && explicit.trim() !== "") return explicit;
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv;
  return WEDGE_URL;
}