const BASE_URL = (process.env.API_BASE || "https://neurofabric-backend.onrender.com").replace(/\/$/, "");

async function post(path: string, body: any, token?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function runAuthTests() {
  console.log("\n===================================================================");
  console.log("   NEUROFABRIC AUTHENTICATION & RBAC VALIDATION SUITE              ");
  console.log(`   Target Endpoint: ${BASE_URL}                                   `);
  console.log("===================================================================\n");

  let passed = 0;
  let failed = 0;

  function assert(title: string, condition: boolean, extra?: string) {
    if (condition) {
      console.log(`  [PASS] ${title}`);
      passed++;
    } else {
      console.error(`  [FAIL] ${title} ${extra ? `-> ${extra}` : ""}`);
      failed++;
    }
  }

  // 1. Unauthenticated Request Blocked
  console.log("--> [Test 1] Attempting Unauthenticated Mutation...");
  const unauth = await post("/api/v1/embassy/decisions", {
    taskId: `unauth-${Date.now()}`,
    decision: "APPROVED",
  });
  assert("Unauthenticated mutation blocked with HTTP 401", unauth.status === 401);

  // 2. Invalid Credentials Rejected
  console.log("\n--> [Test 2] Submitting Invalid Login Credentials...");
  const badLogin = await post("/api/v1/auth/login", {
    username: "commander@neurofabric.io",
    password: "WrongPassword999!",
  });
  assert("Invalid password rejected with HTTP 401", badLogin.status === 401);

  // 3. Valid Commander Login
  console.log("\n--> [Test 3] Authenticating Incident Commander...");
  const commanderLogin = await post("/api/v1/auth/login", {
    username: "commander@neurofabric.io",
    password: "Commander2026!",
  });
  assert("Commander issued signed session Bearer token", commanderLogin.status === 200 && Boolean(commanderLogin.data?.token));
  const commanderToken = commanderLogin.data?.token;

  // 4. Read-Only Auditor Login & Mutation Attempt
  console.log("\n--> [Test 4] Verifying Read-Only RBAC Enforcement...");
  const auditorLogin = await post("/api/v1/auth/login", {
    username: "auditor@neurofabric.io",
    password: "Audit2026!",
  });
  const auditorToken = auditorLogin.data?.token;
  const auditorMutation = await post(
    "/api/v1/embassy/decisions",
    { taskId: `audit-test-${Date.now()}`, decision: "APPROVED" },
    auditorToken
  );
  assert("Read-Only Auditor blocked from mutating with HTTP 403 Forbidden", auditorMutation.status === 403);

  // 5. Authorized Mutation with Commander Token
  console.log("\n--> [Test 5] Executing Mutation with Incident Commander Signature...");
  const commanderMutation = await post(
    "/api/v1/embassy/decisions",
    {
      taskId: `commander-approved-${Date.now().toString(36)}`,
      target: "order-processing-service",
      decision: "APPROVED",
    },
    commanderToken
  );
  assert(
    "Incident Commander successfully authenticated and authorized (HTTP 200)",
    commanderMutation.status === 200 && commanderMutation.data?.reviewer?.includes("Incident Commander")
  );

  console.log("\n===================================================================");
  console.log(`   AUTH TEST RESULTS: ${passed} PASSED | ${failed} FAILED          `);
  console.log("===================================================================\n");

  if (failed > 0) process.exit(1);
}

runAuthTests();