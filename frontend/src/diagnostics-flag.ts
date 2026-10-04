/**
 * ARE THE DIAGNOSTICS ON?
 *
 * === WHY THIS IS NOT `import.meta.env.DEV` ===
 *
 * That would have been the obvious choice and it is the wrong one. `DEV` is true
 * on a vite dev server — which is exactly where the operator runs this — so every
 * internal string the operator enumerated would still be on screen, and the
 * jargon problem would be "solved" only in a build nobody looks at.
 *
 * The flag is therefore **OFF unless someone deliberately turns it on**, by
 * `?diagnostics=1` in the URL or `VITE_SHOW_DIAGNOSTICS=1` in the environment.
 * Default-off is the only version that makes "zero internal jargon on the default
 * view" true for the person actually looking at it.
 *
 * === WHY A QUERY PARAM AND NOT ONLY THE ENV VAR ===
 *
 * Because the operator needs to be able to reach the diagnostics for a report
 * without restarting anything. `?diagnostics=1` is one keystroke; an env var is a
 * terminal, a restart, and a reload. Both are here because they answer different
 * situations, and the flag is a single decision whichever is used.
 */

/** Where the strings that must never reach a customer by default live. */
const DIAGNOSTIC_MARKERS = [
  "tenant ",
  "layout version",
  "stub",
  "ready, ",
  "fed by",
  "dev diagnostics",
  "schema endpoint",
  "recs",
] as const;

/**
 * Where the sources are read from, so the decision can be tested BOTH ways.
 *
 * Passing these is how `app-default-view.test.tsx` asserts that `?diagnostics=1`
 * brings the internals BACK — and that test matters as much as the default one,
 * because a flag that can never be turned on is not a flag, it is a deletion.
 *
 * The parameters are optional: called with nothing, this reads the real browser
 * sources. Called with them, it reads those. There is no third path and no global
 * to reset, which is the only way both directions stay honest.
 */
export interface DiagnosticSources {
  /** `window.location.search`. Omitted means "not in a browser". */
  readonly search?: string | undefined;
  /** The `VITE_SHOW_DIAGNOSTICS` value. */
  readonly flag?: string | undefined;
}

/** True when the internal view has been deliberately asked for. */
export function diagnosticsEnabled(sources: DiagnosticSources = {}): boolean {
  const search = sources.search ?? (typeof window === "undefined" ? undefined : window.location.search);
  const flag = sources.flag ?? import.meta.env.VITE_SHOW_DIAGNOSTICS;

  if (typeof search === "string") {
    try {
      if (new URLSearchParams(search).get("diagnostics") === "1") return true;
    } catch {
      // A malformed query string is not a reason to show internals.
    }
  }
  return flag === "1" || flag === "true";
}

/** Read the real browser sources. What components call. */
export function diagnosticsEnabledHere(): boolean {
  return diagnosticsEnabled({});
}

/**
 * THE STRINGS THAT MUST NOT APPEAR BY DEFAULT.
 *
 * Exported so the test can assert against this list rather than a hand-copied
 * duplicate of it — a copy is a second thing to forget, and this list exists
 * precisely because these strings were forgotten once.
 *
 * `recs` and `stub` are lowercase fragments because they are matched as
 * fragments. Case matters here: "Stub" would pass this and still read as jargon.
 */
export const DIAGNOSTIC_MARKERS_FOR_TESTS: readonly string[] = DIAGNOSTIC_MARKERS;