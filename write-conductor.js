import fs from 'node:fs';

// Read the conductor.ts file
let content = fs.readFileSync('platform/conductor/conductor.ts', 'utf-8');

// We need to do three things:
// 1. Import the SQLITE_READ descriptor and define STAGE2_CAPABILITIES after the existing imports.
// 2. Update the constructor to register STAGE2_CAPABILITIES.
// 3. Add a case for "sqlite_read" in the callTool switch statement.

// First, let's add the import for SQLITE_READ and define STAGE2_CAPABILITIES.
// We'll insert after the existing imports from "./capabilities.ts".
const lines = content.split('\n');
let insertIndexAfterCapabilitiesImport = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('import { csvRead, renderPage, STAGE1_CAPABILITIES, type CsvReadResult } from "./capabilities.ts";')) {
    insertIndexAfterCapabilitiesImport = i + 1;
    break;
  }
}

if (insertIndexAfterCapabilitiesImport === -1) {
  // Fallback: insert after the last import line.
  let lastImportLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith('import ')) {
      lastImportLine = i;
    }
  }
  insertIndexAfterCapabilitiesImport = lastImportLine + 1;
}

// We'll insert the import for SQLITE_READ and the definition of STAGE2_CAPABILITIES at insertIndexAfterCapabilitiesImport.
const importSqliteRead = 'import { SQLITE_READ } from "./capabilities.ts";';
const stage2Capabilities = 'export const STAGE2_CAPABILITIES: ToolDescriptor[] = [SQLITE_READ];';

lines.splice(insertIndexAfterCapabilitiesImport, 0, importSqliteRead, stage2Capabilities);
content = lines.join('\n');

// Now, update the constructor to register STAGE2_CAPABILITIES.
// We need to find the line where the kernel.registerTools is called in the constructor.
// Look for: this.kernel.registerTools([...STAGE1_CAPABILITIES, RENDER_BOTTLENECK_REPORT]);
// We'll change it to: this.kernel.registerTools([...STAGE1_CAPABILITIES, ...STAGE2_CAPABILITIES, RENDER_BOTTLENECK_REPORT]);

const lines2 = content.split('\n');
let registerToolsLineIndex = -1;
for (let i = 0; i < lines2.length; i++) {
  if (lines2[i].includes('this.kernel.registerTools([...STAGE1_CAPABILITIES, RENDER_BOTTLENECK_REPORT]);')) {
    registerToolsLineIndex = i;
    break;
  }
}

if (registerToolsLineIndex !== -1) {
  // Replace the line.
  lines2[registerToolsLineIndex] = '    this.kernel.registerTools([...STAGE1_CAPABILITIES, ...STAGE2_CAPABILITIES, RENDER_BOTTLENECK_REPORT]);';
  content = lines2.join('\n');
} else {
  // If we didn't find the exact line, try to find a similar one.
  // We'll look for the line that contains this.kernel.registerTools and STAGE1_CAPABILITIES and RENDER_BOTTLENECK_REPORT.
  for (let i = 0; i < lines2.length; i++) {
    if (lines2[i].includes('this.kernel.registerTools') && lines2[i].includes('STAGE1_CAPABILITIES') && lines2[i].includes('RENDER_BOTTLENECK_REPORT')) {
      // Replace the line with the new one.
      lines2[i] = '    this.kernel.registerTools([...STAGE1_CAPABILITIES, ...STAGE2_CAPABILITIES, RENDER_BOTTLENECK_REPORT]);';
      content = lines2.join('\n');
      break;
    }
  }
}

// Now, add the case for "sqlite_read" in the callTool switch statement.
// We need to find the switch statement in the callTool method.
// Look for: switch (tool) {
// We'll add a case for "sqlite_read" before the default case.

const lines3 = content.split('\n');
let switchStartIndex = -1;
for (let i = 0; i < lines3.length; i++) {
  if (lines3[i].includes('switch (tool) {')) {
    switchStartIndex = i;
    break;
  }
}

if (switchStartIndex !== -1) {
  // Find the end of the switch statement (the closing brace of the switch).
  // We'll look for the line that has a closing brace that is at the same indentation level as the switch.
  // But for simplicity, we'll find the line that has 'default:' and insert before it, or if there's no default, insert before the closing brace.
  let defaultIndex = -1;
  let closingBraceIndex = -1;
  for (let i = switchStartIndex; i < lines3.length; i++) {
    if (lines3[i].trim().startsWith('default:')) {
      defaultIndex = i;
      break;
    }
    if (lines3[i].trim() === '}') {
      closingBraceIndex = i;
      break;
    }
  }
  let insertAt = defaultIndex !== -1 ? defaultIndex : closingBraceIndex;
  if (insertAt !== -1) {
    // Insert the case for sqlite_read before the default or closing brace.
    const sqliteReadCase = `        case "sqlite_read":\n          value = await sqliteRead({ path: String(input.path), query: input.query }, { boundary: this.boundary });\n          break;`;
    lines3.splice(insertAt, 0, sqliteReadCase);
    content = lines3.join('\n');
  } else {
    // If we didn't find default or closing brace, we'll append the case before the last line of the method? 
    // This is getting too complex. We'll assume the structure is as expected.
    // For now, we'll just append the case at the end of the switch block (before the closing brace) by adding it before the last line we saw.
    // We'll do a simple approach: insert before the closing brace of the switch statement by searching for the closing brace from the end.
    for (let i = lines3.length - 1; i >= 0; i--) {
      if (lines3[i].trim() === '}') {
        // Check if this closing brace is for the switch statement by looking for the switch start above it.
        // We'll assume it is the switch's closing brace if we don't see another switch or other block in between.
        // We'll insert before this brace.
        lines3.splice(i, 0, `        case "sqlite_read":\n          value = await sqliteRead({ path: String(input.path), query: input.query }, { boundary: this.boundary });\n          break;`);
        content = lines3.join('\n');
        break;
      }
    }
  }
}

// Write the file.
fs.writeFileSync('platform/conductor/conductor.ts', content);
console.log('Updated platform/conductor/conductor.ts with STAGE2_CAPABILITIES and sqlite_read case in callTool.');