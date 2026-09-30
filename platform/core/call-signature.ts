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
 * Deterministic JSON with sorted object keys, so structural equality decides
 * string equality. Arrays keep their order, because `[a, b]` and `[b, a]` are
 * different calls.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
  return `{${entries.join(",")}}`;
}
