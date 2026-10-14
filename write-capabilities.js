import fs from 'node:fs';

let content = fs.readFileSync('platform/conductor/capabilities.ts', 'utf-8');

// Check if we already have the import for better-sqlite3
if (!content.includes('better-sqlite3')) {
  // Add the import at the top after the last import line.
  const lines = content.split('\n');
  let lastImportLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith('import ')) {
      lastImportLine = i;
    }
  }
  if (lastImportLine !== -1) {
    lines.splice(lastImportLine + 1, 0, 'import Database from "better-sqlite3";');
    content = lines.join('\n');
  } else {
    content = 'import Database from "better-sqlite3";\n' + content;
  }
}

// Now, we want to insert the SQLITE_READ descriptor and the sqliteRead function after the STAGE1_CAPABILITIES export.
const lines = content.split('\n');
let insertIndex = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('export const STAGE1_CAPABILITIES:')) {
    // Find the end of the array.
    for (let j = i; j < lines.length; j++) {
      if (lines[j].trim() === '];') {
        insertIndex = j + 1;
        break;
      }
    }
    break;
  }
}

if (insertIndex === -1) {
  insertIndex = lines.length;
}

// Build the descriptor as a regular string (no template literals in the output).
const sqliteReadDescriptor = `
export const SQLITE_READ: ToolDescriptor = {
  name: "sqlite_read",
  version: "stage2",
  description: "Read a SQLite database inside the workspace and return schema or query results.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      query?: { type: "string" }
    },
    required: ["path"]
  },
  outputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      tables: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            columns: { type: "array", items: { type: "string" } }
          }
        }
      },
      rows: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: { type: "string" }
        }
      }
    }
  },
  capabilities: ["sqlite.read"],
  permissions: ["tool:sqlite_read"],
  riskLevel: "READ_ONLY",
  idempotency: "IDEMPOTENT",
  sideEffect: "PURE",
  timeoutMs: 10_000,
  retryPolicy: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 }
};
`;

// Build the function as a string. We'll use a template literal for the function string in this script, but we will escape the inner template literals.
const sqliteReadFunction = `
/**
 * READ A SQLITE DATABASE AS A GOVERNED TOOL.
 *
 * In schema mode (no query), returns the list of tables and their columns.
 * In query mode (with query), executes a read-only SELECT query and returns the rows.
 *
 * The connection is opened in readonly: true mode to enforce read-only semantics at the driver level.
 */
export async function sqliteRead(
  input: { path: string; query?: string },
  boundary?: { boundary?: { check(p: string): { allowed: boolean } } }
): Promise<{
  path: string;
  tables: { name: string; columns: string[] }[];
  rows: Record<string, string>[];
}> {
  const target = String(input.path ?? "");
  if (boundary?.boundary) {
    const verdict = boundary.boundary.check(target);
    if (!verdict.allowed) throw new Error(\`sqlite_read: the path is outside the workspace boundary (\${verdict.allowed ? \"\" : \"refused\"})\`);
  }

  // Check if the file exists (better-sqlite3 will throw if not, but we can give a clearer message).
  const { existsSync } = await import(\"node:fs\");
  if (!existsSync(target)) {
    throw new Error(\`sqlite_read: file does not exist at \${target}\`);
  }

  // Open the database in readonly mode.
  const db = new Database(target, { readonly: true });

  try {
    if (input.query === undefined) {
      // SCHEMA MODE: return tables and columns.
      const tables: { name: string; columns: string[] }[] = [];

      // Get the list of tables.
      const tableRows = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all();
      for (const tableRow of tableRows as { name: string }[]) {
        const tableName = tableRow.name;
        // Get the columns for this table.
        const pragma = db.prepare(\`PRAGMA table_info(\${tableName})\`).all();
        const columns = (pragma as { name: string }[]).map(col => col.name);
        tables.push({ name: tableName, columns });
      }

      return { path: target, tables, rows: [] };
    } else {
      // QUERY MODE: enforce read-only by checking that the query is a SELECT.
      const queryTrim = input.query.trim();
      if (!queryTrim.toUpperCase().startsWith(\"SELECT\")) {
        throw new Error(\`sqlite_read: only SELECT queries are allowed for read-only access\`);
      }
      // Additionally, we can check for multiple statements by looking for semicolons in the middle.
      // But note: the query might have a semicolon at the end. We'll remove trailing semicolon and check for any remaining.
      const queryWithoutTrailingSemicolon = queryTrim.replace(/;\\s*$/, \"\");
      if (queryWithoutTrailingSemicolon.includes(\";\")) {
        throw new Error(\`sqlite_read: multiple statements are not allowed\`);
      }

      // Execute the query.
      const rows = db.prepare(queryTrim).all() as Record<string, string>[];

      return { path: target, tables: [], rows };
    }
  } finally {
    db.close();
  }
}
`;

// Now, insert the descriptor and the function at insertIndex.
lines.splice(insertIndex, 0, sqliteReadDescriptor, sqliteReadFunction);
content = lines.join('\n');

// Write the file.
fs.writeFileSync('platform/conductor/capabilities.ts', content);
console.log('Updated platform/conductor/capabilities.ts with SQLITE_READ descriptor and sqliteRead function.');