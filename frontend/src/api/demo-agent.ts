/**
 * THE DEMO AGENT. One schema, and enough synthetic traffic to make it breach.
 *
 * === WHY IT IS IN THE BUNDLE AND NOT GENERATED ON DEMAND ===
 *
 * A stranger who opens the Command Center sees an empty screen. Before this, the
 * only ways out were a terminal and a hand-built curl -- the UI could read every
 * route and push nothing at all, because the client had no ingest method. That is
 * not a bad empty state, it is a product with no front door.
 *
 * So the demo agent is a fixed, reviewable document rather than something built
 * at runtime. Three reasons:
 *
 *  1. **It is a claim, and a claim can be checked.** A fixed schema can be read,
 *     reviewed and tested. A generator is a program you trust on sight.
 *  2. **It makes the product legible.** The columns are named for what they
 *     measure -- `alert_code`, `elapsed_time`, `threshold` -- so the screen shows
 *     a *service level agreement* being missed, which is what the product is for.
 *  3. **It is deterministic.** The same click always produces the same agent.
 *
 * === WHY THE DATA IS SYNTHETIC AND SAYS SO ===
 *
 * These are not measurements. The UI renders them as real readings because they
 * ARE real readings *of a stream the user just fed the system* -- the honest
 * framing is that the number is a genuine measurement of synthetic events, not
 * that the events describe a real customer's business. The screen says "Demo
 * traffic" on the button for exactly this reason: a stranger must never be able
 * to mistake generated events for a live pipeline.
 */

/** The columns the agent watches. Named for what they measure, not for a schema. */
export const DEMO_AGENT_ID = "sla-monitor";

/** The provider both the wedge's live route and this traffic use. */
export const DEMO_PROVIDER = "pega";

/** How many events one click pushes. Enough to breach; small enough to be instant. */
export const DEMO_EVENT_COUNT = 240;

/**
 * The bundled agent, in the shape `POST /api/portal/schema` validates.
 *
 * Written against the live contract and checked by `demo-agent.test.ts`, which
 * validates it through the SAME validator the client uses. A hand-written
 * fixture that drifts from the contract is exactly how a demo ends up broken in
 * front of a customer and nobody notices until then.
 */
export const DEMO_AGENT = {
  id: DEMO_AGENT_ID,
  title: "SLA monitor",
  domain: "anomaly",
  version: "1.0.0",
  capabilities: ["Flags a breached service level", "Names the service that missed it"],
  // STREAMS ARE WHAT THE AGENT MEASURES, and a measurement must be numeric.
  // The previous list carried `pega_time` and `alert_code`, which are real
  // fields on every event but are a timestamp and a label. The verdict computes
  // fences over numbers, so neither can EVER appear in the columns table -- the
  // agent advertised two streams it could never evaluate. The operator spotted
  // this as "pega_time in the stream list" and was right: it is a phantom.
  streams: ["elapsed_time", "threshold"],
  rules: [
    {
      // The rule grammar is the REGISTRY's, not mine. The first version of this
      // file invented `column` and `factor`, both of which the validator refuses
      // as unrecognised fields -- so the demo POST would have answered 400 and
      // the front door would have been broken in exactly the situation it exists
      // for. Allowed keys are id, kind, severity, message, field, pattern, flags,
      // operator, value, windowMs, rateAbove, and operators are the six symbolic
      // ones. There is a live-curl receipt for this schema in the MR.
      id: "elapsed-beyond-threshold",
      kind: "threshold",
      severity: "critical",
      message: "Elapsed time is beyond the agreed service level",
      field: "elapsed_time",
      operator: ">",
      value: 1000,
      windowMs: 60000,
    },
  ],
} as const;

/** The services in the synthetic stream, so the top-keys panel has something real. */
const SERVICES = ["checkout", "payments", "onboarding", "claims", "dispatch", "returns"] as const;

/**
 * A small deterministic generator.
 *
 * **Deterministic MEASUREMENTS, live timestamps.** The rule is a small LCG -- not
 * for anything cryptographic, only so the numbers a click produces are the same
 * numbers every time. The `at` values and `observed_at` are deliberately NOT
 * frozen: they are real instants, and a demo whose events are stamped with a
 * past date is a demo that is quietly lying about when things happened.
 *
 * So the same click produces the same *measurements* and a different *time*, and
 * the test asserts exactly that split. An earlier version of this file claimed
 * flat determinism and the test caught it in about ten seconds.
 */
function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 48271) % 2147483647;
    return state / 2147483647;
  };
}

/**
 * Build one batch of synthetic events.
 *
 * **The shape of the data is the shape of the CLAIM.** Most events are ordinary
 * work inside their agreed service level; a small number are not, by a wide
 * margin. That produces a verdict that says something -- one column past its
 * outer fence -- rather than uniform noise that produces nothing legible.
 */
export function demoEvents(count: number = DEMO_EVENT_COUNT, seed = 20261004): { provider: string; events: { fields: Record<string, string>; at: number }[] } {
  const next = lcg(seed);
  const base = Date.now();
  const events: { fields: Record<string, string>; at: number }[] = [];

  for (let i = 0; i < count; i += 1) {
    const service = SERVICES[i % SERVICES.length] ?? "checkout";
    // Roughly one in twenty breaches, and by a lot: a fence is only meaningful if
    // something actually crosses it.
    const breaching = i % 20 === 0;
    const agreed = 400 + Math.floor(next() * 300);
    const elapsed = breaching ? agreed * (6 + Math.floor(next() * 8)) : Math.floor(agreed * (0.3 + next() * 0.6));

    events.push({
      at: base - (count - i) * 50,
      fields: {
        service,
        // The columns the agent watches, named for what they measure.
        elapsed_time: String(elapsed),
        threshold: String(agreed),
        alert_code: breaching ? "SLA_BREACH" : "OK",
        // Renamed from `pega_time`, which was the platform's name for this field
        // and means nothing to a person reading the agent.
        observed_at: new Date(base - (count - i) * 50).toISOString(),
      },
    });
  }

  return { provider: DEMO_PROVIDER, events };
}