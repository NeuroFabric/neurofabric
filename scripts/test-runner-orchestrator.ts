import { spawn, execSync, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import process from "node:process";

const isWindows = process.platform === "win32";
const npxCmd = isWindows ? "npx.cmd" : "npx";

function clearPort(port: number): void {
  if (isWindows) {
    try {
      execSync(`powershell -NoProfile -Command "Stop-Process -Id (Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue).OwningProcess -Force"`, { stdio: "ignore" });
    } catch {}
  }
}

async function runCommand(cmd: string, args: string[], envOverrides: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: "inherit",
      shell: isWindows,
      env: { ...process.env, ...envOverrides },
    });
    child.on("close", (code) => resolve(code ?? 0));
    child.on("error", () => resolve(1));
  });
}

async function pollHealth(url: string, timeoutMs = 20000): Promise<boolean> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const body = (await res.json().catch(() => ({}))) as { status?: string };
        if (body.status === "ok") return true;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

async function main() {
  console.log("\n===================================================================");
  console.log("   NEUROFABRIC UNIFIED TEST RUNNER & SERVICE ORCHESTRATOR          ");
  console.log("===================================================================\n");

  // Step 1: Run DB Migrations
  console.log("--> [Step 1/4] Running PostgreSQL database migrations...");
  try {
    const migrationExit = await runCommand(npxCmd, ["tsx", "scripts/run-migrations.ts"]);
    if (migrationExit !== 0) {
      console.warn("  [WARN] Migrations exited with non-zero status. Proceeding to in-memory fallback...");
    } else {
      console.log("  [PASS] Migrations synchronized successfully.\n");
    }
  } catch {
    console.warn("  [WARN] Migration runner skipped or failed. Continuing...\n");
  }

  // Step 2: Clear Port 8080 and Spawn Backend
  console.log("--> [Step 2/4] Initializing background wedge server on port 8080...");
  clearPort(8080);

  let serverProcess: ChildProcess | null = spawn(npxCmd, ["tsx", "platform/web/server.ts"], {
    stdio: ["ignore", "pipe", "pipe"],
    shell: isWindows,
    env: { ...process.env, PORT: "8080", API_BASE: "http://127.0.0.1:8080" },
  });

  const stopServer = () => {
    if (serverProcess) {
      if (isWindows && serverProcess.pid) {
        try {
          execSync(`taskkill /pid ${serverProcess.pid} /T /F`, { stdio: "ignore" });
        } catch {}
      } else {
        try {
          serverProcess.kill("SIGTERM");
        } catch {}
      }
      serverProcess = null;
    }
    clearPort(8080);
  };

  process.on("SIGINT", () => {
    stopServer();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    stopServer();
    process.exit(143);
  });

  if (serverProcess.stdout) {
    const rl = readline.createInterface({ input: serverProcess.stdout });
    rl.on("line", (line) => {
      if (line.includes("listening") || line.includes("error") || line.includes("WARN")) {
        console.log(`  [server] ${line}`);
      }
    });
  }

  if (serverProcess.stderr) {
    const rlErr = readline.createInterface({ input: serverProcess.stderr });
    rlErr.on("line", (line) => {
      console.error(`  [server:err] ${line}`);
    });
  }

  // Step 3: Poll Health Probe
  console.log("--> [Step 3/4] Awaiting server readiness probe at http://127.0.0.1:8080/health...");
  const isHealthy = await pollHealth("http://127.0.0.1:8080/health", 25000);
  if (!isHealthy) {
    console.error("  [FAIL] Server failed to respond within 25 seconds. Aborting.");
    stopServer();
    process.exit(1);
  }
  console.log("  [PASS] Server is healthy and accepting connections.\n");

  // Step 4: Execute Full Regression Suite strictly against local port 8080
  console.log("--> [Step 4/4] Executing 13-phase regression suite against orchestrated instance...");
  const regressionExit = await runCommand(
    npxCmd,
    ["tsx", "scripts/run-regression-suite.ts"],
    { API_BASE: "http://127.0.0.1:8080" }
  );

  // Graceful Teardown
  console.log("\n--> Teardown: Shutting down background server instance...");
  stopServer();
  console.log("--> Teardown complete.\n");

  process.exit(regressionExit);
}

main().catch((err) => {
  console.error("Orchestrator error:", err);
  clearPort(8080);
  process.exit(1);
});
