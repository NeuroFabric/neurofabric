import fs from 'node:fs';

let content = fs.readFileSync('platform/conductor/conductor.ts', 'utf-8');

// The lines we want to replace are:
//     const raw = named !== undefined && named !== ""
//       ? named
//       : /[\\w./\\-]+\\.csv\\b/i.exec(text)?.[0];
// We'll replace the three lines with the new version.
const lines = content.split('\n');
for (let i = 0; i < lines.length; i++) {
  if (lines[i].trim().startsWith('const raw = named !== undefined && named !== ""')) {
    // Replace this line and the next two lines.
    lines[i] = '    const raw = named !== undefined && named !== ""';
    lines[i+1] = '      ? named';
    lines[i+2] = '      : /[\\w./\\-]+\\.(csv|tsv|jsonl|jsonlines|ndjson|log)\\b/i.exec(text)?.[0];';
    break;
  }
}
content = lines.join('\n');

const b64 = Buffer.from(content).toString('base64');
fs.writeFileSync('platform/conductor/conductor.ts', Buffer.from(b64, 'base64').toString('utf-8'));
console.log('Updated platform/conductor/conductor.ts with extended file extensions in locateInput.');