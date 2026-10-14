import fs from 'node:fs';

const original = fs.readFileSync('platform/embassy/async-approval.ts', 'utf-8');

const updated = original.replace(
  '        tasks.delete(key);\n        terminal.set(key, { status: "expired", decidedAt: at });',
  '        db.prepare("UPDATE approval_tasks SET status = \'expired\' WHERE task_token = ?").run(task.token);\n        terminal.set(key, { status: "expired", decidedAt: at });'
).replace(
  '        terminal.set(key, { status: "consumed", decidedAt: at });\n        tasks.delete(key);',
  '        db.prepare("UPDATE approval_tasks SET status = \'consumed\' WHERE task_token = ?").run(task.token);\n        terminal.set(key, { status: "consumed", decidedAt: at });'
);

const b64 = Buffer.from(updated).toString('base64');
fs.writeFileSync('write-refactor.js', `import fs from 'node:fs';
fs.writeFileSync('platform/embassy/async-approval.ts', Buffer.from('${b64}', 'base64').toString('utf-8'));
`);
console.log('write-refactor.js updated.');
