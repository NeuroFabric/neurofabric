import { readFileSync, writeFileSync } from "node:fs";

/** ONE-OFF. F4 second pass: the two leaks the jargon test caught. */
const P = "frontend/src/components/DynamicDashboard.tsx";
let t = readFileSync(P, "utf8");

const changes = [
  {
    from: `        <dt>version</dt>
        <dd>{agent.version}</dd>`,
    to: `        {/* Version is a build artefact. "0.0.0.dev+derived" on a customer screen
            tells a reader nothing they can act on, and it is one of the lines the
            operator read off the screen by name. Available under ?diagnostics=1. */}
        {diagnosticsEnabled() ? (
          <>
            <dt>version</dt>
            <dd><code>{agent.version}</code></dd>
          </>
        ) : null}`,
  },
  {
    from: `            fed by <code>{widget.agentId}</code>
            {widget.span === undefined ? "" : \` over \${widget.span}\`}`,
    to: `            {/* "fed by dev/sla-monitor" -- a tenant-qualified composite id, which is
                an address in our namespace rather than a thing a customer knows.
                The agent's NAME is what a reader can act on; the id stays behind
                the flag. */}
            fed by <span>{widget.agentId.split("/").pop()}</span>
            {widget.span === undefined ? "" : \` over \${widget.span}\`}`,
  },
];

for (const c of changes) {
  if (!t.includes(c.from)) throw new Error(`anchor missing: ${c.from.slice(0, 50)}`);
  t = t.replace(c.from, c.to);
}

writeFileSync(P, t);
console.log("removed the version string and the composite id from the default view");