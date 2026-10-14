import fs from 'node:fs';

let content = fs.readFileSync('platform/conductor/conductor.ts', 'utf-8');

// Replace the regex in locateInput to make the first quantifier lazy
const updated = content.replace(
  /\/[\\w./\\\\-]+\\.(csv|tsv|jsonl|jsonlines|ndjson|log)\\b/i,
  '/[\\w./\\\\-]+?\\.(csv|tsv|jsonl|jsonlines|ndjson|log)\\b/i'
);

const b64 = Buffer.from(updated).toString('base64');
fs.writeFileSync('platform/conductor/conductor.ts', Buffer.from(b64, 'base64').toString('utf-8'));
console.log('Updated platform/conductor/conductor.ts with lazy quantifier in locateInput regex.');