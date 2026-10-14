import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Simulate the locateInput method
function locateInput(text, cwd) {
  // An explicitly framed input is taken verbatim to its end, so a name that
  // contains spaces survives intact. Guessing backwards out of the prose
  // around it is what truncated `rm -rf.csv` to `-rf.csv` and hid a
  // destructive payload from the kernel entirely.
  const framed = /(?:^|[;\s])input=(.*)$/s.exec(text);
  const named = framed?.[1].trim();
  let raw;
  if (named !== undefined && named !== "") {
    raw = named;
  } else {
    const regex = /[\\w./\\-]+?\.(csv|tsv|jsonl|jsonlines|ndjson|log)\b/i;
    console.log('Regex:', regex);
    console.log('Text:', text);
    const match = regex.exec(text);
    console.log('Match:', match);
    raw = match?.[0];
  }
  if (raw === undefined) return undefined;
  // A NAME THAT CANNOT EXIST ON DISK IS NOT AN INPUT. This is the filesystem
  // speaking, not a security control: `<`, `>` and a NUL cannot appear in a
  // filename on the supported platforms, so there is nothing there for the
  // kernel to rule on. Anything the kernel COULD rule on is passed on.
  if (/[<>:"|?*\u0000-\u0000-\u001f]/.test(raw.replace(/^[A-Za-z]:/, ""))) return undefined;
  return path.resolve(cwd, raw);
}

// Test case
(async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'debug-test-'));
  try {
    // Create the file
    const fs = await import('node:fs');
    fs.writeFileSync(path.join(tmpDir, 'test.csv'), 'col1,col2\\n1,2\\n3,4\\n', 'utf8');
    
    const text = 'please analyze test.csv';
    const raw = locateInput(text, tmpDir);
    console.log('Input text:', text);
    console.log('Raw from locateInput:', raw);
    if (raw !== undefined) {
      console.log('Resolved path:', raw);
      console.log('File exists:', fs.existsSync(raw));
    } else {
      console.log('locateInput returned undefined');
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
})();