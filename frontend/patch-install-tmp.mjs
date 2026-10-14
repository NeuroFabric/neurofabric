import { readFileSync, writeFileSync } from "node:fs";

/** ONE-OFF. Replaces the read-only form table with the real install form. */
const P = "src/components/DynamicDashboard.tsx";
const t = readFileSync(P, "utf8");

const start = t.indexOf("      {config.forms.length === 0 ? null : (");
const end = t.indexOf("    </section>", start);
if (start < 0 || end < 0) throw new Error("markers not found");

const lines = [
  "      {/* THE REAL FORM.",
  "          *",
  "          * This rendered a TABLE describing the portal's declared form -- field,",
  "          * label, type, required -- and called it a form. There was no input and no",
  "          * path to POST /api/portal/schema from the UI at all, so installing an",
  "          * agent was something a person did with curl while the screen described",
  "          * the paperwork.",
  "          *",
  "          * Now it is the loop: type, submit, appear, selectable, rules loaded. See",
  "          * InstallAgentForm.tsx for what is asked and what is supplied. */}",
  "      {config.forms.length === 0 || install === undefined ? null : (",
  "        <>",
  "          <h3>Add an agent</h3>",
  "          {config.forms.map((form) => (",
  "            <InstallAgentForm key={form.id} form={form} source={install} onInstalled={onInstalled} />",
  "          ))}",
  "        </>",
  "      )}",
  "",
  "",
].join("\n");

let next = t.slice(0, start) + lines + t.slice(end);

next = next.replace(
  "  readonly diagnostics?: boolean | undefined;",
  [
    "  readonly diagnostics?: boolean | undefined;",
    "  /** The transport for installing an agent. Omitted means no form is offered. */",
    "  readonly install?: InstallSource | undefined;",
    "  /** Called after a successful install, so the caller can select and load it. */",
    "  readonly onInstalled?: ((agentId: string) => void) | undefined;",
  ].join("\n"),
);

next = next.replace(
  "export function DynamicDashboard({ config, readings = [], diagnostics }: DynamicDashboardProps): ReactElement {",
  "export function DynamicDashboard({ config, readings = [], diagnostics, install, onInstalled }: DynamicDashboardProps): ReactElement {",
);

next = next.replace(
  'import { diagnosticsEnabledHere } from "../diagnostics-flag";',
  'import { diagnosticsEnabledHere } from "../diagnostics-flag";\nimport { InstallAgentForm, type InstallSource } from "./InstallAgentForm";',
);

writeFileSync(P, next);
console.log("wired the real install form");