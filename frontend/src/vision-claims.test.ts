import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * THE VISION IS ASSERTED, LIKE EVERYTHING ELSE.
 *
 * === THE HONEST LIMIT THIS CLOSES ===
 *
 * ADR-004 (§13) said a test *should* fail on the superseded claim
 * "multi-tenancy in the UI is out of scope" once Phase 1 memory is recorded — and
 * said plainly that **it did not exist**. That sentence was the honest part. A
 * document that states a verification nobody wrote is a description, not a
 * commitment, and this repository had already learned that lesson the expensive
 * way with a stale route count and a stale port.
 *
 * So the vision now has the same kind of claim the code has: a test that fails
 * when the document goes back.
 *
 * === WHY A DOCUMENT NEEDS THIS AT ALL ===
 *
 * Because documents rot silently and nobody notices. Every stale thing this
 * project has shipped was a **literal that drifted**: a port, a route count, a
 * status word, a provider name in customer copy. `docs/PRODUCT-VISION.md` is the
 * document the whole delivery is judged against, and it is exactly as capable of
 * becoming untrue as any of them.
 *
 * **A vision that cannot be falsified is decoration.**
 */

/** The repository root, from this file's location. */
const ROOT = path.resolve(import.meta.dirname, "..", "..");
const DOCS = path.join(ROOT, "docs");

const read = (relative: string): string => readFileSync(path.join(DOCS, relative), "utf8");

describe("the product vision is true of the repository it describes", () => {
  const vision = read("PRODUCT-VISION.md");

  it("exists, because everything below asserts against it", () => {
    expect(vision.length).toBeGreaterThan(500);
  });

  it("does not still claim multi-tenancy is out of scope", () => {
    // THE SUPERSEDED CLAIM. ADR-004 amended it: the ENGINE is already
    // tenant-scoped, only the screen presents one tenant, so it is a Phase 5+
    // destination rather than an exclusion.
    //
    // The precise phrase is asserted rather than the word "multi-tenancy", because
    // the word is supposed to remain -- it is the CLAIM that was superseded, and a
    // ban on the word would force the document to avoid saying the truth.
    expect(vision).not.toContain("Multi-tenancy in the UI.**");
    expect(vision).not.toContain("| Multi-tenancy in the UI. |");
  });

  it("states the amended claim instead, so the exclusion is not simply deleted", () => {
    // Deleting the row would be the reflex. The row is AMENDED because the truth
    // got narrower and more accurate, and a missing row reads as a gap rather
    // than as a decision.
    expect(vision).toContain("Phase 5+ destination");
    expect(vision).toContain("tenant-scoped");
  });

  it("keeps the out-of-scope promises it has not withdrawn", () => {
    // A sweep that quietly grows the document is its own failure. Each of these is
    // still true and still load-bearing.
    for (const kept of ["Any model call", "Any internal jargon on the default view", "Historical retention"]) {
      expect(vision, `the vision dropped "${kept}"`).toContain(kept);
    }
  });

  it("still forbids jargon on the default view, which is Check 3", () => {
    // Check 3 is "zero internal jargon on the default view". If this sentence is
    // ever withdrawn, that criterion has been redefined rather than met, and the
    // tests in src/jargon.test.tsx are guarding a standard that no longer exists.
    expect(vision).toContain("jargon");
  });

  it("points at ADR-004 from the row it amended, so a reader can follow the reasoning", () => {
    expect(vision).toContain("0004-recollection-is-reconciliation.md");
  });
});

describe("ADR-004 exists and says what it was asked to say", () => {
  it("is present, and this test is why that is checkable", () => {
    expect(existsSync(path.join(DOCS, "adr", "0004-recollection-is-reconciliation.md"))).toBe(true);
  });

  it("records the five project laws have a home, or the vision has no teeth", () => {
    const adr = read(path.join("adr", "0004-recollection-is-reconciliation.md"));
    // Reconciliation rather than memory is the load-bearing distinction; if this
    // sentence is ever rewritten to say the system "remembers", the ADR has
    // drifted into the framing it refused.
    expect(adr).toContain("Reconciliation is not recall");
    expect(adr).toContain("The diff is the product");
  });
});

describe("ADR-005's status matches reality", () => {
  /**
   * THIS TEST CHANGED WHEN THE DOCUMENT DID, AND THE REASON MATTERS MORE THAN
   * THE CHANGE.
   *
   * It used to assert that ADR-005 was "published for ratification", carried
   * "pending", and said "Nothing here is implemented" -- which was correct while
   * it was true, and would have gone RED the moment the operator ratified it and
   * !104/!105 landed.
   *
   * A test like that has a real cost: it makes ratification look like a
   * regression, and the cheapest way to keep it green would have been to leave
   * the ADR claiming to be a proposal. So the invariant is now the one that
   * actually matters in both directions --
   *
   *  - BEFORE ratification the ADR must say it is a proposal, and
   *  - AFTER it, the ADR must SAY SO and must NAME what was built.
   *
   * The second half is the load-bearing half. A decision record that says
   * "ratified" without saying which MRs implemented it is decoration, and the
   * failure mode is silent: nothing breaks, the document just stops being
   * checkable.
   */
  const path5 = path.join(DOCS, "adr", "0005-memory.md");
  const adr = existsSync(path5) ? readFileSync(path5, "utf8") : "";

  it("exists", () => {
    expect(existsSync(path5), "ADR-005 is missing").toBe(true);
  });

  it("records that it is RATIFIED, and no longer claims to be a proposal", () => {
    expect(adr).toContain("RATIFIED");
    // The superseded pre-ratification language must not survive alongside the
    // new status. Two statuses in one document is how a reader picks the wrong
    // one.
    expect(adr).not.toContain("published for ratification");
    expect(adr).not.toContain("Nothing here is implemented");
  });

  it("names the work that implemented it, so the claim is falsifiable", () => {
    expect(adr).toContain("!104");
    expect(adr).toContain("!105");
  });

  it("still keeps the open questions open -- ratification is not a blank cheque", () => {
    // The sections that were deliberately deferred stay deferred. A ratified ADR
    // that quietly absorbed its own refusals would be a different document.
    expect(adr).toContain("does not decide");
    expect(adr).toContain("Encryption at rest");
  });
});