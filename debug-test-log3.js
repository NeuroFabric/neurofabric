import fs from 'node:fs';

let content = fs.readFileSync('platform/conductor/conductor.class.test.ts', 'utf-8');
// Find the test and add a console.log at the very beginning of the function.
const updated = content.replace(
  /it\('locateInput method guesses unbracketed filename with supported extensions', async \(\) => {/g,
  "it('locateInput method guesses unbracketed filename with supported extensions', async () => {\n    console.log(\"Test started\");"
);
fs.writeFileSync('platform/conductor/conductor.class.test.ts', content);
console.log('Added test started log');