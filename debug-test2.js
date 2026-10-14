import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeFileSync } from 'node:fs';

// Simulate the locateInput method (as in conductor.ts)
function locateInput(text, cwd) {
  const framed = /(?:^|[;\s])input=(.*)$/s.exec(text);
  const named = framed?.[1].trim();
  let raw;
  if (named !== undefined && named !== "") {
    raw = named;
  } else {
    console.log('Testing regex on:', text);
    const regex = /[\\w./\\-]+?\.(csv|tsv|jsonl|jsonlines|ndjson|log)\b/i;
    console.log('Regex:', regex);
    const match = regex.exec(text);
    console.log('Match:', match);
    raw = match?.[0];
    console.log('Raw:', raw);
  }
  if (raw === undefined) return undefined;
  console.log('Before invalid char check:', raw);
  if (/[<>:"|?*\u0000-\u001f]/.test(raw.replace(/^[A-Za-z]:/, ""))) {
    console.log('Failed invalid char check');
    return undefined;
  }
  return path.resolve(cwd, raw);
}

// Test case
(async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'debug-test-'));
  try {
    // Create the file
    writeFileSync(path.join(tmpDir, 'test.csv'), 'col1,col2\\n1,2\\n3,4\\n', 'utf8');
    
    const request = 'please analyze test.csv';
    console.log('Request:', request);
    
    // Simulate the locateInput method
    const raw = locateInput(request, tmpDir);
    console.log('Raw from locateInput:', raw);
    
    if (raw === undefined) {
      console.log('locateInput returned undefined -> will enter clarify step');
    } else {
      console.log('locateInput returned:', raw);
      console.log('Resolved path:', raw);
      const fs = await import('node:fs');
      console.log('File exists:', fs.existsSync(raw));
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
})();