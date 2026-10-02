import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";

import { Conductor, type ConductorResult } from "../conductor/conductor.ts";
import { applyFeedback } from "./feedback.ts";
import { titleFor, type Purpose } from "../conductor/semantics.ts";
import { parseCsv, csvRead } from "../conductor/capabilities.ts";
import { resolveWithinRoot } from "../core/workspace.ts";
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
 * Read the file a correction applies to.
 *
 * The headers are needed because a correction names a COLUMN, and the only way
 * to know whether that column exists is to hold the header row. A structurally
 * broken file yields undefined rather than a partial table: correcting a mapping
 * against a file the parser could not read would store a role for a shape that
 * is not there.
 */
async function readCsvFor(absolute: string): Promise<CsvReadResult | undefined> {
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(absolute, "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  const parsed = parseCsv(text);
  if (parsed.problems.length > 0) return undefined;
  const rows = parsed.rows.map((cells) => Object.fromEntries(parsed.headers.map((h, i) => [h, cells[i] ?? ""])));
  return { path: absolute, headers: parsed.headers, rowCount: rows.length, columns: [], sample: rows.slice(0, 5), rows, problems: parsed.problems };
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

export function createWedgeServer(options: WedgeOptions): Server {
  const cwd = path.resolve(options.cwd);
  const installRoot = options.installRoot ?? process.cwd();

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
            live: { path: target },
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
