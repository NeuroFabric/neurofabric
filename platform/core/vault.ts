import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CoreError } from "./errors.ts";
import { createRedactingSink, redactPreview } from "./redaction.ts";

/**
 * The credentials vault.
 *
 * This module is the ONE sanctioned unredacted store in the harness (D-016,
 * A6). Everything else that records anything about the vault — the event, the
 * log, the trace — goes out through `createRedactingSink`, so the value has
 * exactly one home on disk and nowhere else it could be persisted.
 *
 * Two properties are load-bearing and are the reason the rest of the design is
 * what it is:
 *
 *   1. The file is written whole, never appended and never staged through a
 *      temporary name. A temporary file would be a SECOND unredacted copy of
 *      the material on disk, which is exactly what the one-sanctioned-store
 *      property exists to prevent.
 *   2. No event, error message, or refusal reason here ever carries a value.
 *      Only the operation, the entry name, its shape, and the outcome.
 *
 * There is no encryption and no key-management primitive, because the measured
 * surface has none (OQ-1). The controls are structural instead: the file is
 * gitignored, and every event is sink-wrapped. The store payload is NOT scanned
 * by this module — see the retrieve note below for why the approval gate is
 * the sanction and a local deny-scan would be neither.
 *
 * The residual risk — a local process that can read the workspace directory can
 * read these values — is ACCEPTED BY RULING.
 */

/** How an unredacted retrieval is permitted. */
export type RetrieveMode = "redacted" | "unredacted-optin";

export interface VaultConfig {
  enabled: boolean;
  /** Absolute path of the vault file. Resolved by the operator, not inferred. */
  path: string;
  retrieveMode: RetrieveMode;
}

export interface VaultEntry {
  shape: string;
  value: string;
  /** When this name was last written. An overwrite updates it; there is no rotate op. */
  rotatedAt: string;
}

export interface VaultFile {
  version: number;
  entries: Record<string, VaultEntry>;
}

export type VaultOp = "load" | "store" | "retrieve" | "list" | "delete";
export type VaultOutcome = "ok" | "absent" | "refused" | "error";

/**
 * The complete shape of a vault event.
 *
 * The absence of a value field is the design, not an oversight: this type is
 * what a trace consumer reads, so adding a value here would put the material
 * back on every persistence surface the vault touches.
 */
export interface VaultEvent {
  op: VaultOp;
  outcome: VaultOutcome;
  name?: string;
  shape?: string;
  /**
   * Set on a store that REPLACED an existing entry.
   *
   * A store over an existing name is a rotation, and the entry's own
   * `rotatedAt` records the new stamp. This records the fact that something was
   * replaced at all: without it the audit trail for two stores under one name
   * is two identical `store/ok` lines, and a credential that was silently
   * swapped cannot be told apart from one that was created.
   */
  replaced?: boolean;
  /**
   * Set on an unredacted read: the FACT that an operator approved one.
   *
   * This is the whole audit record of a reveal, and it is deliberately not the
   * value it produced. An unredacted read is a separate tool at the boundary
   * (CONTROLLED tier) precisely so that the approval is visible in the
   * precheck trace rather than buried in a handler argument.
   */
  approval?: boolean;
  at: string;
}

const VAULT_FILE_VERSION = 1;
const VAULT_CONFIG_KEYS = ["enabled", "path", "retrieveMode"] as const;
const RETRIEVE_MODES: ReadonlySet<string> = new Set<RetrieveMode>(["redacted", "unredacted-optin"]);

function fail(source: string, message: string, field?: string): never {
  throw new CoreError("CONFIGURATION_ERROR", `${source}: ${message}`, field ? { retryable: false } : {});
}

function refuse(message: string): never {
  throw new CoreError("POLICY_ERROR", message);
}

/**
 * Validate the `vault` block of a policy document.
 *
 * Fails loud, naming the file and the offending field, on the same template the
 * unscoped-content field uses: a malformed block at session start is a fixable
 * operator error, while a silently-ignored key would let an operator believe a
 * control is in force when it is not (OQ-7).
 *
 * A document with NO `vault` block yields `undefined`, which is inert: no tools
 * are registered and nothing here can be constructed.
 */
