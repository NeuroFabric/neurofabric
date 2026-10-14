import fs from 'node:fs';

let content = fs.readFileSync('platform/embassy/async-approval.ts', 'utf-8');

// Replace pending expiry block
content = content.replace(
  `        write({
          outcome: "expired",
          taskToken: task.token,
          subject: task.subject,
          decidedAt: new Date(at).toISOString(),
          reason: task.reason,
        });
        tasks.delete(key);
        terminal.set(key, { status: "expired", decidedAt: at });`,
  `        write({
          outcome: "expired",
          taskToken: task.token,
          subject: task.subject,
          decidedAt: new Date(at).toISOString(),
          reason: task.reason,
        });
        db.prepare("UPDATE approval_tasks SET status = 'expired' WHERE task_token = ?").run(task.token);
        tasks.delete(key);
        terminal.set(key, { status: "expired", decidedAt: at });`
);

// Replace approved expiry block
content = content.replace(
  `        terminal.set(key, { status: "consumed", decidedAt: at });
        tasks.delete(key);`,
  `        terminal.set(key, { status: "consumed", decidedAt: at });
        db.prepare("UPDATE approval_tasks SET status = 'consumed' WHERE task_token = ?").run(task.token);
        tasks.delete(key);`
);

// Also need to update the CREATE TABLE statement to match the migration schema?
// The gate's internal CREATE TABLE should match the migration we are about to write.
// Let's update the CREATE TABLE in the gate to include the new columns.
// We'll replace the db.exec block for table creation.

const createTable = `    // Initialize SQLite table for approval tasks
  db.exec(\`
    CREATE TABLE IF NOT EXISTS approval_tasks (
      task_token TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'refused', 'expired', 'consumed')),
      subject_json TEXT NOT NULL,
      result_json TEXT,
      decided_at INTEGER,
      approved_by TEXT,
      reason TEXT,
      result_expires_at INTEGER,
      collected_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_approval_tasks_status ON approval_tasks(status);
  \`);`;

content = content.replace(
  /    \/\/ Initialize SQLite table for approval tasks\n  db\.exec\(\`\s*CREATE TABLE IF NOT EXISTS approval_tasks \(\s*task_token TEXT PRIMARY KEY,\s*status TEXT NOT NULL CHECK\(status IN \('pending', 'approved', 'refused', 'expired', 'consumed'\)\),\s*subject_json TEXT NOT NULL,\s*result_json TEXT,\s*collected_at INTEGER,\s*created_at INTEGER NOT NULL DEFAULT \(strftime\('%s','now'\)\)\s*;\s*CREATE INDEX IF NOT EXISTS idx_approval_tasks_status ON approval_tasks\(status\);\s*\)\`\);/,
  createTable
);

const b64 = Buffer.from(content).toString('base64');
fs.writeFileSync('platform/embassy/async-approval.ts', Buffer.from(b64, 'base64').toString('utf-8'));
console.log('Updated platform/embassy/async-approval.ts with proper sweep and table schema.');