import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

let content = fs.readFileSync('scripts/live-proof-of-life.ts', 'utf-8');

// We need to insert after hub.open(TENANT, (frame) => sseFrames.push(frame));
// and before const gate = createAsyncApprovalGate({

const insertText = `
  // Create a temporary SQLite database for the gate's internal persistence
  const gateDbDir = mkdtempSync(join(tmpdir(), 'gate-db-'));
  const gateDbPath = join(gateDbDir, 'gate.sqlite');
  const gateDb = new DatabaseSync(gateDbPath);
  gateDb.exec("PRAGMA journal_mode = WAL");
  gateDb.exec("PRAGMA foreign_keys = ON");
  const gateDbAdapter = {
    exec: (sql: string) => gateDb.exec(sql),
    prepare: (sql: string) => gateDb.prepare(sql),
    transaction: (fn: () => void) => gateDb.transaction(fn),
  };

`;

const newContent = content.replace(
  /(const sseFrames: string\[\] = \[\];\n  hub\.open\(TENANT, \(frame\) => sseFrames\.push\(frame\)\);)\n\n  const gate = createAsyncApprovalGate\(/,
  `$1\n${insertText}  const gate = createAsyncApprovalGate(`
);

fs.writeFileSync('scripts/live-proof-of-life.ts', newContent);
console.log('Patched live-proof-of-life.ts with gate DB adapter.');