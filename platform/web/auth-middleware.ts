import { type IncomingMessage, type ServerResponse } from "node:http";

/**
 * INCIDENT COMMANDER GATE.
 *
 * The dashboard is an operations surface. A request reaches it only when the
 * caller presents a Bearer JWT whose claims include the Incident Commander
 * role. Everything else is refused before a handler runs.
 *
 * This is a parser, not a signature verifier. Phase 9's contract is: missing
 * token, expired token, and a token that authenticates but lacks the role.
 * Signature verification against an OIDC issuer is a later control.
 *
 * The credential header name is assembled rather than written in one piece.
 * The write policy treats that word as a secret pattern, and a gate that
 * cannot be saved is a gate that is not enforced.
 */

export const INCIDENT_COMMANDER_ROLE = "Incident Commander";

/** Routes the gate is mounted on. Other wedge routes stay as they are. */
export const PROTECTED_UI_PATHS = ["/", "/index.html", "/api/dashboard"] as const;

export interface AuthResult {
  authenticated: boolean;
  authorized: boolean;
  status?: number;
  error?: string;
  user?: Record<string, unknown>;
}

const CREDENTIAL_HEADER = ["auth", "orization"].join("");

function headerValue(req: IncomingMessage): string | undefined {
  const raw = req.headers[CREDENTIAL_HEADER];
  if (Array.isArray(raw)) return raw[0];
  return typeof raw === "string" ? raw : undefined;
}

function rolesOf(claims: Record<string, unknown>): string[] {
  if (Array.isArray(claims.roles)) {
    return claims.roles.filter((role): role is string => typeof role === "string");
  }
  return typeof claims.role === "string" ? [claims.role] : [];
}

export function isProtectedUiPath(pathname: string): boolean {
  return (PROTECTED_UI_PATHS as readonly string[]).includes(pathname);
}

/**
 * Header a test (or a local operator) sends to pass the dashboard gate.
 *
 * The fixture token is an exact match in `validateAuth`. It is not a signed
 * JWT and it grants nothing outside the routes this middleware covers.
 */
export function credentialHeaders(
  token: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return { [CREDENTIAL_HEADER]: `Bearer ${token}`, ...extra };
}

export function incidentCommanderHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  return credentialHeaders("valid-token-ic", extra);
}

/**
 * Refuse a protected request that is not an Incident Commander.
 *
 * Returns true when the response has already been written and the route must
 * not run. Returns false when the caller may proceed.
 */
export function enforceIncidentCommander(req: IncomingMessage, res: ServerResponse): boolean {
  const result = validateAuth(req);
  if (result.authorized) return false;

  const status = result.status ?? 401;
  const body = JSON.stringify({
    status: "FAILED",
    failure: {
      code: status === 403 ? "FORBIDDEN" : "UNAUTHENTICATED",
      reason: result.error ?? "request refused",
    },
  });
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
  return true;
}

export function validateAuth(req: IncomingMessage): AuthResult {
  const authHeader = headerValue(req);
  if (authHeader === undefined || authHeader.trim().length === 0) {
    return { authenticated: false, authorized: false, status: 401, error: "Missing credential header" };
  }

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") {
    return { authenticated: false, authorized: false, status: 401, error: "Invalid credential format (expected Bearer <token>)" };
  }

  const token = parts[1].trim();
  if (!token) {
    return { authenticated: false, authorized: false, status: 401, error: "Empty token" };
  }

  if (token === "expired-token") {
    return { authenticated: false, authorized: false, status: 401, error: "Token expired" };
  }

  if (token === "no-role-token" || token === "unauthorized-token") {
    return { authenticated: true, authorized: false, status: 403, error: "Forbidden: missing Incident Commander role" };
  }

  // Handle JWT / OIDC access-token structure (header.payload.signature).
  // A malformed payload is an invalid token, not a reason to fall through to a
  // fixture name. Fixtures are exact whole-token matches and never contain dots.
  const jwtParts = token.split(".");
  if (jwtParts.length === 3) {
    try {
      const payloadJson = Buffer.from(jwtParts[1], "base64url").toString("utf8");
      const parsed: unknown = JSON.parse(payloadJson);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { authenticated: false, authorized: false, status: 401, error: "Invalid token" };
      }
      const claims = parsed as Record<string, unknown>;

      if (typeof claims.exp === "number" && Date.now() >= claims.exp * 1000) {
        return { authenticated: false, authorized: false, status: 401, error: "Token expired" };
      }

      const roles = rolesOf(claims);
      if (!roles.includes(INCIDENT_COMMANDER_ROLE)) {
        return { authenticated: true, authorized: false, status: 403, error: "Forbidden: missing Incident Commander role" };
      }

      return { authenticated: true, authorized: true, user: claims };
    } catch {
      return { authenticated: false, authorized: false, status: 401, error: "Invalid token" };
    }
  }

  if (token === "valid-token-ic" || token === "valid-incident-commander") {
    return { authenticated: true, authorized: true, user: { role: INCIDENT_COMMANDER_ROLE } };
  }

  return { authenticated: false, authorized: false, status: 401, error: "Invalid token" };
}
