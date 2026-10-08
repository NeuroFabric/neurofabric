import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  client,
  connectMcp,
  resetPerformanceSqlExecutor,
  setPerformanceSqlExecutor,
} from "./mcp-server.ts";

/**
 * PHASE 9 RED TEAM — SQL INJECTION AGAINST query_database_performance.
 *
 * The tool is allowed to look at performance counters. It is not allowed to
 * run a second statement. A stacked query (`SELECT 1; DROP TABLE t`) is the
 * classic bypass of a "does it start with SELECT" check, so these tests prove
 * two things:
 *
 *   1. The MCP result is an error that names the stacked-statement refusal.
 *   2. The SQL executor is never invoked, so the DROP never left the tool.
 *
 * (2) is the load-bearing claim. An error message with a DROP that still ran
 * is a green test and a deleted table.
 */

afterEach(() => {
  resetPerformanceSqlExecutor();
});

async function call(name: string, args: Record<string, unknown>) {
  await connectMcp();
  return client.callTool({ name, arguments: args });
}

function textOf(result: { content?: unknown; isError?: unknown }): string {
  const content = result.content;
  const first = Array.isArray(content) ? content[0] as { type?: string; text?: string } : undefined;
  return first?.type === "text" && typeof first.text === "string" ? first.text : JSON.stringify(content ?? null);
}

const STACKED = [
  "SELECT 1; DROP TABLE users",
  "SELECT * FROM pg_stat_activity; DELETE FROM pg_stat_statements",
  "SELECT 1; INSERT INTO audit VALUES (1)",
];

test("a stacked query is refused and never reaches the SQL executor", async () => {
  const seen: string[] = [];
  setPerformanceSqlExecutor((sql) => {
    seen.push(sql);
    return [{ reached: true }];
  });

  for (const query of STACKED) {
    const result = await call("query_database_performance", { query });
    assert.equal(result.isError, true, `stacked query must be an MCP error: ${query}`);
    const text = textOf(result);
    assert.match(text, /SQL Rejected/, `refusal must be labelled: ${query}`);
    assert.match(text, /stacked statements/i, `reason must name stacking: ${query} -> ${text}`);
  }

  assert.deepEqual(seen, [], "no stacked query may be handed to the executor");
});

test("a single read-only SELECT is executed", async () => {
  const seen: string[] = [];
  setPerformanceSqlExecutor((sql) => {
    seen.push(sql);
    return [{ query_id: "slow_q_1", duration_ms: 12 }];
  });

  const result = await call("query_database_performance", { query: "SELECT 1" });
  assert.notEqual(result.isError, true, `a plain SELECT must run: ${textOf(result)}`);
  const body = JSON.parse(textOf(result)) as { status: string; readOnly: boolean; rows: unknown[] };
  assert.equal(body.status, "success");
  assert.equal(body.readOnly, true);
  assert.deepEqual(seen, ["SELECT 1"]);
  assert.equal(body.rows.length, 1);
});

test("fetch_infrastructure_logs returns traces for a correlation id", async () => {
  const result = await call("fetch_infrastructure_logs", {
    correlationId: "corr-phase9",
    metadataTag: "payments-api",
  });
  assert.notEqual(result.isError, true, textOf(result));
  const traces = JSON.parse(textOf(result)) as Array<{ correlationId: string; tag: string }>;
  assert.equal(traces.length, 1);
  assert.equal(traces[0]?.correlationId, "corr-phase9");
  assert.equal(traces[0]?.tag, "payments-api");
});