export function parseVaultConfig(raw: unknown, source: string): VaultConfig | undefined {
  if (raw === undefined) return undefined;

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail(source, "vault must be an object with enabled, path and retrieveMode", "vault");
  }
  const block = raw as Record<string, unknown>;

  for (const key of Object.keys(block)) {
    if (!(VAULT_CONFIG_KEYS as readonly string[]).includes(key)) {
      fail(
        source,
        `vault.${key} is not a known vault field (expected one of: ${VAULT_CONFIG_KEYS.join(", ")})`,
        `vault.${key}`,
      );
    }
  }

  if (typeof block.enabled !== "boolean") {
    fail(source, `vault.enabled must be a boolean; got ${JSON.stringify(block.enabled)}`, "vault.enabled");
  }
  if (typeof block.path !== "string" || block.path.trim() === "") {
    fail(source, "vault.path must be a non-empty string", "vault.path");
  }
  if (typeof block.retrieveMode !== "string" || !RETRIEVE_MODES.has(block.retrieveMode)) {
    fail(
      source,
      `vault.retrieveMode must be "redacted" or "unredacted-optin"; got ${JSON.stringify(block.retrieveMode)}`,
      "vault.retrieveMode",
    );
  }

  return {
    enabled: block.enabled,
    path: block.path,
    retrieveMode: block.retrieveMode as RetrieveMode,
  };
}

