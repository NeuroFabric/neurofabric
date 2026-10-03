import {
  descriptorOf,
  unavailable,
  type DiagnosticAgent,
  type DiagnosticInput,
  type DiagnosticResult,
} from "./diagnostic-agent.ts";

/**
 * THE THREE SPECIALISTS, AS STUBS.
 *
 * === WHY STUBS, AND WHY THESE THREE ===
 *
 * The platform's claim is that it pinpoints systemic INDUSTRY problems, and the
 * three below are the first three disciplines that claim has to be true in before
 * it is true at all: how software gets built and shipped, whether money movement
 * obeys the rules, and whether the system performs. Each is registered, described,
 * selectable by scope, and refuses to answer.
 *
 * They are in ONE file rather than three because a stub is a dozen lines and three
 * files of a dozen lines each is ceremony that makes the roster harder to read,
 * not easier. The moment one of them grows an implementation it becomes its own
 * module, and the registry does not change, because it only ever knew the
 * interface. That property is the point of the interface, and it is worth more
 * than the tidiness of three separate paths.
 *
 * === WHAT A STUB PROMISES AND REFUSES ===
 *
 * Each declares the vocabulary it will own, so `handles` works and a caller can
 * see the platform's coverage WITHOUT the implementation existing. That is a real
 * capability: an operator asking "can this platform audit my dependency tree"
 * gets an accurate yes at the level of scope, and a refusal at the level of
 * result, and never a fabricated finding in between.
 *
 * The vocabulary is deliberately INCLUSIVE of the phrasing a real user types. A
 * stub whose `handles` only matched its own name would never be selected, and the
 * whole point of registering it is to be selected and then decline honestly.
 */

type Template = DiagnosticAgent & {
  /** Declared at build time so the vocabulary is data, not a chain of regexes. */
  readonly vocabulary: readonly string[];
};

/** Build one stub. The three differ only in their declared scope, which is the point. */
function stub(options: {
  id: string;
  title: string;
  domain: DiagnosticAgent["domain"];
  capabilities: readonly string[];
  vocabulary: readonly string[];
}): Template {
  const agent: Template = {
    id: options.id,
    title: options.title,
    domain: options.domain,
    maturity: "stub",
    version: "0.1.0",
    capabilities: options.capabilities,
    vocabulary: options.vocabulary,

    handles(scope: string): boolean {
      const text = String(scope ?? "").toLowerCase();
      if (text.trim() === "") return false;
      return options.vocabulary.some((term) => text.includes(term));
    },

    async diagnose(input: DiagnosticInput): Promise<DiagnosticResult> {
      // The scope that was asked for is echoed, so an operator can see the stub
      // received the question rather than having ignored it -- and no finding is
      // invented to fill the space.
      const asked = input.prompt.trim() === "" ? options.title : input.prompt.trim();
      const refusal = unavailable(agent);
      return { ...refusal, summary: `${refusal.summary} Asked about: "${asked}".` };
    },

    describe: () => descriptorOf(agent),
  };
  return agent;
}

/**
 * PIPELINE AND SUPPLY CHAIN: how the artefact came to exist, and what came with it.
 */
export const devsecOpsAgent: Template = stub({
  id: "devsecops",
  title: "DevSecOps pipeline and supply chain",
  domain: "supply-chain",
  capabilities: [
    "dependency and transitive-dependency exposure",
    "build provenance and pipeline integrity",
    "vulnerability disclosure correlated to the versions actually deployed",
  ],
  vocabulary: [
    "supply chain", "supply-chain", "dependency", "dependencies", "package",
    "pipeline", "build", "vulnerability", "vulnerabilities", "cve", "sbom",
    "provenance", "artifact", "container image", "npm", "maven", "patch",
  ],
});

/**
 * FINANCIAL COMPLIANCE: whether money movement obeys the rules it is supposed to.
 */
export const complianceAgent: Template = stub({
  id: "compliance",
  title: "Financial compliance and AML",
  domain: "financial-compliance",
  capabilities: [
    "structuring and rapid-movement patterns across accounts",
    "sanctions and counterparty screening against the entity graph",
    "reconciliation breaks between ledger, settlement and statement",
  ],
  vocabulary: [
    "aml", "money laundering", "compliance", "regulatory", "regulation",
    "sanction", "sanctions", "kyc", "transaction", "transactions", "ledger",
    "settlement", "reconciliation", "wire", "payment", "payments", "fraud",
    "structuring", "ctr", "audit trail",
  ],
});

/**
 * PERFORMANCE: where the capacity went, expressed in the vocabulary operators use.
 */
export const performanceAgent: Template = stub({
  id: "performance",
  title: "Performance and load bottleneck detection",
  domain: "performance",
  capabilities: [
    "bottleneck attribution from JMeter and LoadRunner result trees",
    "saturation and queueing identified per resource rather than per endpoint",
    "regression attribution between a baseline run and a current one",
  ],
  vocabulary: [
    "performance", "load test", "load-test", "loadtest", "jmeter", "loadrunner",
    "bottleneck", "throughput", "latency", "percentile", "p95", "p99",
    "saturation", "capacity", "concurrency", "ramp-up", "response time",
    "slow", "slowness", "regression",
  ],
});

/** THE THREE, IN REGISTRATION ORDER. The order is precedence, and it is data. */
export const SPECIALIST_TEMPLATES: readonly Template[] = [
  devsecOpsAgent,
  complianceAgent,
  performanceAgent,
];
