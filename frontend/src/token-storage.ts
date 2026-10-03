/**
 * WHERE THE GATEWAY CREDENTIAL LIVES BETWEEN RELOADS.
 *
 * === SESSION STORAGE, NOT LOCAL STORAGE ===
 *
 * Both are readable by any script this page runs, so neither is safe against XSS
 * and pretending otherwise would be the more dangerous choice. The difference is
 * lifetime: `sessionStorage` dies with the tab, while `localStorage` keeps a
 * credential on disk indefinitely, survives a browser restart, and is readable by
 * every other application on the same origin. For a credential that an operator
 * can re-enter in five seconds, the narrower blast radius is the right trade.
 *
 * The best answer is still "hold it in memory and re-prompt", which is what this
 * module does whenever storage is unavailable or throws. Private browsing modes
 * and hardened configurations make `sessionStorage` access throw, and that must
 * degrade to a prompt rather than to a white screen.
 */

/** Namespaced so it cannot collide with another key this origin might use. */
export const GATEWAY_TOKEN_KEY = "command-center:gatewayToken";

export interface TokenStorage {
  /** The stored credential, or null when there is none or it cannot be read. */
  read(): string | null;
  write(value: string): void;
}

/** A credential is usable only if it is a non-blank string. */
export function isUsableToken(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * The one place a typed value becomes a credential or nothing.
 *
 * Blank input is refused here rather than passed on, so no component has to
 * remember the check and a blank credential can never reach the client
 * constructor to throw.
 */
export function normaliseToken(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/** In-memory storage. The default when no DOM storage is available. */
export function memoryTokenStorage(initial: string | null = null): TokenStorage {
  let value = initial;
  return {
    read: () => value,
    write: (next) => {
      value = next;
    },
  };
}

/**
 * Storage backed by `sessionStorage`, degrading to memory.
 *
 * Every access is wrapped: a browser that denies storage throws on ACCESS to
 * `sessionStorage`, not on write, and that throw must not reach a React render.
 */
export function sessionTokenStorage(scope?: Storage): TokenStorage {
  let fallback: TokenStorage | null = null;
  let degraded = false;
  const memory = (): TokenStorage => {
    fallback ??= memoryTokenStorage();
    return fallback;
  };

  const store = (): Storage | null => {
    try {
      return scope ?? (typeof sessionStorage === "undefined" ? null : sessionStorage);
    } catch {
      return null;
    }
  };

  return {
    read: () => {
      // Once a write has been refused, EVERY subsequent read comes from memory.
      // Writing to the fallback while still reading from the storage that just
      // failed is a silent data loss: the operator types a credential, hits
      // Connect, sees the app work, and finds it gone on reload with no error
      // anywhere. Degrading once, and staying degraded, is the only version of
      // this that is honest.
      if (degraded) return memory().read();
      const target = store();
      if (target === null) return memory().read();
      try {
        const value = target.getItem(GATEWAY_TOKEN_KEY);
        return value === null ? null : value;
      } catch {
        degraded = true;
        return memory().read();
      }
    },
    write: (value) => {
      const target = store();
      if (target === null) {
        degraded = true;
        memory().write(value);
        return;
      }
      try {
        target.setItem(GATEWAY_TOKEN_KEY, value);
        // A successful write clears any earlier degradation: the credential is
        // durably stored again.
        degraded = false;
        memory().write(value);
      } catch {
        degraded = true;
        memory().write(value);
      }
    },
  };
}

/**
 * THE CREDENTIAL TO START WITH.
 *
 * === STORAGE FIRST, ENVIRONMENT SECOND, AND THE ORDER IS THE FIX ===
 *
 * This was environment-first, on the reasoning that a deployment's configuration
 * should outrank a person. It has the opposite effect in the only place it
 * matters: once a `VITE_GATEWAY_TOKEN` exists, a value typed into the prompt is
 * read, stored, and then ignored. The operator watches their entry have no
 * effect while the client keeps presenting the configured one, which is
 * indistinguishable from the entry being rejected.
 *
 * A person at the keyboard is the more authoritative source. The environment is
 * the DEFAULT -- what a person gets before they have expressed a preference --
 * and a stored value is that preference, recorded. So the stored value wins,
 * and the environment still supplies one on a fresh tab with nothing stored, which
 * is what makes an unattended demo boot at all.
 *
 * Neither is trusted blindly: `isUsableToken` gates both, so a variable that is
 * present but empty falls through to the prompt instead of producing a
 * blank-credential crash.
 */
export function initialToken(fromEnvironment: string | undefined, storage: TokenStorage): string | null {
  const stored = normaliseToken(storage.read() ?? "");
  if (stored !== null) return stored;
  const fromEnv = normaliseToken(fromEnvironment ?? "");
  return fromEnv;
}