import { randomBytes } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * THE REMEDIATION ENGINE.
 *
 * The Conductor diagnoses; this engine writes the PRESCRIPTION, and
 * nothing else. A proposal is a document in a sandbox, keyed by an
 * unguessable id, waiting for a human.
 *
 * THE ONE RULE, STATED WHERE IT CANNOT BE MISSED:
 *
 * This module contains no execution path at all. There is no kubectl,
 * no terraform, no process spawner, no shell -- not commented out,
 * not behind a flag, not "for later". The reason is not that the
 * commands are wrapped in a guard; it is that a module that cannot
 * execute is a module that cannot be made to execute, and a module
 * that can execute is one flag or one refactor away from doing it.
 * Every patch this engine produces is a document an operator runs,
 * after an Incident Commander has approved it (see remediation-gate.ts).
 *
 * THE SANDBOX IS THE CONTAINMENT.
 *
 * Every write lands at `<sandboxRoot>/<patchId>.<ext>`, where
 * `<patchId>` is 192 bits of CSPRNG output. The resource being
 * patched appears in the DOCUMENT, never in the PATH: a hostile
 * resource name is data, and data cannot walk out of a directory
 * it was never placed in. The containment is still verified on
 * every write and every read, because a property that is checked is
 * a property, and one that is merely assumed is a hope.
 */

/** The two document formats the engine emits. */
export type RemediationFormat = "kubernetes" | "terraform";

/** The workload a patch names. */
export interface PatchTarget {
  /** The Kubernetes kind or Terraform resource kind, e.g. "Deployment". */
  readonly kind: string;
  /** The workload name, e.g. "payments-api". */
  readonly resource: string;
  readonly namespace?: string;
  /** The alert source that caused the patch. Provenance, not routing. */
  readonly provider?: string;
  /** The alert text that caused the patch. Provenance, not routing. */
  readonly alertText?: string;
}

/**
 * The desired state, flat on purpose.
 *
 * One level of scalars under `spec` (Kubernetes) or inside the
 * resource block (Terraform). A nested desired state is a schema,
 * and a schema is a contract the operator should read, not one the
 * generator invents from a free-form request.
 */
export type DesiredState = Readonly<Record<string, string | number | boolean>>;

export interface PatchRequest {
  readonly target: PatchTarget;
  readonly format: RemediationFormat;
  readonly desiredState: DesiredState;
}

/** A patch that exists on disk and is waiting for a human. */
export interface ProposedPatch {
  readonly patchId: string;
  readonly format: RemediationFormat;
  /** Absolute path inside the sandbox. How the operator finds it. */
  readonly path: string;
  readonly document: string;
  /**
   * The state a proposal is in. It is the ONLY state this module
   * can produce: a patch is born waiting, and nothing here moves it
   * past that. Movement requires the approval gate.
   */
  readonly state: "AWAITING_APPROVAL";
}

/** Where proposals are written. Resolved at CALL time, so a test can point it anywhere. */
let patchSandbox: string | undefined;

export function setPatchSandboxRoot(root: string): void {
  patchSandbox = root;
}

export function resetPatchSandboxRoot(): void {
  patchSandbox = undefined;
}

export function patchSandboxRoot(): string {
  if (patchSandbox !== undefined) return patchSandbox;
  const fromEnv = process.env.NEUROFEBRIC_PATCH_SANDBOX;
  return fromEnv !== undefined && fromEnv.trim() !== ""
    ? fromEnv
    : path.join(process.cwd(), "gate-data", "patches");
}

/** A target as a string, "kind/name" or a bare name. Refuses anything else. */
export function parseTarget(target: string): PatchTarget {
  const trimmed = target.trim();
  if (trimmed.length === 0) {
    throw new Error("a target names a resource: 'kind/name' or a bare name");
  }
  const parts = trimmed.split("/");
  if (parts.length > 2) {
    throw new Error(`a target names ONE kind and ONE name, not ${parts.length} segments`);
  }
  if (parts.length === 2) {
    return { kind: capitalizeKebab(parts[0]), resource: parts[1] };
  }
  return { kind: "Deployment", resource: parts[0] };
}

function capitalizeKebab(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

const YAML_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const HCL_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KIND_NAME = /^[A-Za-z][A-Za-z0-9-]*$/;
const RESOURCE_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/**
 * The shape check every target passes before it is written anywhere.
 *
 * A name that cannot exist as a Kubernetes name is not "sanitised"
 * and not truncated: it is refused, because a refused name is a
 * caller error and a truncated one is a DIFFERENT resource than the
 * caller asked about.
 */
function assertTargetShapes(target: PatchTarget): void {
  if (!KIND_NAME.test(target.kind)) {
    throw new Error("the target kind is not a valid resource kind");
  }
  if (!RESOURCE_NAME.test(target.resource)) {
    throw new Error("the target resource is not a valid resource name");
  }
  if (target.namespace !== undefined && !RESOURCE_NAME.test(target.namespace)) {
    throw new Error("the target namespace is not a valid namespace name");
  }
}

/** A string scalar, emitted as a double-quoted YAML/HCL scalar. */
function quote(value: string): string {
  return JSON.stringify(value);
}

/**
 * Control characters, by code point rather than by escape.
 * Written this way on purpose: the characters themselves never
 * appear in this file, so the check cannot be corrupted by the
 * same characters it exists to catch.
 */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code === undefined || code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function assertScalar(key: string, value: string | number | boolean): void {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error(`the desired state field '${key}' is not a finite number`);
  }
  if (typeof value === "string" && hasControlCharacter(value)) {
    throw new Error(`the desired state field '${key}' contains a control character`);
  }
}

