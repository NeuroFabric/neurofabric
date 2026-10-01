import type { PolicyRequest } from "./types.ts";

/**
 * A stable identity for one call, used only to count repeats.
 *
 * Object keys are sorted so two structurally identical calls compare equal
 * regardless of construction order, and the result is never returned, logged or
 * traced — only the count derived from it is. The separator is a control
 * character that cannot appear in a tool name, so distinct calls cannot collide.
 *
 * Extracted from `configured-policy.ts` unchanged, so the policy's repeat
 * accounting and the kernel adapter's attempt identity are hashed by ONE
 * function. Two normalizers would let the two sides disagree about whether two
 * calls are the same call, which is precisely the question the strategy fund
 * asks when it decides whether an attempt is a new approach or a repeat.
 *
 * The hash domain is the tool, the operation, and the normalized input. The
 * taskId is NOT part of the hash: identity is a property of the CALL, so two
 * tasks making the same call are the same call as far as novelty is concerned.
 *
 * NOT re-exported from the package barrel. This is an internal normalizer, not
 * public API.
 */
export function callSignature(request: PolicyRequest): string {
  return `${request.tool?.name ?? ""}\u0000${request.operation}\u0000${stableStringify(request.input)}`;
}

/**
 * How deep the normalizer descends before it stops.
 *
 * RULING 3 (2026-10-01) added a reason for this bound to exist. Counting a
 * REFUSED call means hashing a call the policy has just rejected — and one of
 * the reasons a call is rejected is that its payload is nested far too deep for
 * the scanners to walk (`bounded-scan-truncation.test.ts`, D-027). Hashing that
 * payload recursed to a stack overflow and took the process down, which is the
 * exact failure a bounded scanner exists to prevent: the guard was fine and the
 * bookkeeping beside it was not.
 *
 * The bound is deliberately generous — deeper than any payload the scanners
 * will walk — so every real call is still identified exactly. Past the bound the
 * walk stops and records a marker, which means an over-deep call still lands in
 * ONE repeatable bucket instead of being uncountable. That is the property that
 * matters for the refusal loop this count exists to expose: five identical
 * refusals must still look like five.
 */
const MAX_SIGNATURE_DEPTH = 64;

/**
 * Deterministic JSON with sorted object keys, so structural equality decides
 * string equality. Arrays keep their order, because `[a, b]` and `[b, a]` are
 * different calls.
 */
export function stableStringify(value: unknown): string {
  return render(value, 0);
}

function render(value: unknown, depth: number): string {
  if (depth > MAX_SIGNATURE_DEPTH) return '"<depth-exceeded>"';
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map((item) => render(item, depth + 1)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${render(item, depth + 1)}`);
  return `{${entries.join(",")}}`;
}
