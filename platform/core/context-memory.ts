import type { ContextSource, MemoryRecord, MemoryStore, ValidationResult } from "./types.ts";
import { DEFAULT_LIMITS } from "./limits.ts";

/**
 * Select context sources within a token budget.
 *
 * D-009: the budget defaults to `DEFAULT_LIMITS.maxContextTokens` rather than
 * being supplied by every caller. It was previously a required argument with no
 * production caller at all, which left `maxContextTokens` declared on
 * `CoreLimits` and read by nothing.
 */
export function selectContext(sources: ContextSource[], maxTokens: number = DEFAULT_LIMITS.maxContextTokens): ContextSource[] {
  const selected: ContextSource[] = [];
  let used = 0;
  const required = sources.filter((source) => source.required).sort((a, b) => b.priority - a.priority);
  const optional = sources.filter((source) => !source.required).sort((a, b) => b.priority - a.priority);
  for (const source of [...required, ...optional]) {
    if (used + source.estimatedTokens > maxTokens && !source.required) continue;
    if (used + source.estimatedTokens > maxTokens) continue;
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
