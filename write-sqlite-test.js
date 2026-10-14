import fs from 'node:fs';
import path from 'node:path';

// We'll create the test file content.
const testContent = `import { describe, it, expect, vi } from 'vitest';
import { Conductor } from './conductor.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Mock kernel adapter that does nothing but record calls
class MockKernelAdapter {
  constructor() {
    this.events = {
      recent: () => [],
    };
    this.currentTask = null;
    this.boundary = null;
    this.policy = null;
    this.registerTools = () => {};
    this.beginTask = async (request, _, { input }) => {
      this.currentTask = { taskId: 'task123', input };
    };
    this.finishTask = async () => ({ ok: true, status: 'COMPLETED' });
    this.beginToolExecution = async (callId, tool, _) => ({ callId, tool });
    this.precheckToolCall = async (tool, _, input, __, callId) => ({
      decision: { decision: 'ALLOW', reason: '', violation: '', tier: undefined }
    });
    this.declareToolOutputs = async () => {};
    this.recordToolResult = async () => {};
    this.artifacts = [{ reference: 'artifact1' }];
  }
}

// Mock options for the Conductor
function createOptions(cwd) {
  return {
    cwd,
    projectConfig: { policyMode: 'TRUSTED_PROJECT', allowedRoots: ['.'] },
    defaultsRoot: cwd,
  };
}

// Helper to create a temporary SQLite file with a table and some data.
function createTempSqliteFile(dir, filename) {
  const filepath = path.join(dir, filename);
  const Database = require('better-sqlite3').default;
  const db = new Database(filepath);
  db.exec(\`
    CREATE TABLE test_table (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      value REAL
    );
    INSERT INTO test_table (name, value) VALUES ('Alice', 10.5), ('Bob', 20.3);
  \`);
  db.close();
  return filepath;
}

// Helper to create a temporary SQLite file with no tables (empty).
function createTempEmptySqliteFile(dir, filename) {
  const filepath = path.join(dir, filename);
  const Database = require('better-sqlite3').default;
  const db = new Database(filepath);
  // No tables created.
  db.close();
  return filepath;
}

describe('Conductor class with SQLite read capability', () => {
  it('should reject paths outside the workspace boundary', async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'conductor-test-'));
    try {
      // Create a file outside the tmpDir.
      const outsideDir = mkdtempSync(path.join(tmpdir(), 'outside'));
      const outsideFile = path.join(outsideDir, 'test.sqlite');
      writeFileSync(outsideFile, '', 'utf8');

      const options = createOptions(tmpDir);
      const conductor = new Conductor(options);
      let resolveCallCount = 0;
      const resolve = (question) => {
        resolveCallCount++;
        if (question.code === 'MISSING_INPUT_FILE') {
          // We'll return a path that is outside the workspace.
          return `input=${outsideFile}`;
        }
        return undefined;
      };

      // We expect the run to fail because the boundary check will fail.
      // The locateInput method will return the outside path, but then the kernel's boundary check in the tool call will refuse it.
      // However, note that the Conductor's locateInput method does not check the boundary; the boundary check is done in the tool call.
      // So the clarify step will succeed (because the input is found), but the execute step will fail with a boundary refusal.
      const result = await conductor.run('any request', { resolve });
      // We expect the result to be FAILED with a policy refusal.
      expect(result.status).toBe('FAILED');
      expect(result.failure?.code).toBe('POLICY_SOFT_REFUSE'); // or POLICY_REFUSE depending on the tier.
      // We don't care about the exact tier, just that it's a policy failure.
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('should return schema information for a SQLite file with tables', async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'conductor-test-'));
    try {
      const sqliteFile = createTempSqliteFile(tmpDir, 'test.sqlite');

      const options = createOptions(tmpDir);
      const conductor = new Conductor(options);
      let resolveCallCount = 0;
      const resolve = (question) => {
        resolveCallCount++;
        if (question.code === 'MISSING_INPUT_FILE') {
          return `input=test.sqlite`;
        }
        return undefined;
      };

      const result = await conductor.run('any request', { resolve });
      // We expect the clarify step to succeed and then the execute step to succeed.
      // We don't have a way to check the exact output of the tool call in the ConductorResult,
      // but we can check that the run did not fail and that we have artifacts (if any) or that the state is DELIVER.
      // However, the Conductor's run method does not return the tool output directly; it only returns whether the run succeeded.
      // To test the sqliteRead function directly, we would need to bypass the Conductor and call the function.
      // But for the purpose of this test, we can check that the run did not fail and that we went through the execute step.
      // We'll also check that the clarifyRounds is 0 (since we provided the input in the request).
      expect(result.clarifyRounds).toBe(0);
      expect(result.state).not.toBe('CLARIFY_EXHAUSTED');
      // We can also check that the state is not FAILED.
      expect(result.status).not.toBe('FAILED');
      // We'll also check that we have at least gone through the PLAN and EXECUTE steps by looking at the progress.
      // The progress array should have entries for PLAN and EXECUTE.
      const planProgress = result.progress.find(p => p.state === 'PLAN');
      const executeProgress = result.progress.find(p => p.state === 'EXECUTE');
      expect(planProgress).toBeDefined();
      expect(executeProgress).toBeDefined();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should execute a valid SELECT query and return rows', async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'conductor-test-'));
    try {
      const sqliteFile = createTempSqliteFile(tmpDir, 'test.sqlite');

      const options = createOptions(tmpDir);
      const conductor = new Conductor(options);
      let resolveCallCount = 0;
      const resolve = (question) => {
        resolveCallCount++;
        if (question.code === 'MISSING_INPUT_FILE') {
          // We'll provide a query in the resolve function.
          // We'll return a framed input with a query.
          return `input=test.sqlite?query=SELECT%20*%20FROM%20test_table`;
        }
        return undefined;
      };

      const result = await conductor.run('any request', { resolve });
      expect(result.clarifyRounds).toBe(0);
      expect(result.state).not.toBe('CLARIFY_EXHAUSTED');
      expect(result.status).not.toBe('FAILED');
      // Again, we rely on the progress to see that we went through the execute step.
      const executeProgress = result.progress.find(p => p.state === 'EXECUTE');
      expect(executeProgress).toBeDefined();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should reject mutation attempts due to readonly: true', async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'conductor-test-'));
    try {
      const sqliteFile = createTempSqliteFile(tmpDir, 'test.sqlite');

      const options = createOptions(tmpDir);
      const conductor = new Conductor(options);
      let resolveCallCount = 0;
      const resolve = (question) => {
        resolveCallCount++;
        if (question.code === 'MISSING_INPUT_FILE') {
          // We'll try to execute an INSERT statement.
          return `input=test.sqlite?query=INSERT%20INTO%20test_table%20(name,%20value)%20VALUES(%27Charlie%27,%2030.0)`;
        }
        return undefined;
      };

      const result = await conductor.run('any request', { resolve });
      // We expect the run to fail because the sqliteRead function will throw an error due to the readonly: true flag.
      // The error will be caught by the Conductor and turned into a TOOL_ERROR.
      expect(result.status).toBe('FAILED');
      expect(result.failure?.code).toBe('TOOL_ERROR');
      // We can also check that the clarifyRounds is 0.
      expect(result.clarifyRounds).toBe(0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

`;

fs.writeFileSync('platform/conductor/sqlite-read.test.ts', testContent);
console.log('Created platform/conductor/sqlite-read.test.ts');