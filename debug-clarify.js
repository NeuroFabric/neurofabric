import fs from 'node:fs';

let content = fs.readFileSync('platform/conductor/conductor.ts', 'utf-8');
// We'll add a console.log after the line: let input = this.locateInput(request);
// We'll look for that line and insert a console.log after it.
const lines = content.split('\n');
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('let input = this.locateInput(request);')) {
    // Insert a console.log line after this line.
    lines.splice(i + 1, 0, '    console.log(\"clarify step input:\", input);');
    break;
  }
}
content = lines.join('\n');
fs.writeFileSync('platform/conductor/conductor.ts', content);
console.log('Added clarify step input log');