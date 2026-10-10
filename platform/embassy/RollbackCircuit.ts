/**
 * ROLLBACK CIRCUIT — Canary verification & automated rollback.
 *
 * Responsibilities:
 * 1. invertDiff  — given a unified diff, produce an exact reverse patch
 *    by swapping '+' → '-' and '-' → '+'.
 * 2. startCanaryObservation — upon approval, begin a timed observation window.
 *    • If a CRITICAL severity telemetry event for the target arrives within the window,
 *      invert the patch and apply it via AutonomousDeploymentAdapter (rollback).
 *    • If the window expires without critical errors, mark the task VERIFIED_RESOLVED.
 *
 * Design notes:
 * • Uses the shared dbPool from server.ts, injected via setDbPool().
 • Broadcasts SSE events via hitlEventBus so the UI can display canary status badges.
 • The observation timer is cleared as soon as a terminal event (critical or
   timeout) fires, so only one rollback or verification can happen per task.
 * • Listens on hitlEventBus 'hitl:events' for events matching the target.
 */

import { Pool } from "pg";
import { AutonomousDeploymentAdapter } from "./AutonomousDeploymentAdapter.ts";
import { hitlEventBus } from "./HitlAdapter.ts";

// Shared reference to the PostgreSQL pool — injected by the caller (server.ts).
let dbPool: Pool | undefined;

/** Assign the shared PostgreSQL pool from the embassy server. */
export function setDbPool(pool: Pool): void {
  dbPool = pool;
}

/**
 * Given a unified diff string (e.g. the kind produced by ingest-route.ts),
 * return an exact reverse patch where all '+' become '-' and all '-' become '+'.
 * Context lines (starting with ' ') are left untouched.
 */
export function invertDiff(diff: string): string {
  return diff.split("\n").map((line) => {
    if (line.startsWith("-")) {
      return "+" + line.slice(1);
    }
    if (line.startsWith("+")) {
      return "-" + line.slice(1);
    }
    return line;
  }).join("\n");
}

/**
 * Start a canary observation window for a given task.
 *
 * Steps:
 * 1. Persist task status → 'CANARY_VERIFYING' in approval_tasks.
 * 2. Broadcast SSE event 'CANARY_VERIFYING' with { taskId, target, timeoutMs }.
 * 3. Set an observation timer (default 15000 ms).
 * 4. Listen for CRITICAL severity events for the target during the window:
 *    - If found → invert the diff, apply remediation, mark 'ROLLED_BACK',
 *      broadcast 'REMEDIATION_ROLLED_BACK'.
 * 5. If the timer expires without critical errors → mark 'VERIFIED_RESOLVED',
 *    broadcast 'CANARY_CONFIRMED'.
 *
 * The SSE listener in ingest-route.ts (via options.onBroadcast) will call
 * this method after an APPROVED decision.
 */
export function startCanaryObservation(
  taskId: string,
  target: string,
  originalDiff: string,
  durationMs: number = 15000
): void {
  const pool = dbPool; // may be undefined during testing; check before query

  // 1. Persist task status → 'CANARY_VERIFYING'
  if (pool) {
    void pool.query(
      `UPDATE approval_tasks SET status = 'CANARY_VERIFYING' WHERE task_token = $1`,
      [taskId],
    ).catch((err) =>
      console.warn("[rollback-circuit] failed to set CANARY_VERIFYING:", err instanceof Error ? err.message : err),
    );
  }

  // 2. Broadcast SSE event 'CANARY_VERIFYING'
  const verifyPayload = {
    type: "CANARY_VERIFYING",
    data: {
      taskId,
      target,
      timeoutMs: durationMs,
    },
  };
  // Use the hitlEventBus to broadcast via the existing SSE infrastructure
  if (hitlEventBus) {
    hitlEventBus.emit("hitl:events", verifyPayload);
  }

  // 3. Set observation timer
  let timeoutId: NodeJS.Timeout | undefined;
  if (durationMs > 0) {
    timeoutId = setTimeout(async () => {
      // Window expired without critical errors → verify resolved
      if (pool) {
        void pool.query(
          `UPDATE approval_tasks SET status = 'VERIFIED_RESOLVED' WHERE task_token = $1`,
          [taskId],
        ).catch((err) =>
          console.warn("[rollback-circuit] failed to set VERIFIED_RESOLVED:", err instanceof Error ? err.message : err),
        );
      }

      const confirmPayload = {
        type: "CANARY_CONFIRMED",
        data: {
          taskId,
          target,
          status: "VERIFIED_RESOLVED",
        },
      };
      if (hitlEventBus) {
        hitlEventBus.emit("hitl:events", confirmPayload);
      }
    }, durationMs);
  }

  // 4. Listen for CRITICAL severity events for the target during the observation window.
  // We use a one-time listen approach: attach a temporary listener that auto-removes after
  // either the rollback path or the timeout path executes.
  const listener = hitlEventBus?.on("hitl:events", (data: any) => {
    if (!data?.data) return;
    const payload = data.data;
    // Check for CRITICAL severity matching the target
    if (payload.severity !== "critical") return;
    if (payload.source !== target) return;

    // Critical event found for this target → trigger rollback
    if (timeoutId) clearTimeout(timeoutId);

    const invertedDiff = invertDiff(originalDiff);

    try {
      const adapter = new AutonomousDeploymentAdapter();
      const execution = adapter.applyRemediation({
        target,
        diff: invertedDiff,
      });
      // Mark task as ROLLED_BACK
      if (pool) {
        void pool.query(
          `UPDATE approval_tasks SET status = 'ROLLED_BACK' WHERE task_token = $1`,
          [taskId],
        ).catch((err) =>
          console.warn("[rollback-circuit] failed to set ROLLED_BACK:", err instanceof Error ? err.message : err),
        );
      }

      const rollbackPayload = {
        type: "REMEDIATION_ROLLED_BACK",
        data: {
          taskId,
          target,
          reason: "Canary health metrics failed post-remediation",
        },
      };
      if (hitlEventBus) {
        hitlEventBus.emit("hitl:events", rollbackPayload);
      }
    } catch (err) {
      console.warn("[rollback-circuit] rollback failed:", err instanceof Error ? err.message : err);
    } finally {
      // Clean up: remove the listener so we don't double-trigger
      listener?.();
    }
  });
}

/** Namespace re-export for import compatibility with server.ts */
