import { useCallback, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";

import { App } from "./App";
import { CredentialPrompt } from "./components/CredentialPrompt";
import { GatewayClient } from "./api/gateway-client";
import { SchemaStore } from "./store/SchemaStore";
import { type AlertPayload } from "./api/live-contracts";
import { initialToken, isUsableToken, sessionTokenStorage, type TokenStorage } from "./token-storage";

/**
 * THE BOOT DECISION.
 *
 * The tree is EITHER a credential prompt OR a working command center. Never
 * neither, and never a half-built one.
 *
 * === THE CRASH THIS REPLACES ===
 *
 * `main.tsx` used to call `new GatewayClient({ gatewayToken })` at module scope.
 * With no credential configured -- the default on a fresh checkout -- the
 * constructor threw during module evaluation, which is before React exists. There
 * was no tree, no boundary, and no handler in a position to catch it, so the
 * operator got a blank page and a stack trace in a console they had not opened.
 *
 * The client was right to throw. The call site was wrong: a value read from an
 * environment variable is UNTRUSTED until checked, and a constructor is the
 * worst possible place to discover it is missing.
 *
 * === THE CLIENT IS BUILT INSIDE A GUARD, NOT INSIDE A RENDER ===
 *
 * `makeClient` catches everything and returns null, and the null case renders
 * the prompt. So even a constructor that throws for a reason nobody anticipated
 * -- a future validation, an exotic environment -- produces a form rather than a
 * white screen. The boundary is the backstop for the parts this cannot reach; it
 * is not the primary defence.
 */
export interface RootProps {
  /** Supplied by the caller. Defaults to session storage. */
  readonly storage?: TokenStorage;
  /** Usually `import.meta.env.VITE_GATEWAY_TOKEN`. An empty value falls through to storage. */
  readonly environmentToken?: string | undefined;
  readonly alerts?: readonly AlertPayload[];
  /** Poll cadence for the live panel. */
  readonly pollMs?: number;
}

/**
 * Build a client, or nothing. Never throws.
 *
 * Exported so the guarantee is directly testable: a constructor that throws must
 * yield `null`, not an exception.
 */
export function makeClient(token: string | null): GatewayClient | null {
  if (!isUsableToken(token)) return null;
  try {
    return new GatewayClient({ gatewayToken: token });
  } catch {
    return null;
  }
}

export function Root({
  storage,
  environmentToken,
  alerts = [],
  pollMs,
}: RootProps): ReactElement {
  const resolved = useMemo(() => storage ?? sessionTokenStorage(), [storage]);

  // The store is created ONCE. Recreating it on a credential change would throw
  // away every agent already loaded, so signing in shows an empty command
  // center that refills a moment later -- a worse experience than one that was
  // simply waiting for a credential.
  const storeRef = useRef<SchemaStore | null>(null);
  storeRef.current ??= new SchemaStore();
  const store = storeRef.current;

  const [token, setToken] = useState<string | null>(() => initialToken(environmentToken, resolved));
  const [buildError, setBuildError] = useState<string | undefined>(undefined);

  const client = useMemo(() => makeClient(token), [token]);

  const submit = useCallback(
    (next: string) => {
      if (makeClient(next) === null) {
        // Report it here rather than flipping to a state that renders nothing.
        // A Connect button that silently fails is indistinguishable from a dead
        // one.
        setBuildError("that credential could not be used to build a client");
        return;
      }
      setBuildError(undefined);
      resolved.write(next);
      setToken(next);
    },
    [resolved],
  );

  if (client === null) {
    return <CredentialPrompt onSubmit={submit} error={buildError} />;
  }

  return (
    <App
      store={store}
      source={client}
      // The SAME client polls the live route. One transport, one credential, one
      // timeout policy -- so there is no second place where the gateway
      // credential could be handled differently.
      liveSource={client}
      alerts={alerts}
      // Conditional spread rather than `pollMs={pollMs}`: under
      // `exactOptionalPropertyTypes` an explicitly-passed `undefined` is not the
      // same as an absent optional, and the difference is the difference between
      // "use the default" and "pass undefined to a default parameter".
      {...(pollMs === undefined ? {} : { pollMs })}
    />
  );
}