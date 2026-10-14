import { readFileSync, writeFileSync } from "node:fs";

const FILE = "platform/web/server.ts";
let src = readFileSync(FILE, "utf8");
const before = src;

const anchor = '        if (request.method === "POST" && url.pathname === "/api/chat") {';
if (!src.includes(anchor)) throw new Error("chat route anchor not found");

const route = `        if (request.method === "POST" && url.pathname === "/api/export") {
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
                reason: \`path boundary violation: \${resolvedExport.reason ?? "the file is outside the workspace"}\`,
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
              failure: { code: "BAD_REQUEST", reason: \`the file \${path.basename(target)} could not be read\` },
            });
            return;
          }

          const rowsForExport = csvForExport.rows.map((cells) =>
            Object.fromEntries(csvForExport.headers.map((h, i) => [h, cells[i] ?? ""])));
          const { resolveSchemaMemory: resolveForExport } = await import("../conductor/schema-memory.ts");
          const schemaForExport = await resolveForExport({
            cwd, headers: csvForExport.headers, rows: rowsForExport,
            defaultsRoot: options.defaultsRoot ?? installRoot,
          });
          const analysisForExport = analyseBottlenecks(csvForExport, schemaForExport);

          const { toReactDashboard } = await import("./react-report.ts");
          const html = toStandaloneExport(analysisForExport, target, schemaForExport?.roles ?? {}, thread);

          response.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "content-length": Buffer.byteLength(html),
            // A filename the recipient can recognise. The basename is escaped so
            // a file called \\" on disk cannot inject a quote into the header.
            "content-disposition": \`attachment; filename="\${headerSafeName(target)}"\`,
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          });
          response.end(html);
          return;
        }

`;

src = src.replace(anchor, route + anchor);

// The helpers the route calls.
const helperAnchor = "/**\n * The findings, worst first, in the shape the conversation router expects.";
if (!src.includes(helperAnchor)) throw new Error("helper anchor not found");

src = src.replace(helperAnchor, `/**
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
  const base = path.basename(target).replace(/\\\\.[^.]+$/, "") || "analysis";
  const safe = base.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  return \`\${(safe === "" ? "analysis" : safe)}-analysis.html\`;
}

/**
 * BUILD THE EXPORT THROUGH THE STANDALONE GENERATOR.
 *
 * Note what is NOT passed: no \`live\`. That single omission is the whole safety
 * argument for this endpoint -- it produces a document with
 * \`connect-src 'none'\` and no composer, because the standalone page has no
 * endpoints to talk to and does not pretend otherwise.
 *
 * The transcript is rendered into the greeting's slot so the export OPENS with
 * what was discussed, rather than burying a conversation under a chart. Every
 * turn is escaped with the same function the whole page uses, because the text
 * came from a browser and the reader's browser is what parses it.
 */
function toStandaloneExport(
  analysis: BottleneckAnalysis,
  target: string,
  learned: Readonly<Record<string, string>>,
  thread: readonly { role: string; text: string }[],
): string {
  const { toReactDashboard } = toReactDashboardRef;
  return toReactDashboard(analysis, {
    title: \`Exported analysis: \${path.basename(target)}\`,
    // The conversation becomes the opening of the export. It is rendered as
    // plain escaped text -- never as markup -- because this file is going to be
    // opened by somebody with no relationship to the workspace it came from.
    learned,
    transcript: thread.map((turn) => ({
      role: turn.role,
      text: turn.text,
      widgets: [],
      suggestions: [],
    })),
  });
}

${helperAnchor}`);

if (src === before) throw new Error("nothing changed");
writeFileSync(FILE, src, "utf8");
console.log("export route and helpers added");