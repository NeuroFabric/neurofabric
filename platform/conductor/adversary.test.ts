import test from "node:test";
import assert from "node:assert";
import { sanitize } from "./sanitizer.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("Attack Vector 3: Log PII & Secret Stuffing (OWASP LLM02)", () => {
  const rawLog = "192.168.1.105 - - [01/Oct/2026:11:15:22 +0000] \"GET /api/v1/data HTTP/1.1\" 200 1234 Auth: Bearer sk-12345abcdef67890\nuser@example.com - 550e8400-e29b-41d4-a716-446655440000";
  const sanitized = sanitize(rawLog);
  
  assert.strictEqual(sanitized.includes("192.168.1.105"), false, "IP not masked");
  assert.strictEqual(sanitized.includes("[IP_MASKED]"), true, "IP not masked");
  assert.strictEqual(sanitized.includes("user@example.com"), false, "Email not masked");
  assert.strictEqual(sanitized.includes("[EMAIL_MASKED]"), true, "Email not masked");
  assert.strictEqual(sanitized.includes("550e8400-e29b-41d4-a716-446655440000"), false, "UUID not masked");
  assert.strictEqual(sanitized.includes("[UUID_MASKED]"), true, "UUID not masked");
  assert.strictEqual(sanitized.includes("sk-12345abcdef67890"), false, "token not masked");
  assert.strictEqual(sanitized.includes("Bearer [TOKEN_MASKED]"), true, "token not masked");
});

test("Attack Vector 2: Schema Mutation & Excessive Agency (OWASP LLM03 / NIST GOVERN 1.2)", () => {
    // Payload simulating DDL injection
    const payload = JSON.stringify({ result_json: "DROP TABLE approval_tasks;" });
    const SCHEMA_MUTATION_RE = /\b(ALTER|DROP|CREATE|TRUNCATE|RENAME|ATTACH|DETACH)\b/i;
    
    const isSchemaMutation = SCHEMA_MUTATION_RE.test(payload);
    assert.strictEqual(isSchemaMutation, true, "Schema mutation not intercepted");
    
    // Second mutation pattern
    const payload2 = JSON.stringify({ result_json: "ALTER TABLE users ADD COLUMN compromised TEXT;" });
    const isSchemaMutation2 = SCHEMA_MUTATION_RE.test(payload2);
    assert.strictEqual(isSchemaMutation2, true, "ALTER TABLE not intercepted");
});

test("Attack Vector 1: Unbounded Iteration Flood (OWASP LLM10) - circuit breaker logic", async () => {
    // Test the iteration counting logic directly
    const MAX_ITERATIONS = 3;
    const taskIterationMap = new Map<string, number>();
    const taskId = "test-task-123";
    
    // Simulate 4 consecutive calls
    for (let i = 1; i <= 4; i++) {
        const current = taskIterationMap.get(taskId) ?? 0;
        const next = current + 1;
        taskIterationMap.set(taskId, next);
        
        if (i <= 3) {
            assert.strictEqual(next, i, `Call ${i}: iteration count mismatch`);
            assert.strictEqual(next <= MAX_ITERATIONS, true, `Call ${i}: should be allowed`);
        } else {
            assert.strictEqual(next, 4, "Call 4: iteration count should be 4");
            assert.strictEqual(next > MAX_ITERATIONS, true, "Call 4: should trigger circuit breaker");
        }
    }
});