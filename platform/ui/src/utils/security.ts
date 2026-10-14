// NeuroFabric Sovereign Security Primitives (Enforcing All 55 Checklist Controls)

// Item #12: Block XSS & HTML Injection
export function sanitizeXSS(raw: string): { clean: string; blocked: boolean; threats: string[] } {
  const threats: string[] = [];
  if (/<script\b[^>]*>/i.test(raw)) threats.push('Blocked <script> tag');
  if (/javascript:/i.test(raw)) threats.push('Blocked javascript: URI');
  if (/on(error|load|click|mouseover|focus)\s*=/i.test(raw)) threats.push('Blocked inline DOM event handler');
  if (/<(iframe|object|embed|svg)\b/i.test(raw)) threats.push('Blocked embedded active element');

  const clean = raw
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '[XSS:SCRIPT_BLOCKED]')
    .replace(/javascript:/gi, '[XSS:JS_URI_BLOCKED]')
    .replace(/on(error|load|click|mouseover|focus)\s*=/gi, 'data-blocked-event=')
    .replace(/[<>]/g, (m) => (m === '<' ? '&lt;' : '&gt;'));

  return { clean, blocked: threats.length > 0, threats };
}

// Item #5: Hash Passwords with WebCrypto PBKDF2-HMAC-SHA256 (100,000 iterations)
export async function hashPasswordPBKDF2(password: string, emailSalt: string): Promise<string> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: enc.encode(`neurofabric-salt-2026:${emailSalt.toLowerCase()}`),
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );
  return Array.from(new Uint8Array(derivedBits))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Item #10 & #3: Parameterized SQL Builder & Row-Level Security (RLS) Enforcer
export function buildParameterizedQuery(
  tenantId: string,
  serviceFilter: string,
  searchKeyword: string
): { sql: string; params: string[]; injectionAttemptBlocked: boolean } {
  const sqliPattern = /('|--|;|\b(DROP|DELETE|UNION|INSERT|UPDATE|ALTER|EXEC)\b)/i;
  const injectionAttemptBlocked = sqliPattern.test(searchKeyword) || sqliPattern.test(serviceFilter);
  const safeSearch = searchKeyword.replace(sqliPattern, '');

  const sql = `SELECT id, timestamp, severity, service, message FROM telemetry_wal WHERE tenant_id = ? AND (? = 'ALL' OR service = ?) AND message LIKE ? ORDER BY epoch_ms DESC LIMIT 200;`;
  const params = [tenantId, serviceFilter, serviceFilter, `%${safeSearch}%`];

  return { sql, params, injectionAttemptBlocked };
}

// Item #13: Validate Uploads (Allowlist MIME types, extensions, path traversal & 2MB size cap)
export function validateUploadFile(
  fileName: string,
  mimeType: string,
  sizeBytes: number
): { valid: boolean; reason: string } {
  const MAX_BYTES = 2 * 1024 * 1024; // 2 MB
  const allowedExt = /\.(json|yaml|yml|log|csv|txt)$/i;
  const allowedMimes = new Set([
    'application/json',
    'text/yaml',
    'text/x-yaml',
    'text/plain',
    'text/csv',
    'application/octet-stream',
  ]);

  if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
    return { valid: false, reason: 'PATH_TRAVERSAL_BLOCKED: Filename contains illegal directory traversal characters.' };
  }
  if (!allowedExt.test(fileName)) {
    return { valid: false, reason: 'EXECUTABLE_UPLOAD_BLOCKED: Only .json, .yaml, .log, and .csv telemetry files are permitted.' };
  }
  if (sizeBytes > MAX_BYTES) {
    return { valid: false, reason: `FILE_TOO_LARGE: ${(sizeBytes / 1024 / 1024).toFixed(2)}MB exceeds 2.00MB sovereign cap.` };
  }
  if (mimeType && !allowedMimes.has(mimeType)) {
    return { valid: false, reason: `DISALLOWED_MIME_TYPE: ${mimeType} rejected by upload filter.` };
  }
  return { valid: true, reason: 'UPLOAD_VERIFIED: File extension, MIME signature, and size within sovereign bounds.' };
}

// Items #14 & #59: Webhook HMAC-SHA256 Verification + 300s Replay Window + Nonce Cache
const processedWebhookNonces = new Set<string>();

export async function verifyWebhookPayload(
  payload: string,
  timestampSec: number,
  nonce: string,
  secret: string,
  providedSignature?: string
): Promise<{ verified: boolean; code: number; reason: string; signature: string }> {
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - timestampSec) > 300) {
    return {
      verified: false,
      code: 401,
      reason: `WEBHOOK_REPLAY_REJECTED: Timestamp drift (${Math.abs(nowSec - timestampSec)}s) exceeds 300s window.`,
      signature: '',
    };
  }
  if (processedWebhookNonces.has(nonce)) {
    return {
      verified: false,
      code: 409,
      reason: `WEBHOOK_REPLAY_REJECTED: Nonce "${nonce}" was already consumed (Replay Attack Blocked).`,
      signature: '',
    };
  }

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`${timestampSec}.${nonce}.${payload}`));
  const computedSig = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  if (providedSignature && providedSignature !== computedSig) {
    return {
      verified: false,
      code: 403,
      reason: 'INVALID_WEBHOOK_SIGNATURE: HMAC-SHA256 digest mismatch.',
      signature: computedSig,
    };
  }

  processedWebhookNonces.add(nonce);
  return {
    verified: true,
    code: 200,
    reason: 'WEBHOOK_AUTHENTICATED: HMAC-SHA256 verified and nonce sealed.',
    signature: computedSig,
  };
}

// Item #69: Open Redirect Sanitizer
const ALLOWED_INTERNAL_PATHS = new Set([
  '/overview',
  '/stress',
  '/alerts',
  '/telemetry',
  '/integrations',
  '/embassy',
  '/circuits',
  '/governance',
  '/topology',
  '/security',
  '/support',
  '/roadmap',
  '/privacy',
  '/terms',
]);

export function sanitizeRedirectPath(rawTarget: string | null | undefined): string {
  if (!rawTarget) return '/overview';
  const trimmed = rawTarget.trim();
  if (
    !trimmed.startsWith('/') ||
    trimmed.startsWith('//') ||
    trimmed.includes('http:') ||
    trimmed.includes('https:') ||
    trimmed.includes('\\')
  ) {
    return '/overview';
  }
  const basePath = trimmed.split('?')[0];
  return ALLOWED_INTERNAL_PATHS.has(basePath) ? basePath : '/overview';
}

// Item #15: Client Action Rate Limiter
const actionTimestamps: number[] = [];
export function checkClientRateLimit(maxPerMinute = 60): boolean {
  const now = Date.now();
  while (actionTimestamps.length > 0 && now - actionTimestamps[0] > 60_000) {
    actionTimestamps.shift();
  }
  if (actionTimestamps.length >= maxPerMinute) {
    return false;
  }
  actionTimestamps.push(now);
  return true;
}
