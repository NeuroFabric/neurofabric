import type { RiskLevel, SkillDescriptor } from "./core/types.ts";

/**
 * Type declarations for `skill-registry.mjs`.
 *
 * The registry is JavaScript and is CONSUMED through this file, not type-checked
 * directly: `allowJs` stays off, so the strict sweep covers TypeScript only and
 * every `.mjs` import in a `.ts` file needs a declaration beside it or it
 * arrives as `any`. That silence is what the three TS7016 sites exposed.
 *
 * Everything structural is REUSED from the source of truth rather than restated.
 * `discoverSkills` returns exactly what `parseSkillDocument` returns, and
 * `SkillDescriptor` is the type the kernel itself enforces, so a change to the
 * skill contract flows through to every consumer of this declaration without
 * anyone editing it. Only the two shapes that exist nowhere else — the risk-level
 * union and the options bag — are written out here, and both are narrow: this
 * file can under-claim and be corrected by the compiler, but it cannot widen a
 * contract into something the kernel does not already guarantee.
 */

export declare const DEFAULT_SKILL_FILE: string;

/**
 * Absent frontmatter means read, so the default is READ_ONLY.
 *
 * The parameter and return use the real four-value `RiskLevel`, which includes
 * DESTRUCTIVE. The JSDoc on the `.mjs` declares only three values
 * ("READ_ONLY" | "CONTROLLED" | "WRITE"), which is narrower than reality:
 * `parseSkillDocument` builds a `SkillDescriptor` whose `riskLevel` is a
 * `RiskLevel`, so a DESTRUCTIVE descriptor reaches this function and is
 * returned unchanged. Typing the declaration to the JSDoc made four call sites
 * fail to compile, which is how the discrepancy surfaced. This file follows the
 * implementation, and the JSDoc discrepancy is filed rather than propagated.
 */
export declare function skillRiskLevel(
  skill: { riskLevel?: RiskLevel },
): RiskLevel;

export declare function discoverSkills(
  skillsRoot: string,
  options?: { strict?: boolean; knownTools?: readonly string[] },
): Promise<SkillDescriptor[]>;

export declare function formatSkillCatalog(skills: readonly SkillDescriptor[]): string;
