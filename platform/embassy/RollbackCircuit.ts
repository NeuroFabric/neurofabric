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
  private static failureCounts = new Map<string, number>();
  private static trippedCircuits = new Set<string>();

  public static setDbPool(pool: Pool | null): void {
    this.dbPool = pool;
  }

  public static setMemoryLedger(ledger: Map<string, any>): void {
    this.memoryLedgerRef = ledger;
  }

  public static setBroadcast(fn: (payload: unknown) => void): void {
    this.broadcastFn = fn;
  }

  public static isTripped(target: string): boolean {
    return this.trippedCircuits.has(target);
  }

  public static getTrippedCircuits(): string[] {
    return Array.from(this.trippedCircuits);
  }

  public static resetCircuit(target: string): void {
    this.trippedCircuits.delete(target);
    this.failureCounts.delete(target);
    this.broadcast({
      type: "CIRCUIT_RESET",
      data: { target },
    });
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
  ): boolean {
    if (this.isTripped(target)) {
      console.warn(`[RollbackCircuit] Target ${target} circuit breaker is TRIPPED. Blocking automated mutation.`);
      void this.updateStatus(taskId, "CIRCUIT_TRIPPED", "Anti-flapping threshold exceeded (3 strikes). Manual intervention required.");
      return false;
    }

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
      this.failureCounts.delete(target);
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
    return true;
  }

  public static async onTelemetry(service: string, severity: string): Promise<boolean> {
    const sev = String(severity).toUpperCase();
    if (sev !== "CRITICAL") return false;

    let canary: CanaryWatcher | undefined;
    for (const [key, watcher] of this.activeCanaries.entries()) {
      if (key === service || service.includes(key) || key.includes(service)) {
        canary = watcher;
        break;
      }
    }

    if (!canary) return false;

    clearTimeout(canary.timer);
    this.activeCanaries.delete(service);
    this.activeCanaries.delete(canary.target);

    const strikes = (this.failureCounts.get(canary.target) || 0) + 1;
    this.failureCounts.set(canary.target, strikes);

    let reason = `Canary anomaly detected: Strike ${strikes}/3`;
    let status = "ROLLED_BACK";

    if (strikes >= 3) {
      this.trippedCircuits.add(canary.target);
      status = "CIRCUIT_TRIPPED";
      reason = "Circuit breaker tripped: Service flapping continuously. Automated actions frozen.";
    }

    const invertedDiff = this.invertDiff(canary.originalDiff);
    try {
      const adapter = new AutonomousDeploymentAdapter();
      await adapter.applyRemediation({ target: canary.target, diff: invertedDiff } as any);
    } catch (err) {
      console.warn("[RollbackCircuit] Rollback patch execution warning:", err);
    }

    await this.updateStatus(canary.taskId, status, reason);

    this.broadcast({
      type: "REMEDIATION_ROLLED_BACK",
      data: { taskId: canary.taskId, target: canary.target, status, strikes, reason },
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
      } catch {}
    }
  }

  private static broadcast(payload: unknown): void {
    if (this.broadcastFn) {
      this.broadcastFn(payload);
    }
  }
}

export default RollbackCircuit;