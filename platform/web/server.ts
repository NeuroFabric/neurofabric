import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";

export class CircuitBreakerError extends Error {
  constructor(message = 'Task execution halted: maximum iteration threshold exceeded.') {
    super(message);
    this.name = 'CircuitBreakerError';
  }
}

const MAX_ITERATIONS = 3;
const taskIterationMap = new Map<string, number>();
// ioredis ships as CJS; under node16/nodenext resolution the constructable
// value is the module default, reached through a namespace import.
import * as RedisNamespace from "ioredis";
const RedisClient = (RedisNamespace as unknown as { default: new (url: string, opts?: Record<string, unknown>) => any }).default;
const redis = new RedisClient(process.env.REDIS_URL || 'redis://localhost:6379', {
  lazyConnect: true,
});

import { Conductor, type ConductorResult } from "../conductor/conductor.ts";
import { applyFeedback } from "./feedback.ts";
import { titleFor, type Purpose } from "../conductor/semantics.ts";
import { csvRead } from "../conductor/capabilities.ts";
import { analyseBottlenecks, type BottleneckAnalysis } from "../conductor/bottlenecks.ts";
import { createPortalRoutes, InMemoryPortalStore, type PortalRouter } from "../api/portal-routes.ts";
import { createEvaluationScheduler } from "../omniroute/evaluation-scheduler.ts";
import { createMemoryRoutes, MEMORY_ALERTS_PATH, type MemoryRouter } from "../memory/memory-routes.ts";
import { validateSchema, type AgentSchema } from "../swarm/dynamic-registry.ts";
import { buildAlertPayload } from "../egress/webhook-dispatcher.ts";
import { createAlertHub, frame, type AlertHub } from "../memory/alert-hub.ts";
import type { MemoryStore } from "../memory/store.ts";
import type { SwarmAlert } from "../omniroute/omniroute-gateway.ts";
import { environmentVault, type VaultProvider } from "../omniroute/edge-security.ts";
import { OmniRouteGateway } from "../omniroute/omniroute-gateway.ts";
import { DynamicAgentRegistry } from "../swarm/dynamic-registry.ts";
import { resolveWithinRoot } from "../core/workspace.ts";
import { appendTurn, assertSessionId, newSessionId, readSession } from "../conductor/session-store.ts";
import type { CsvReadResult } from "../conductor/capabilities.ts";
import { RemediationService } from "../remediation/remediation-gate.ts";
import { createAsyncApprovalGate } from "../embassy/async-approval.ts";
import { mkdirSync, readdirSync, readFile } from "node:fs";

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
   * THE SHARED ALERT HUB.
   *
   * Passed to the memory routes so an SSE subscriber and the async HITL verdict
   * broadcaster are talking to ONE set of subscribers. Omitted, the routes build
   * their own and verdicts published elsewhere in the process are invisible to
   * them -- which presents as a verdict nobody ever received.
   *
   * Only helps WITHIN THIS PROCESS. See `createAlertHub` for the boundary.
   */
  hub?: AlertHub;
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
  /**
   * The install root, for finding the shipped schemas. */
  installRoot?: string;
  /**
   * WHERE THE PORTAL API READS ITS CREDENTIALS FROM.
   *
   * Defaults to the environment provisioner, which reads one JSON array from
   * `NEUROFEBRIC_GATEWAY_TOKENS`. Injectable so a test can present a known
   * credential without touching the environment, and so a deployment that mints
   * its own can hand the result to the same call site.
   *
   * Empty is not a default: an unset variable yields NO tokens, so with nothing
   * provisioned every portal route answers 401. That is the correct answer --
   * a portal surface nobody is admitted to serves nobody -- and it is why the
   * frontend shows a sign-in fault rather than an empty dashboard.
   */
  portalVault?: VaultProvider;
  /**
   * PROVIDERS THE LIVE GATEWAY ACCEPTS, and the one the portal reports on.
   *
   * Default `["pega", "webhook"]`. The names are door labels, not configuration
   * a caller chooses freely: the ingest route refuses an unknown provider, so
   * this list is the whole ingress surface and it is fixed at boot rather than
   * being taken from a request. A provider named by a caller must be a provider
   * this process connected first, or the boundary is the caller's to choose.
   */
  liveProviders?: readonly string[];
  /**
   * HOW OFTEN THE EVALUATION LOOP RUNS, in millis.
   *
   * Present because the right answer depends on what is being watched, and this
   * platform does not get to guess it: a stream breaching in seconds and a
   * warehouse landing in hours do not want the same cadence. The default is the
   * value this product is tuned for, and setting it here is how a deployment
   * overrules that without editing code.
   *
   * The loop is armed whatever this is set to, so a deployment cannot end up
   * with no evaluation at all by omitting it. There is deliberately no way to
   * disable it here: a monitor that can be switched off by a config key is a
   * monitor whose silence is indistinguishable from health.
   */
  evaluationIntervalMs?: number;
  /**
   * THE DURABLE RECORD, WHEN THIS PROCESS HAS ONE OPEN.
   *
   * Optional because the wedge is started by more than one caller and a caller
   * with no record has nothing to reconcile -- a test over the report routes, for
   * instance. It is optional at the TYPE level and it is honest at RUNTIME: with
   * no store, `/api/memory/*` is not mounted at all and answers 404, rather than
   * answering 200 with an empty diff that reads as "your record agrees with
   * everything". **A surface that reports agreement it did not check is worse
   * than a surface that is absent**, and that is the whole reason this is a
   * union rather than a nullable field that quietly defaults.
   */
  memory?: {
    readonly store: MemoryStore;
    /**
     * WHICH TENANT THE LIVE PATH BELONGS TO.
     *
     * **REQUIRED to record a decision, and absent means decisions are not
     * recorded.** A verdict is namespaced by `tokenId` (ADR-005 §10.1), the live
     * gateway carries no tenant of its own, and the boot process has no
     * credential. So somebody has to say which tenant a breach belongs to, and
     * every alternative was rejected:
     *
     *  - a sentinel like `"local"` writes rows under a tenant no credential can
     *    ever authenticate as, so they are invisible to every read forever;
     *  - taking the first of several provisioned tokens picks one at random and
     *    attributes another customer's breach to them.
     *
     * So it is declared, and `start-ui.mjs` resolves it from the vault and says
     * so on the boot line. No tenant, no recording -- stated, not silent.
     */
    readonly tenant?: string;
    /**
     * Newest live reading per composite agent id. Computed by the CALLER because
     * only the caller knows which of its ingresses a producer actually used --
     * see the honesty note in `createWedgeServer`.
     */
    readonly latest?: () => Readonly<Record<string, number>>;
  };
}

