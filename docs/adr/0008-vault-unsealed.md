# ADR-008 — THE VAULT, UNSEALED AND DELIBERATELY NOT WIRED

- **Status:** **RATIFIED as a capability. NOT WIRED. The gateway wiring named in
  the Phase 3 integration order is NOT implemented and is NOT approved.**
- **Date:** 2026-10-04
- **Ratified by:** operator instruction, "the vault is officially unsealed"
- **Supersedes:** **D-017** (`docs/DECISIONS.md`), on one narrow point only —
  see §3. It does not reopen anything else D-017 decided.
- **Relates to:** D-016 (the vault intake record D-017 disposes of), D-017,
  ADR-005 (memory, the two-truths contract), ADR-006 §7 (why D-017 was not
  re-opened then), ADR-007 (namespaces), `docs/SECURITY.md` residual
  limitations 7 and 8

---

## 1. Why this record exists at all

D-017 said something that leaves no room for interpretation:

> The vault is NOT a live production control and must never be described as one.
> Any documentation, report, or operator briefing implying the vault currently
> protects credentials is wrong and must be corrected.

An operator has now unsealed it. That is legitimate authority and it is the
process ADR-006 §4 describes — a decision record is superseded by a later one,
not edited quietly. But the corollary of D-017's sentence follows just as hard:

**The moment the decision changes, every document that described the old
posture is wrong until one of them says so.** `docs/SECURITY.md` residual
limitations 7 and 8, `docs/handoff.md` "Enforced versus declared", and D-017's
own status line all currently assert the vault is dark. This record is what makes
them wrong *on the record* instead of wrong in secret.

It is written before the code, not after, because D-017's own lesson was that the
decision log was the thing that went stale.

---

## 2. What was asked, and what is actually delivered

The Phase 3 integration order asked for:

1. `platform/vault/store.ts` providing tenant-isolated credential retrieval for
   custom agents.
2. Cryptographic bounds so an agent holding a capability token can only reach
   authorised secrets.
3. Those bounds to **replace the static environment variables the MCP Gateway
   uses today**.

Items 1 and 2 are **delivered**: the module exists, is tenant-isolated, is
capability-bounded, and is covered by sixteen tests.

**Item 3 is not delivered, and this record is the reason.** It is not deferred as
an oversight; it is a decision with its reasoning in §5.

---

## 3. Exactly what is superseded, and what is not

This is deliberately narrow, because a broad supersession would quietly reopen
settled ground.

**Superseded:** D-017's conclusion that the vault must never be wired *because
there was no reviewed design for doing so*. A design now exists.

**Not superseded:**

- **The finding that the vault is safe because it is unreachable.** That
  sentence is still true of `platform/core/vault.ts`, which remains unwired.
- **D-017's three preconditions for enabling the wiring.** All three remain
  unanswered. They are §5.
- **Everything about the D-016 kernel path.** The precheck choke point,
  CONTROLLED-tier approval, and redaction are unchanged and still load-bearing.

So the net effect: a **new, separate** capability exists alongside the old one.
Neither is wired. They are not interchangeable and should not be described as two
front doors to the same thing — see §4.

---

## 4. Why this is a NEW capability and not D-016 being switched on

This is the load-bearing section, and getting it wrong is how an operator
accidentally ships a weaker control than they believe they are shipping.

`CredentialVault` is safe for an unredacted read **because of where the read is
gated**. Every tool reaches execution through the kernel's `precheckToolCall`.
`vault_reveal` is declared CONTROLLED tier, the measured policy engine returns
`REQUIRE_APPROVAL` on every call, and that approval is recorded in the precheck
trace *before the handler runs*. The value is disclosed because a person approved
that specific call.

**The embassy has no precheck.** `callTool` invokes a handler directly;
`callCore` reaches the portal with a credential already in hand. A secret tool
added to the embassy would therefore disclose values with:

- no per-call approval,
- no approval record in any trace,
- and no operator in the loop at the moment of disclosure.

That is not D-016 enabled. It is a **value-disclosing path with no approval
mechanism**, which is a materially weaker control wearing the same name. ADR-006
§7 refused to re-open D-017 on exactly this kind of reasoning, and the reasoning
has not expired.

Hence `platform/vault/store.ts` is designed to stand alone — the grant is carried
in the capability, tenant isolation is structural, and every refusal is one
indistinguishable answer — rather than relying on a choke point that is not there.

### 4.1 And the module does not verify capabilities

Stated plainly because it reads as a reassurance if it is not: `store.ts` does
**not** mint, sign, or verify capabilities. A `Capability` passed to it is an
assertion by the caller. Verifying a signature would mean holding a signing key in
the store process, and a store that signs its own capabilities is an authority on
its own isolation.

The module enforces everything *below* the assertion — tenant, grant set, expiry,
revocation, and the audit trail. Whoever constructs capabilities must prove them.
That hand-off is the seam, and it is named rather than left to be discovered.

---

## 5. The three D-017 preconditions, and why each still blocks the wiring

D-017 required a security review covering at minimum these three. None has
happened, because there was no wiring to review until this turn, and a review
conducted after the fact is not a review.

### 5.1 Where does approval for an ungranted read live? — OPEN, and blocking

Today an ungranted read is refused. That is safe and it is not the feature being
asked for: the useful case is a human deciding to widen a grant at the moment it
is needed. That decision needs somewhere to live.

