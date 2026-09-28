import type { ContextSource, MemoryRecord, MemoryStore, ValidationResult } from "./types.ts";

/**
 * Select context sources within a token budget.
 *
 * D-016b: `maxContextTokens` was REMOVED from `CoreLimits`. D-009 had wired it
 * to this function's default argument, but the function still had no production
 * caller and the `estimatedTokens` input has no producer, so the field
 * advertised a bound that could not occur — the same defect F-006 was raised
 * for. With the field gone there is nothing truthful to default to, so the
 * budget is a required argument again.
 *
 * `maxTokens` is a budget over the CALLER's own `estimatedTokens` figures. This
 * is arithmetic over an attributed estimate, not a token count: no tokenizer
 * runs here and no estimate is validated.
 *
 * D-020: `maxTokens` is a SOFT cap for required sources and a HARD cap for
 * optional ones. A required source the budget cannot cover is still admitted,
 * because a required source is by definition one the caller must not run
 * without, and dropping it returned a context the caller had been told it could
 * rely on. An optional source that does not fit is still dropped as before.
 *
 * A required source charges its full `estimatedTokens` against `used` exactly
 * as an optional one does, so a later optional source is measured against the
 * TRUE remaining budget rather than an unearned one. Softness is the exemption,
 * not an unaccounted cost.
 *
 * The over-admission is NOT signalled in the return value, which remains a
 * plain `ContextSource[]`. A caller who needs to know the budget was exceeded
 * must compare its own `estimatedTokens` figures against its own budget, the
 * same arithmetic this function performs. Fencing the shape here would have
 * changed the return type for every caller to carry information the caller
 * already holds.
 */
export function selectContext(sources: ContextSource[], maxTokens: number): ContextSource[] {
  const selected: ContextSource[] = [];
  let used = 0;
  const required = sources.filter((source) => source.required).sort((a, b) => b.priority - a.priority);
  const optional = sources.filter((source) => !source.required).sort((a, b) => b.priority - a.priority);
  for (const source of [...required, ...optional]) {
    if (used + source.estimatedTokens > maxTokens && !source.required) continue;
    selected.push(source);
    used += source.estimatedTokens;
  }
  return selected;
}

export class InMemoryStore implements MemoryStore {
  private readonly records = new Map<string, MemoryRecord>();
  private sequence = 0;

  async read(scope: MemoryRecord["scope"], query?: string): Promise<MemoryRecord[]> {
    return [...this.records.values()].filter((record) => record.scope === scope && (!query || record.content.includes(query)));
  }

  async write(record: Omit<MemoryRecord, "id" | "createdAt">): Promise<MemoryRecord> {
    const stored: MemoryRecord = { ...record, id: `memory-${++this.sequence}`, createdAt: new Date().toISOString() };
    this.records.set(stored.id, stored);
    return stored;
  }

  async search(scope: MemoryRecord["scope"], query: string): Promise<MemoryRecord[]> {
    return this.read(scope, query);
  }

  async delete(id: string): Promise<void> {
    this.records.delete(id);
  }
}

export function summarizeValidation(results: ValidationResult[]): string {
  return results.map((result) => `${result.status}: ${result.message}`).join("; ");
}
