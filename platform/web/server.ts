import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";

import { Conductor, type ConductorResult } from "../conductor/conductor.ts";
import { applyFeedback } from "./feedback.ts";
import { titleFor, type Purpose } from "../conductor/semantics.ts";
import { csvRead } from "../conductor/capabilities.ts";
import { analyseBottlenecks, type BottleneckAnalysis } from "../conductor/bottlenecks.ts";
import { resolveWithinRoot } from "../core/workspace.ts";
import { appendTurn, assertSessionId, newSessionId, readSession } from "../conductor/session-store.ts";
import type { CsvReadResult } from "../conductor/capabilities.ts";

/**
 * THE WEDGE: a governed bottleneck report behind a dropzone.
 *
 * THE ONE RULE, restated for the web. This file performs NO validation of its
 * own. It does not check that a path is inside the workspace, does not inspect
 * a filename, does not sanitise anything, and holds no list of bad inputs. Every
 * path it is given is handed verbatim to the Conductor, which drives the same
 * kernel the CLI drives, and the refusal that comes back is the kernel's refusal
 * with the kernel's own tier.
 *
 * That is not a stylistic preference. A validation rule in this file would be a
 * second control plane: it would drift from the policy, it would be invisible in
 * the event stream, and a hole in it would be a hole in the boundary that no
 * test of the kernel could see. So there is nothing here to bypass.
 *
 * AND THAT CLAIM WAS FALSE FOR ONE ROUTE, which is the most useful thing this
 * file has to say. The security sweep found that `/api/feedback` called
 * `readCsvFor(path.resolve(cwd, target))` -- a direct `readFile` with no boundary
 * check anywhere on the way to it -- so a POST could read any file on the disk
 * and apply a correction to it. The exploit was demonstrated, not theorised: the
 * red test watched the correction come back in the response body.
 *
 * The read is fixed now, and the fix is `resolveWithinRoot`: the kernel's own
 * function, called directly. It is still not a second control plane, because it
 * is not a second IMPLEMENTATION -- it is the same one the policy uses and the
 * PDF and database connectors use. Four call sites, one function.
 *
 * But the deeper lesson is the one worth keeping. This file was safe on one
 * route and unsafe on the other, and review had passed it, because the header
 * told every reader that there was nothing here to find. A documented guarantee
 * of absence is load-bearing: it changes where people look. Claiming "no
 * validation of its own" is only safe while it is true on every branch, and it
 * has to be checked on the branches a reviewer has no reason to open.
 *
 * WHAT IT DOES DO, and the reason each is here rather than in the kernel:
 *   - binds to 127.0.0.1 only, because this tool reads the user's files;
 *   - caps the request body, because the kernel's budget is not a body limit;
 *   - escapes nothing itself: the report is returned as data, and the page
 *     escapes before it renders (see `page.ts`).
 */

/**
 * What the title helper falls back to before an analysis exists.
 *
 * A `Purpose` of "unknown" is the honest default, and it is used because
 * some call sites need a title BEFORE the kernel has run: the file name is
 * known and nothing else is. Building a Purpose-shaped value rather than
 * passing undefined keeps `titleFor` total, because a helper that can be
 * called in the wrong order is a helper that eventually will be.
 */
const UNKNOWN_PURPOSE: Purpose = {
  kind: "unknown",
  statement: "This file has not been read yet.",
  confidence: "none",
  evidence: [],
  columns: [],
};

export interface WedgeOptions {
  /** The data workspace. This is the ONLY place a file may be read from. */
  cwd: string;
  /** Where `configs/default-schemas.json` lives. Defaults to the install root. */
  defaultsRoot?: string;
  /** 0 asks the OS for a free port, which is what the tests do. */
  port?: number;
  /**
   * The interface to bind. LOOPBACK BY DEFAULT, and the default is the security
   * property: this process reads the user's files, so a listener on every
   * interface turns a local tool into a remote one.
   *
   * `0.0.0.0` exists for exactly one reason -- a container. Inside a container
   * a loopback bind is unreachable from the host, because Docker's published
   * port forwards to the container's own interface rather than to its loopback,
   * so a containerised wedge appears to start and then refuses every connection.
   * The safe way out is to widen the bind INSIDE the container's network
   * namespace and keep the published port on the host's loopback, which leaves
   * the reachable surface identical to running it directly. That means this
   * option is an opt-in for a deployment that has already thought about it, and
   * it is deliberately not the default -- a default that is convenient in one
   * deployment and unsafe in another is a default that will eventually be the
   * unsafe one.
   */
  host?: string;
  /** The install root, for finding the shipped schemas. */
  installRoot?: string;
}

export interface RunningWedge {
  url: string;
  port: number;
  close: () => Promise<void>;
}

