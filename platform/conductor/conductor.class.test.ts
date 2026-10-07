import * as path from 'path';
import { describe, it, expect, vi } from 'vitest';
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

// Helper to create a temporary CSV file
function createTempCsvFile(dir, filename) {
  const filepath = path.join(dir, filename);
  writeFileSync(filepath, 'col1,col2\n1,2\n3,4\n', 'utf8');
  return filepath;
}

// Helper to create a temporary JSONL file
function createTempJsonlFile(dir, filename) {
  const filepath = path.join(dir, filename);
  writeFileSync(filepath, '{"a":1}\n{"a":2}\n', 'utf8');
  return filepath;
}

describe('Conductor class', () => {
  it('clarify step with framed input', async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'conductor-test-'));
    try {
      const options = createOptions(tmpDir);
      const conductor = new Conductor(options);
      let resolveCallCount = 0;
      let resolveAnswer = '';
      const resolve = (question) => {
        resolveCallCount++;
        if (question.code === 'MISSING_INPUT_FILE') {
          resolveAnswer = 'input=test.csv';
          return resolveAnswer;
        }
        return undefined;
      };

      const result = await conductor.run('any request', { resolve });
      expect(result.clarifyRounds).toBe(1);
      expect(result.state).not.toBe('CLARIFY_EXHAUSTED');
      expect(result.questions.length).toBe(1);
      expect(result.questions[0].code).toBe('MISSING_INPUT_FILE');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('clarify step with unbracketed filename (CSV)', async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'conductor-test-'));
    try {
      const options = createOptions(tmpDir);
      const conductor = new Conductor(options);
      let resolveCallCount = 0;
      let resolveAnswer = '';
      const resolve = (question) => {
        resolveCallCount++;
        if (question.code === 'MISSING_INPUT_FILE') {
          resolveAnswer = 'data.csv';
          return resolveAnswer;
        }
        return undefined;
      };

      createTempCsvFile(tmpDir, 'data.csv');

      const result = await conductor.run('any request', { resolve });
      expect(result.clarifyRounds).toBe(1);
      expect(result.state).not.toBe('CLARIFY_EXHAUSTED');
      expect(result.questions.length).toBe(1);
      expect(result.questions[0].code).toBe('MISSING_INPUT_FILE');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('clarify step with unbracketed filename (JSONL)', async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'conductor-test-'));
    try {
      const options = createOptions(tmpDir);
      const conductor = new Conductor(options);
      let resolveCallCount = 0;
      let resolveAnswer = '';
      const resolve = (question) => {
        resolveCallCount++;
        if (question.code === 'MISSING_INPUT_FILE') {
          resolveAnswer = 'data.jsonl';
          return resolveAnswer;
        }
        return undefined;
      };

      createTempJsonlFile(tmpDir, 'data.jsonl');
      const result = await conductor.run('please analyze data.jsonl', { resolve });
      
      expect(result.clarifyRounds).toBe(0);
      expect(result.state).not.toBe('CLARIFY_EXHAUSTED');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('clarify step repeats up to 3 times', async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'conductor-test-'));
    try {
      const options = createOptions(tmpDir);
      const conductor = new Conductor(options);
      let resolveCallCount = 0;
      const resolve = (question) => {
        resolveCallCount++;
        return undefined;
      };

      const result = await conductor.run('any request', { resolve });
      expect(result.status).toBe('CLARIFY_EXHAUSTED');
      expect(result.state).toBe('CLARIFY_EXHAUSTED');
      expect(result.clarifyRounds).toBe(3);
      expect(result.questions.length).toBe(3);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('execute step in dashboard mode', async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'conductor-test-'));
    try {
      const options = createOptions(tmpDir);
      const conductor = new Conductor(options);
      let resolveCallCount = 0;
      const resolve = (question) => {
        resolveCallCount++;
        if (question.code === 'MISSING_INPUT_FILE') {
          return 'input=test.csv';
        }
        return undefined;
      };

      createTempCsvFile(tmpDir, 'test.csv');

      const result = await conductor.run('any request', { resolve, output: 'dashboard.html' });
      expect(result.clarifyRounds).toBe(1);
      expect(result.state).not.toBe('CLARIFY_EXHAUSTED');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('execute step in bottleneck mode', async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'conductor-test-'));
    try {
      const options = createOptions(tmpDir);
      const conductor = new Conductor(options);
      let resolveCallCount = 0;
      const resolve = (question) => {
        resolveCallCount++;
        if (question.code === 'MISSING_INPUT_FILE') {
          return 'input=test.csv';
        }
        return undefined;
      };

      createTempCsvFile(tmpDir, 'test.csv');

      const result = await conductor.run('any request', { resolve, mode: 'bottleneck' });
      expect(result.clarifyRounds).toBe(1);
      expect(result.state).not.toBe('CLARIFY_EXHAUSTED');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('locateInput method guesses unbracketed filename with supported extensions', async () => {
    const supportedExtensions = ['.csv', '.tsv', '.jsonl', '.jsonlines', '.ndjson', '.log'];
    for (let i = 0; i < supportedExtensions.length; i++) {
      const ext = supportedExtensions[i];
      const tmpDir = mkdtempSync(path.join(tmpdir(), 'conductor-test-'));
      try {
        const options = createOptions(tmpDir);
        const conductor = new Conductor(options);
        
        createTempCsvFile(tmpDir, 'test' + ext);

        // We provide a resolve function to auto-answer AMBIGUOUS_CSV if csvRead complains about the extension
        const resolve = (q) => q.code === 'AMBIGUOUS_CSV' ? 'continue' : undefined;
        const result = await conductor.run('please analyze test' + ext, { resolve });
        
        // The critical assertion: locateInput successfully extracted the filename, 
        // so the Conductor NEVER asked MISSING_INPUT_FILE.
        const askedMissing = result.questions.some(q => q.code === 'MISSING_INPUT_FILE');
        expect(askedMissing).toBe(false);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  });
});