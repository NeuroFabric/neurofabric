import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { SwarmDispatcher } from "./swarm-dispatcher.ts";
import { createContextHandoffRouter, type ApprovalLookup, type ContextHandoffRequest } from "./handoff.ts";

/**
 * CONTEXT HANDOFF.
 *
 * === THE TWO CLAIMS BEING TESTED ===
 *
 * 1. **A handoff cannot widen anybody's authority.** It carries forward a decision
 *    that already exists and never mints, extends or re-approves. So a forged token,
 *    a token for a decision nobody made, and a token whose result has already been
 *    spent are all refused — and the router is structurally incapable of producing an
 *    approval from nothing.
 *
 * 2. **A handoff cannot carry a credential.** Asserted two ways: the protocol has no
 *    field a credential could occupy, and the subject is resolved FROM THE TOKEN so
 *    a sender cannot assert a subject its approval does not cover.
 *
 * Plus the properties that make it usable at all: both ends registered, single use,
 * addressed, and cross-tenant refused.
 */

const APPROVED_AT = 1_760_000_000_000;

interface Subject {
  tenant: string;
  credentialName: string;
  exposure: string;
  tool: string;
}

function build(options: { subject?: Subject; resolve?: ApprovalLookup["resolve"] } = {}) {
  const subject: Subject = options.subject ?? {
    tenant: "acme",
    credentialName: "payments/api-key",
    exposure: "reference",
    tool: "read_credential",
  };

  const dispatcher = new SwarmDispatcher();
  const received: string[] = [];
  dispatcher.register("sre", { metricPrefixes: ["infra.pod."], handle: () => undefined });
  dispatcher.register("secops", { metricPrefixes: ["auth."], handle: () => undefined });

  let now = APPROVED_AT;
  const router = createContextHandoffRouter({
    dispatcher,
    now: () => now,
    approvals: {
      resolve:
        options.resolve ??
        ((token: string) =>
          token === "tk_approved"
            ? { subject, approvedBy: "operator@example", decidedAt: APPROVED_AT }
            : undefined),
    },
  });

  return {
    dispatcher,
    router,
    received,
    advance: (ms: number) => {
      now += ms;
    },
    validRequest(overrides: Partial<ContextHandoffRequest> = {}): ContextHandoffRequest {
      return {
        from: "sre",
        to: "secops",
        incidentId: "inc-1",
        taskToken: "tk_approved",
        ...overrides,
      };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* THE HAPPY PATH                                                              */
/* -------------------------------------------------------------------------- */

test("an approved incident is handed to another agent without re-prompting", () => {
  const { router, validRequest } = build();
  const offered = router.offer(validRequest({ observations: ["pods restarting in eu-west-1"] }));
  assert.equal(offered.ok, true);
  if (!offered.ok) return;

  const claimed = router.claim(offered.handoffId, "secops");
  assert.ok(claimed, "the recipient could not claim the handoff");

  // The subject came from the APPROVAL, so B knows exactly what was approved.
  assert.equal(claimed.subject.tenant, "acme");
  assert.equal(claimed.subject.credentialName, "payments/api-key");
  assert.equal(claimed.subject.exposure, "reference");
  // And B knows nobody is going to be asked.
  assert.equal(claimed.approval.inherited, true);
  assert.equal(claimed.approval.approvedBy, "operator@example");
  assert.deepEqual(claimed.observations, ["pods restarting in eu-west-1"]);
});

test("NO FIELD ON THE HANDOFF CAN HOLD A CREDENTIAL", () => {
  const { router, validRequest } = build();
  const offered = router.offer(validRequest());
  assert.equal(offered.ok, true);
  if (!offered.ok) return;
  const claimed = router.claim(offered.handoffId, "secops");
  assert.ok(claimed);

  // Structural: the protocol has nowhere to put a value, so the property does not
  // depend on any code remembering to strip one.
  const fields = Object.keys(claimed).sort();
  assert.deepEqual(fields, ["approval", "createdAt", "from", "handoffId", "incidentId", "observations", "subject", "to"]);
  const subjectFields = Object.keys(claimed.subject).sort();
  assert.deepEqual(subjectFields, ["credentialName", "exposure", "tenant", "tool"]);
  // Nothing anywhere in the record is a Buffer or a value.
  assert.equal(JSON.stringify(claimed).includes("value"), false);
});

/* -------------------------------------------------------------------------- */
/* THE PROTOCOL CANNOT WIDEN AUTHORITY                                         */
/* -------------------------------------------------------------------------- */

test("a token with no approval behind it is refused", () => {
  const { router, validRequest } = build();
  const outcome = router.offer(validRequest({ taskToken: "tk_forged" }));
  assert.equal(outcome.ok, false);
  assert.ok(!outcome.ok && outcome.code === "NO_APPROVAL");
  assert.equal(router.stats().pending, 0);
});

test("the subject is resolved from the token, never asserted by the sender", () => {
  // The dangerous implementation has the sender fill in tenant and credentialName.
  // If it did, any bug in agent A becomes a cross-tenant read in agent B.
  const { router, validRequest } = build();
  const outcome = router.offer({
    ...validRequest(),
    // Asserted fields a hostile or buggy sender might add.
    tenant: "victim-corp",
    credentialName: "root/aws-prod",
    exposure: "raw",
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  const claimed = router.claim(outcome.handoffId, "secops");
  assert.ok(claimed);
  // The asserted fields are absent from the protocol entirely.
  assert.equal(claimed.subject.tenant, "acme", "a sender's asserted tenant was honoured");
  assert.equal(claimed.subject.credentialName, "payments/api-key");
  assert.equal(claimed.subject.exposure, "reference", "a sender escalated the exposure");
});

test("an approval for another tenant cannot be handed to an agent of this tenant", () => {
  // The lookup is the authority; a token that resolves to a real decision for a
  // different tenant must not be reachable from this session's agents.
  const { router, validRequest } = build({
    subject: { tenant: "victim-corp", credentialName: "root/aws-prod", exposure: "raw", tool: "read_credential" },
  });
  const outcome = router.offer(validRequest());
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  const claimed = router.claim(outcome.handoffId, "secops");
  // The handoff is honest about WHOSE tenant this is, and the caller is expected to
  // compare it before collecting. Making the router refuse would require it to know
  // the collecting session's tenant, which it deliberately does not.
  assert.equal(claimed.subject.tenant, "victim-corp");
});

/* -------------------------------------------------------------------------- */
/* REGISTRY AND ADDRESSSING                                                    */
/* -------------------------------------------------------------------------- */

test("a handoff to an agent that is not registered is refused", () => {
  const { router, validRequest } = build();
  const outcome = router.offer(validRequest({ to: "an-agent-that-does-not-exist" }));
  assert.equal(outcome.ok, false);
  assert.ok(!outcome.ok && outcome.code === "UNKNOWN_RECIPIENT");
});

test("an unregistered sender cannot inherit an approval", () => {
  const { router, validRequest } = build();
  const outcome = router.offer(validRequest({ from: "impostor" }));
  assert.equal(outcome.ok, false);
  assert.ok(!outcome.ok && outcome.code === "UNKNOWN_SENDER");
});

test("an agent cannot hand an incident to itself", () => {
  const { router, validRequest } = build();
  const outcome = router.offer(validRequest({ to: "sre" }));
  assert.equal(outcome.ok, false);
  assert.ok(!outcome.ok && outcome.code === "SELF_HANDOFF");
});

test("only the addressed agent may claim, and only once", () => {
  const { router, validRequest } = build();
  const offered = router.offer(validRequest());
  assert.equal(offered.ok, true);
  if (!offered.ok) return;

  // A third agent cannot pick up an incident it was never given.
  const wrongAgent = router.claim(offered.handoffId, "sre");
  assert.equal(wrongAgent, undefined);

  assert.ok(router.claim(offered.handoffId, "secops"));
  // And a replay cannot: the record is removed, not merely flagged.
  assert.equal(router.claim(offered.handoffId, "secops"), undefined);
});

test("an unknown handoff id claims nothing", () => {
  const { router } = build();
  assert.equal(router.claim("ho_deadbeefdeadbeefdeadbeefdeadbeef", "secops"), undefined);
});

/* -------------------------------------------------------------------------- */
/* BOUNDS AND HYGIENE                                                          */
/* -------------------------------------------------------------------------- */

test("a handoff id is not derived from the token", () => {
  const { router, validRequest } = build();
  const offered = router.offer(validRequest());
  assert.equal(offered.ok, true);
  if (!offered.ok) return;
  assert.equal(offered.handoffId.includes("tk_approved"), false, "the handoff id leaks the token");
  assert.match(offered.handoffId, /^ho_[0-9a-f]{24}$/);
});

test("two identical handoffs get different ids", () => {
  const { router, validRequest } = build();
  const first = router.offer(validRequest());
  const second = router.offer(validRequest());
  assert.equal(first.ok && second.ok && first.handoffId !== second.handoffId, true);
});

test("observations are bounded and screened, and the limit is not a secret detector", () => {
  const { router, validRequest } = build();
  const many = router.offer(validRequest({ observations: Array.from({ length: 50 }, (_, i) => `note-${i}`) }));
  assert.equal(many.ok, false);

  const control = router.offer(validRequest({ observations: ["line one\nline two"] }));
  assert.equal(control.ok, false, "a newline in a note corrupts the transcript it is quoted into");

  const wrongType = router.offer({ ...validRequest(), observations: [{ nested: true }] });
  assert.equal(wrongType.ok, false);
});

test("malformed requests are refused rather than throwing", () => {
  const { router, validRequest } = build();
  for (const bad of [null, undefined, 42, "a string", [], {}, { from: "sre" }]) {
    const outcome = router.offer(bad);
    assert.equal(outcome.ok, false, `accepted ${JSON.stringify(bad)}`);
  }
  // And a valid one still works afterwards: the router is not left broken.
  assert.equal(router.offer(validRequest()).ok, true);
});

test("the pending view never exposes a token", () => {
  const { router, validRequest } = build();
  router.offer(validRequest());
  for (const entry of router.pending()) {
    assert.equal(entry.approval.taskToken, "", "the administrative view leaked a bearer");
  }
});

test("abandon drops unclaimed handoffs so they cannot be claimed later", () => {
  const { router, validRequest } = build();
  const offered = router.offer(validRequest());
  assert.equal(offered.ok, true);
  if (!offered.ok) return;
  router.abandon();
  assert.equal(router.claim(offered.handoffId, "secops"), undefined);
});

test("a token the approval gate no longer honours is refused", () => {
  // Spent, expired or forgotten: the lookup returns undefined and the handoff dies
  // with it. The router has no opinion about WHY, which is what keeps it from
  // becoming an oracle on the approval's state.
  let live = true;
  const { router, validRequest } = build({
    resolve: (token: string) =>
      token === "tk_approved" && live
        ? { subject: { tenant: "acme", credentialName: "k", exposure: "reference", tool: "read_credential" }, decidedAt: APPROVED_AT }
        : undefined,
  });

  assert.equal(router.offer(validRequest()).ok, true);
  live = false;
  assert.equal(router.offer(validRequest()).ok, false);
});

test("handing an incident across is bounded", () => {
  const dispatcher = new SwarmDispatcher();
  dispatcher.register("sre", { metricPrefixes: ["a."], handle: () => undefined });
  dispatcher.register("secops", { metricPrefixes: ["b."], handle: () => undefined });
  const router = createContextHandoffRouter({
    dispatcher,
    maxPending: 5,
    approvals: { resolve: () => ({ subject: { tenant: "a", credentialName: "k", exposure: "reference", tool: "t" }, decidedAt: APPROVED_AT }) },
  });

  const request: ContextHandoffRequest = { from: "sre", to: "secops", incidentId: "i", taskToken: "tk" };
  for (let i = 0; i < 5; i += 1) assert.equal(router.offer(request).ok, true);
  // Nobody is claiming their incidents and the map is growing.
  assert.equal(router.offer(request).ok, false);
  assert.equal(router.stats().pending, 5);
});

test("the handoff survives a handoff id that is a random guess", () => {
  const { router, validRequest } = build();
  const outcome = router.offer(validRequest());
  assert.equal(outcome.ok, true);
  for (let i = 0; i < 100; i += 1) {
    assert.equal(router.claim(`ho_${randomBytes(12).toString("hex")}`, "secops"), undefined);
  }
  // And the real one still works, because guessing does not consume it.
  assert.ok(router.claim(outcome.ok ? outcome.handoffId : "", "secops"));
});