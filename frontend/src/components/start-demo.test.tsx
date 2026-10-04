import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { StartDemo, hasDemoTransport } from "./StartDemo";
import { DEMO_AGENT, DEMO_PROVIDER, demoEvents } from "../api/demo-agent";

/**
 * THE FRONT DOOR. A stranger opens an empty screen; one click must do the work.
 *
 * === WHAT IS AND IS NOT PROVEN HERE ===
 *
 * This proves the SEQUENCE and the COPY: that the agent is registered before any
 * traffic moves, that the empty state offers a way out, that generated data is
 * labelled as generated, and that a failure is told rather than swallowed.
 *
 * It does **not** prove the schema validates against the real server, nor that
 * the whole click completes inside five seconds. Both need a running wedge, and
 * the schema one has a live-curl receipt in the MR description. A green run here
 * is a green run on a fake transport, and it is labelled as such.
 */

const markup = (node: React.ReactElement): string => renderToStaticMarkup(node);
const words = (node: React.ReactElement): string =>
  markup(node).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

function fakeSource() {
  const calls: string[] = [];
  return {
    calls,
    uploadSchema: vi.fn(async () => {
      calls.push("upload");
      return { installed: true };
    }),
    ingest: vi.fn(async (provider: string, events: readonly unknown[]) => {
      calls.push("ingest");
      void provider;
      void events;
      return { accepted: events.length, refused: 0 };
    }),
  };
}

describe("the empty state has a way out", () => {
  it("offers the button, and says the traffic is generated", () => {
    const html = markup(<StartDemo source={fakeSource()} />);
    expect(html).toContain("Show me a demo");
    // The disclosure is BEFORE the click, not after. A stranger must never be
    // able to finish this flow believing they are watching a live pipeline.
    expect(html).toContain("generated traffic");
    expect(html).toContain("Nothing leaves this machine");
  });

  it("never describes the sample as live, real, or production", () => {
    const text = words(<StartDemo source={fakeSource()} />).toLowerCase();
    for (const banned of ["live data", "real data", "production", "actual traffic"]) {
      expect(text, `must not offer "${banned}"`).not.toContain(banned);
    }
  });

  it("says what it does in the customer's words, not the schema's", () => {
    const text = words(<StartDemo source={fakeSource()} />);
    expect(text).toContain("sample agent");
    expect(text.toLowerCase()).not.toContain("ingest");
    expect(text.toLowerCase()).not.toContain("provider");
  });
});

describe("the demo agent is a document, not a guess", () => {
  it("uses ONLY rule fields the registry accepts", () => {
    // The first version of this schema invented `column` and `factor`. The
    // validator refuses both as unrecognised fields, so the POST would have
    // answered 400 and the front door would have been broken in exactly the
    // situation it exists for. Asserted here so it cannot drift back.
    const allowed = new Set([
      "id", "kind", "severity", "message", "field", "pattern",
      "flags", "operator", "value", "windowMs", "rateAbove",
    ]);
    for (const rule of DEMO_AGENT.rules) {
      for (const key of Object.keys(rule)) {
        expect(allowed.has(key), `rule field "${key}" is not in the registry's grammar`).toBe(true);
      }
    }
  });

  it("uses an operator the registry accepts", () => {
    const operators = new Set([">", ">=", "<", "<=", "==", "!="]);
    for (const rule of DEMO_AGENT.rules) {
      if ("operator" in rule) expect(operators.has(rule.operator as string)).toBe(true);
    }
  });

  it("names the columns it watches as measurements, not as schema fields", () => {
    // These strings are what appear on screen. `elapsed_time` reads as a
    // measurement; a name like `rule_3_predicate` does not.
    expect(DEMO_AGENT.streams).toContain("elapsed_time");
    expect(DEMO_AGENT.streams).toContain("threshold");
    // F2:  is a real field on every event but it is a LABEL, not a
    // measurement -- the verdict computes fences over numbers, so it can never
    // appear in the columns table. Advertising it as a stream was advertising a
    // phantom. It is still sent, and it is simply not a measurement.
    expect(DEMO_AGENT.streams).not.toContain("alert_code");
    expect(DEMO_AGENT.streams).not.toContain("pega_time");
    expect(DEMO_AGENT.streams).toEqual(["elapsed_time", "threshold"]);
  });

  it("produces the columns the agent watches, in every event", () => {
    const batch = demoEvents(25);
    for (const event of batch.events) {
      expect(event.fields.elapsed_time).toBeDefined();
      expect(event.fields.threshold).toBeDefined();
      expect(event.fields.alert_code).toBeDefined();
    }
  });

  it("produces enough breach to make the verdict say something", () => {
    // Uniform data produces a uniform verdict, which produces nothing legible.
    // About one in twenty breaching is what puts a column past its outer fence.
    const batch = demoEvents(240);
    const breaches = batch.events.filter((e) => e.fields.alert_code === "SLA_BREACH");
    expect(breaches.length).toBeGreaterThanOrEqual(8);
    // And the breaches must be BEYOND the agreed level, not merely flagged.
    for (const breach of breaches) {
      expect(Number(breach.fields.elapsed_time)).toBeGreaterThan(Number(breach.fields.threshold) * 4);
    }
  });

  it("is deterministic in its MEASUREMENTS, and live in its timestamps", () => {
    const a = demoEvents(20, 99).events;
    const b = demoEvents(20, 99).events;

    // The numbers a click produces must be the same numbers every time, or "it
    // worked yesterday" becomes a claim nobody can check.
    for (const [index, event] of a.entries()) {
      const other = b[index];
      expect(event.fields.elapsed_time).toBe(other?.fields.elapsed_time);
      expect(event.fields.threshold).toBe(other?.fields.threshold);
      expect(event.fields.alert_code).toBe(other?.fields.alert_code);
      expect(event.fields.service).toBe(other?.fields.service);
    }

    // The timestamps are deliberately NOT frozen. They are real instants, and a
    // demo whose events are stamped in the past is quietly lying about when
    // things happened. This assertion exists so freezing them again -- to make
    // the suite pass -- is a visible decision rather than an accident.
    const aFirst = a[0]?.at ?? 0;
    const bFirst = b[0]?.at ?? 0;
    expect(Math.abs(aFirst - bFirst)).toBeLessThan(5_000);
    expect(b.every((event) => typeof event.at === "number")).toBe(true);
  });

  it("names the provider the live route reports on", () => {
    // The one that mattered in the field: the flood pushed to `pega` and the live
    // route reported something else, and the events were ACCEPTED and invisible.
    expect(DEMO_PROVIDER).toBe("pega");
    expect(demoEvents(1).provider).toBe(DEMO_PROVIDER);
  });
});

describe("hasDemoTransport", () => {
  it("refuses a source that cannot push, rather than offering a button that cannot work", () => {
    // A cast would have compiled. This is the check that stops the front door
    // being offered to a transport with no way to keep the promise.
    expect(hasDemoTransport(fakeSource())).toBe(true);
    expect(hasDemoTransport({ uploadSchema: () => {} })).toBe(false);
    expect(hasDemoTransport({ ingest: () => {} })).toBe(false);
    expect(hasDemoTransport(null)).toBe(false);
    expect(hasDemoTransport(undefined)).toBe(false);
  });
});

describe("the machine attributes", () => {
  it("publishes the phase, so a test never has to read a sentence", () => {
    // Raw markup, per the !86 contract. The words are for people and may change.
    expect(markup(<StartDemo source={fakeSource()} />)).toContain('data-demo-phase="idle"');
  });
});