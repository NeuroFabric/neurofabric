import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseStandingInstructions, evaluateStandingInstruction } from "./osi.ts";
import { MemoryStore } from "../memory/store.ts";

/**
 * OPERATOR STANDING INSTRUCTIONS: A HUMAN PRE-APPROVING PATTERNS, NOT PEOPLE.
 *
 * === WHY THIS IS THE MOST DANGEROUS THING IN THE SERIES ===
 *
 * Everything else here exists because a PERSON decides whether a credential is read.
 * An OSI removes that person for the cases it covers, which means every question
 * ADR-008, ADR-009 and ADR-010 answered about attribution has to hold in a world
 * where some decisions are made in advance.
 *
 * So the design starts from the question "when may nobody be asked?" and the answer
 * is narrow: a standing instruction may only ever authorise a REDUCED exposure. A
 * live value in a model's context is not something a document signed weeks ago can
 * consent to on behalf of whoever is on call that night, so `raw` is not
 * configurable and saying so in a schema is not enough -- it is refused at parse
 * time and refused again at evaluation time.
 *
 * === WHY AN EXPIRY IS MANDATORY, LIKE A CAPABILITY'S ===
 *
 * A standing instruction with no window is a permanent waiver signed by somebody who
 * is not in the room when it is used. The same argument that made an untimed
 * capability a refusal applies here, and it applies harder: a capability expires in
 * minutes, and these are expected to last weeks.
 *
 * === ATTRIBUTION IS NOT OPTIONAL ===
 *
 * An OSI decision names the human who WROTE the instruction even though nobody was
 * present to approve the individual read. Without that, the ledger contains a grant
 * attributable to nobody, which is the row shape this whole series has been trying to
 * avoid.
 */

const TENANT = "acme";
const OTHER = "globex";

const NOW = 1_700_000_000_000;

function policy(over: Record<string, unknown> = {}) {
  return {
    standingInstructions: [
      {
        id: "osi-1",
        tenant: TENANT,
        credentialPatterns: ["payments/*"],
        maxExposure: "reference",
        expiresAt: NOW + 86_400_000,
        justification: "Triage reads the payment provider key; approved by the on-call rota owner.",
        approvedBy: "compliance-officer",
        ...over,
      },
    ],
  };
}

test("A PARSED POLICY CANNOT CONFIGURE RAW, whatever the file says", () => {
  // The refusal has to be at PARSE time. A schema that merely documents the limit
  // is a comment, and a config file is exactly where somebody will try it.
  const parsed = parseStandingInstructions(
    JSON.stringify(policy({ maxExposure: "raw" })),
    "osi-test",
    NOW,
  );

  assert.deepEqual(parsed.rejected, [
    { id: "osi-1", reason: "an instruction may not stand in for a person approving a raw value" },
  ]);
  assert.equal(parsed.instructions.length, 0, "a rejected instruction grants nothing at all");
});

test("AN INSTRUCTION WITH NO EXPIRY IS REJECTED, because a permanent waiver is not an instruction", () => {
  const parsed = parseStandingInstructions(
    JSON.stringify(policy({ expiresAt: undefined })),
    "osi-test",
    NOW,
  );

  assert.equal(parsed.instructions.length, 0);
  assert.match(parsed.rejected[0]?.reason ?? "", /expir/i);
});

test("AN INSTRUCTION WITH NO HUMAN BEHIND IT IS REJECTED", () => {
  for (const field of ["approvedBy", "justification"]) {
    const parsed = parseStandingInstructions(JSON.stringify(policy({ [field]: "  " })), "osi-test", NOW);
    assert.equal(parsed.instructions.length, 0, `${field} must be required`);
  }
});

test("AN UNPARSEABLE POLICY GRANTS NOTHING, rather than everything", () => {
  const parsed = parseStandingInstructions("{ not json", "osi-test", NOW);

  assert.deepEqual(parsed.instructions, []);
  assert.equal(parsed.rejected.length, 1);
});

