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
    raw = /[\\w./\\-]+?\.(csv|tsv|jsonl|jsonlines|ndjson|log)\b/i.exec(text)?.[0];
  }
  if (raw === undefined) return undefined;
  if (/[<>:"|?*\u0000-\u001f]/.test(raw.replace(/^[A-Za-z]:/, ""))) return undefined;
  return path.resolve(cwd, raw);
}

// Simulate the Conductor's run method partially: we only care about the locateInput step
async function simulateTest() {
  const ext = '.csv';
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'debug-test-'));
  try {
    // Create the file
    writeFileSync(path.join(tmpDir, 'test' + ext), 'col1,col2\\n1,2\\n3,4\\n', 'utf8');
    
    const request = 'please analyze test' + ext;
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
}

simulateTest();