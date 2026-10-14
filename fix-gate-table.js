import fs from 'node:fs';

let content = fs.readFileSync('platform/embassy/async-approval.ts', 'utf-8');

const newTableBlock = `  // Initialize SQLite table for approval tasks
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

const replaced = content.replace(
  /\/\/\s*Initialize SQLite table for approval tasks[\s\S]*?`\);/,
  newTableBlock
);

if (replaced === content) {
  console.log('Regex did not match; trying alternative...');
  // Try a more specific pattern
  const replaced2 = content.replace(
    /  \/\/ Initialize SQLite table for approval tasks\n  db\.exec\(\`[\s\S]*?`\);/,
    newTableBlock
  );
  fs.writeFileSync('platform/embassy/async-approval.ts', replaced2);
  console.log('Replaced with alternative pattern.');
} else {
  fs.writeFileSync('platform/embassy/async-approval.ts', replaced);
  console.log('Replaced table block.');
}