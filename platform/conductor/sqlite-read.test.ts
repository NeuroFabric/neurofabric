import { describe, it } from 'node:test';
import assert from 'node:assert';
import { sqliteRead } from './capabilities.ts';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('sqliteRead', () => {
  it('mutation attempt throws due to readonly', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'sqlite-test-'));
    const sqlitePath = join(tmpDir, 'test.sqlite');
    const db = new Database(sqlitePath);
    db.exec('CREATE TABLE t (id INT);');
    db.close();
    try {
      await assert.rejects(sqliteRead({ path: sqlitePath, query: 'INSERT INTO t (id) VALUES (1)' }));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});