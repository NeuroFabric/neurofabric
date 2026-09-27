import { createHash } from "node:crypto";
import { createReadStream, promises as fs, statSync } from "node:fs";
import path from "node:path";
import { extractToolPathCandidates } from "./tool-paths.ts";
import { WorkspaceBoundary } from "./workspace.ts";
import { redactValue } from "./redaction.ts";
import { DEFAULT_LIMITS } from "./limits.ts";
import type { Artifact, ToolDescriptor } from "./types.ts";

/**
 * Artifacts and generic verification.
 *
 * Pi returns tool output as text. That is not the same as having produced a
 * result: a tool can report success while writing nothing, a model can claim a
 * file exists that it never created, and a write can be truncated or corrupt.
 * This module turns "the tool said OK" into a checkable statement about
 * something on disk.
 *
 * Design rules:
 *
 *  - **Never fabricate.** An artifact exists only when a reference is actually
 *    known. An unverifiable reference is reported as such, never upgraded.
 *  - **Descriptor-driven.** Whether a tool produces artifacts is derived from
 *    its `sideEffect`/`riskLevel` classification, never from a list of tool
 *    names, so new and remote/MCP tools need no changes here.
 *  - **Domain-agnostic.** `classifyArtifactKind` is a lookup table that new
 *    capabilities extend; it is not a set of special cases for one domain.
 */

export type ArtifactKind =
  | "file" | "directory" | "structured-data" | "image" | "video" | "audio"
  | "code" | "document" | "report" | "unknown";

export type ArtifactVerificationStatus = "VERIFIED" | "INVALID" | "UNVERIFIED";

export type ArtifactOrigin = "TOOL_DECLARED" | "DERIVED_FROM_INPUT";

export interface ArtifactChecks {
  exists: boolean;
  withinBoundary: boolean;
  readable: boolean;
  nonEmpty: boolean;
  matchesDeclaredKind: boolean;
}

export interface ArtifactVerification {
  status: ArtifactVerificationStatus;
  checks: ArtifactChecks;
  kind: ArtifactKind;
  sizeBytes?: number;
  sha256?: string;
  verifiedAt: string;
  reason?: string;
}

/**
 * Extension -> kind. Capabilities add entries here as new media types appear;
 * nothing else in the kernel needs to change.
 */
const KIND_BY_EXTENSION: Readonly<Record<string, ArtifactKind>> = {
  ".json": "structured-data", ".jsonl": "structured-data", ".ndjson": "structured-data",
  ".csv": "structured-data", ".tsv": "structured-data", ".yaml": "structured-data", ".yml": "structured-data",
  ".xml": "structured-data", ".toml": "structured-data", ".parquet": "structured-data",
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image", ".webp": "image", ".svg": "image", ".bmp": "image",
  ".mp4": "video", ".mov": "video", ".webm": "video", ".mkv": "video", ".avi": "video",
  ".mp3": "audio", ".wav": "audio", ".flac": "audio", ".ogg": "audio", ".m4a": "audio",
  ".ts": "code", ".tsx": "code", ".js": "code", ".jsx": "code", ".mjs": "code", ".py": "code",
  ".go": "code", ".rs": "code", ".java": "code", ".c": "code", ".h": "code", ".cpp": "code", ".cs": "code", ".rb": "code", ".php": "code",
  ".md": "document", ".doc": "document", ".docx": "document", ".odt": "document", ".pdf": "document", ".rtf": "document", ".txt": "document",
  ".html": "document", ".htm": "document",
  ".pptx": "report", ".xlsx": "report",
};

export function classifyArtifactKind(reference: string, declaredType?: string): ArtifactKind {
  if (declaredType) {
    const normalized = declaredType.toLowerCase();
    const known = Object.values(KIND_BY_EXTENSION);
    if ((known as string[]).includes(normalized)) return normalized as ArtifactKind;
    if (normalized === "file" || normalized === "directory" || normalized === "unknown") return normalized as ArtifactKind;
  }
  // A malformed reference must degrade to `unknown`, never throw: artifact
  // creation runs on untrusted tool input.
  if (typeof reference !== "string") return "unknown";
  return KIND_BY_EXTENSION[path.extname(reference).toLowerCase()] ?? "file";
}

