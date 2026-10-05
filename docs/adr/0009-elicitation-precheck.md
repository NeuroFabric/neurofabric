# ADR-009 — THE PRECHECK ANSWERS ADR-008 §5.1, AND THE VAULT IS STILL NOT WIRED

- **Status:** **RATIFIED. The approval mechanism exists and is tested. The vault
  is STILL not wired to a real reader — see §4.**
- **Date:** 2026-10-04
- **Ratified by:** operator instruction, "with the precheck capability established,
  formally wire the store"
- **Amends:** ADR-008 §5.1 (the blocker). Does not amend §5.2 or §5.3, which remain
  open.
- **Relates to:** ADR-006 (the embassy), ADR-008 (the vault, unsealed and not
  wired), D-016, D-017, `docs/SECURITY.md` residual limitations 7 and 8

---

## 1. What this record settles

ADR-008 §5.1 asked the one question that had to be answered before anything else
could be built:

> Where does approval for an ungranted read live?

**On the MCP surface, it lives in the client, reached by MCP Elicitation.** The
server sends an `elicitation/create` request; a human decides; the answer comes
back and the server acts on it. No new approval mechanism was invented, because
the protocol already specifies one and a bespoke one would have been a second
door.

This is the first time in this repository that a credential read is gated
somewhere other than the kernel precheck, so the reasoning is recorded here in
full rather than only in the module.

---

## 2. Why elicitation is the right shape, and what it cost

It is the only standard mechanism for a server to ask a person anything. The
alternatives were all worse:

| Option | Why not |
|---|---|
| Approve once at startup | A grant that cannot be withdrawn is a grant nobody reasons about at review time. ADR-008 §5.1 was asking about the *per-read* case. |
| Ask in the agent's own words | The agent is the thing being supervised. Letting it phrase the request to a human is supervision by the supervised. |
| Approve in a separate UI | A second door, and one whose identity the operator cannot check from the stream. |

**What it cost:** the server had to stop being a pure function of a line. It now
sends requests as well as answering them, which meant a JSON-RPC *response* — an
`id`, a `result`, and no `method` — had to become a frame the parser recognises.
It did not, and every approval would have timed out into a refusal. That is
recorded in ADR-008's own terms: the component would have looked correctly
fail-closed while being entirely non-functional.

---

## 3. The three rules this surface holds, that the kernel surface gets differently

### 3.1 The capability, never the bearer

The prompt names the capability's **ID**. The specification forbids form mode for
API keys and tokens, and form-mode data is exposed to the client by design — so a
bearer value in that payload would be handed to the host process, rendered into
whatever UI the host has, and plausibly written to its logs.

The operator still learns what they are approving, because the ID is what
identifies *which grant* is being exercised. Showing a credential to help someone
identify a grant is spending the secret to solve a problem the ID already solves.

### 3.2 The reader is a factory, not a dependency

The store is reached through something that is *called*, never something that is
*passed*. It therefore cannot be constructed at startup, at configuration time, or
in any handler that is not an approved read. "The store is only reachable through
an approval" is a fact about construction, and the tests count factory
invocations rather than trusting a comment: declined, cancelled, expired,
unsupported, and refused-before-handshake all assert **zero**.

This is stronger than ADR-008 could have promised. There, the store existed and
was unwired, so the claim was "nothing constructs it". Here, something constructs
it — and only one line in one branch does.

### 3.3 One refusal, every cause

Decline, cancel, an unchecked box, an unowned approval, a malformed answer, an
expired window, a client that cannot ask, and a trail that throws all refuse with
**the same code**. A refusal that varies with its cause is an oracle: it tells a
probing agent which grants are live and whether a person is looking at its
request. The internal reason travels to the audit trail, where it is written for
somebody reading it later, and to nobody else.

---

## 4. What is NOT wired, and why that is not a contradiction of §1

The operator's instruction was to wire the store "with the precheck capability
established". What exists:

- the approval mechanism, the pending state, the audit trail — **built and tested**;
- `read_credential` in the published tool list — **discoverable**;
- `ApprovedCredentialReader`, a port — **defined**;
- an **implementation of that port** — **does not exist**.

So the precheck is established and the wiring point exists, and no process yet
constructs a real reader. That is a deliberate landing point rather than an
omission, because the port's implementation is where ADR-008 §4.1's missing seam
lives: **who mints capabilities.** The store verifies nothing about a capability
it is handed. Somebody must build one from the credential that was already proved,
and decide what that capability is scoped to. That is a security decision about
capability issuance, not a matter of plumbing, and it is §5.1 of this record.

---

## 5. Still open — and unchanged from ADR-008

| # | Question | Status |
|---|---|---|
| 1 | Who issues capabilities, and what scopes them? | **NEW, and now the blocker.** §4. |
| 2 | Should the operator-supplied location sit inside the workspace boundary? | Open — ADR-008 §5.2 |
| 3 | Is a redacted-by-default standing instruction needed for a live deployment? | Open — ADR-008 §5.3 |

§5.3 deserves emphasis now that reads are reachable: `store.ts` has **no** operator
standing instruction and always returns the value to an entitled capability. The
only gate is the grant. That is fine for a test and is a real gap for a
deployment.

---

## 6. Consequences

**Good.** The blocking question has an answer, and the answer uses a standard
mechanism rather than a new door. The read path is reachable only through an
approval, and that is enforced by construction and counted by tests. Every
refusal is one answer.

**Bad, and honestly so.** The gateway is now bidirectional, which is a permanent
cost: every id this server emits shares a stream with ids it receives, and
correlation is the security property here. Outbound ids are prefixed strings for
that reason, and that is a convention rather than a type.

Reading is now *possible* on this surface, which means every future change to the
embassy is a change to a credential-adjacent path. That is the cost of the
feature and it should be named in every future ADR that touches `tools.ts`.

---

## 7. Traceability

| Obligation | Where it comes from |
|---|---|
| The blocker is answered before anything else is built | ADR-008 §5.1, §7 |
| No second door | ADR-006 §5.2, §7 |
| Fail closed, one answer | `platform/embassy/elicitation.ts` `APPROVAL_REFUSED` |
| Bearer values never in form mode | MCP elicitation spec; `platform/embassy/elicitation.ts` |
| Reader is a dependency of the read, not the process | `platform/embassy/server.ts` `credentialReader` |
| The store cannot be named from the gateway | import-graph scan in `stdio.test.ts` |
| Capability issuance is still unowned | ADR-008 §4.1, §4 here |
| Redacted-by-default still absent | ADR-008 §5.3, §5 here |