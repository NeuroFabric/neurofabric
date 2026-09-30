/**
 * Centralized secret redaction.
 *
 * This is the single sanitization mechanism in Neurofebric. Every value that
 * can reach a persistent store (`pi.appendEntry`, trace files) or be shown back
 * to the operator passes through here first.
 *
 * Design rules:
 *
 *  - **Fail closed.** A value that is clearly secret-like and uncertain is
 *    redacted. The key *name* is always preserved, so the diagnostic value
 *    ("a credential leaked here") survives while the value does not.
 *  - **Signature-based, not length-based.** Long hex digests, UUIDs, and
 *    timestamps are platform-generated identifiers, not secrets; redacting
 *    them would destroy provenance without protecting anything.
 *  - **Domain-agnostic.** No knowledge of any particular capability, provider,
 *    or data shape. Providers are matched by their published key *prefix*, and
 *    structured data by *field name*.
 *  - **Total.** Any input is accepted. Malformed, circular, exotic, or hostile
 *    values degrade safely instead of throwing.
 */

export const REDACTED = "[REDACTED]";

// ---------------------------------------------------------------------------
// Structured data: field names whose values are always secret
// ---------------------------------------------------------------------------

/**
 * Anchored to the whole field name so ordinary business fields are untouched.
 * Ambiguous names (`signature`, `salt`, `hash`, `key` inside `keyboard`) are
 * deliberately excluded to avoid destroying normal data.
 */
const SENSITIVE_FIELD = /^(?:[a-z0-9]+[_-])*(?:api[_-]?key|apikey|secret|secrets|secret[_-]?key|token|tokens|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|authorization|auth|password|passwd|pwd|passphrase|credential|credentials|private[_-]?key|privatekey|client[_-]?secret|session[_-]?key|connection[_-]?string|conn[_-]?str|cookie|set[_-]?cookie|otp|pin|passport|bearer)$/i;

// ---------------------------------------------------------------------------
// Free text
// ---------------------------------------------------------------------------

/** PEM private key blocks, including the body. */
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

/**
 * `secret-ish name` followed by `:`/`=` and a value. Covers `.env` lines,
 * JSON fragments, log lines, and query strings in one rule. The value may be
 * quoted; the quotes are consumed with the value.
 */
const KEY_VALUE_ASSIGNMENT =
  /\b((?:[a-z0-9]+[_-])*(?:api[_-]?key|apikey|secret|secret[_-]?key|token|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|authorization|password|passwd|pwd|passphrase|credential|credentials|private[_-]?key|client[_-]?secret|session[_-]?key|connection[_-]?string|cookie|set[_-]?cookie))\b(\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;&)\]}"']+)/gi;

/** `Authorization: Bearer <token>` and bare `Bearer <token>`. */
const BEARER = /\b(bearer|basic|token)\s+([A-Za-z0-9\-._~+/]{8,}=*)/gi;

/** JSON Web Tokens. */
const JWT = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g;

/**
 * Credential userinfo inside a URI: `scheme://user:password@host` and
 * `scheme://:password@host`.
 *
 * The host is kept — it is diagnostically useful and rarely sensitive — while
 * the userinfo is removed. The user part is optional (`*`, not `+`) so that a
 * password-only authority such as `redis://:secret@host` is covered, but a
 * bare username such as `ssh://git@github.com/...` is left readable.
 */
const URI_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]*):([^/\s@]*)@/gi;

/**
 * Credential-bearing provider key formats, matched by their published prefix.
 * Prefixes are unambiguous, so these do not collide with platform-generated
 * hex digests or UUIDs.
 */
