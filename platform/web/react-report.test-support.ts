import { parseCsv } from "../conductor/capabilities.ts";
import { analyseBottlenecks, type BottleneckAnalysis } from "../conductor/bottlenecks.ts";

/**
 * A REAL ANALYSIS, built by the real engine, for the dashboard tests.
 *
 * These are the Owner's own numbers, not a mock: the same shape of the file the
 * 3x-IQR fence was chosen for, with one column carrying an extreme value and
 * another carrying type mismatches. A hand-written object literal with the
 * right field names would type-check and prove nothing about whether the
 * dashboard can actually read what the engine produces -- and the whole risk
 * here is that those two things have drifted.
 *
 * The file is generated rather than committed because it is 40 rows of noise
 * that no one can read in a diff, and because generating it makes the one
 * planted value obvious: `col_15`'s 9,999,999.99 and `col_16`'s "N/A" are the
 * only two things in it that are not ordinary noise.
 */

/** Deterministic pseudo-noise, so a failure is reproducible and a diff is small. */
function noise(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

const ROWS = 40;

function buildCsv(): string {
  const header = ["col_1", "col_15", "col_16"].join(",");
  const lines: string[] = [header];
  for (let i = 0; i < ROWS; i += 1) {
    // col_15 is ordinary noise except at row 20, where it is the extreme
    // outlier the fence exists to catch. col_16 carries a "N/A" in two rows,
    // which is a TYPE MISMATCH rather than an empty cell, and the health
    // section must not conflate the two.
    const col15 = i === 20 ? "9999999.99" : (noise(i + 1) * 2 - 1).toFixed(6);
    const col16 = i === 7 || i === 19 ? "N/A" : (noise(i + 99) * 50).toFixed(4);
    lines.push(`${(noise(i + 5) * 2 - 1).toFixed(6)},${col15},${col16}`);
  }
  return `${lines.join("\n")}\n`;
}

/** A genuine `BottleneckAnalysis`, with anomalies the assertions can rely on. */
export async function buildAnalysis(): Promise<BottleneckAnalysis> {
  const parsed = parseCsv(buildCsv());
  // The generic path: resolve-then-analyse, the same order the pipeline uses,
  // so the schema resolution is exercised rather than bypassed.
  const { resolveSchemaMemory } = await import("../conductor/schema-memory.ts");
  const schema = await resolveSchemaMemory({
    cwd: "configs/..",
    headers: parsed.headers,
    rows: parsed.rows.map((cells) => Object.fromEntries(parsed.headers.map((h, i) => [h, cells[i] ?? ""]))),
  });
  return analyseBottlenecks({
    path: "operations.csv",
    headers: parsed.headers,
    rowCount: parsed.rows.length,
    columns: [],
    sample: [],
    rows: parsed.rows.map((cells) => Object.fromEntries(parsed.headers.map((h, i) => [h, cells[i] ?? ""]))),
    problems: parsed.problems,
  }, schema);
}

/** The generated CSV, so a failing test can be reproduced by eye. */
export const FIXTURE_CSV = buildCsv();
