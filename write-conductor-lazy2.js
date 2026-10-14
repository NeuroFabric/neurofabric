import fs from 'node:fs';

let content = fs.readFileSync('platform/conductor/conductor.ts', 'utf-8');
const lines = content.split('\n');
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('/[\\w./\\-]+\\.(csv|tsv|jsonl|jsonlines|ndjson|log)\\b/i.exec(text)?.[0];')) {
    lines[i] = lines[i].replace('/[\\w./\\-]+\\.(csv|tsv|jsonl|jsonlines|ndjson|log)\\b/i', '/[\\w./\\-]+?\\.(csv|tsv|jsonl|jsonlines|ndjson|log)\\b/i');
    break;
  }
}
content = lines.join('\n');
fs.writeFileSync('platform/conductor/conductor.ts', content);
console.log('Updated platform/conductor/conductor.ts with lazy quantifier in locateInput regex (line-based).');