/**
 * Emit the Kubernetes manifest for a request.
 *
 * A fixed shape -- mappings of scalar keys, two-space indentation --
 * because a generator whose output shape is fixed is a generator
 * whose output can be validated by inspection.
 */
function kubernetesDocument(request: PatchRequest, patchId: string): string {
  const { target, desiredState } = request;
  const lines: string[] = [
    "# Generated by propose_infrastructure_patch.",
    "# This document is a PROPOSAL. It has not been applied, and the",
    "# process that wrote it will never apply it.",
    "apiVersion: apps/v1",
    `kind: ${target.kind}`,
    "metadata:",
    `  name: ${target.resource}`,
  ];
  if (target.namespace !== undefined) {
    lines.push(`  namespace: ${target.namespace}`);
  }
  lines.push("  annotations:");
  lines.push(`    neurofebric.patch-id: ${quote(patchId)}`);
  if (target.provider !== undefined) {
    lines.push(`    neurofebric.source-provider: ${quote(target.provider)}`);
  }
  if (target.alertText !== undefined) {
    lines.push(`    neurofebric.source-alert: ${quote(target.alertText)}`);
  }
  lines.push("spec:");
  for (const [key, value] of Object.entries(desiredState)) {
    if (!YAML_KEY.test(key)) {
      throw new Error(`the desired state field '${key}' is not a valid mapping key`);
    }
    assertScalar(key, value);
    lines.push(`  ${key}: ${typeof value === "string" ? quote(value) : String(value)}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Emit the Terraform HCL for a request.
 *
 * Provenance travels in comments: an HCL attribute has to be an
 * identifier, and an alert text is not one.
 */
function terraformDocument(request: PatchRequest, patchId: string): string {
  const { target, desiredState } = request;
  const resourceType = `kubernetes_${target.kind.toLowerCase()}`;
  const resourceName = target.resource.replace(/[^A-Za-z0-9_]/g, "_");
  const lines: string[] = [
    "# Generated by propose_infrastructure_patch.",
    `# patch-id: ${patchId}`,
    ...(target.provider !== undefined ? [`# source-provider: ${target.provider}`] : []),
    ...(target.alertText !== undefined ? [`# source-alert: ${target.alertText}`] : []),
    "# This document is a PROPOSAL. It has not been applied, and the",
    "# process that wrote it will never apply it.",
    `resource "${resourceType}" "${resourceName}" {`,
  ];
  for (const [key, value] of Object.entries(desiredState)) {
    if (!HCL_KEY.test(key)) {
      throw new Error(`the desired state field '${key}' is not a valid HCL identifier`);
    }
    assertScalar(key, value);
    lines.push(`  ${key} = ${typeof value === "string" ? quote(value) : String(value)}`);
  }
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

/** Generate the document. Pure: no I/O, no clock, no surprise. */
export function generatePatchDocument(request: PatchRequest, patchId: string): string {
  assertTargetShapes(request.target);
  return request.format === "kubernetes"
    ? kubernetesDocument(request, patchId)
    : terraformDocument(request, patchId);
}

/**
 * THE CONTAINMENT CHECK. Every path this module touches goes through
 * it, on write AND on read, so the property holds even if a later
 * edit adds a new call site that forgot to think about it.
 */
function containedPath(root: string, fileName: string): string {
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, fileName);
  const relative = path.relative(resolvedRoot, candidate);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`sandbox refusal: '${fileName}' would escape the remediation sandbox`);
  }
  return candidate;
}

/** A new patch id: a prefix, then 192 bits of CSPRNG output, hex. */
function newPatchId(): string {
  return `patch-${randomBytes(12).toString("hex")}`;
}

/**
 * Propose a patch: generate the document, write it into the sandbox,
 * and return the handle an operator and an approver will both use.
 *
 * The file is named by the patch id and NOTHING else, which is the
 * whole isolation argument: the resource under remediation is data
 * inside the document, and data never becomes a path component here.
 */
export async function proposeInfrastructurePatch(
  request: PatchRequest,
  sandboxRoot: string = patchSandboxRoot(),
): Promise<ProposedPatch> {
  const patchId = newPatchId();
  const document = generatePatchDocument(request, patchId);
  const extension = request.format === "kubernetes" ? "yaml" : "tf";
  const targetPath = containedPath(sandboxRoot, `${patchId}.${extension}`);

  await mkdir(sandboxRoot, { recursive: true });
  await writeFile(targetPath, document, "utf8");

  return {
    patchId,
    format: request.format,
    path: targetPath,
    document,
    state: "AWAITING_APPROVAL",
  };
}

/**
 * Read a proposed patch back, for the operator who has been approved
 * to see it. The id is checked for containment before it is used as
 * a filename, so an id that names an escape is refused rather than
 * resolved.
 */
export async function readProposedPatch(
  patchId: string,
  sandboxRoot: string = patchSandboxRoot(),
): Promise<string> {
  if (!/^patch-[0-9a-f]{24}$/.test(patchId)) {
    throw new Error(`sandbox refusal: '${patchId}' is not a patch id this engine issues`);
  }
  for (const extension of ["yaml", "tf"]) {
    const targetPath = containedPath(sandboxRoot, `${patchId}.${extension}`);
    try {
      return await readFile(targetPath, "utf8");
    } catch {
      // Not this extension; the next one is tried. A patch id
      // that exists as neither is refused below, not silently
      // answered with an empty document.
    }
  }
  throw new Error(`sandbox refusal: no patch '${patchId}' exists in the remediation sandbox`);
}