function emptyFile(): VaultFile {
  return { version: VAULT_FILE_VERSION, entries: {} };
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** Metadata only. What `list` returns and what a retrieval reports about the entry. */
export interface VaultEntrySummary {
  name: string;
  shape: string;
  rotatedAt: string;
}

export interface RetrieveOptions {
  /**
   * Ask for the value itself rather than the redacted preview.
   *
   * The per-call operator approval an unredacted read requires is enforced at
   * the kernel precheck, on a separate CONTROLLED-tier tool, and is NOT
   * re-litigated here. A handler-level grant would have two failures: it has
   * no measured home in the approval mechanism, and it would sit BELOW the
   * trace, so an approved reveal would leave no approval record behind it.
   *
   * What this module still owns is the operator's standing instruction, which
   * no approval of one call may override: a vault configured `redacted` refuses
   * an unredacted read outright.
   */
  unredacted?: boolean;
}

export type RetrieveResult =
  | { name: string; shape: string; rotatedAt: string; unredacted: false; preview: string }
  | { name: string; shape: string; rotatedAt: string; unredacted: true; value: string };

export interface CredentialVaultOptions {
  /** Where a redacted vault event would be persisted. Wrapped, never called raw. */
  persist: (entry: unknown) => void;
  /** Clock, injectable so rotation stamps are assertable. */
  now?: () => string;
}

export class CredentialVault {
  private readonly file: string;
  private readonly mode: RetrieveMode;
  private readonly record: (entry: unknown) => void;
  private readonly now: () => string;

  constructor(config: VaultConfig, options: CredentialVaultOptions) {
    this.file = config.path;
    this.mode = config.retrieveMode;
    // Every event leaves through the redacting sink. A caller cannot reach the
    // raw sink, so a future edit cannot bypass redaction by writing to it
    // directly — the same property that makes the sink the enforcement point for
    // the trace.
    this.record = createRedactingSink(options.persist);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Where this vault reads and writes. */
  get path(): string {
    return this.file;
  }

  get retrieveMode(): RetrieveMode {
    return this.mode;
  }

  /**
   * Read the vault file.
   *
   * A missing file is an empty vault, not an error: the operator may not have
   * created it yet. A file that exists but does not match the layout IS an
   * error, because silently treating a malformed store as empty would look
   * like data loss.
   */
  async load(): Promise<VaultFile> {
    let file: VaultFile;
    try {
      file = await this.read();
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        this.event({ op: "load", outcome: "absent" });
        return emptyFile();
      }
      throw error;
    }
    this.event({ op: "load", outcome: "ok" });
    return file;
  }

  /**
   * Write a value under `name`.
   *
   * Storing an existing name overwrites it and updates `rotatedAt`; there is no
   * rotate operation, and the event record is the audit trail of what changed
   * and when (OQ-2).
   */
  async store(name: string, shape: string, value: string): Promise<VaultEntry> {
    if (!nonEmpty(name)) refuse("a vault entry needs a non-empty name");
    if (!nonEmpty(shape)) refuse(`vault entry '${name}' needs a non-empty shape`);
    if (typeof value !== "string") refuse(`vault entry '${name}' needs a string value`);

    const file = await this.readQuietly();
    const replaced = file.entries[name] !== undefined;
    const entry: VaultEntry = { shape, value, rotatedAt: this.now() };
    file.entries[name] = entry;
    await this.persist(file);
    this.event({ op: "store", outcome: "ok", name, shape, ...(replaced ? { replaced: true } : {}) });
    return { ...entry };
  }

  /**
   * Read an entry.
   *
   * The default returns a redacted preview. An unredacted retrieval is refused
   * outright when the configured mode does not opt in, and is otherwise gated
   * on per-call approval — never on a session scope or a standing grant.
   */
  async retrieve(name: string, options: RetrieveOptions = {}): Promise<RetrieveResult> {
    if (!nonEmpty(name)) refuse("a vault entry needs a non-empty name");

    const revealing = options.unredacted === true;
    if (revealing && this.mode !== "unredacted-optin") {
      this.event({ op: "retrieve", outcome: "refused", name });
      refuse(`vault entry '${name}': unredacted retrieval is refused because retrieveMode is "${this.mode}"`);
    }

    const file = await this.readQuietly();
    const entry = file.entries[name];
    if (entry === undefined) {
      this.event({ op: "retrieve", outcome: "absent", name });
      throw new CoreError("TOOL_ERROR", `no vault entry named '${name}'`);
    }

    this.event({ op: "retrieve", outcome: "ok", name, shape: entry.shape, ...(revealing ? { approval: true } : {}) });
    if (revealing) {
      return { name, shape: entry.shape, rotatedAt: entry.rotatedAt, unredacted: true, value: entry.value };
    }
    return {
      name,
      shape: entry.shape,
      rotatedAt: entry.rotatedAt,
      unredacted: false,
      preview: redactPreview(entry.value),
    };
  }

  /** Names and shapes, never a value. Metadata is free; values are gated. */
  async list(): Promise<VaultEntrySummary[]> {
    const file = await this.readQuietly();
    const entries = Object.entries(file.entries)
      .map(([name, entry]) => ({ name, shape: entry.shape, rotatedAt: entry.rotatedAt }))
      .sort((left, right) => left.name.localeCompare(right.name));
    this.event({ op: "list", outcome: "ok" });
    return entries;
  }

  /** Remove an entry. Reports whether there was one to remove. */
  async delete(name: string): Promise<boolean> {
    if (!nonEmpty(name)) refuse("a vault entry needs a non-empty name");
    const file = await this.readQuietly();
    if (file.entries[name] === undefined) {
      this.event({ op: "delete", outcome: "absent", name });
      return false;
    }
    delete file.entries[name];
    await this.persist(file);
    this.event({ op: "delete", outcome: "ok", name });
    return true;
  }

  /**
   * Read the file, treating absence as empty.
   *
   * Every operation other than `load` goes through here, so a first store
   * against a vault that does not exist yet does not have to special-case it.
   */
  private async readQuietly(): Promise<VaultFile> {
    try {
      return await this.read();
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return emptyFile();
      throw error;
    }
  }

  private async read(): Promise<VaultFile> {
    const content = await readFile(this.file, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      throw new CoreError(
        "TOOL_ERROR",
        `${this.file}: vault file is not valid JSON (${(error as Error).message})`,
      );
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new CoreError("TOOL_ERROR", `${this.file}: vault file must be a JSON object`);
    }
    const file = parsed as Partial<VaultFile>;
    if (file.version !== VAULT_FILE_VERSION) {
      throw new CoreError(
        "TOOL_ERROR",
        `${this.file}: vault file version ${JSON.stringify(file.version)} is not supported (expected ${VAULT_FILE_VERSION})`,
      );
    }
    if (file.entries === null || typeof file.entries !== "object" || Array.isArray(file.entries)) {
      throw new CoreError("TOOL_ERROR", `${this.file}: vault file entries must be an object`);
    }
    for (const [name, entry] of Object.entries(file.entries as Record<string, unknown>)) {
      const candidate = entry as Partial<VaultEntry>;
      if (!nonEmpty(candidate.shape) || typeof candidate.value !== "string" || !nonEmpty(candidate.rotatedAt)) {
        throw new CoreError(
          "TOOL_ERROR",
          `${this.file}: vault entry '${name}' must have a shape, a string value and a rotatedAt`,
        );
      }
    }
    return { version: VAULT_FILE_VERSION, entries: file.entries as Record<string, VaultEntry> };
  }

  /**
   * Write the whole file in place.
   *
   * No temporary name, no append: either of those would leave a second
   * unredacted copy of the material on disk.
   */
  private async persist(file: VaultFile): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  }

  private event(partial: Omit<VaultEvent, "at">): void {
    this.record({ ...partial, at: this.now() });
  }
}
