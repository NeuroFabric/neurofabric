import fs from 'node:fs';

let content = fs.readFileSync('platform/conductor/conductor.class.test.ts', 'utf-8');
// Find the line with the expect for clarifyRounds in the locateInput test and add a console.log before it.
const updated = content.replace(
  /expect\(result.clarifyRounds\)\.toBe\(0\);/g,
  'console.log(\"clarifyRounds:\", result.clarifyRounds);\nexpect(result.clarifyRounds).toBe(0);'
);
fs.writeFileSync('platform/conductor/conductor.class.test.ts', content);
console.log('Added clarifyRounds log');