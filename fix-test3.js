import fs from 'node:fs';

let content = fs.readFileSync('platform/conductor/conductor.class.test.ts', 'utf-8');
// Replace the incorrect variable name inside the loop
const updated = content.replace(
  /const ext = extensions\[i\];/g,
  'const ext = supportedExtensions[i];'
);
fs.writeFileSync('platform/conductor/conductor.class.test.ts', updated);
console.log('Fixed variable name inside loop.');