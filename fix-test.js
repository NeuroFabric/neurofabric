import fs from 'node:fs';

let content = fs.readFileSync('platform/conductor/conductor.class.test.ts', 'utf-8');
// Replace the incorrect variable name in the for loop
const updated = content.replace(
  /for \(let i = 0; i < extensions\.length; i\) {/g,
  'for (let i = 0; i < supportedExtensions.length; i++) {'
);
fs.writeFileSync('platform/conductor/conductor.class.test.ts', updated);
console.log('Fixed variable name in test file.');