/**
 * Does this tool produce artifacts we should check?
 *
 * Derived from the tool's own classification, so registered, built-in, and
 * future remote/MCP tools are handled identically. Read-only tools consume
 * inputs; they do not produce outputs, so their paths are evidence, not
 * artifacts. `bash` is deliberately excluded: a command may touch a thousand
 * paths and guessing which are outputs would fabricate provenance.
 */
export function toolProducesArtifacts(descriptor: ToolDescriptor): boolean {
  return descriptor.sideEffect === "SIDE_EFFECTING"
    && (descriptor.riskLevel === "WRITE" || descriptor.riskLevel === "DESTRUCTIVE");
}

export function createArtifact(options: {
  reference: string;
  descriptor: ToolDescriptor;
  taskId: string;
  stepId: string;
  executionId: string;
  origin?: ArtifactOrigin;
  metadata?: Record<string, unknown>;
}): Artifact {
  const reference = typeof options.reference === "string" ? options.reference : "";
  // D-009: enforce `maxArtifactBytes` at the creation choke point. This is the
  // one place every artifact passes through, and the policy byte cap
  // (`maxBytesPerWrite`) governs tool payloads, not the files they produce, so
  // nothing upstream would have caught an oversize artifact. Hardcoded to the
  // default; configurability is a separate decision.
  enforceArtifactSize(reference);
  return {
    artifactId: `art-${createHash("sha256").update(`${options.taskId}:${options.stepId}:${options.executionId}:${reference}`).digest("hex").slice(0, 16)}`,
    type: classifyArtifactKind(reference),
    reference,
    producer: options.descriptor.name,
    taskId: options.taskId,
    stepId: options.stepId,
    createdAt: new Date().toISOString(),
    origin: options.origin ?? "TOOL_DECLARED",
    // Trust is earned by verification, never asserted at creation.
    trust: "UNVERIFIED",
    // Artifact metadata originates from tool output, so it is sanitized here
    // rather than trusted to be harmless.
    metadata: options.metadata === undefined
      ? undefined
      : (redactValue(options.metadata) as Record<string, unknown> | undefined),
  };
}

/**
 * D-009: reject a reference that already exists and is larger than the artifact
 * budget. Fails open when the size cannot be read — a reference that does not
 * exist yet is not an oversize artifact, and `verifyArtifact` is what decides
 * whether it exists at all. Directories are excluded: their aggregate size is
 * not a single artifact's size.
 */
function enforceArtifactSize(reference: string): void {
  let sizeBytes: number;
  try {
    const stats = statSync(reference);
    if (stats.isDirectory()) return;
    sizeBytes = stats.size;
  } catch {
    return;
  }
  if (sizeBytes > DEFAULT_LIMITS.maxArtifactBytes) {
    throw new Error(
      `artifact exceeds maxArtifactBytes: ${sizeBytes} > ${DEFAULT_LIMITS.maxArtifactBytes} (${reference})`,
    );
  }
}

/** Candidate output references declared by a tool call's input. */
export function declaredArtifactReferences(descriptor: ToolDescriptor, input: unknown): string[] {
  if (!toolProducesArtifacts(descriptor)) return [];
  return extractToolPathCandidates(descriptor, input);
}

