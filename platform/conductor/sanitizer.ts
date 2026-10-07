/**
 * DLP SANITIZER.
 * 
 * Masking functions for PII and credentials before LLM context ingestion.
 */

const IP_RE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const BEARER_RE = /Bearer\s+[a-zA-Z0-9\-\._~\+\/]+=*/gi;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;

export function sanitize(input: string): string {
  return input
    .replace(IP_RE, "[IP_MASKED]")
    .replace(UUID_RE, "[UUID_MASKED]")
    .replace(BEARER_RE, "Bearer [TOKEN_MASKED]")
    .replace(EMAIL_RE, "[EMAIL_MASKED]");
}
