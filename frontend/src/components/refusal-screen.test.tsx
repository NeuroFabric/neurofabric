import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RefusalScreen } from "./RefusalScreen";
import type { CredentialState } from "../api/credential-state";

/**
 * THE REFUSAL SCREENS, RENDERED.
 *
 * === WHY THIS RENDERS A COMPONENT AND NOT App ===
 *
 * `App` reaches this branch through the telemetry hook, the hook polls inside an
 * effect, and an effect does not run in `renderToStaticMarkup`. So the branch was
 * unreachable from any test in this workspace, and "the states are visibly
 * distinct" was a claim about a screenshot rather than an assertion.
 *
 * Rendering the screen directly fixes that, and it is the honest unit anyway: the
 * whole content of the refusal is the words on the page, and words are what is
 * being asserted.
 */

const submit = (): void => {};

describe("RefusalScreen", () => {
  it("asks for a credential when the caller can accept one, and says WHY", () => {
    const html = renderToStaticMarkup(
      <RefusalScreen state="rejected" onCredentialRequired={submit} />,
    );

    // The operator is told the server refused what was presented -- not that no
    // credential is configured, which would send them looking in the wrong place.
    expect(html).toContain("refused the credential this command center is presenting");
    expect(html).toContain("does not recognise this gateway credential");
    expect(html).toContain("Enter the one the server was started with");
    // A real input, because a credential is something a person types.
    expect(html).toContain("<input");
    expect(html).toContain("Connect");
  });

  it("masks the credential it asks for, without using the masked input type", () => {
    const html = renderToStaticMarkup(<RefusalScreen state="rejected" onCredentialRequired={submit} />);

    // The type stays "text" -- the project's vocabulary rule forbids the other
    // spelling, and stating the truth about the DOM is worth more than the
    // convenience. The masking is presentational and lives in the style attribute.
    expect(html).toMatch(/type="text"/);
    expect(html).toContain("-webkit-text-security:disc");
  });

  it("says NO CREDENTIAL ARRIVED differently from saying the WRONG ONE ARRIVED", () => {
    const missing = renderToStaticMarkup(<RefusalScreen state="required" onCredentialRequired={submit} />);
    const wrong = renderToStaticMarkup(<RefusalScreen state="rejected" onCredentialRequired={submit} />);

    expect(missing).toContain("No gateway credential reached the portal");
    expect(missing).toContain("The client is unwired");
    expect(wrong).toContain("does not recognise this gateway credential");

    // The assertion that matters: they are not the same screen with a swapped
    // word. This is the distinction the incident turned on.
    expect(missing).not.toBe(wrong);
  });

  it("does not invite a retype of a credential that was withdrawn", () => {
    const html = renderToStaticMarkup(<RefusalScreen state="revoked" onCredentialRequired={submit} />);
    expect(html).toContain("withdrawn");
    // The same value will not work, so "enter the one the server was started with"
    // would walk the operator round the same loop. The lead names the difference.
    expect(html).toContain("Enter a current one");
    expect(html).not.toContain("Enter the one the server was started with");
  });

  it("does not offer a credential input when nothing can accept one", () => {
    const html = renderToStaticMarkup(<RefusalScreen state="rejected" />);

    // An input that goes nowhere is worse than none: it accepts input and reports
    // nothing, which is indistinguishable from a broken page.
    expect(html).not.toContain("<input");
    expect(html).not.toContain("Connect");
    expect(html).toContain("does not recognise this gateway credential");
    expect(html).toContain("role=\"alert\"");
  });

  it("offers Retry only when a retry is wired", () => {
    const without = renderToStaticMarkup(<RefusalScreen state="other" />);
    expect(without).not.toContain("Retry");

    const with_ = renderToStaticMarkup(<RefusalScreen state="other" onRetry={() => {}} />);
    expect(with_).toContain("Retry");
  });

  it("reports a missing gateway as a server fault, not as a credential problem", () => {
    const html = renderToStaticMarkup(<RefusalScreen state="no-gateway" onCredentialRequired={submit} />);

    // Offering a credential prompt here would ask the operator to fix something
    // they do not control. The words must name what is actually wrong.
    expect(html).toContain("no live gateway is attached");
    expect(html).toContain("server-side fault, not a credential one");
    expect(html).not.toContain("Enter the one the server was started with");
  });

  it("renders a distinct screen for every refusal state", () => {
    const states: CredentialState[] = ["required", "rejected", "revoked", "forbidden"];
    const screens = states.map((state) => renderToStaticMarkup(<RefusalScreen state={state} />));

    expect(new Set(screens).size).toBe(states.length);
  });
});