async function sha256(reference: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(reference)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * Check an artifact against the filesystem and the workspace boundary.
 *
 * Returns UNVERIFIED (not INVALID) when the environment cannot support a
 * definitive check, so an inconclusive result is never reported as a pass.
 */
export async function verifyArtifact(artifact: Artifact, options: { boundary?: WorkspaceBoundary; now?: () => Date } = {}): Promise<ArtifactVerification> {
  const now = options.now ?? (() => new Date());
  const checks: ArtifactChecks = {
    exists: false, withinBoundary: false, readable: false, nonEmpty: false, matchesDeclaredKind: false,
  };
  const kind = classifyArtifactKind(artifact.reference, artifact.type);
  const fail = (reason: string): ArtifactVerification => ({ status: "INVALID", checks, kind, verifiedAt: now().toISOString(), reason });

  if (typeof artifact.reference !== "string" || artifact.reference.trim() === "" || artifact.reference.includes("\0")) {
    return fail("artifact reference is not a usable path");
  }
  if (artifact.reference.includes("://")) {
    return { status: "UNVERIFIED", checks, kind, verifiedAt: now().toISOString(), reason: "remote reference cannot be verified locally" };
  }

  if (options.boundary) {
    const verdict = options.boundary.check(artifact.reference);
    checks.withinBoundary = verdict.allowed;
    if (!verdict.allowed) return fail(`outside the allowed workspace: ${verdict.reason}`);
  } else {
    checks.withinBoundary = true;
  }

  let stats;
  try {
    stats = await fs.stat(artifact.reference);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return fail(`artifact does not exist at ${artifact.reference}`);
    return { status: "UNVERIFIED", checks, kind, verifiedAt: now().toISOString(), reason: `could not stat artifact: ${(error as Error).message}` };
  }
  checks.exists = true;

  const isDirectory = stats.isDirectory();
  checks.matchesDeclaredKind = kind === "directory" ? isDirectory : !isDirectory;
  if (!checks.matchesDeclaredKind) return fail(`artifact kind mismatch: expected ${kind}`);

  if (isDirectory) {
    // A directory is verified by existing and being readable; emptiness and
    // content hashing do not apply.
    try {
      await fs.access(artifact.reference);
      checks.readable = true;
      checks.nonEmpty = true;
    } catch {
      return fail("directory is not readable");
    }
    return { status: "VERIFIED", checks, kind, sizeBytes: stats.size, verifiedAt: now().toISOString() };
  }

  if (stats.size === 0) return fail("artifact is empty");
  checks.nonEmpty = true;

  try {
    await fs.access(artifact.reference);
    checks.readable = true;
  } catch {
    return fail("artifact is not readable");
  }

  let digest: string;
  try {
    digest = await sha256(artifact.reference);
  } catch (error) {
    return { status: "UNVERIFIED", checks, kind, sizeBytes: stats.size, verifiedAt: now().toISOString(), reason: `could not hash artifact: ${(error as Error).message}` };
  }

  return { status: "VERIFIED", checks, kind, sizeBytes: stats.size, sha256: digest, verifiedAt: now().toISOString() };
}

export interface ArtifactReport {
  artifacts: Artifact[];
  invalid: Artifact[];
  unverified: Artifact[];
  allVerified: boolean;
}

/**
 * Verify a batch and stamp each artifact with its result.
 *
 * `allVerified` is true only when every declared artifact reached VERIFIED.
 * An unverified artifact therefore blocks completion, which is the point: a
 * claim that cannot be substantiated must not be delivered as fact.
 */
export async function verifyArtifacts(artifacts: Artifact[], options: { boundary?: WorkspaceBoundary } = {}): Promise<ArtifactReport> {
  const verified: Artifact[] = [];
  const invalid: Artifact[] = [];
  const unverified: Artifact[] = [];

  for (const artifact of artifacts) {
    const result = await verifyArtifact(artifact, options);
    const trust = result.status === "VERIFIED" ? "VERIFIED" : result.status === "INVALID" ? "INVALID" : "UNVERIFIED";
    const stamped: Artifact = { ...artifact, trust, verification: result };
    verified.push(stamped);
    if (result.status === "INVALID") invalid.push(stamped);
    if (result.status === "UNVERIFIED") unverified.push(stamped);
  }

  return {
    artifacts: verified,
    invalid,
    unverified,
    allVerified: artifacts.length > 0 && invalid.length === 0 && unverified.length === 0,
  };
}