The embassy has no precheck, so it cannot inherit the D-016 mechanism. The
options are a distinct approval record for the MCP surface, or a grant that a
person issues out of band. **This is an architectural decision, not an
implementation detail, and it is not made here.**

### 5.2 Should the operator-supplied secret location sit inside the workspace boundary? — OPEN

D-016 answered this for the kernel vault by keeping the path in operator
configuration and never accepting it from tool input. The same question reappears
here and this module's answer is only partial: `SecretSource` is a port, so the
location is the caller's, but nothing yet constrains *where* a caller may put it.
A caller that hands the store a path outside the intended root has made a
decision that should be somebody else's.

### 5.3 Is the redacted default safe for a live deployment? — OPEN

`CredentialVault` defaults to `redacted` and refuses an unredacted read when
configured that way. The new store has **no equivalent operator standing
instruction** — it always returns the value to an entitled capability, and the only
gate is the grant. For a deployment rather than a test that is a real gap, and it
should be closed by a configured mode that this module does not yet have.

---

## 6. What the module guarantees

Sixteen tests, and most of them are about what a capability holder *cannot* do,
because the entitled path is one line and the refusal paths are the design.

| Property | Where |
|---|---|
| Tenant isolation: the only tenant ever loaded is the capability's | `store.ts` `retrieve`, grant check before `source.load` |
| No existence oracle: wrong tenant, not granted, expired, revoked, absent are one answer | `REFUSAL_CODE` / `REFUSAL_MESSAGE`, single pair |
| Whole-secret grants: no prefix or wildcard inheritance | `equalConstantTime` over exact names |
| Expiry required; a grant with no window is refused | `retrieve` |
| Revocation is effective before any I/O | `retrieve`, checked before `source.load` |
| Audit trail carries the request, never the value | `record`, `VaultAuditEvent` |
| A refusal message names nothing: not tenant, not secret, not value | `refuse` |
| A broken audit sink refuses the read rather than serving unaudited | `record` |
| A source answering for the wrong tenant is refused, not served | `set.tenant !== capability.tenant` |

The audit-sink rule deserves a note: allowing a sink exception to propagate would
mean an outage in this path gets answered by disabling the trail. Refusing the read
means a broken trail produces no reads rather than unaudited reads.

---

## 7. What would have to be true to wire it

Stated as conditions so the next person can check them off rather than re-derive
them. All three of §5, plus:

- **A capability issuer is named**, and it is outside `store.ts`. Without one there
  is no way for the store's "assertion" to become "verified", and §4.1 currently
  carries the whole gap.
- **The secret source is chosen**, with §5.2 answered for it.
- **A decision on whether the MCP gateway should stop reading
  `NEUROFEBRIC_EMBASSY_TOKEN` from the environment at all.** This deserves its
  own attention: that variable is currently the embassy's *only* trust root, read
  once at start-up. Moving it behind a store is not a refactor — it changes what
  the embassy trusts, and it makes the store a dependency of every authenticated
  call rather than of one read.
- **D-017, ADR-006 §7, and `docs/SECURITY.md` residual limitations 7 and 8 are
  updated in the same change**, so the decision log does not become stale in the
  way D-017 was written to prevent.

---

## 8. Alternatives considered

1. **Wire it now as specified.** Rejected. It creates a value-disclosing path with
   no approval mechanism (§4) and answers none of D-017's three questions (§5).
   The operator's authority to unseal does not extend to deciding where human
   approval lives, which is a new question this turn raises rather than one it
   settles.
2. **Refuse the task entirely.** Rejected. The capability is real work, it is
   safe on its own terms, and delivering it unwired is the maximum progress that
   does not require the missing review.
3. **Wire it to the kernel precheck instead of the embassy.** This is the right
   long-term shape and remains open — but it needs the existing D-016 vault to
   grow tenant scoping, not a second store beside it. Recorded as a direction, not
   chosen.
4. **Delete D-017.** Rejected, on D-017's own reasoning: it is a correct record of
   a real review, and its Consequences section is what makes §1 checkable.

---

## 9. Consequences

**Good.** A tested, unwired capability with its safety argument written down.
An existence oracle that a naive implementation would have shipped is closed by
design. The decision log stays accurate, and the three questions that must be
answered before wiring are written down where the next reader will find them.

**Bad, and honestly so.** The operator asked for a wired gateway and did not get
one. If that is the decision, the shortest honest route is §7, and the first item
is the real blocker: someone must decide where a human approving a secret read is
recorded, because on the MCP surface there is nowhere for that to go today.

The store is *not* a second front door to the D-016 vault. It is a separate
capability with different properties, and treating it as interchangeable with the
reviewed one is the mistake this record exists to prevent.

---

## 10. Traceability

| Obligation | Where it comes from |
|---|---|
| Decision records are superseded, never quietly edited | ADR-006 §4, `docs/DECISIONS.md` conventions |
| Vault must not be described as a live control while dark | D-017 Consequences |
| Precheck approval is what makes a reveal safe | D-016 rationale 1, ADR-008 §4 |
| The embassy has no precheck | `platform/embassy/tools.ts` `callTool`, `platform/embassy/core.ts` `callCore` |
| Three preconditions before wiring | D-017 Consequences, restated in §5 |
| No existence oracle | `platform/vault/store.ts` single refusal pair |
| Vault stays dark in the kernel path | D-017, unchanged by this record |
| Documentation must be corrected, not just code | D-017 Consequences, §1, §7 |