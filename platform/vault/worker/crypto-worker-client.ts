/**
 * THE MAIN-THREAD HALF OF THE CRYPTO WORKER.
 *
 * === WHAT THIS FILE IS ALLOWED TO TOUCH, AND WHY IT IS ALMOST NOTHING ===
 *
 * The main thread serves every tenant's traffic. It holds the event loop that a slow
 * or hanging credential read would stall for everybody. It is therefore not allowed
 * to hold a credential, and this client is the whole of the enforcement: it sends a
 * tenant, a key name and a path, and receives a label. There is no code path through
 * which a payload arrives here, and there is no field in `CryptoWorkResponse` that
 * one could arrive in.
 *
 * The reader in `reader.ts` is unchanged and still runs on this thread. What changes
 * is that the store it reads from can be backed by a worker, so a caller holding a
 * capability gets the same reference from either path.
 *
 * === THREE THINGS THAT ARE EASY TO GET WRONG AND ARE DONE EXPLICITLY ===
 *
 * 1. **The worker is created lazily, on the first request.** A vault that is never
 *    read should not cost a thread. Constructing it eagerly would mean every
 *    process that merely imports this module — including every test file that
 *    imports a module that imports it — pays for a thread it does not use.
 *
 * 2. **The worker is `unref`'d when it is idle, and `ref`'d only while a request is
 *    in flight.** This is the subtle one. A worker that is `unref`'d unconditionally
 *    does not hold the process open — true — and it also lets the process exit while
 *    a `reference()` is still outstanding, so the promise never settles and the
 *    answer is lost rather than delayed. `unref` alone converts a latency bug into a
 *    silent disappearance, which on this code path is indistinguishable from a
 *    vault that does not contain the credential.
 *
 *    The correct reading of "do not hold the process open" is *"when this thread has
 *    nothing to do, let the process end"* — not *"ignore this thread's work"*. So the
 *    handle is `ref`'d for the duration of an in-flight request and dropped again the
 *    moment the last one is answered. A process whose work is finished still exits.
 *
 * 3. **The worker is terminated when it goes idle.** This is not a resource
 *    optimisation dressed up as a security control, though it is both: the worker
 *    holds the HMAC key in its heap and holds credential bytes transiently, and a
 *    thread that has been idle for `idleTimeoutMs` is holding a key for no reason.
 *    Terminating it drops that heap. The next request pays to start a new one, which
 *    is the correct trade for a path this rare.
 */

import { randomFillSync } from "node:crypto";
import { Worker } from "node:worker_threads";

import type {
  CryptoWorkerInbound,
  CryptoWorkRequest,
  CryptoWorkResponse,
} from "./crypto-worker.ts";

export type { CryptoWorkRequest, CryptoWorkResponse, CryptoWorkerInbound };

/** Response to a caller. Same two failure codes, for the reasons in the worker. */
const FAULT_CODE = "WORKER_FAULT";
const FAULT_MESSAGE = "the credential worker could not complete the request";

export interface CryptoWorkerClientOptions {
  /**
   * The HMAC key. The client COPIES it, posts the copy, and overwrites the copy;
   * the buffer the caller passed in is the caller's to wipe, and this function does
   * not touch it because wiping somebody else's buffer is not its decision to make.
   *
   * The original having been on this thread at all is a residual — see the worker
   * header. A deployment that needs the key off this thread should pass the worker
   * a key-file path.
   */
  readonly hmacKey: Buffer;
  /** Ceiling on the vault this client will open. A larger file is a refusal. */
  readonly maxVaultBytes?: number;
  /** Terminate the worker after this long with no in-flight request. Default 30s. */
  readonly idleTimeoutMs?: number;
  /** A single request that gets no answer. Default 10s. Must exceed the idle gap. */
  readonly requestTimeoutMs?: number;
  /** Injectable so tests can drive a worker without spawning one. */
  readonly workerPath?: string;
}

export interface CryptoWorkInput {
  readonly tenant: string;
  readonly keyName: string;
  readonly vaultPath: string;
}

/**
 * The port the composition root holds. `reference` rather than `read`, and there is
 * no overload, no flag and no second method that returns a payload — the naming is
 * the specification, and a caller wanting a value is looking for a method that does
 * not exist.
 */
export interface CryptoWorkerClient {
  reference(input: CryptoWorkInput): Promise<CryptoWorkResponse>;
  /** Terminate now and fail everything in flight. Safe to call more than once. */
  dispose(): void;
  /** Whether a worker currently exists. False after an idle reap or a crash. */
  readonly running: boolean;
}

interface Pending {
  resolve(response: CryptoWorkResponse): void;
  timer: NodeJS.Timeout;
}

let sequence = 0;