const PROVIDER_KEY_PREFIXES = [
  /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{10,}/g,        // OpenAI / Anthropic style
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,                              // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,                              // AWS access key id
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,                             // Slack
  /\bAIza[0-9A-Za-z_-]{20,}/g,                                  // Google API key
  /\bya29\.[0-9A-Za-z_-]{20,}/g,                                 // Google OAuth
  /\bglpat-[A-Za-z0-9_-]{16,}/g,                                 // GitLab
  /\bnpm_[A-Za-z0-9]{30,}/g,                                     // npm token
  /\bhf_[A-Za-z0-9]{30,}/g,                                      // HuggingFace
  /\bdop_v1_[A-Za-z0-9]{40,}/g,                                  // DigitalOcean
  /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g,                // SendGrid
  /\b(?:pypi-)?AgEIcHlwaS5vcmc[A-Za-z0-9_-]{20,}/g,              // PyPI
  /\bkey-[A-Za-z0-9]{32,}\b/g,                                   // Stripe
];

/** Value shapes that are secret regardless of the field they appear under. */
const GENERIC_SECRET_VALUE =
  /(^|[\s"'`=:,;(\[{&?])([A-Za-z0-9+/_-]{40,}={0,2})(?=$|[\s"'`)\]};,&?])/g;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check if a string looks like a toolCallId (internal identifier, not a secret).
 * toolCallIds come in two shapes: call-<uuid> or call_<digits>.
 */
function looksLikeToolCallId(token: string): boolean {
  return /^call-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token) ||
         /^call_[0-9]+$/.test(token);
}

/**
 * Uniformly redact toolCallIds.
 */
export function redactToolCallId(value: string): string {
  return looksLikeToolCallId(value) ? REDACTED : value;
}

/**
 * Longest hex run treated as a digest rather than a secret.
 *
 * 64 characters covers SHA-256/SHA-512 and 32 covers MD5. A hex blob far longer
 * than that is not a content hash — it is encoded key material or a dump — and
 * must fail closed rather than inherit the digest exemption.
 */
const MAX_DIGEST_LENGTH = 128;

/**
 * Does this long token look like a secret, or like a platform identifier?
 *
 * Deliberately excludes hex digests (our SHA-256 artifact hashes), decimal
 * numbers, and anything without mixed character classes. A bare 40-character
 * lowercase word is not a secret.
 * Also excludes toolCallIds, which are internal identifiers.
 */
export function looksLikeGenericSecret(token: string): boolean {
  // toolCallIds are internal identifiers, not secrets
  if (looksLikeToolCallId(token)) return false;
  
  // No upper bound: a secret padded past a size limit must not become a
  // bypass. The surrounding pattern already bounds how much text is examined.
  if (token.length < 40) return false;
  if (token.length <= MAX_DIGEST_LENGTH && (HEX_ONLY.test(token) || DECIMAL_ONLY.test(token))) return false;
  if (!/[0-9]/.test(token) || !/[A-Za-z]/.test(token)) return false;
  const hasUpper = /[A-Z]/.test(token);
  const hasLower = /[a-z]/.test(token);
  // Base64/Base64url secrets mix cases or carry base64 punctuation.
  return (hasUpper && hasLower) || /[+/=_-]/.test(token);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RedactionResult {
  text: string;
  /** True when at least one substitution was made. */
  redacted: boolean;
}

/**
 * Redact secrets from a string. Idempotent: running it on its own output is a
 * no-op, and the original secret substring never appears in the result.
 */
export function redactString(value: string, depth = 0): string {
  if (typeof value !== "string" || value.length === 0) return value;

  let changed = false;
  let out = value;

  const apply = (pattern: RegExp, replacer: (...args: never[]) => string): void => {
    pattern.lastIndex = 0;
    const next = out.replace(pattern, replacer as never);
    if (next !== out) {
      changed = true;
      out = next;
    }
  };

  apply(PRIVATE_KEY_BLOCK, () => REDACTED);
  apply(URI_USERINFO, (_m, scheme: string) => `${scheme}${REDACTED}@`);
  apply(BEARER, (_m, scheme: string) => `${scheme} ${REDACTED}`);
  apply(JWT, () => REDACTED);
  for (const pattern of PROVIDER_KEY_PREFIXES) {
    apply(pattern, () => REDACTED);
  }
  // Keep the key name and separator, drop the value.
  apply(KEY_VALUE_ASSIGNMENT, (_m, name: string, separator: string) => `${name}${separator}${REDACTED}`);
  apply(GENERIC_SECRET_VALUE, (_m, lead: string, token: string) => (looksLikeGenericSecret(token) ? `${lead}${REDACTED}` : `${lead}${token}`));

  if (changed) out = redactEncodedForms(out, depth);
  return changed ? out : value;
}

export function redactStringDetailed(value: string): RedactionResult {
  const text = redactString(value);
  return { text, redacted: text !== value };
}

/**
 * Percent-decoding guard.
 *
 * A double-encoded connection string (`postgres%3A%2F%2Fuser%3Apass%40host`)
 * contains no recognizable credential in its raw form, so pattern matching
 * alone lets it through. If a value only becomes sensitive once decoded, the
 * raw form cannot be safely preserved, so the whole value is replaced.
 */
function redactEncodedForms(value: string, depth: number): string {
  if (depth > 2 || !value.includes("%")) return value;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return value;
  }
  if (decoded === value) return value;
  const redactedDecoded = redactString(decoded, depth + 1);
  if (redactedDecoded !== decoded) return REDACTED;
  return redactEncodedForms(decoded, depth + 1);
}

const MAX_DEPTH = 12;

/**
 * Recursively redact an arbitrary value.
 *
 * Handles strings, arrays, plain objects, `Map`, `Set`, `Error`, `Date`,
 * `Buffer`, and typed arrays. Cycles are broken and depth is bounded, so a
 * hostile or malformed payload cannot hang or crash the boundary.
 *
 * When an object's *key* is a sensitive field name, the value is replaced
 * wholesale without recursing into it.
 */
export function redactValue<T = unknown>(value: T, seen: WeakSet<object> = new WeakSet(), depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return value;
  if (typeof value === "symbol" || typeof value === "function") return undefined;
  if (depth >= MAX_DEPTH) return REDACTED;

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { name: value.name, message: redactString(value.message) };
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return `[buffer ${value.length} bytes]`;

  if (typeof value !== "object") return value;

  const object = value as object;
  if (seen.has(object)) return "[circular]";
  seen.add(object);

  try {
    if (Array.isArray(value)) return value.map((item) => redactValue(item, seen, depth + 1));

    if (value instanceof Map) {
      const out: Record<string, unknown> = {};
      for (const [key, item] of value) {
        const name = String(key);
        out[name] = SENSITIVE_FIELD.test(name) ? REDACTED : redactValue(item, seen, depth + 1);
      }
      return out;
    }
    if (value instanceof Set) return [...value].map((item) => redactValue(item, seen, depth + 1));

    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_FIELD.test(key) ? REDACTED : redactValue(item, seen, depth + 1);
    }
    return out;
  } catch {
    // A getter threw, or the object is exotic. Fail closed.
    return REDACTED;
  } finally {
    seen.delete(object);
  }
}

/** Redact an event payload, preserving its shape. */
export function redactPayload(payload: Record<string, unknown>): Record<string, unknown> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return {};
  return (redactValue(payload) ?? {}) as Record<string, unknown>;
}

/**
 * A redacting sink wrapper for any persistence target.
 *
 * This is the enforcement point for `pi.appendEntry`: it redacts the whole
 * entry regardless of which code path produced it, so a future caller cannot
 * bypass redaction by writing to the sink directly.
 */
export function createRedactingSink<T>(write: (value: T) => void): (value: T) => void {
  return (value: T) => write(redactValue(value) as T);
}

/** Convenience for the common "one string in, safe string out" preview case. */
export function redactPreview(value: string, maxLength = 160): string {
  const safe = redactString(value);
  return safe.length > maxLength ? `${safe.slice(0, maxLength)}…` : safe;
}