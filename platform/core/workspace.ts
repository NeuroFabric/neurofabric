import fs from "node:fs";
import path from "node:path";
import { CoreError } from "./errors.ts";

/**
 * Filesystem boundary resolution.
 *
 * This module is the single place that answers "may this path be touched?".
 * It is deliberately pure and synchronous apart from `realpath` so that it can
 * be used from policy evaluation, artifact registration, and delivery.
 *
 * It is a *policy* boundary, not an OS sandbox. It prevents the platform from
 * knowingly operating outside the approved roots; it does not constrain what a
 * hostile process started by an already-permitted command can reach.
 */

export interface PathVerdict {
  allowed: boolean;
  /** Absolute, normalized path. Only meaningful when `allowed` is true. */
  resolvedPath?: string;
  /** Why the path was rejected. Stable, safe to show to the model. */
  reason?: string;
  /** True when the caller supplied an absolute path. */
  absolute: boolean;
  /** True when the input tried to climb out with `..`. */
  traversal: boolean;
}

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

function comparable(value: string): string {
  return CASE_INSENSITIVE ? value.toLowerCase() : value;
}

/** Depth-first search for the closest ancestor that actually exists on disk. */
function realpathOfNearestExisting(target: string): string {
  let current = path.resolve(target);
  for (;;) {
    try {
      return fs.realpathSync.native(current);
    } catch {
      const parent = path.dirname(current);
      // Reached the filesystem root without finding anything that exists.
      if (parent === current) return current;
      current = parent;
    }
  }
}

/**
 * Containment test that is not fooled by sibling directories sharing a prefix
 * (`/srv/app` must not contain `/srv/app-backup`) or by case differences.
 */
export function isInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === "") return true;
  if (path.isAbsolute(relative)) return false;
  if (CASE_INSENSITIVE) {
    const normalized = comparable(relative);
    if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) return false;
    return true;
  }
  return relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

/** True when any segment of the (already split) relative path is `..`. */
function containsTraversal(candidate: string): boolean {
  const parts = candidate.split(/[\\/]+/);
  return parts.includes("..");
}

/**
 * The candidate read with backslashes as separators.
 *
 * A backslash separates directories on Windows and is an ordinary filename
 * character on POSIX, so the same operand is an escape on one host and a
 * single oddly named file on the other. Normalising the separator produces one
 * reading that every host evaluates identically, which is what makes the
 * escape forms recognisable everywhere instead of only where they happen to be
 * separators.
 */
function withForwardSlashes(candidate: string): string {
  return candidate.includes("\\") ? candidate.replace(/\\/g, "/") : candidate;
}

/**
 * Resolve `candidate` against `root` and prove the result stays inside it.
 *
 * Checks, in order:
 *  1. the input is a non-empty string with no NUL byte;
 *  2. `..` segments are recorded (not silently allowed through);
 *  3. lexical resolution cannot escape the root;
 *  4. the same candidate read with backslashes as separators is also contained,
 *     so a Windows or mixed-separator escape is an escape on every host;
 *  5. the real path of the nearest existing ancestor is also inside the root,
 *     which defeats symlinks and Windows junctions/reparse points.
 */
export function resolveWithinRoot(root: string, candidate: unknown): PathVerdict {
  if (typeof candidate !== "string" || candidate.length === 0) {
    return { allowed: false, reason: "path must be a non-empty string", absolute: false, traversal: false };
  }
  if (candidate.includes("\0")) {
    return { allowed: false, reason: "path contains a NUL byte", absolute: false, traversal: false };
  }

  const rootPath = path.resolve(root);
  const rootReal = realpathOfNearestExisting(rootPath);
  const absolute = path.isAbsolute(candidate) || /^[a-zA-Z]:[\\/]/.test(candidate);
  const traversal = containsTraversal(candidate);

  const resolved = absolute ? path.resolve(candidate) : path.resolve(rootPath, candidate);

  if (!isInsideRoot(rootPath, resolved)) {
    return { allowed: false, reason: `path escapes the allowed root (${rootPath})`, absolute, traversal };
  }

  // A Windows or mixed-separator escape is an escape on every host, not only
  // on the one where a backslash happens to be a separator. The candidate is
  // therefore read a second time with backslashes normalised, and that reading
  // must be contained too. This can only ever add a denial, never remove one:
  // a candidate contained under both readings is allowed, so the check fails
  // closed and no host is more permissive than another. Denials raised here
  // are exactly the forms that were silently accepted on POSIX.
  const slashForm = withForwardSlashes(candidate);
  if (slashForm !== candidate && !isInsideRoot(rootPath, path.resolve(rootPath, slashForm))) {
    return { allowed: false, reason: `path escapes the allowed root (${rootPath})`, absolute, traversal };
  }

  // Defeat symlinks / junctions: the physical location must also be contained.
  const resolvedReal = realpathOfNearestExisting(resolved);
  if (!isInsideRoot(rootReal, resolvedReal)) {
    return { allowed: false, reason: "path resolves outside the allowed root through a link", absolute, traversal };
  }

  return { allowed: true, resolvedPath: resolved, absolute, traversal };
}

