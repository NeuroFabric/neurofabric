import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";

import { Conductor, type ConductorResult } from "../conductor/conductor.ts";

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
 * WHAT IT DOES DO, and the reason each is here rather than in the kernel:
 *   - binds to 127.0.0.1 only, because this tool reads the user's files;
 *   - caps the request body, because the kernel's budget is not a body limit;
 *   - escapes nothing itself: the report is returned as data, and the page
 *     escapes before it renders (see `page.ts`).
 */

export interface WedgeOptions {
  /** The data workspace. This is the ONLY place a file may be read from. */
  cwd: string;
  /** Where `configs/default-schemas.json` lives. Defaults to the install root. */
  defaultsRoot?: string;
  /** 0 asks the OS for a free port, which is what the tests do. */
  port?: number;
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
          const conductor = new Conductor({
            cwd,
            defaultsRoot: options.defaultsRoot ?? installRoot,
            projectConfig: { policyMode: "TRUSTED_PROJECT", allowedRoots: [cwd] },
          });
          const result = await conductor.run(`bottleneck report for ${target}`, {
            mode: "bottleneck",
            format: "markdown",
            output: path.join(cwd, "workspace", "bottleneck-report.md"),
            title: `Bottleneck report: ${path.basename(target)}`,
          });
          sendJson(response, statusFor(result), toResponse(result));
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
  await new Promise<void>((resolve, reject) => {
    // 127.0.0.1, never 0.0.0.0. This process can read the user's files; a
    // listener on every interface turns a local tool into a remote one.
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const bound = typeof address === "object" && address !== null ? address.port : port;
  return {
    url: `http://127.0.0.1:${bound}`,
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
