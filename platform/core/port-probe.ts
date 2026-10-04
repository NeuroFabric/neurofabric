import { createServer } from "node:net";
import { execFileSync } from "node:child_process";

/**
 * IS ANYTHING ALREADY ON THIS PORT? And what is it?
 *
 * === WHY THIS IS IN THE KERNEL AND NOT IN A SCRIPT ===
 *
 * Every session in this project's history has lost time to the same two things:
 * a port already bound, and an orphaned process holding one. The dev-boot script
 * *reports* a stale listener rather than stopping it, and it reports it with
 * `netstat` and `tasklist` shelling out — which is a process spawn in a boot
 * path, and it is a Windows-only implementation.
 *
 * This is the fifth coat of that fix, and the reason it belongs here is
 * structural: `start-ui.mjs` is the thing that actually calls `bind`. A check
 * anywhere else is advisory. A check at the bind site is the last moment the
 * answer is still cheap.
 *
 * === IT REPORTS. IT NEVER STOPS ANYTHING. ===
 *
 * There is no code path in this file that terminates a process, and adding one
 * would have to be argued for on its own merits. Deciding whether to end a
 * process somebody else started is a person's decision, and a tool that makes it
 * silently is a tool that will eventually make it wrongly.
 *
 * A previous session of this work was terminated by a deletion guard. The correct
 * response was to leave the file and write that down, not to find a way around
 * it. This module is that note, in code.
 *
 * === PROBES A FREE PORT RATHER THAN ONLY DESCRIBING A BUSY ONE ===
 *
 * `isPortFree` binds port 0 and releases it, so the answer is about *this
 * machine, now*. That distinction matters: a stale-listener report that is itself
 * a stale report would make the check a new source of the confusion it exists to
 * remove.
 */

/** What a caller needs to say something useful about a busy port. */
export interface PortReport {
  readonly port: number;
  readonly host: string;
  /** True when nothing is listening and a bind would be expected to succeed. */
  readonly free: boolean;
  /** The owning process, when it could be identified. Never invented. */
  readonly process?: { readonly pid: string; readonly name: string };
  /** True when the port is busy but the owner could not be named. */
  readonly unidentified?: boolean;
}

/** Try to bind. Port 0 asks the OS for any free port, so this is a real probe. */
export function isPortFree(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, host);
  });
}

/** The listening PID for a port, or undefined. Read-only; never signals anything. */
function listeningPid(port: number): string | undefined {
  const listening = process.platform === "win32" ? "LISTENING" : "LISTEN";
  try {
    const out = execFileSync("netstat", ["-ano"], { encoding: "utf8", timeout: 5_000 });
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes(listening)) continue;
      const parts = line.trim().split(/\s+/);
      const local = parts[1] ?? "";
      if (!local.endsWith(`:${port}`)) continue;
      return parts[parts.length - 1];
    }
  } catch {
    // netstat unavailable. Returning undefined is correct: we do not know, and
    // saying "no PID" is not the same as saying "no process".
    return undefined;
  }
  return undefined;
}

/** The process name for a PID, or "unknown". Cosmetic; the PID is the useful part. */
function processName(pid: string): string {
  if (process.platform !== "win32") return "unknown";
  try {
    const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8", timeout: 5_000 });
    // tasklist leads with a blank line even under /NH, so `[0]` is empty.
    const first = out.split(/\r?\n/).find((line) => line.trim() !== "") ?? "";
    return first.trim().split(/\s{2,}/)[0] || "unknown";
  } catch {
    return "unknown";
  }
}

/** Describe a port. Reports; never stops. */
export async function inspectPort(port: number, host = "127.0.0.1"): Promise<PortReport> {
  if (await isPortFree(port, host)) return { port, host, free: true };

  const pid = listeningPid(port);
  if (pid === undefined) return { port, host, free: false, unidentified: true };
  return { port, host, free: false, process: { pid, name: processName(pid) } };
}

/**
 * The message an operator sees when a port is already taken.
 *
 * A bind failure on its own says `EADDRINUSE`. That is a code for a situation,
 * not a description of it: it does not say WHICH process holds the port, and
 * someone reading it has to go and find out. This says it, with the PID, and it
 * says plainly that nothing was stopped.
 */
export function describePort(report: PortReport): string {
  if (report.free) return `port ${report.port} is free`;
  if (report.unidentified) {
    return `port ${report.port} on ${report.host} is already in use, and the owning process could not be identified.`;
  }
  return [
    `port ${report.port} on ${report.host} is already in use by PID ${report.process?.pid} (${report.process?.name}).`,
    "",
    "Nothing has been stopped. If that process is yours and you no longer want it,",
    "end it deliberately -- and note that it may be holding a workspace in use.",
    "",
    "To see it yourself:",
    process.platform === "win32"
      ? `  Get-NetTCPConnection -LocalPort ${report.port} -State Listen |`
      : `  lsof -i :${report.port}`,
  ].join("\n");
}