/**
 * The common safety bound for every bounded security scanner in the platform.
 *
 * A depth bound is a SAFETY limit, not an allow condition. When a scan stops
 * early because a payload is deeper than this, the operation has not been shown
 * to be safe -- it has been left uninspected. Truncation is therefore reported
 * explicitly and propagated to the policy decision, which fails closed. It is
 * never inferred from an empty candidate list.
 *
 * 12 is the bound D-027 already fixed for the write deny-scan (MAX_DEPTH in
 * redaction.ts, MAX_WRITE_PAYLOAD_DEPTH in configured-policy.ts), so reads,
 * writes, and pattern scanning share one threshold instead of the three
 * unrelated literals (4, 6, 12) that had drifted apart.
 *
 * Defined HERE, once, because this is the lowest module both scanners depend
 * on; the alternative -- a second literal in tool-paths.ts -- is how the
 * literals drifted apart in the first place.
 *
 * Recursion is safe at this depth: the walkers recurse once per payload level,
 * so frame count is capped at 13 regardless of input size. The RangeError that
 * motivated D-027 appeared around 2000-3000 levels. Breadth is unaffected --
 * the walk was already linear in the payload, as any traversal of one must be.
 */
export const MAX_SECURITY_SCAN_DEPTH = 12;

/**
 * Mutable truncation flag threaded through a bounded walk. Never a global, and
 * never inferred from the emptiness of a result.
 */
export interface ScanState {
  truncated: boolean;
}

/**
 * The one typed contract every bounded security scan returns.
 *
 * `candidates: []` with `truncated: false` means "scanned, nothing found".
 * `candidates: []` with `truncated: true` means "not fully inspected". Only
 * the first is evidence of safety, and a policy decision must be able to tell
 * them apart.
 */
export interface CandidateScan {
  candidates: string[];
  truncated: boolean;
}

/**
 * The one typed contract every bounded string scan returns: what was seen, and
 * whether the walk was able to finish.
 */
export interface StringScan {
  strings: string[];
  truncated: boolean;
}

export function newScanState(): ScanState {
  return { truncated: false };
}

/**
 * Collect path-like candidates out of a tool input without assuming a schema.
 *
 * A fixed set of well-known argument names is inspected first. Command strings
 * are then scanned for absolute paths and `..` sequences. This is a *conservative
 * detector*, not a shell parser: it is meant to catch escapes, not to model
 * what a shell would do.
 */
export function scanPathCandidates(input: unknown): CandidateScan {
  const candidates = new Set<string>();
  const seeds: string[] = [];
  let truncated = false;
  const KEY_NAMES = ["path", "filePath", "file_path", "filename", "fileName", "dir", "directory", "cwd", "output", "outputPath", "target"];

  const visit = (value: unknown, depth: number): void => {
    if (depth > MAX_SECURITY_SCAN_DEPTH) {
      // Recorded, never swallowed. The previous bare `return` here meant a deep
      // payload yielded an empty list that read as "no paths", so the boundary
      // was never consulted for whatever the payload actually contained.
      truncated = true;
      return;
    }
    if (value === null || value === undefined) return;
    if (typeof value === "string") {
      seeds.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value === "object") {
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        // Only well-known path arguments are trusted as-is.
        if (KEY_NAMES.includes(key) && typeof nested === "string" && nested.trim() !== "") candidates.add(nested);
        visit(nested, depth + 1);
      }
    }
  };

  visit(input, 0);

  // Separately scan every string for tokens that look like a filesystem path,
  // which is how escapes and credential paths hide inside free-form command text.
  for (const raw of seeds) {
    for (const token of raw.split(/[\s"'`()<>]+/)) {
      if (token === "") continue;
      // URLs are not filesystem paths and must not be resolved as one.
      if (token.includes("://")) continue;
      const looksAbsolute = path.isAbsolute(token) || /^[a-zA-Z]:[\\/]/.test(token);
      const looksRelative = /^\.{1,2}[\\/]/.test(token);
      // A token containing a separator may hide an escape or a nested traversal
      // (`deploy/prod.env`, `src/../../etc/passwd`), so treat it as a path.
      const looksNested = token.includes("/") || token.includes("\\");
      if (looksAbsolute || looksRelative || looksNested) candidates.add(token);
    }
  }

  return { candidates: [...candidates], truncated };
}

/**
 * The candidates from `scanPathCandidates`, without the truncation flag.
 *
 * A SECURITY decision must use `scanPathCandidates`: an empty array here is
 * ambiguous between "nothing found" and "the walk stopped early", and that
 * ambiguity is the defect this contract exists to remove.
 */
export function extractPathCandidates(input: unknown): string[] {
  return scanPathCandidates(input).candidates;
}

/**
 * The runtime boundary object handed to policy implementations.
 */
export class WorkspaceBoundary {
  readonly roots: string[];

  constructor(roots: string[]) {
    if (roots.length === 0) throw new CoreError("CONFIGURATION_ERROR", "At least one allowed root is required");
    this.roots = roots.map((root) => path.resolve(root));
  }

  /**
   * A path is permitted when it resolves inside *any* approved root.
   * Roots may not be nested duplicates of each other; overlap is harmless.
   */
  check(candidate: unknown): PathVerdict {
    let lastReason = "path is outside every allowed root";
    for (const root of this.roots) {
      const verdict = resolveWithinRoot(root, candidate);
      if (verdict.allowed) return verdict;
      lastReason = verdict.reason ?? lastReason;
    }
    return { allowed: false, reason: lastReason, absolute: typeof candidate === "string" && path.isAbsolute(candidate), traversal: typeof candidate === "string" && containsTraversal(candidate) };
  }

  /** Check every path-like value in a tool input. Returns the first violation. */
  checkInput(input: unknown): PathVerdict {
    return this.checkCandidates(extractPathCandidates(input));
  }

  checkCandidates(candidates: readonly string[]): PathVerdict {
    for (const candidate of candidates) {
      const verdict = this.check(candidate);
      if (!verdict.allowed) return { ...verdict, reason: `${candidate}: ${verdict.reason}` };
    }
    return { allowed: true, absolute: false, traversal: false };
  }
}
