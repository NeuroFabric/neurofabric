import fs from 'node:fs';

const original = fs.readFileSync('platform/embassy/async-approval.ts', 'utf-8');

const updated = original.replace(
  '        tasks.delete(key);\n        terminal.set(key, { status: "expired", decidedAt: at });',
  '        db.prepare("UPDATE approval_tasks SET status = \'expired\' WHERE task_token = ?").run(task.token);\n        terminal.set(key, { status: "expired", decidedAt: at });'
).replace(
  '        terminal.set(key, { status: "consumed", decidedAt: at });\n        tasks.delete(key);',
  '        db.prepare("UPDATE approval_tasks SET status = \'consumed\' WHERE task_token = ?").run(task.token);\n        terminal.set(key, { status: "consumed", decidedAt: at });'
);

const scriptContent = `const fs = require('fs');
fs.writeFileSync('platform/embassy/async-approval.ts', Buffer.from('${Buffer.from(updated).toString('base64')}', 'base64').toString('utf-8'));
`;

fs.writeFileSync('write-refactor.js', scriptContent);
console.log('write-refactor.js created.');