export interface RunningWedge {
  url: string;
  port: number;
  close: () => Promise<void>;
}

/** 8 MiB. A CSV export that does not fit in this is not a CSV export. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * HOW OFTEN THE EVALUATION LOOP RUNS, when the deployment does not say.
 *
 * Five seconds is chosen against the thing it must not do: the alert policy
 * refuses to write anything for a healthy reading, so a tick over a quiet stream
 * costs one in-memory pass and no I/O. The cost only appears on a first
 * observation, where the record is persisted synchronously. That makes the
 * interval a trade between noticing a breach promptly and paying a blocking
 * write more often than once -- and since the loop refuses to re-enter while a
 * tick is running, a slow tick is skipped rather than stacked.
 */
const DEFAULT_EVALUATION_INTERVAL_MS = 5_000;

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

/** Convert the ledger's epoch-second timestamps to ISO, while tolerating legacy ISO rows. */
function ledgerTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;

  let milliseconds: number;
  if (typeof value === "number" && Number.isFinite(value)) {
    milliseconds = value * 1000;
  } else if (typeof value === "string" && value.trim() !== "") {
    const numeric = Number(value);
    milliseconds = Number.isFinite(numeric) ? numeric * 1000 : Date.parse(value);
  } else {
    return null;
  }

  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
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
  const analysis = result.report?.analysis;
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
    purpose: analysis?.purpose,
    ...(analysis === undefined ? {} : {
      // Structured, bounded findings let the UI render evidence-based remediation
      // without re-parsing a file or inventing chart samples in the browser.
      analysis: {
        totalRows: analysis.totalRows,
        errorRows: analysis.errorRows,
        errorRate: analysis.errorRate,
        problems: Array.isArray(analysis.problems) ? analysis.problems.slice(0, 50) : [],
        mappings: Array.isArray(analysis.mappings) ? analysis.mappings.slice(0, 32) : [],
        byHour: Array.isArray(analysis.byHour)
          ? analysis.byHour.slice(0, 500).map(({ key, count, errorCount, errorRate }) => ({ key, count, errorCount, errorRate }))
          : [],
        latencyBands: Array.isArray(analysis.latency)
          ? analysis.latency.slice(0, 32).map(({ label, count }) => ({ label, count }))
          : [],
        categories: Array.isArray(analysis.categories)
          ? analysis.categories.slice(0, 50).map(({ key, count, p95Elapsed }) => ({ key, count, p95Elapsed }))
          : [],
      },
    }),
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

  /**
   * THE PORTAL API, MOUNTED ONCE PER SERVER INSTANCE.
   *
   * Built here, outside the request handler, and that placement is the whole
   * point. The registry is the store of registered agents: build one per request
   * and every `POST /api/portal/schema` installs into a registry that is
   * discarded the moment the response is written, so the write route would answer
   * 200 and the next read would see nothing. A 200 that installs nothing is
   * worse than an error, because it is a success the caller has to disbelieve.
   *
   * The registry starts EMPTY, and that is not an oversight to be papered over.
   * `configs/default-schemas.json` is not a source for it: that file describes
   * core diagnostics in a `match`/`allOf` shape, while `AgentSchema` wants
   * `rules`/`capabilities`/`streams`. Feeding one to the other would be refused
   * by `validateSchema` for every entry. So agents arrive through
   * `POST /api/portal/schema`, and until one does, `GET /api/portal/config`
   * honestly reports a derived portal with nothing in it.
   *
   * Nothing else about the wedge changes. Same containment, same loopback
   * default, same body ceiling, and the portal routes are reached only after the
   * same `resolveWithinRoot` boundary as every other path that reads a file.
   */
  const sandboxRoot = path.join(cwd, "gate-data", "patches");
  mkdirSync(sandboxRoot, { recursive: true });
  const gate = createAsyncApprovalGate({ audit: () => undefined });
  const remediation = new RemediationService({ gate, sandboxRoot, tenant: options.memory?.tenant ?? "default" });

  const registry = new DynamicAgentRegistry();

  /**
   * THE LIVE GATEWAY. ONE PER SERVER PROCESS, AND IT HAS TO BE.
   *
   * The gateway is the store of in-flight telemetry AND of the counters the
   * dashboard reads. Built per request, a push would land in a broker discarded
   * when the response was written, and every read would report "no data" forever
   * -- the same failure `DynamicAgentRegistry` had when the routes were first
   * mounted, and the reason the singleton shape is repeated here on purpose.
   *
   * It is created even when no credential is provisioned. Empty tokens means the
   * gateway admits nothing, which is the safe direction: an ingress that admits
   * by default is an ingress nobody notices is open until someone reads a log.
   */
  /**
   * THE TENANT THE LIVE PATH BELONGS TO.
   *
   * Read from the option and nothing else. This factory is synchronous and stays
   * that way -- an earlier version read the vault here with `await`, which would
   * have made the whole server factory async and pushed the change onto every
   * test that builds one. **The boot script resolves the tenant and passes it**,
   * because the boot script is a person-facing process that already prints what
   * it decided, and a decision that cannot be printed should not be made inside a
   * factory.
   *
   * Absent means decisions are NOT recorded, and `/api/memory/alerts` has no
   * tenant to scope a subscription to. Stated on the boot line rather than
   * silently skipped.
   */
  const liveTenant = options.memory?.tenant;

  /**
   * THE ROUTES, REFERENCED BEFORE THEY EXIST.
   *
   * `onDecision` needs the hub to publish into, and the hub is owned by the
   * routes -- but the routes need the gateway for the live half of a diff. So
   * the dependency is genuinely circular, and this is the smallest honest way to
   * express it: a name the decision path reads at CALL time, assigned once the
   * routes exist.
   *
   * The alternative -- publishing from a gateway subscriber instead -- would
   * avoid the reference and be worse, because it would spread "record, then
   * publish" across two registration points where a later edit could move them
   * apart. Keeping both halves in one function body is the point.
   */
  let routes: MemoryRouter | undefined;

  const gateway = new OmniRouteGateway({
    /**
     * THE DECISION PATH. The verdict, the alert and the audit trace, in ONE
     * transaction, before anyone is told -- which is the whole of ADR-005 §7.1
     * expressed as a call.
     *
     * Attached only when both a record AND a tenant exist. `node:sqlite` is
     * synchronous, so this blocks the event loop, and the boundary exists to pay
     * that cost for facts that change what a person does next. A breach qualifies.
     * A healthy reading is not written at all.
     */
    ...(options.memory === undefined || liveTenant === undefined
      ? {}
      : {
          onDecision: (alert: SwarmAlert) => {
            /**
             * THE PAYLOAD THE WEBHOOK ALREADY SENDS, reused.
             *
             * Not a convenience. `buildAlertPayload` is where this platform's
             * severity policy LIVES -- "critical" means every partition breached,
             * and the reason is that attaching it to a single sick replica is how
             * an on-call rotation learns to ignore the word. It also produces the
             * deterministic alert id, which makes a redelivery after a timeout the
             * SAME incident instead of a new one.
             *
             * So the record and the webhook say the same thing about the same
             * event by construction. A second severity function here would be a
             * second policy free to disagree with the first, and the one that
             * disagrees is the one an operator reads at 3am.
             */
            const payload = buildAlertPayload(alert);
            options.memory?.store.recordDecision({
              tenant: liveTenant,
              agentId: `${liveTenant}/${alert.provider}`,
              verdict: {
                at: alert.at,
                provider: alert.provider,
                records: alert.verdict.records,
                breached: payload.summary.breachedColumns,
                document: {
                  open: payload.summary.open,
                  partitions: payload.summary.partitions,
                  columns: payload.columns,
                  busiestHour: alert.verdict.busiestHour,
                  topKeys: alert.verdict.topKeys,
                },
              },
              alert: {
                // The SAME id the webhook carries, so a receiver and the record
                // can be joined on it without a second naming scheme.
                id: payload.id,
                severity: payload.severity,
                document: { title: payload.title, body: payload.body, firstObservation: alert.firstObservation },
              },
              audit: {
                actor: "system",
                action: "raise-alert",
                document: { provider: alert.provider, firstObservation: alert.firstObservation },
              },
            });

            /**
             * AND ONLY NOW, THE NOTIFICATION. This is ADR-005 §5 rule 3 in one
             * ordering: the alert is durable before anybody is told.
             *
             * **STRICTLY AFTER `recordDecision`, AND THE THROW PROPAGATES.** If
             * the write above throws, this line is never reached -- which is the
             * whole point. A subscriber that pushed first and wrote afterwards
             * would put an alert on a screen with nothing behind it, which §7.3
             * classifies as corruption rather than as a difference.
             *
             * The frame carries the SAME id the record stored, so a consumer that
             * reconnects with `Last-Event-ID` can tell what it already has.
             */
            routes?.hub.publish(
              liveTenant,
              frame(payload.id, "alert", {
                id: payload.id,
                title: payload.title,
                body: payload.body,
                severity: payload.severity,
                source: payload.source,
                at: payload.at,
                summary: payload.summary,
                columns: payload.columns,
              }),
            );
          },
        }),
  });
  const liveProviders = options.liveProviders ?? ["pega", "webhook"];
  const bindings = new Map<string, boolean>();
  for (const name of liveProviders) {
    gateway.connect({ name, keyColumn: "service", timeColumn: "pega_time" });
    bindings.set(name, true);
  }
  const liveProvider = liveProviders[0] ?? "pega";

  /**
   * THE EVALUATION LOOP, ARMED HERE BECAUSE THIS IS WHERE IT BELONGS.
   *
   * Evaluation used to be reachable only through a portal read, so the alert
   * policy -- and therefore `onDecision`, the durable record write and the SSE
   * publish -- ran when somebody asked how a stream was doing. The read route no
   * longer decides anything, so this is what makes the whole decision path
   * reachable: a deployment with no dashboard open still evaluates, records and
   * publishes, which is the only version of a monitor that is not a dashboard
   * with a stopwatch.
   *
   * It is started HERE, at the composition root, and nowhere else. Nothing below
   * this point constructs one, so there is no path to a live interval that did
   * not go through this one -- which is the failure mode that hung this
   * repository before, when a timer was created in the server factory and became
   * a handle outliving its owner in every test that built a server.
   *
   * The providers are resolved PER TICK rather than captured, so a provider bound
   * after boot is still evaluated. Resolving once here would work today -- the
   * bindings are filled just above -- and would quietly stop working the first
   * time a provider is attached at runtime, which is exactly the kind of
   * regression that reports a healthy zero breaches forever.
   *
   * A failure inside a tick is contained and counted by the scheduler, and the
   * interval is unref'd, so neither a locked database nor this loop can be the
   * reason the process stays up. Stopping on close is tidiness; the loop is not
   * what holds anything open.
   */
  const evaluation = createEvaluationScheduler({
    gateway,
    providers: () => [...bindings.keys()],
    intervalMs: options.evaluationIntervalMs ?? DEFAULT_EVALUATION_INTERVAL_MS,
    onError: (error, context) => {
      // Reported where a boot-time failure would be seen, and counted by the
      // scheduler so a degraded loop can be asked about it later. A monitor that
      // fails silently is worse than one that never started, because it looks
      // healthy while it misses every breach.
      const reason = error instanceof Error ? error.message : String(error);
      const subject = context.provider ?? "the provider list";
      console.error(`[evaluation] ${subject} could not be evaluated: ${reason}`);
    },
  });

  /**
   * THE NEWEST EVENT TIME PER PROVIDER. Bounded by the provider list, which is
   * fixed at boot, so it cannot grow without limit.
   */
  const liveNewest = new Map<string, number>();

  const portalRoutes: PortalRouter = createPortalRoutes({
    registry,
    store: new InMemoryPortalStore(),
    vault: options.portalVault ?? environmentVault(),
    /**
     * THE RECORD HEARS ABOUT AN INSTALLED AGENT.
     *
     * This is the only path by which the durable record gains content in this
     * process, and it is deliberately narrow: schemas and nothing else. A verdict
     * is written at decision time by the alert path (ADR-005 §7.1), NOT here --
     * a portal read must never block on a synchronous write, because the record's
     * cost model only pays for facts that change what a person does next, and an
     * agent appearing on a screen is not one of them.
     */
    ...(options.memory === undefined
      ? {}
      : {
          onSchemaRegistered: (tenant: string, schema: AgentSchema) => {
            options.memory?.store.putSchema(tenant, schema.id, schema.version, schema, Date.now());
          },
        }),
    live: {
      verdict: (provider) => gateway.verdict(provider),
      /**
       * NO `evaluate` HERE, AND THE ABSENCE IS THE POINT.
       *
       * This member used to forward the alert policy, and it was the only thing
       * making `onDecision` -- and therefore `recordDecision` and the SSE publish
       * -- reachable: before it existed the record was wired, the ordering was
       * proved, and nothing ever asked for an alert, so a write boundary that is
       * never entered is indistinguishable from no boundary.
       *
       * That is now the scheduler's job, and removing the member here is what
       * makes the read path provably read-only rather than merely intended to
       * be. The type still permits it, because the portal route is also a usable
       * schema surface with no stream attached -- so instead of trusting the
       * absence, `portal-routes.test.ts` counts the decisions a read causes and
       * pins that it causes none. A seam with a test on it does not need the
       * caller to be trusted.
       */
      push: (provider, event) => {
        // THE NEWEST LIVE READING, TAKEN AT THE INGRESS.
        //
        // It is recorded here rather than derived from the gateway because the
        // gateway answers "how many records are in the window", which is a COUNT
        // and not a TIME -- and the whole point of difference 2 and difference 5
        // is WHEN. The gap matters: an event with no `at` falls back to the
        // arrival time and says so, rather than being dropped, because a missing
        // timestamp is a fact about the producer and not a reason to lose the
        // reading entirely.
        const at = typeof event.at === "number" ? event.at : Date.now();
        const previous = liveNewest.get(provider);
        if (previous === undefined || at > previous) liveNewest.set(provider, at);
        gateway.push(provider, event);
      },
      connected: (provider) => bindings.has(provider),
    },
    liveProvider,
  });

  /**
   * THE LIVE HALF OF THE DIFF, DERIVED HONESTLY OR NOT AT ALL.
   *
   * Two conditions, both required, and each one is there to stop a fabricated
   * "live reading":
   *
   *  - the gateway must hold records, so an empty window produces NO entry rather
   *    than an entry timestamped now. This is what makes difference 2 ("no live
   *    window yet") reachable at all -- substituting "now" for a missing reading
   *    would make that difference impossible to ever see, which is the failure
   *    mode a fabricated timestamp creates everywhere it appears.
   *  - an event must actually have arrived, because a verdict can exist from a
   *    drain that happened before this process saw the event.
   *
   * **AND THE ATTRIBUTION IS COARSE, WHICH IS STATED RATHER THAN HIDDEN.** The
   * newest reading is attributed to every registered agent because the wedge's
   * live path is not tenant-routed: `push` carries no tenant, so there is nothing
   * here that could attribute an event to one agent rather than another. That
   * makes the reading "something live arrived recently", not "this agent produced
   * a reading at this instant" -- so it is fit for differences 2 and 5, which ask
   * whether the window is empty and whether history is ahead, and it is NOT fit
   * for attributing a number to an agent. A caller with real attribution passes
   * `memory.latest` and this default is not used.
   */
  const defaultLatest = (): Readonly<Record<string, number>> => {
    const verdict = gateway.verdict(liveProvider);
    if (verdict === undefined || verdict.records === 0) return {};
    const newest = liveNewest.get(liveProvider);
    if (newest === undefined) return {};
    const out: Record<string, number> = {};
    for (const agent of registry.describeAll()) out[agent.id] = newest;
    return out;
  };

  /**
   * THE DIFF ROUTES, MOUNTED ONLY WHEN A RECORD IS OPEN.
   *
   * `validateSchema` is passed as the CURRENT validator so a grammar that
   * tightened after an agent was written is difference 1 -- an expected
   * disagreement the operator resolves -- rather than corruption. That distinction
   * is the difference between a list somebody reads and an alarm somebody
   * skims past, so the function is wired here rather than left undefined, which
   * would have silently disabled difference 1 for every deployment.
   */
  const memoryRoutes: MemoryRouter | undefined =
    options.memory === undefined
      ? undefined
      : createMemoryRoutes({
          store: options.memory.store,
          live: {
            providers: liveProviders,
            latest: options.memory.latest ?? defaultLatest,
            accepts: (document) => validateSchema(document).ok,
          },
          vault: options.portalVault ?? environmentVault(),
          ...(options.hub === undefined ? {} : { hub: options.hub }),
        });
  // The reference the decision path reads, now that it exists. Assigned once, at
  // boot, and never reassigned -- so there is one hub for the life of the process
  // rather than one per request.
  routes = memoryRoutes;

  const server = createServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");

        /**
         * THE DASHBOARD GATE, BEFORE ANY PROTECTED HANDLER.
         *
         * Exclusive to `/`, `/index.html` and `/api/dashboard`. A missing,
         * expired, or role-less token is answered here and the handler never
         * runs. Report, chat, feedback and portal routes keep their own gates.
         */
        if (isProtectedUiPath(url.pathname)) {
          if (enforceIncidentCommander(request, response)) return;
        }

        /**
         * THE EVENT STREAM, BEFORE THE GENERAL MEMORY BRANCH.
         *
         * Order matters and the reason is narrow: the branch below matches every
         * `/api/memory/*` path, so a stream routed through it would be answered
         * with a JSON 404 -- the stream would "work" and deliver nothing, which
         * is the `a 200 that installs nothing` shape in its purest form.
         *
         * It cannot go through `handle` at all, which answers with a body and
         * returns: a stream has no body to return and its promise never settles.
         *
         * **THE STREAM OWNS THE SOCKET FROM HERE.** When `openStream` returns
         * true it has already written headers and will write until it closes, so
         * nothing after this call may touch `response`. The branch returns in both
         * cases: `false` means a refusal was already written, `true` means the
         * response belongs to the stream.
         */
        if (memoryRoutes !== undefined && url.pathname === MEMORY_ALERTS_PATH) {
          const streamHeaders: Record<string, string | undefined> = {};
          for (const [name, value] of Object.entries(request.headers)) {
            streamHeaders[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
          }
          await memoryRoutes.openStream(request.method ?? "GET", url.pathname, streamHeaders, response, request);
          return;
        }

        /**
         * THE DIFF SURFACE, BEFORE ANY PORTAL ROUTE.
         *
         * Delegated first so `/api/memory/*` can never fall through to a route
         * written for a different verb, and so a 404 from the memory router is a
         * memory 404 rather than the wedge's own.
         *
         * With no record open this branch does not exist at all, which is the
         * point of the `undefined` above: a caller without a record gets a 404,
         * not an answer about a record nobody is keeping.
         */
        if (memoryRoutes !== undefined && url.pathname.startsWith("/api/memory/")) {
          const headers: Record<string, string | undefined> = {};
          for (const [name, value] of Object.entries(request.headers)) {
            headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
          }

          let payload: unknown;
          if (request.method === "POST") {
            try {
              const raw = await readBody(request);
              payload = raw.trim() === "" ? undefined : JSON.parse(raw);
            } catch {
              sendJson(response, 400, { error: "the request body is not valid JSON" });
              return;
            }
          }

          const result = await memoryRoutes.handle(request.method ?? "GET", url.pathname, headers, payload);
          const text = JSON.stringify(result.body ?? null);
          response.writeHead(result.status, {
            ...result.headers,
            "content-length": Buffer.byteLength(text),
          });
          response.end(text);
          return;
        }

        /**
         * THE PORTAL SURFACE, BEFORE ANY WEDGE ROUTE.
         *
         * Delegated first so `/api/portal/*` can never fall through to a wedge
         * handler written for a different verb, and so a 404 from the portal
         * router is a portal 404 rather than the wedge's own.
         *
         * The body is read only for a write. Reading it on a GET would leave the
         * request stream undrained on any client that sent one anyway, and
         * `readBody` rejects past the same ceiling every other body is held to.
         */
        if (url.pathname.startsWith("/api/portal/")) {
          const headers: Record<string, string | undefined> = {};
          for (const [name, value] of Object.entries(request.headers)) {
            headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
          }

          let payload: unknown;
          if (request.method === "POST" || request.method === "PUT" || request.method === "PATCH") {
            try {
              const raw = await readBody(request);
              payload = raw.trim() === "" ? undefined : JSON.parse(raw);
            } catch {
              // A body that is not JSON is the caller's error, and saying so is
              // more useful than letting the router receive `undefined` and
              // report every required field missing.
              sendJson(response, 400, { error: "the request body is not valid JSON" });
              return;
            }
          }

          const result = await portalRoutes.handle(request.method ?? "GET", url.pathname, headers, payload);
          const text = JSON.stringify(result.body ?? null);
          response.writeHead(result.status, {
            ...result.headers,
            "content-length": Buffer.byteLength(text),
          });
          response.end(text);
          return;
        }
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

        // --- GOVERNANCE ENDPOINTS ---

        // GET /api/v1/governance/ledger
        if (request.method === "GET" && url.pathname === "/api/v1/governance/ledger") {
          try {
            const Database = (await import("better-sqlite3")).default;
            const db = new Database(path.join(cwd, "workspace", "gate.db"), { readonly: true });

            /**
             * THE TRACEABILITY COLUMNS ARE ASKED FOR, NOT ASSUMED.
             *
             * `owasp_ref` and `nist_ref` arrived in a ledger migration,
             * and nothing in this process creates them on a table that
             * pre-dates it. A SELECT that names a column the table does
             * not have is a refusal against exactly the archive the
             * projection below claims to tolerate -- so the table's own
             * shape is read first, and the columns are projected only
             * when the table carries them. An unmigrated ledger answers
             * with nulls, which is what "pre-dates the migration" means.
             */
            const tableInfo = db
              .prepare("PRAGMA table_info(approval_tasks)")
              .all() as { name: string }[];
            const columnNames = new Set(tableInfo.map((column) => column.name));
            const hasTraceability =
              columnNames.has("owasp_ref") && columnNames.has("nist_ref");

            // subject_json is a serialised object; parse it back so the caller
            // receives a plain record rather than an escaped string inside JSON.
            // Rows that pre-date the column or whose JSON is malformed still travel
            // as-is so a parse failure does not drop an audit row.
            const rows = db
              .prepare(
                `SELECT task_token, status, subject_json, decided_at, approved_by,
                        reason, result_expires_at, collected_at, created_at
                        ${hasTraceability ? ", owasp_ref, nist_ref" : ""}
                 FROM approval_tasks
                 ORDER BY created_at DESC`,
              )
              .all() as {
                task_token: string;
                status: string;
                subject_json: string;
                decided_at: number | null;
                approved_by: string | null;
                reason: string | null;
                result_expires_at: number | null;
                collected_at: number | null;
                created_at: number;
                owasp_ref?: string | null;
                nist_ref?: string | null;
              }[];

            const ledger = rows.map((row) => {
              let subject: unknown;
              try {
                subject = JSON.parse(row.subject_json);
              } catch {
                subject = row.subject_json;
              }
              return {
                token: row.task_token,
                status: row.status,
                subject,
                decidedAt: ledgerTimestamp(row.decided_at),
                approvedBy: row.approved_by ?? null,
                reason: row.reason ?? null,
                resultExpiresAt: ledgerTimestamp(row.result_expires_at),
                collectedAt: ledgerTimestamp(row.collected_at),
                createdAt: ledgerTimestamp(row.created_at),
                // Regulatory traceability columns — null on rows that pre-date
                // the migration or that were not flagged as schema mutations.
                owaspRef: hasTraceability ? row.owasp_ref ?? null : null,
                nistRef: hasTraceability ? row.nist_ref ?? null : null,
              };
            });

            sendJson(response, 200, ledger);
            return;
          } catch (error) {
            // A missing database file is a normal startup condition — no tasks
            // have been created yet. Return an empty ledger rather than a 500.
            const message = error instanceof Error ? error.message : String(error);
            const code = typeof error === "object" && error !== null && "code" in error
              ? (error as { code?: unknown }).code
              : undefined;
            if (code === "SQLITE_CANTOPEN" || message.includes("no such file") || message.includes("unable to open database file")) {
              sendJson(response, 200, []);
              return;
            }
            sendJson(response, 500, { error: "Could not read the governance ledger.", detail: message });
            return;
          }
        }

        // GET /api/v1/remediation/patches
        if (request.method === "GET" && url.pathname === "/api/v1/remediation/patches") {
          const files = readdirSync(sandboxRoot).filter(f => f.endsWith('.yaml') || f.endsWith('.tf'));
          const patches = await Promise.all(files.map(async (file) => {
            const document = await readFile(path.join(sandboxRoot, file), 'utf8');
            const patchId = file.replace(/\.(yaml|tf)$/, '');
            return { patchId, format: file.endsWith('.yaml') ? 'kubernetes' : 'terraform', document, state: 'AWAITING_APPROVAL' };
          }));
          sendJson(response, 200, patches);
          return;
        }

        // POST /api/v1/remediation/approvals
        if (request.method === "POST" && url.pathname === "/api/v1/remediation/approvals") {
          const body = JSON.parse(await readBody(request));
          remediation.review(body.task_token, { approved: body.status === 'approved', approvedBy: "Incident Commander", reason: "HITL review" });
          sendJson(response, 200, { status: "success" });
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/v1/workspace/ingest") {
          const contentType = (request.headers["content-type"] ?? "").toLowerCase();
          if (!contentType.startsWith("multipart/form-data")) {
            sendJson(response, 400, { error: "Content-Type must be multipart/form-data." });
            return;
          }

          // Extract the boundary token from the Content-Type header.
          // RFC 7578 §4.1: boundary parameter is required.
          const boundaryMatch = /boundary=([^;\s]+)/i.exec(request.headers["content-type"] ?? "");
          if (boundaryMatch === null) {
            sendJson(response, 400, { error: "multipart/form-data boundary is missing from Content-Type." });
            return;
          }
          const boundary = boundaryMatch[1]!.replace(/^"|"$/g, "");

          // Read the raw body as a Buffer so binary files are not corrupted by
          // a UTF-8 decode. `readBody` returns a string, so we read manually.
          let rawBuffer: Buffer;
          try {
            rawBuffer = await new Promise<Buffer>((resolve, reject) => {
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
              request.on("end", () => resolve(Buffer.concat(chunks)));
              request.on("error", reject);
            });
          } catch (error) {
            sendJson(response, 400, { error: error instanceof Error ? error.message : "Could not read the request body." });
            return;
          }

          // Manual multipart parser. We deliberately avoid a third-party library
          // to honour the project's no-runtime-dependencies constraint.
          //
          // Structure: --<boundary>\r\n<headers>\r\n\r\n<body>\r\n repeated,
          // terminated by --<boundary>--.
          const delimiter = Buffer.from(`--${boundary}`);
          const crlf = Buffer.from("\r\n");
          const crlfcrlf = Buffer.from("\r\n\r\n");

          let fileName: string | undefined;
          let fileBuffer: Buffer | undefined;

          // Walk the parts by finding each boundary marker.
          let offset = 0;
          while (offset < rawBuffer.length) {
            const delimPos = rawBuffer.indexOf(delimiter, offset);
            if (delimPos === -1) break;

            const afterDelim = delimPos + delimiter.length;
            // "--" suffix marks the closing boundary; stop.
            if (
              rawBuffer[afterDelim] === 0x2d /* - */ &&
              rawBuffer[afterDelim + 1] === 0x2d /* - */
            ) {
              break;
            }
            // Skip the CRLF after the boundary line.
            const partStart = afterDelim + crlf.length;

            // Find the blank line that separates part headers from part body.
            const headerEnd = rawBuffer.indexOf(crlfcrlf, partStart);
            if (headerEnd === -1) { offset = afterDelim; continue; }

            const partHeaders = rawBuffer.slice(partStart, headerEnd).toString("utf8");
            const bodyStart = headerEnd + crlfcrlf.length;

            // Find the next boundary to know where the body ends.
            const nextDelim = rawBuffer.indexOf(delimiter, bodyStart);
            // Body ends just before the preceding CRLF that RFC 7578 places
            // between the body and the next boundary.
            const bodyEnd = nextDelim === -1 ? rawBuffer.length : nextDelim - crlf.length;
            const partBody = rawBuffer.slice(bodyStart, bodyEnd);

            // Parse Content-Disposition to find the field name and filename.
            const dispositionMatch = /content-disposition:[^\r\n]*/i.exec(partHeaders);
            if (dispositionMatch !== null) {
              const nameMatch = /name="([^"]*)"/i.exec(dispositionMatch[0]);
              const fileNameMatch = /filename="([^"]*)"/i.exec(dispositionMatch[0]);
              if (nameMatch?.[1] === "file" && fileNameMatch !== null) {
                fileName = path.basename(fileNameMatch[1]);
                fileBuffer = partBody;
              }
            }

            offset = nextDelim === -1 ? rawBuffer.length : nextDelim;
          }

          if (fileName === undefined || fileBuffer === undefined) {
            sendJson(response, 400, { error: 'A file field named "file" is required in the multipart body.' });
            return;
          }

          // Reject empty or suspiciously named files before the boundary check.
          const safeName = fileName.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[._]+/, "") || "upload";
          if (fileBuffer.length === 0) {
            sendJson(response, 400, { error: "The uploaded file is empty." });
            return;
          }

          // All writes must stay inside the workspace. resolveWithinRoot is the
          // single boundary function; there is no second implementation here.
          const destRelative = path.join("workspace", safeName);
          const destVerdict = resolveWithinRoot(cwd, destRelative);
          if (!destVerdict.allowed) {
            sendJson(response, 403, {
              error: "path boundary violation: the destination is outside the workspace.",
            });
            return;
          }
          const destAbsolute = destVerdict.resolvedPath as string;

          try {
            const fs = await import("node:fs/promises");
            await fs.mkdir(path.dirname(destAbsolute), { recursive: true });
            await fs.writeFile(destAbsolute, fileBuffer);
          } catch (error) {
            sendJson(response, 500, {
              error: "The file could not be saved.",
              detail: error instanceof Error ? error.message : String(error),
            });
            return;
          }

          // SHA-256 over the raw file bytes, consistent with the frontend's own
          // crypto.subtle fingerprint function.
          const { createHash } = await import("node:crypto");
          const sha256 = createHash("sha256").update(fileBuffer).digest("hex");

          sendJson(response, 200, {
            path: destRelative.replace(/\\/g, "/"),
            name: safeName,
            size: fileBuffer.length,
            sha256,
          });
          return;
        }

        // POST /api/v1/agent/task
        if (request.method === "POST" && url.pathname === "/api/v1/agent/task") {
          const raw = await readBody(request);
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            sendJson(response, 400, { error: "the request body is not valid JSON" });
            return;
          }

          const body = parsed as { workspacePath?: unknown; prompt?: unknown } | null;
          const workspacePath = body?.workspacePath;
          const prompt = body?.prompt;

          if (typeof workspacePath !== "string" || workspacePath.trim().length === 0) {
            sendJson(response, 400, { error: "workspacePath is required." });
            return;
          }
          if (typeof prompt !== "string" || prompt.trim().length === 0) {
            sendJson(response, 400, { error: "prompt is required." });
            return;
          }

          const taskId = workspacePath;
          let currentIterations = 0;

          try {
            if (redis.status === 'ready') {
              const key = `neurofebric:task:iterations:${taskId}`;
              const results = await redis.pipeline().incr(key).expire(key, 300).exec();
              if (results && results[0][1]) {
                currentIterations = results[0][1] as number;
              }
            } else {
              currentIterations = (taskIterationMap.get(taskId) ?? 0) + 1;
              taskIterationMap.set(taskId, currentIterations);
            }
          } catch (e) {
            currentIterations = (taskIterationMap.get(taskId) ?? 0) + 1;
            taskIterationMap.set(taskId, currentIterations);
          }

          if (currentIterations > MAX_ITERATIONS) {
            sendJson(response, 429, { error: 'CIRCUIT_BREAKER_TRIPPED', details: 'Iteration threshold exceeded.' });
            return;
          }

          try {
            // The same boundary check every other route that reads a file applies.
            const resolvedTask = resolveWithinRoot(cwd, workspacePath);
            if (!resolvedTask.allowed) {
              sendJson(response, 403, {
                status: "FAILED",
                failure: {
                  code: "PATH_OUTSIDE_WORKSPACE",
                  reason: `path boundary violation: ${resolvedTask.reason ?? "the file is outside the workspace"}`,
                  kernelReasonCode: "PATH_OUTSIDE_WORKSPACE",
                },
              });
              return;
            }

            // Wire to the Conductor's omni-routing loop. The request is framed
            // with an explicit input= marker so the Conductor receives the filename
            // exactly as given, for the same reason /api/report does it.
            const conductor = new Conductor({
              cwd,
              defaultsRoot: options.defaultsRoot ?? installRoot,
              projectConfig: { policyMode: "TRUSTED_PROJECT", allowedRoots: [cwd] },
              remediation,
            });
            const result = await conductor.run(`${prompt}; input=${workspacePath}`, {
              mode: "omni",
              output: path.join(cwd, "workspace", "task-output"),
              title: titleFor({ fileName: path.basename(workspacePath), purpose: UNKNOWN_PURPOSE }),
            });

            sendJson(response, statusFor(result), toResponse(result));
          } finally {
            if (redis.status === 'ready') {
              await redis.del(`neurofebric:task:iterations:${taskId}`).catch(() => {});
            } else {
              taskIterationMap.delete(taskId);
            }
          }
          return;
        }

        // POST /api/v1/governance/verdict
        if (request.method === "POST" && url.pathname === "/api/v1/governance/verdict") {
          const raw = await readBody(request);
          let parsed: any;
          try {
            parsed = JSON.parse(raw);
          } catch {
            sendJson(response, 400, { error: "the request body is not valid JSON" });
            return;
          }

          const { task_token, status, approved_by, reason, result_json, ttl_seconds = 3600 } = parsed;
          if (!task_token || !status) {
            sendJson(response, 400, { error: "task_token and status are required." });
            return;
          }

          try {
            // Connect to the temporary SQLite adapter created by the proof-of-life script.
            // Note: If your script named it something other than "gate.db" (e.g., "embassy.db"), update it here.
            const Database = (await import("better-sqlite3")).default;
            const db = new Database(path.join(cwd, "workspace", "gate.db"));

            // ── SCHEMA MIGRATION: legally-defensible audit columns ──────────
            //
            // These two columns extend the approval ledger with regulatory
            // traceability: owasp_ref names the OWASP LLM Top 10 category a
            // payload triggered, and nist_ref names the NIST AI RMF control.
            //
            // ALTER TABLE … ADD COLUMN is idempotent in SQLite only if wrapped
            // in a try/catch: SQLite does not support IF NOT EXISTS on ADD COLUMN
            // (it was added in 3.37 for CREATE TABLE but never backported to ALTER).
            // A duplicate-column error is SQLITE_ERROR with the text
            // "duplicate column name"; catching it here keeps the server alive
            // across restarts without a separate one-time migration script.
            try {
              db.prepare("ALTER TABLE approval_tasks ADD COLUMN owasp_ref TEXT").run();
            } catch (migrationErr) {
              const msg = migrationErr instanceof Error ? migrationErr.message : String(migrationErr);
              if (!msg.includes("duplicate column name")) throw migrationErr;
            }
            try {
              db.prepare("ALTER TABLE approval_tasks ADD COLUMN nist_ref TEXT").run();
            } catch (migrationErr) {
              const msg = migrationErr instanceof Error ? migrationErr.message : String(migrationErr);
              if (!msg.includes("duplicate column name")) throw migrationErr;
            }

            // ── PAYLOAD INSPECTION: schema-mutation tagging ─────────────────
            //
            // Intercept the inbound payload and check whether it is attempting
            // a schema mutation (e.g., DDL keywords, ALTER/DROP/CREATE in a
            // result_json value). When detected, tag the row with the relevant
            // OWASP LLM03 and NIST AI RMF GOVERN 1.2 controls so auditors can
            // filter for these events in the ledger without re-inspecting JSON.
            //
            // The check is intentionally conservative: any JSON that serialises
            // to a string containing a DDL keyword at a word boundary is flagged.
            // False positives are acceptable in a governance ledger; false
            // negatives are not.
            const SCHEMA_MUTATION_RE = /\b(ALTER|DROP|CREATE|TRUNCATE|RENAME|ATTACH|DETACH)\b/i;
            const payloadStr = result_json ? JSON.stringify(result_json) : "";
            const isSchemaMutation = SCHEMA_MUTATION_RE.test(payloadStr);
            const owaspTag = isSchemaMutation ? "OWASP LLM03: Excessive Agency" : null;
            const nistTag = isSchemaMutation ? "NIST AI RMF: GOVERN 1.2" : null;

            const existing = db.prepare("SELECT status FROM approval_tasks WHERE task_token = ?").get(task_token) as any;

            if (!existing) {
              sendJson(response, 404, { error: "Task not found." });
              return;
            }
            if (existing.status !== "pending") {
              sendJson(response, 400, { error: `Cannot update task. Current status is '${existing.status}'.` });
              return;
            }

            // SQLite stores all lifecycle timestamps as epoch seconds, matching
            // the INTEGER schema and created_at default. HTTP responses still
            // expose ISO strings for browser-friendly display.
            const decided_at = Math.floor(Date.now() / 1000);
            const result_expires_at = decided_at + Math.floor(ttl_seconds);
            const result_string = result_json ? JSON.stringify(result_json) : null;

            db.prepare(`
              UPDATE approval_tasks
              SET status = ?, result_json = ?, decided_at = ?, approved_by = ?,
                  reason = ?, result_expires_at = ?, owasp_ref = ?, nist_ref = ?
              WHERE task_token = ?
            `).run(
              status,
              result_string,
              decided_at,
              approved_by || "system",
              reason || null,
              result_expires_at,
              owaspTag,
              nistTag,
              task_token,
            );

            sendJson(response, 200, {
              success: true,
              task_token,
              status,
              decided_at: ledgerTimestamp(decided_at),
              ...(isSchemaMutation ? { owasp_ref: owaspTag, nist_ref: nistTag } : {}),
            });
            return;
          } catch (error) {
            sendJson(response, 500, { error: "Internal server error processing verdict.", detail: String(error) });
            return;
          }
        }

        // GET /api/v1/governance/result/:token
        const resultMatch = url.pathname.match(/^\/api\/v1\/governance\/result\/(.+)$/);
        if (request.method === "GET" && resultMatch) {
          const token = resultMatch[1];
          try {
            const Database = (await import("better-sqlite3")).default;
            const db = new Database(path.join(cwd, "workspace", "gate.db"));

            const task = db.prepare("SELECT * FROM approval_tasks WHERE task_token = ?").get(token) as any;

            if (!task) {
              sendJson(response, 404, { error: "Task not found." });
              return;
            }

            if (task.status === "pending") {
              sendJson(response, 202, { status: "pending", message: "Task is awaiting governance decision." });
              return;
            }

            if (task.status === "approved" || task.status === "rejected") {
              const collected_at = Math.floor(Date.now() / 1000);

              // Mark as consumed to prevent replay reads, satisfying the UPDATE-only rule
              db.prepare(`
                UPDATE approval_tasks 
                SET status = 'consumed', collected_at = ? 
                WHERE task_token = ?
              `).run(collected_at, token);

              sendJson(response, 200, {
                status: task.status,
                result: task.result_json ? JSON.parse(task.result_json) : null,
                decided_at: task.decided_at,
                approved_by: task.approved_by,
                reason: task.reason,
                collected_at: ledgerTimestamp(collected_at)
              });
              return;
            }

            sendJson(response, 200, {
              status: task.status,
              result: task.result_json ? JSON.parse(task.result_json) : null,
              message: `Task is no longer active (Status: ${task.status})`
            });
            return;
          } catch (error) {
            sendJson(response, 500, { error: "Internal server error retrieving result.", detail: String(error) });
            return;
          }
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

  /**
   * ARMED AT THE COMPOSITION ROOT, AND RELEASED ON THE SERVER'S OWN CLOSE.
   *
   * Both halves are here rather than in `startWedgeServer` because the server is
   * built in tests that never call `startWedgeServer`, and a loop started by the
   * listener and stopped by the listener is a loop nobody owns. Binding release
   * to the server's `close` event means every path out of this function releases
   * it, including the direct ones.
   *
   * Started only once the handler exists, so a request can never arrive before
   * the loop that records what it produces.
   */
  server.once("close", () => evaluation.stop());
  evaluation.start();

  return server;
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