/** 8 MiB. A CSV export that does not fit in this is not a CSV export. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Read the file a route needs, THROUGH THE STREAMING READER.
 *
 * This used to be a second reader: `readFile(absolute, "utf8")` followed by
 * `parseCsv`, which meant the web layer held every byte of the export as one
 * string and then rebuilt every row as an object. On the small files the tests use
 * that is invisible. On the enterprise export this product is aimed at it is the
 * difference between serving a request and being OOM-killed by one -- and the
 * server is the worst place for that, because it is a long-lived process holding
 * the heap for every OTHER request too.
 *
 * So it delegates to `csvRead`, which streams and retains a bounded window. The
 * consolidation also removes a second implementation of the CSV rules from the
 * web layer: a parser that answers differently from the reader the rest of the
 * product uses is how a file becomes analysable by the CLI and unreadable by the
 * dashboard.
 *
 * THE CONTRACT IS UNCHANGED. Undefined means "cannot be used", for every reason:
 * unreadable, or structurally broken. Correcting a mapping against a file the
 * parser could not read would store a role for a shape that is not there.
 */
async function readCsvFor(absolute: string): Promise<CsvReadResult | undefined> {
  const csv = await csvRead({ path: absolute }).catch(() => undefined);
  if (csv === undefined) return undefined;
  if (csv.problems.length > 0) return undefined;
  return csv;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    // The page and the API are same-origin only. A response a browser will
    // happily hand to another origin is a report about someone else's
    // infrastructure, published.
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(text);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`the request body exceeds ${MAX_BODY_BYTES} bytes`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

/**
 * The Conductor run, as the response body.
 *
 * `kernelEvents` is included on every response, refusals included, because the
 * claim this product makes is that the kernel governs it. A caller that cannot
 * see the event stream cannot check that, and an uncheckable claim is a
 * decoration.
 */
function toResponse(result: ConductorResult): Record<string, unknown> {
  return {
    status: result.status,
    state: result.state,
    markdown: result.report?.markdown,
    failure: result.failure,
    questions: result.questions,
    artifacts: result.artifacts,
    schema: result.report?.schema === undefined ? undefined : {
      // `learnedRoles` lives on the SCHEMA, not on the report. Reading it off
      // the report returned undefined for every run, so the UI could never
      // show which columns came from the per-checkout archive.
      id: result.report.schema.id,
      source: result.report.schema.source,
      learnedRoles: result.report.schema.learnedRoles,
    },
    /**
     * WHAT THE FILE IS, and how sure the engine is.
     *
     * Carried in the response rather than left inside the analysis because it is
     * the first thing the interface has to say. It travels with its `evidence`
     * and its `confidence` so a client that renders it is showing the engine's
     * reasoning and its uncertainty, not a bare label it can present as fact.
     */
    purpose: result.report?.analysis.purpose,
    kernelEvents: result.kernelEvents,
    progress: result.progress,
  };
}

/** A refusal is a 403 with the kernel's tier; a bad request is a 400. */
function statusFor(result: ConductorResult): number {
  if (result.status === "DELIVERED") return 200;
  const tier = result.failure?.kernelReasonCode;
  return tier === undefined ? 400 : 403;
}

/**
 * A FILENAME SAFE TO PUT IN A HEADER.
 *
 * The basename is user data -- it came off somebody's disk -- and it is about to
 * be interpolated into a quoted header parameter. A name carrying a quote, a
 * newline or a backslash could terminate the filename early or split the header,
 * which is a response-splitting primitive wearing an innocent hat. Anything
 * outside a conservative set is replaced, so the value stays recognisable
 * without being able to escape its own quotes.
 */
function headerSafeName(target: string): string {
  const base = path.basename(target).replace(/\\.[^.]+$/, "") || "analysis";
  const safe = base.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  return `${(safe === "" ? "analysis" : safe)}-analysis.html`;
}

/**
 * BUILD THE EXPORT THROUGH THE STANDALONE GENERATOR.
 *
 * Note what is NOT passed: no `live`. That single omission is the whole safety
 * argument for this endpoint -- it produces a document with
 * `connect-src 'none'` and no composer, because the standalone page has no
 * endpoints to talk to and does not pretend otherwise.
 *
 * The transcript is rendered into the greeting's slot so the export OPENS with
 * what was discussed, rather than burying a conversation under a chart. Every
 * turn is escaped with the same function the whole page uses, because the text
 * came from a browser and the reader's browser is what parses it.
 */
async function toStandaloneExport(
  analysis: BottleneckAnalysis,
  target: string,
  learned: Readonly<Record<string, string>>,
  thread: readonly { role: string; text: string }[],
): Promise<string> {
  // Imported lazily, exactly as the dashboard route does. The module pulls in
  // the whole dashboard template, and this route is not on the hot path.
  const { toReactDashboard } = await import("./react-report.ts");
  return toReactDashboard(analysis, {
    title: `Exported analysis: ${path.basename(target)}`,
    // PROVENANCE WITHOUT LIVENESS. The export names the file it describes so the
    // recipient can see where the numbers came from. It deliberately does NOT
    // pass `live`, which is the single omission that makes this artifact safe to
    // email: no composer, no endpoint, `connect-src 'none'`. Naming a file must
    // never be the thing that turns an offline document into a live one.
    sourceName: target,
    // The conversation becomes the opening of the export. It is rendered as
    // plain escaped text -- never as markup -- because this file is going to be
    // opened by somebody with no relationship to the workspace it came from.
    learned,
    // Narrowed to the union the payload declares. The filter above has
    // already rejected anything that is not one of the two roles, but the type
    // cannot see that, and widening it back to string would be worse.
    transcript: thread.map((turn) => ({
      role: turn.role === "user" ? "user" : "agent",
      text: turn.text,
      widgets: [],
      suggestions: [],
    })),
  });
}

/**
 * The findings, worst first, in the shape the conversation router expects.
 *
 * One projection so `/api/chat` and the dashboard's embedded greeting cannot
 * disagree about what the findings ARE -- a conversation whose opening message
 * and its answer to "what is wrong with this file" describe different data is
 * worse than no conversation.
 */
function anomaliesFor(analysis: BottleneckAnalysis): {
  column: string; severity: "critical" | "warning" | "info"; kind: string; detail: string; factor: number | null;
}[] {
  const byName = new Map(analysis.numerical.columns.map((c) => [c.column, c]));
  const out: {
    column: string; severity: "critical" | "warning" | "info"; kind: string; detail: string; factor: number | null;
  }[] = [];
  for (const health of analysis.health.columns) {
    const stat = byName.get(health.column);
    const factor = (value: number | null, fence: number | null): number | null => {
      if (fence === null || fence === 0 || value === null) return null;
      const ratio = Math.abs(value / fence);
      return Number.isFinite(ratio) ? ratio : null;
    };
    if (health.outliers > 0 && health.worstValue !== null) {
      out.push({
        column: health.column, severity: "critical", kind: "extreme value",
        detail: `${Math.abs(health.worstValue).toLocaleString("en-US")} against a fence of ${Math.round(health.fence ?? 0).toLocaleString("en-US")}`,
        factor: factor(health.worstValue, health.fence),
      });
    } else if (stat?.outliers !== undefined && stat.outliers > 0 && stat.outlierMax !== null) {
      out.push({
        column: health.column, severity: "warning", kind: "marginal value",
        detail: `${stat.outliers} value(s) past the 1.5x fence, worst ${stat.outlierMax.toLocaleString("en-US")}`,
        factor: factor(stat.outlierMax, stat.fenceExtremeUpper ?? null),
      });
    }
    if (health.dirty > 0) {
      out.push({
        column: health.column, severity: "warning", kind: "type mismatch",
        detail: `${health.dirty} cell(s) hold something that is not a number${health.examples.length > 0 ? `, e.g. ${health.examples.join(", ")}` : ""}`,
        factor: null,
      });
    }
    if (health.empty > 0) {
      out.push({
        column: health.column, severity: "info", kind: "missing values",
        detail: `${health.empty} empty cell(s)`, factor: null,
      });
    }
  }
  return out;
}

export function createWedgeServer(options: WedgeOptions): Server {
  const cwd = path.resolve(options.cwd);
  const installRoot = options.installRoot ?? process.cwd();

  /**
   * THE SESSION STORE, INSIDE THE WORKSPACE.
   *
   * One directory, under the same `cwd` every other write in this server obeys,
   * so a session inherits the containment rather than inventing its own idea of
   * where it may live. The ids are constrained by the store itself (hex and
   * dashes only), so no id can name a path, and the store degrades to "no
   * memory" on every failure rather than throwing at the page.
   *
   * Nothing here is created on disk until a conversation actually happens.
   * Viewing a dashboard mints an ID and writes nothing, so opening the page
   * twenty times leaves zero files behind rather than twenty empty ones.
   */
  const sessions = path.join(cwd, "workspace", "sessions");

  return createServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
          const page = await import("./page.ts").then((m) => m.PAGE_HTML);
          response.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "content-length": Buffer.byteLength(page),
            "cache-control": "no-store",
            // The page is entirely self-contained, so it needs no external
            // origin at all. Saying so makes that a property rather than a
            // habit: a later edit that adds a CDN fails the header's intent.
            "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
            "x-content-type-options": "nosniff",
          });
          response.end(page);
          return;
        }

        if (request.method === "GET" && url.pathname === "/api/dashboard") {
          // THE LIVE DASHBOARD. The interactive artifact, served from the origin
          // that owns the correction endpoint.
          //
          // It exists because the chat needs an origin. A dashboard written to
          // disk is opened with file://, where a POST to /api/feedback has no
          // meaning and connect-src 'none' is the correct answer. So the
          // conversational view is served HERE, next to the API it talks to, and
          // the standalone file keeps its offline guarantees.
          //
          // The path is resolved by the SAME kernel function every other route
          // uses, for the same reason: a second implementation of "is this
          // inside the workspace" is a second control plane, and the lesson this
          // file already paid for is that the unguarded route is the one nobody
          // looks at.
          const target = url.searchParams.get("path");
          if (target === null || target.trim().length === 0) {
            sendJson(response, 400, {
              status: "FAILED",
              failure: { code: "BAD_REQUEST", reason: "name a file: /api/dashboard?path=<file>" },
            });
            return;
          }

          const resolved = resolveWithinRoot(cwd, target);
          if (!resolved.allowed) {
            sendJson(response, 403, {
              status: "FAILED",
              failure: {
                code: "PATH_OUTSIDE_WORKSPACE",
                reason: `path boundary violation: ${resolved.reason ?? "the file is outside the workspace"}`,
                kernelReasonCode: "PATH_OUTSIDE_WORKSPACE",
              },
            });
            return;
          }

          // The analysis comes from the kernel, through the Conductor, exactly
          // as the Markdown report's does. This route renders; it does not
          // profile. A dashboard whose numbers came from anywhere else would be
          // a second opinion wearing the engine's name.
          const conductor = new Conductor({
            cwd,
            defaultsRoot: options.defaultsRoot ?? installRoot,
            projectConfig: { policyMode: "TRUSTED_PROJECT", allowedRoots: [cwd] },
          });
          const result = await conductor.run(`bottleneck report; input=${target}`, {
            mode: "bottleneck",
            format: "markdown",
            output: path.join(cwd, "workspace", "bottleneck-report.md"),
            // ONE TITLE, FROM THE ENGINE'S OWN READING OF THE FILE.
            // titleFor names the FILE, which is always true; the purpose travels
            // separately, in the greeting, as a hypothesis with its evidence.
            title: titleFor({ fileName: path.basename(target), purpose: UNKNOWN_PURPOSE }),
          });
          if (result.status !== "DELIVERED" || result.report === undefined) {
            sendJson(response, statusFor(result), toResponse(result));
            return;
          }

          const { toReactDashboard, dashboardCsp } = await import("./react-report.ts");
          // The SAME function that builds the document's meta policy, so the
          // header and the meta tag cannot disagree. See dashboardCsp().
          const DASHBOARD_CSP = dashboardCsp(true);
          const html = toReactDashboard(result.report.analysis, {
            // The analysis EXISTS here, unlike at the `conductor.run` call above,
            // so this is the one site where the title can carry the file's actual
            // purpose rather than just its name.
            // ONE TITLE, FROM THE ENGINE'S OWN READING OF THE FILE.
            // titleFor names the FILE, which is always true; the purpose travels
            // separately, in the greeting, as a hypothesis with its evidence.
            title: titleFor({ fileName: path.basename(target), purpose: result.report.analysis.purpose }),
            // The one opt-in that widens the page. It is what lets the chat
            // reach /api/feedback, and it is scoped to this route alone.
            //
            // AND THE SESSION ID, MINTED HERE AND WRITTEN NOWHERE.
            //
            // The page has to know which conversation is its own before it has
            // asked anything, and the id is the only thing that can say so. It
            // is minted rather than read, and NOTHING is created on disk: an
            // empty session file per page view would be twenty files on the
            // twentieth refresh, all of them saying the same thing. The first
            // question asked is what makes a session exist.
            //
            // The browser keeps the id, not this server, so a reload finds the
            // conversation it already had instead of a new empty one.
            live: { path: target, sessionId: newSessionId() },
            learned: result.report.schema?.roles ?? {},
          });
          response.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "content-length": Buffer.byteLength(html),
            "cache-control": "no-store",
            // THE POLICY IS SENT AS A HEADER, NOT ONLY AS A META TAG.
            //
            // The generated document has carried its own <meta http-equiv> policy
            // since D-033, and a header is strictly better for three reasons. A
            // meta policy is only honoured if it appears before any resource the
            // page loads, so a future edit that moves it down the document
            // silently disarms it. It cannot be seen by anything inspecting a
            // response. And it cannot be tested from the server side -- which is
            // how a dashboard spent a release failing to draw its charts.
            //
            // The value is identical to the meta tag's, and a test asserts the
            // two agree, because a header and a meta tag that drift is a page
            // whose real policy is whichever one the author forgot about.
            //
            // The CDN origins are named EXPLICITLY. There is no wildcard and no
            // 'unsafe-eval': the charting library, React and Tailwind are three
            // known files, and permitting anything wider would grant every
            // script on the internet the ability to rewrite this page.
            "content-security-policy": DASHBOARD_CSP,
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
          });
          response.end(html);
          return;
        }

        if (request.method === "POST" && url.pathname === "/api/report") {
          const raw = await readBody(request);
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            // A malformed request is not a policy question and does not get a
            // policy answer; it is a 400 with a reason, before any conductor runs.
            sendJson(response, 400, {
              status: "FAILED",
              failure: { code: "BAD_REQUEST", reason: "the request body is not valid JSON" },
            });
            return;
          }
          const target = (parsed as { path?: unknown } | null)?.path;
          if (typeof target !== "string" || target.trim().length === 0) {
            sendJson(response, 400, {
              status: "FAILED",
              failure: { code: "BAD_REQUEST", reason: "no file path was supplied" },
            });
            return;
          }

          // The handoff. One call, no inspection: whatever the browser asked for
          // is what the kernel is asked to rule on.
          // THE INPUT IS NAMED, NOT PARSED OUT OF PROSE.
          //
          // The path is framed with an explicit marker so the conductor
          // receives the filename exactly as it was given. Guessing it back
          // out of a sentence silently truncated `rm -rf.csv` to `-rf.csv`, so
          // the hazard never reached the kernel and a destructive payload was
          // quietly downgraded to a missing file. Framing is not validation:
          // the kernel still rules on whatever arrives, and it still decides.
          const conductor = new Conductor({
            cwd,
            defaultsRoot: options.defaultsRoot ?? installRoot,
            projectConfig: { policyMode: "TRUSTED_PROJECT", allowedRoots: [cwd] },
          });
          const result = await conductor.run(`bottleneck report; input=${target}`, {
            mode: "bottleneck",
            format: "markdown",
            output: path.join(cwd, "workspace", "bottleneck-report.md"),
            // ONE TITLE, FROM THE ENGINE'S OWN READING OF THE FILE.
            // titleFor names the FILE, which is always true; the purpose travels
            // separately, in the greeting, as a hypothesis with its evidence.
            title: titleFor({ fileName: path.basename(target), purpose: UNKNOWN_PURPOSE }),
          });
          sendJson(response, statusFor(result), toResponse(result));
          return;
        }

        if (request.method === "POST" && url.pathname === "/api/export") {
          // ONE FILE, SOMEONE ELSE CAN OPEN.
          //
          // A POST, not the GET the shape of this feature suggested, and the
          // reason is not a preference: the CONVERSATION lives in the browser's
          // React state. A GET can carry a path; it cannot carry the transcript
          // the user is looking at, and an export that silently omitted the
          // conversation would omit the one thing this feature exists to share.
          //
          // So the browser posts its thread and the SERVER renders. That also
          // avoids a second implementation of "what an export is" living in the
          // page -- which is how this product ended up with a chart that 404ed
          // and a chat that was dead markup in the browser.
          //
          // THE ARTIFACT IS THE STANDALONE ONE. No 'live' option, so it carries
          // connect-src 'none' and NO COMPOSER. An export gets emailed and opened
          // by people with no server: a chat widget inside it would be a visible
          // control wired to endpoints that do not exist, failing silently and
          // reading as a broken product. export.test.ts asserts it.
          const raw = await readBody(request);
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            sendJson(response, 400, {
              status: "FAILED",
              failure: { code: "BAD_REQUEST", reason: "the request body is not valid JSON" },
            });
            return;
          }
          const body = (parsed as { path?: unknown; thread?: unknown } | null);
          const target = body?.path;
          if (typeof target !== "string" || target.trim().length === 0) {
            sendJson(response, 400, {
              status: "FAILED",
              failure: { code: "BAD_REQUEST", reason: "no file path was supplied, so there is nothing to export" },
            });
            return;
          }

          // The transcript is RENDERED AS TEXT, never trusted as markup. It
          // originates in a browser that typed it, but the recipient's browser is
          // what parses it, and the export may well be opened years later by
          // someone who never met the workspace boundary above.
          const thread: { role: string; text: string }[] = [];
          if (Array.isArray(body?.thread)) {
            for (const turn of body!.thread as unknown[]) {
              const t = turn as { role?: unknown; text?: unknown };
              if (t && typeof t.text === "string" && (t.role === "agent" || t.role === "user")) {
                thread.push({ role: t.role, text: t.text.slice(0, 4000) });
              }
            }
            if (thread.length > 200) thread.length = 200;
          }

          // An export endpoint that reads an arbitrary path is an exfiltration
          // endpoint with a download header on it. Same kernel function, same
          // refusal, as every other route.
          const resolvedExport = resolveWithinRoot(cwd, target);
          if (!resolvedExport.allowed) {
            sendJson(response, 403, {
              status: "FAILED",
              failure: {
                code: "PATH_OUTSIDE_WORKSPACE",
                reason: `path boundary violation: ${resolvedExport.reason ?? "the file is outside the workspace"}`,
                kernelReasonCode: "PATH_OUTSIDE_WORKSPACE",
              },
            });
            return;
          }

          const csvForExport = await readCsvFor(resolvedExport.resolvedPath as string);
          if (csvForExport === undefined) {
            // NOT exported as an empty document. An empty export reads to the
            // recipient as "your file was clean", which is the precise outcome
            // this product exists not to produce.
            sendJson(response, 400, {
              status: "FAILED",
              failure: { code: "BAD_REQUEST", reason: `the file ${path.basename(target)} could not be read` },
            });
            return;
          }

          // Already records -- see the note on `rowsForChat`. This was the same
          // double conversion, so a learned schema was silently discarded on the
          // export path too.
          const rowsForExport = csvForExport.rows;
          const { resolveSchemaMemory: resolveForExport } = await import("../conductor/schema-memory.ts");
          const schemaForExport = await resolveForExport({
            cwd, headers: csvForExport.headers, rows: rowsForExport,
            defaultsRoot: options.defaultsRoot ?? installRoot,
          });
          const analysisForExport = await analyseBottlenecks(csvForExport, schemaForExport);

          const { toReactDashboard } = await import("./react-report.ts");
          const html = await toStandaloneExport(analysisForExport, target, schemaForExport?.roles ?? {}, thread);

          response.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "content-length": Buffer.byteLength(html),
            // A filename the recipient can recognise. The basename is escaped so
            // a file called \" on disk cannot inject a quote into the header.
            "content-disposition": `attachment; filename="${headerSafeName(target)}"`,
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          });
          response.end(html);
          return;
        }

        if (request.method === "POST" && url.pathname === "/api/chat") {
          // ONE SENTENCE IN, ONE ANSWER OUT.
          //
          // The router lives HERE and not in the page, deliberately. The parser
          // was serialised into the browser because it is one small pure
          // function; the router is a module that imports the analysis types and
          // the correction parser, and a copy of it in the page would be a second
          // implementation that agrees until somebody edits one. That has already
          // happened twice in this product -- a parser in two places, a title in
          // four -- so the thing that decides what a sentence MEANS stays in one
          // file, and the tests exercise it there.
          //
          // It is also, plainly, not a language model: it is a deterministic
          // router over an analysis already computed. It declines rather than
          // improvise, and an unanswerable question comes back with NO widget,
          // because a widget is a number and there is no number to give.
          const raw = await readBody(request);
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            sendJson(response, 400, {
              status: "FAILED",
              failure: { code: "BAD_REQUEST", reason: "the request body is not valid JSON" },
            });
            return;
          }
          const chat = (parsed as { path?: unknown; message?: unknown; sessionId?: unknown } | null);
          const target = chat?.path;
          const message = chat?.message;
          if (typeof target !== "string" || target.trim().length === 0) {
            sendJson(response, 400, {
              status: "FAILED",
              failure: { code: "BAD_REQUEST", reason: "no file path was supplied" },
            });
            return;
          }
          if (typeof message !== "string") {
            sendJson(response, 400, {
              status: "FAILED",
              failure: { code: "BAD_REQUEST", reason: "no question was supplied" },
            });
            return;
          }

          // The same kernel function every other route uses. A chat endpoint that
          // reached a path by its own rules would be a second control plane, which
          // is exactly what this server's own header says it must not have.
          const resolvedChat = resolveWithinRoot(cwd, target);
          if (!resolvedChat.allowed) {
            sendJson(response, 403, {
              status: "FAILED",
              failure: {
                code: "PATH_OUTSIDE_WORKSPACE",
                reason: `path boundary violation: ${resolvedChat.reason ?? "the file is outside the workspace"}`,
                kernelReasonCode: "PATH_OUTSIDE_WORKSPACE",
              },
            });
            return;
          }

          const csvForChat = await readCsvFor(resolvedChat.resolvedPath as string);
          if (csvForChat === undefined) {
            sendJson(response, 400, {
              status: "FAILED",
              failure: { code: "BAD_REQUEST", reason: `the file ${path.basename(target)} could not be read` },
            });
            return;
          }

          // `csvForChat.rows` is ALREADY a list of records -- `readCsvFor`
          // converts the cell arrays to `{header: value}` before returning.
          //
          // This used to convert them a SECOND time, mapping over the records as
          // if they were cell arrays. Every "row" then came out as a copy of the
          // FIRST record's values, so a 200-row file reached the analyser as 200
          // identical rows and every column held exactly ONE distinct value.
          //
          // That is invisible until it destroys something: the category-role
          // check demotes a single-valued column as degenerate, so the user's
          // own correction ("channel is the category") was accepted, written to
          // disk, and then thrown away as unusable -- while the same schema
          // resolved perfectly in isolation. The data reaching the analyser was
          // the only difference.
          const rowsForChat = csvForChat.rows;
          const { resolveSchemaMemory } = await import("../conductor/schema-memory.ts");
          const { replyTo } = await import("../conductor/conversation.ts");
          const schemaForChat = await resolveSchemaMemory({
            cwd, headers: csvForChat.headers, rows: rowsForChat,
            defaultsRoot: options.defaultsRoot ?? installRoot,
          });
          const analysisForChat = await analyseBottlenecks(csvForChat, schemaForChat);

          // THE SESSION, TAKEN FROM THE RAW BODY THE BROWSER SENT.
          //
          // The id arrives with the question rather than being invented here: it
          // was minted when the page was served and the browser has been
          // carrying it since, which is the only way the SAME conversation is
          // found again after a reload. A body naming no session -- or one
          // naming an id the store cannot accept -- gets a fresh session rather
          // than a refusal, because a question must not fail on the grounds
          // that it could not be remembered.
          let sessionId = newSessionId();
          if (typeof chat?.sessionId === "string") {
            try {
              sessionId = assertSessionId(chat.sessionId);
            } catch {
              sessionId = newSessionId();
            }
          }

          // THE ANSWER, HELD RATHER THAN INLINED, because it is now written down.
          const answer = replyTo({
              source: target,
              totalRows: analysisForChat.totalRows,
              purpose: analysisForChat.purpose,
              columns: analysisForChat.numerical.columns.map((c) => ({
                name: c.column, mean: c.mean, min: c.min, max: c.max,
                measured: c.measured, dirty: c.dirty, empty: c.empty,
        // Buckets, so the agent can COUNT rather than only route.
        histogram: c.histogram,
              })),
              anomalies: anomaliesFor(analysisForChat),
              ranking: analysisForChat.categories.slice(0, 10).map((c) => ({ key: c.key, count: c.count })),
              timeline: analysisForChat.hourly.hours.map((h) => ({
                hour: h.key, count: h.count, share: h.share,
                multiple: h.multiple, spike: h.isSpike, rule: h.rule,
              })),
              learned: schemaForChat?.roles ?? {},
              // The rows, for the questions a summary cannot answer. Without
              // these the cross-column check has nothing to run on, and the
              // agent must say so rather than claim a file is clean.
              rows: rowsForChat,
            }, message);

          sendJson(response, 200, { status: "OK", sessionId: sessionId, reply: answer });

          // THE TRANSCRIPT IS WRITTEN AFTER THE RESPONSE HAS LEFT.
          //
          // Order is the point. The user already has the answer in front of
          // them; persisting it is bookkeeping, and bookkeeping that delays an
          // answer is bookkeeping somebody will eventually switch off. So the
          // response is flushed first and the two turns are written afterwards.
          //
          // BOTH turns, or the replay is a lie: a reload that restores the
          // question without its answer is worse than one that restores
          // nothing, because it reads as the engine forgetting its own reply.
          try {
            await appendTurn(sessions, sessionId, { role: "user", text: message });
            await appendTurn(sessions, sessionId, {
              role: "agent",
              text: answer.text,
              widgets: answer.widgets,
              suggestions: answer.suggestions,
            });
          } catch {
            // Swallowed on purpose, and the module's own rule says why: a memory
            // subsystem that can take the page down is worse than a user who
            // loses one conversation. The answer was already delivered.
          }
          return;
        }

        if (request.method === "GET" && url.pathname === "/api/session") {
          // THE CONVERSATION THAT ALREADY HAPPENED.
          //
          // One GET, because reading a transcript is one lookup of something
          // already written and carries nothing but an id -- there is no state
          // here to be confused by and no path for a caller to supply. The id
          // is constrained by the store rather than by anything written here,
          // which is why this route has no validation of its own to get wrong.
          //
          // A session that does not exist answers 200 with `session: null`
          // rather than a 404. "You have no conversation here yet" is the
          // normal first-load state, not an error, and a page that treats it as
          // one would open with a failure banner above an empty transcript.
          const requested = url.searchParams.get("id");
          if (requested === null || requested.trim().length === 0) {
            sendJson(response, 400, {
              status: "FAILED",
              failure: { code: "BAD_REQUEST", reason: "name a session: /api/session?id=<id>" },
            });
            return;
          }
          // The one refusal this route states for itself: an id that could
          // express a path is a BAD REQUEST, not a missing session. Both would
          // otherwise answer 200, and a caller could not tell "nothing is
          // remembered" from "you asked for something you may not have".
          try {
            assertSessionId(requested);
          } catch {
            sendJson(response, 400, {
              status: "FAILED",
              failure: { code: "BAD_SESSION_ID", reason: "a session id may only contain lowercase hex and dashes" },
            });
            return;
          }
          const record = await readSession(sessions, requested);
          sendJson(response, 200, { status: "OK", session: record ?? null });
          return;
        }

        if (request.method === "POST" && url.pathname === "/api/feedback") {
          // THE CORRECTION LOOP. The browser sends a role and a column; the
          // engine stops guessing that one and the report is regenerated so the
          // user can SEE the difference they just made.
          //
          // The file being corrected comes from the same body as the report
          // request, so a correction always applies to the file the user is
          // actually looking at. Inferring it from session state would let a
          // correction land on the wrong file, and a correction applied to the
          // wrong file is worse than no correction: it is confidently wrong.
          const raw = await readBody(request);
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            sendJson(response, 400, {
              status: "FAILED",
              failure: { code: "BAD_REQUEST", reason: "the request body is not valid JSON" },
            });
            return;
          }
          const body = (parsed as { path?: unknown; column?: unknown; role?: unknown } | null);
          const target = body?.path;
          if (typeof target !== "string" || target.trim().length === 0) {
            sendJson(response, 400, {
              status: "FAILED",
              failure: { code: "BAD_REQUEST", reason: "no file path was supplied, so there is nothing to correct" },
            });
            return;
          }

          // THE PATH IS GOVERNED BEFORE IT IS READ. This is the one place in the
          // file that resolves a path itself, and it is here because a correction
          // needs the file's HEADER ROW to know whether the column being
          // corrected exists at all -- which the Conductor does not need, and
          // which therefore cannot be borrowed from the report route.
          //
          // The resolution is the kernel's own, not a hand-rolled prefix test, so
          // a sibling directory sharing a name prefix, a `..` climb, a
          // backslash form, and a symlink out are all refused by exactly the
          // logic that governs every other read. And the refusal is a 403, the
          // same as `/api/report` returns for the same path, because the two
          // routes must not be distinguishable by whether they check.
          const resolved = resolveWithinRoot(cwd, target);
          if (!resolved.allowed) {
            sendJson(response, 403, {
              status: "FAILED",
              failure: {
                code: "PATH_OUTSIDE_WORKSPACE",
                reason: `path boundary violation: ${resolved.reason ?? "the file is outside the workspace"}`,
                kernelReasonCode: "PATH_OUTSIDE_WORKSPACE",
              },
            });
            return;
          }

          const csv = await readCsvFor(resolved.resolvedPath as string);
          if (csv === undefined) {
            sendJson(response, 400, {
              status: "FAILED",
              failure: { code: "BAD_REQUEST", reason: `the file ${path.basename(target)} could not be read` },
            });
            return;
          }

          const applied = await applyFeedback({
            cwd,
            headers: csv.headers,
            rows: csv.rows,
            column: body?.column,
            role: body?.role,
          });
          if (!applied.ok) {
            // A refusal is a 400 with the reason. It is not a policy question
            // and must not get a 403, which would tell the user the kernel
            // refused them rather than that the request was wrong.
            sendJson(response, 400, {
              status: "FAILED",
              failure: { code: "BAD_REQUEST", reason: applied.reason },
            });
            return;
          }

          // REGENERATE, so the correction is visible rather than merely stored.
          const conductor = new Conductor({
            cwd,
            defaultsRoot: options.defaultsRoot ?? installRoot,
            projectConfig: { policyMode: "TRUSTED_PROJECT", allowedRoots: [cwd] },
          });
          const result = await conductor.run(`bottleneck report; input=${target}`, {
            mode: "bottleneck",
            format: "markdown",
            output: path.join(cwd, "workspace", "bottleneck-report.md"),
            // ONE TITLE, FROM THE ENGINE'S OWN READING OF THE FILE.
            // titleFor names the FILE, which is always true; the purpose travels
            // separately, in the greeting, as a hypothesis with its evidence.
            title: titleFor({ fileName: path.basename(target), purpose: UNKNOWN_PURPOSE }),
          });
          sendJson(response, statusFor(result), { ...toResponse(result), feedback: { reason: applied.reason, roles: applied.roles ?? {} } });
          return;
        }

        sendJson(response, 404, { status: "FAILED", failure: { code: "NOT_FOUND", reason: `no route for ${request.method} ${url.pathname}` } });
      } catch (error) {
        // An unexpected throw is a 500 with the message, never a stack trace and
        // never a fabricated success.
        sendJson(response, 500, {
          status: "FAILED",
          failure: { code: "SERVER_ERROR", reason: error instanceof Error ? error.message : String(error) },
        });
      }
    })();
  });
}

export async function startWedgeServer(options: WedgeOptions): Promise<RunningWedge> {
  const server = createWedgeServer(options);
  const port = options.port ?? 0;
  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address();
  const bound = typeof address === "object" && address !== null ? address.port : port;
  return {
    url: `http://${host}:${bound}`,
    port: bound,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      // `close()` alone only stops the LISTENER. It then waits for every open
      // connection to end on its own, and the client's connection pool holds a
      // keep-alive socket open for seconds after its last response. So a close
      // that is correct can still never resolve, and a test awaiting it hangs.
      // Destroying the connections is what makes close mean close.
      server.closeAllConnections();
    }),
  };
}
