import fs from 'node:fs';

let content = fs.readFileSync('platform/conductor/conductor.class.test.ts', 'utf-8');
const lines = content.split('\n');
for (let i = 0; i < lines.length; i++) {
  if (lines[i].trim() === 'expect(result.clarifyRounds).toBe(0);') {
    lines[i] = '        console.log(\"clarifyRounds:\", result.clarifyRounds);\n        expect(result.clarifyRounds).toBe(0);';
    break;
  }
}
content = lines.join('\n');
fs.writeFileSync('platform/conductor/conductor.class.test.ts', content);
console.log('Added clarifyRounds log with exact match');