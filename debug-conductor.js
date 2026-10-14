import fs from 'node:fs';

let content = fs.readFileSync('platform/conductor/conductor.ts', 'utf-8');
// We'll add a console.log before the return statement in locateInput
// We'll look for the line: "if (raw === undefined) return undefined;"
 // and insert a console.log before it.
// Actually, we want to log the raw value before the invalid char check and after.
// Let's insert after we set raw and before the invalid char check.
// We'll look for the line that sets raw and then add a console.log after it.
// The line is:
//      : /[\\w./\\-]+?\\.(csv|tsv|jsonl|jsonlines|ndjson|log)\\b/i.exec(text)?.[0];
// We'll change it to:
//      : /[\\w./\\-]+?\\.(csv|tsv|jsonl|jsonlines|ndjson|log)\\b/i.exec(text)?.[0];
//      console.log('locateInput raw:', raw);
// But we need to be careful with the line boundaries.
// Let's split by lines and modify the line that sets raw.
const lines = content.split('\n');
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('/[\\w./\\-]+?\\.(csv|tsv|jsonl|jsonlines|ndjson|log)\\b/i.exec(text)?.[0];')) {
    // We'll replace this line with two lines: the original line and a console.log line.
    const originalLine = lines[i];
    lines[i] = originalLine + '\n    console.log(\"locateInput raw:\", raw);';
    break;
  }
}
content = lines.join('\n');
fs.writeFileSync('platform/conductor/conductor.ts', content);
console.log('Added debug log to locateInput method in conductor.ts');