test("A MATCHING REQUEST IS PRE-APPROVED, WITHIN ITS CEILING", () => {
  const { instructions } = parseStandingInstructions(JSON.stringify(policy()), "osi-test", NOW);
  const subject = { tenant: TENANT, credentialName: "payments/api-key", exposure: "reference" as const };

  const verdict = evaluateStandingInstruction(instructions, subject, NOW);

  assert.equal(verdict.applies, true);
  if (verdict.applies) {
    assert.equal(verdict.instruction.id, "osi-1");
    assert.equal(verdict.instruction.approvedBy, "compliance-officer", "the decision names who pre-approved it");
  }
});

test("A PATTERN DOES NOT REACH ANOTHER TENANT, however well it matches", () => {
  const { instructions } = parseStandingInstructions(JSON.stringify(policy()), "osi-test", NOW);
  const subject = { tenant: OTHER, credentialName: "payments/api-key", exposure: "reference" as const };

  assert.equal(evaluateStandingInstruction(instructions, subject, NOW).applies, false);
});

test("A PATTERN DOES NOT REACH OUTSIDE ITS PREFIX", () => {
  const { instructions } = parseStandingInstructions(JSON.stringify(policy()), "osi-test", NOW);

  const outside = evaluateStandingInstruction(
    instructions,
    { tenant: TENANT, credentialName: "billing/settlement-token", exposure: "reference" },
    NOW,
  );
  const traversed = evaluateStandingInstruction(
    instructions,
    { tenant: TENANT, credentialName: "payments/../../billing/settlement-token", exposure: "reference" },
    NOW,
  );

  assert.equal(outside.applies, false);
  assert.equal(traversed.applies, false, "a pattern is a prefix, not a glob an attacker can steer with ..");
});

test("A REQUEST AT A HIGHER EXPOSURE THAN THE CEILING IS NOT PRE-APPROVED", () => {
  // The ceiling has to bind the OTHER direction too: an instruction that may answer
  // "reference" must not be read as consent for anything above it.
  const { instructions } = parseStandingInstructions(JSON.stringify(policy()), "osi-test", NOW);

  assert.equal(
    evaluateStandingInstruction(instructions, { tenant: TENANT, credentialName: "payments/api-key", exposure: "raw" }, NOW).applies,
    false,
    "raw is never pre-approved",
  );
});

test("AN EXPIRED INSTRUCTION STOPS APPLYING, without needing anybody to remove it", () => {
  const { instructions } = parseStandingInstructions(JSON.stringify(policy()), "osi-test", NOW);
  const subject = { tenant: TENANT, credentialName: "payments/api-key", exposure: "reference" as const };

  assert.equal(evaluateStandingInstruction(instructions, subject, NOW + 86_400_001).applies, false);
});

test("NO POLICY MEANS NO PRE-APPROVAL, which is the default every deployment starts from", () => {
  const verdict = evaluateStandingInstruction([], { tenant: TENANT, credentialName: "payments/api-key", exposure: "reference" }, NOW);

  assert.equal(verdict.applies, false);
});

test("AN OSI DECISION IS RECORDED AS ITS OWN CLASS, never mixed with a human approval", () => {
  // The ledger is the thing an investigator reads. A pre-approval and a person's
  // approval are different acts by different means, and a query that cannot tell
  // them apart cannot answer "was anyone actually watching".
  const store = MemoryStore.open({ directory: mkdtempSync(join(tmpdir(), "nf-osi-")) });
  try {
    store.appendAudit(TENANT, "compliance-officer", "vault.approval.osi", {
      instructionId: "osi-1",
      credentialName: "payments/api-key",
      exposure: "reference",
    });

    const osi = store.auditFor(TENANT).filter((row) => row.action === "vault.approval.osi");
    const human = store.auditFor(TENANT).filter((row) => row.action === "vault.approval.granted");

    assert.equal(osi.length, 1);
    assert.equal(human.length, 0, "a pre-approval does not appear as a human approval");
    assert.equal(osi[0]?.actor, "compliance-officer", "and it names who wrote the instruction");
  } finally {
    store.close();
  }
});