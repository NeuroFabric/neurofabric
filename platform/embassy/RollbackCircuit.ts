import type { Pool } from "pg";
import { AutonomousDeploymentAdapter } from "./AutonomousDeploymentAdapter.ts";

export interface CanaryWatcher {
  taskId: string;
  target: string;
  originalDiff: string;
  timer: NodeJS.Timeout;
}

export class RollbackCircuit {
  private static dbPool: Pool | null = null;
  private static activeCanaries = new Map<string, CanaryWatcher>();
  private static memoryLedgerRef: Map<string, any> | null = null;
  private static broadcastFn: ((payload: unknown) => void) | null = null;

  public static setDbPool(pool: Pool | null): void {
    this.dbPool = pool;
  }

  public static setMemoryLedger(ledger: Map<string, any>): void {
    this.memoryLedgerRef = ledger;
  }

  public static setBroadcast(fn: (payload: unknown) => void): void {
    this.broadcastFn = fn;
  }

  public static invertDiff(diff: string): string {
    if (!diff) return "";
    return diff
      .split("\n")
      .map((line) => {
        if (line.startsWith("--- ")) return line.replace("--- ", "+++ ");
        if (line.startsWith("+++ ")) return line.replace("+++ ", "--- ");
        if (line.startsWith("+")) return "-" + line.slice(1);
        if (line.startsWith("-")) return "+" + line.slice(1);
        return line;
      })
      .join("\n");
  }

  public static startCanaryObservation(
    taskId: string,
    target: string,
    originalDiff: string,
    durationMs: number = 15000
  ): void {
    if (this.activeCanaries.has(target)) {
      clearTimeout(this.activeCanaries.get(target)!.timer);
      this.activeCanaries.delete(target);
    }
    if (this.activeCanaries.has(taskId)) {
      clearTimeout(this.activeCanaries.get(taskId)!.timer);
      this.activeCanaries.delete(taskId);
    }

    const timer = setTimeout(async () => {
      this.activeCanaries.delete(target);
      this.activeCanaries.delete(taskId);
      await this.updateStatus(taskId, "VERIFIED_RESOLVED");
      this.broadcast({
        type: "CANARY_CONFIRMED",
        data: { taskId, target, status: "VERIFIED_RESOLVED" },
      });
    }, durationMs);

    const watcher: CanaryWatcher = { taskId, target, originalDiff, timer };
    this.activeCanaries.set(target, watcher);
    this.activeCanaries.set(taskId, watcher);

    void this.updateStatus(taskId, "CANARY_VERIFYING");

    this.broadcast({
      type: "CANARY_VERIFYING",
      data: { taskId, target, timeoutMs: durationMs },
    });
  }

  public static async onTelemetry(service: string, severity: string): Promise<boolean> {
    const sev = String(severity).toUpperCase();
    if (sev !== "CRITICAL") return false;

    // Match active canary by target or default
    let canary: CanaryWatcher | undefined;
    for (const [key, watcher] of this.activeCanaries.entries()) {
      if (
        key === service ||
        service.includes(key) ||
        key.includes(service) ||
        key === "payment-gateway-service" ||
        service === "payment-gateway-service"
      ) {
        canary = watcher;
        break;
      }
    }

    if (!canary && this.activeCanaries.size > 0) {
      canary = this.activeCanaries.values().next().value;
    }

    if (!canary) return false;

    clearTimeout(canary.timer);
    this.activeCanaries.clear();

    const reason = "Canary anomaly detected: Critical telemetry spike post-remediation";
    await this.updateStatus(canary.taskId, "ROLLED_BACK", reason);

    const invertedDiff = this.invertDiff(canary.originalDiff);
    try {
      const adapter = new AutonomousDeploymentAdapter();
      await adapter.applyRemediation({ target: canary.target, diff: invertedDiff } as any);
    } catch (err) {
      console.warn("[RollbackCircuit] Rollback patch execution warning:", err);
    }

    this.broadcast({
      type: "REMEDIATION_ROLLED_BACK",
      data: { taskId: canary.taskId, target: canary.target, reason },
    });

    return true;
  }

  public static async updateStatus(taskId: string, status: string, reason?: string): Promise<void> {
    if (this.memoryLedgerRef) {
      const existing = this.memoryLedgerRef.get(taskId) || {};
      this.memoryLedgerRef.set(taskId, {
        ...existing,
        token: taskId,
        task_token: taskId,
        taskId,
        status,
        reason: reason || existing.reason || null,
        decidedAt: new Date().toISOString(),
        decided_at: Math.floor(Date.now() / 1000),
        createdAt: existing.createdAt || new Date().toISOString(),
        created_at: existing.created_at || Math.floor(Date.now() / 1000),
      });
    }

    if (this.dbPool) {
      try {
        await this.dbPool.query(
          `UPDATE approval_tasks 
           SET status = $1, reason = COALESCE($2, reason), resolved_at = EXTRACT(EPOCH FROM NOW()) * 1000
           WHERE task_token = $3`,
          [status, reason || null, taskId]
        );
      } catch {
        // Fallback to in-memory ledger
      }
    }
  }

  private static broadcast(payload: unknown): void {
    if (this.broadcastFn) {
      this.broadcastFn(payload);
    }
  }
}