export function createCryptoWorkerClient(options: CryptoWorkerClientOptions): CryptoWorkerClient {
  const workerPath = options.workerPath ?? new URL("./crypto-worker.ts", import.meta.url);
  const maxVaultBytes = options.maxVaultBytes;
  const idleTimeoutMs = options.idleTimeoutMs ?? 30_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;

  let worker: Worker | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let disposed = false;
  const pending = new Map<string, Pending>();

  const failAll = (code: string, message: string): void => {
    // Drain before answering: a `resolve` runs caller continuations synchronously
    // enough to re-enter this client, and re-entering while the map is being
    // iterated is a bug that would only appear under load.
    const waiting = [...pending.values()];
    pending.clear();
    for (const entry of waiting) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, correlationId: "", code, message });
    }
  };

  /**
   * TERMINATE, AND REAP ANYTHING STILL WAITING.
   *
   * A worker that is terminated mid-request will never answer, so every pending
   * caller is failed here rather than left on a timer. That is the difference
   * between "the vault worker is down" and "twelve requests hang for ten seconds
   * each and then all fail anyway".
   */
  const stop = (): void => {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
    const dying = worker;
    worker = undefined;
    if (dying !== undefined) {
      // Detach first: `terminate` is async and the 'exit' handler would otherwise
      // run against a worker this function has already replaced.
      dying.removeAllListeners();
      void dying.terminate();
    }
    failAll(FAULT_CODE, FAULT_MESSAGE);
  };

  /**
   * BRING THE HANDLE INTO LINE WITH WHETHER THERE IS WORK OUTSTANDING.
   *
   * Called after every request is posted and after every request is answered, so the
   * `ref`/`unref` pair below is evaluated twice per request rather than kept in sync
   * by hand in two places that could drift apart.
   */
  const reapWhenIdle = (): void => {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
    if (worker === undefined || disposed) return;

    if (pending.size > 0) {
      // IN FLIGHT: hold the loop open so the answer cannot be lost to an exit.
      worker.ref();
      return;
    }

    // IDLE: do not hold the process open, and reap the heap holding the HMAC key.
    worker.unref();
    const timer = setTimeout(() => {
      // Re-check rather than trusting the check above: a request could have arrived
      // while this timer was queued, and reaping a worker mid-flight would convert
      // a slow read into a fault.
      if (pending.size > 0 || disposed || worker === undefined) return;
      stop();
    }, idleTimeoutMs);
    // The reaper must not be a reason to stay alive. Without this, every process
    // that ever made one credential read holds an open timer for `idleTimeoutMs`
    // after it has otherwise finished.
    timer.unref?.();
    idleTimer = timer;
  };

  const ensureWorker = (): Worker => {
    if (worker !== undefined) return worker;
    if (disposed) throw new Error("the credential worker client has been disposed");

    /**
     * `execArgv` is passed EXPLICITLY rather than inherited.
     *
     * A worker entry that is TypeScript needs `--experimental-strip-types`, and
     * that flag lives in `process.execArgv`. Inheriting is the default, but an
     * explicit pass documents the dependency at the one line that would break
     * without it, and survives a future where the default changes.
     */
    const spawned = new Worker(workerPath, { execArgv: process.execArgv });

    spawned.on("message", (message: CryptoWorkResponse) => {
      const correlationId = message.correlationId;
      const entry = correlationId === "" ? undefined : pending.get(correlationId);
      if (entry === undefined) return; // late, duplicated, or from a replaced worker
      pending.delete(correlationId);
      clearTimeout(entry.timer);
      entry.resolve(message);
      reapWhenIdle();
    });

    spawned.on("error", () => {
      // The reason is on stderr already; a stack carries the vault path.
      stop();
    });
    spawned.on("exit", () => {
      if (worker === spawned) stop();
    });

    /**
     * THE ONE LINE THAT MAKES THIS COMPATIBLE WITH AN EMBEDDED SERVER.
     *
     * `unref` says: when this thread has nothing in flight, do not hold the process
     * open on my account. `ref` (called from `reapWhenIdle` when a request is
     * outstanding) says the opposite for the duration of that request. Both halves
     * are required; either alone is the bug described in the header.
     */
    spawned.unref();

    const keyCopy = Buffer.from(options.hmacKey);
    const init: CryptoWorkerInbound = {
      type: "init",
      hmacKey: keyCopy,
      ...(maxVaultBytes === undefined ? {} : { maxVaultBytes }),
    };
    spawned.postMessage(init);
    // The structured clone already gave the worker its own copy. This one is dead on
    // arrival and is overwritten here so it is not sitting in the main thread's
    // heap waiting for a collection it may never come due for.
    randomFillSync(keyCopy);

    worker = spawned;
    return spawned;
  };

  return {
    async reference(input: CryptoWorkInput): Promise<CryptoWorkResponse> {
      if (disposed) {
        return { ok: false, correlationId: "", code: FAULT_CODE, message: FAULT_MESSAGE };
      }
      sequence += 1;
      const correlationId = `cw-${sequence}`;

      let active: Worker;
      try {
        active = ensureWorker();
      } catch {
        return { ok: false, correlationId, code: FAULT_CODE, message: FAULT_MESSAGE };
      }

      return await new Promise<CryptoWorkResponse>((resolve) => {
        const timer = setTimeout(() => {
          if (!pending.delete(correlationId)) return;
          // A worker that has not answered in time is not trusted to answer at all.
          // Terminating it also wipes whatever it was holding, which is the correct
          // response to "this is taking too long" on a credential path.
          stop();
          resolve({ ok: false, correlationId, code: FAULT_CODE, message: FAULT_MESSAGE });
        }, requestTimeoutMs);
        timer.unref?.();

        pending.set(correlationId, { resolve, timer });
        active.postMessage({
          type: "work",
          correlationId,
          tenant: input.tenant,
          keyName: input.keyName,
          vaultPath: input.vaultPath,
        } satisfies CryptoWorkerInbound);
        // Posted, so the handle is now `ref`'d until this request is answered.
        reapWhenIdle();
      });
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      stop();
    },

    get running(): boolean {
      return worker !== undefined;
    },
  };
}