import { CoreError } from "../core/errors.ts";
import {
  CredentialVault,
  type RetrieveResult,
  type VaultConfig,
  type VaultEntrySummary,
} from "../core/vault.ts";
import type { ToolDescriptor } from "../core/types.ts";

/**
 * The vault's tool surface: five descriptors, and the handlers that back them.
 *
 * The descriptors are declarative only — M2 shape, no handler field on the
 * descriptor — because the kernel registry holds a declaration of what a tool
 * IS, and the binding from that declaration to an implementation belongs to the
 * extension.
 *
 * They register IFF the operator has put a `vault` block in the policy document
 * AND set `enabled: true` (A2). The vault ships dark: with no block, nothing
 * here is constructed and no tool is registered, and the committed policy file
 * is never touched by the build. Enablement is an operator action.
 *
 * The governing invariant is OQ-6: METADATA IS FREE, VALUES ARE GATED. Reading
 * is split in two so the gate lands where the kernel already has one:
 *
 *   - `vault_retrieve` is READ_ONLY and returns a redacted preview. It can
 *     never return a value, and it names the tool that can.
 *   - `vault_reveal` is CONTROLLED, so the measured policy engine requires
 *     approval for it on every call, and the approval is in the trace.
 *
 * There is no scan of the store payload here, deliberately. The value field sits
 * outside the engine's write scan BY DESIGN, and a local deny-scan could only
 * ever fire on a store the operator had already approved — overriding the
 * operator's sanction, or never firing, with nothing in between. The approval
 * IS the sanction.
 */

/** What the adapter needs to know to decide whether the tools exist at all. */
export interface VaultWiring {
  config: VaultConfig;
}

export interface VaultHandlerOptions {
  /** Where a redacted vault event would be persisted. */
  persist: (entry: unknown) => void;
  /** Clock, injectable so rotation stamps are assertable. */
  now?: () => string;
}

const NAME_PROPERTY = { name: { type: "string", description: "the entry name" } };

function property(type: string, description: string): Record<string, unknown> {
  return { type, description };
}

function descriptor(
  name: string,
  description: string,
  access: "store" | "read" | "delete",
  tier: "WRITE" | "READ_ONLY" | "CONTROLLED",
  properties: Record<string, unknown>,
  required: string[],
  idempotency: ToolDescriptor["idempotency"],
): ToolDescriptor {
  return {
    name,
    version: "d-016",
    description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    outputSchema: { type: "object" },
    // A1: the only access strings in this surface are the three below. The
    // identifier surface is scanned, so nothing here may name a pattern.
    capabilities: [`credential.${access}`],
    permissions: [`credential.${access}`],
    riskLevel: tier,
    // Only a write changes state. A reveal is a pure read that is CONTROLLED
    // because what it discloses, not because it alters anything.
    sideEffect: tier === "WRITE" ? "SIDE_EFFECTING" : "PURE",
    idempotency,
    timeoutMs: 30_000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
  };
}

/** The five descriptors, in registration order. */
export function vaultToolDescriptors(): ToolDescriptor[] {
  return [
    descriptor(
      "vault_store",
      "Store a value in the project vault under a name, replacing any previous value for that name.",
      "store",
      "WRITE",
      {
        name: property("string", "the name to store the value under"),
        shape: property("string", "a short classification of what the value is, recorded beside it"),
        value: property("string", "the value to store"),
      },
      ["name", "shape", "value"],
      "NON_IDEMPOTENT",
    ),
    descriptor(
      "vault_retrieve",
      "Read one entry from the project vault. Returns a redacted preview and its shape; it never returns the value.",
      "read",
      "READ_ONLY",
      { ...NAME_PROPERTY },
      ["name"],
      "IDEMPOTENT",
    ),
    descriptor(
      "vault_reveal",
      "Return the stored value of one entry. The operator must approve every call, and the approval is recorded.",
      "read",
      "CONTROLLED",
      { ...NAME_PROPERTY },
      ["name"],
      "IDEMPOTENT",
    ),
    descriptor(
      "vault_list",
      "List the names and shapes held in the project vault. No values are returned.",
      "read",
      "READ_ONLY",
      {},
      [],
      "IDEMPOTENT",
    ),
    descriptor(
      "vault_delete",
      "Remove one entry from the project vault by name.",
      "delete",
      "WRITE",
      { ...NAME_PROPERTY },
      ["name"],
      "IDEMPOTENT",
    ),
  ];
}

export interface VaultHandlers {
  vault_store(input: { name?: unknown; shape?: unknown; value?: unknown }): Promise<{ name: string; shape: string; rotatedAt: string }>;
  vault_retrieve(input: Record<string, unknown>): Promise<RetrieveResult>;
  vault_reveal(input: Record<string, unknown>): Promise<RetrieveResult>;
  vault_list(input?: Record<string, unknown>): Promise<VaultEntrySummary[]>;
  vault_delete(input: { name?: unknown }): Promise<{ name: string; removed: boolean }>;
}

function requireName(input: { name?: unknown }, tool: string): string {
  if (typeof input.name !== "string" || input.name.trim() === "") {
    throw new CoreError("TOOL_ERROR", `${tool} needs a non-empty name`);
  }
  return input.name;
}

/**
 * The Pi-side handlers, bound to one configured vault.
 *
 * Nothing here decides whether a call was approved. An execution binds only on
 * an ALLOW decision, so a handler reached through the kernel has already passed
 * the precheck — and for `vault_reveal` that precheck is a recorded, per-call
 * operator approval. Re-deciding it here would put a second, untraced gate
 * below the one that already exists.
 */
export function createVaultHandlers(wiring: VaultWiring, options: VaultHandlerOptions): VaultHandlers {
  const vault = new CredentialVault(wiring.config, {
    persist: options.persist,
    ...(options.now !== undefined ? { now: options.now } : {}),
  });

  return {
    async vault_store(input) {
      const name = requireName(input, "vault_store");
      if (typeof input.shape !== "string" || input.shape.trim() === "") {
        throw new CoreError("TOOL_ERROR", "vault_store needs a non-empty shape");
      }
      if (typeof input.value !== "string") {
        throw new CoreError("TOOL_ERROR", "vault_store needs a string value");
      }
      const entry = await vault.store(name, input.shape, input.value);
      return { name, shape: entry.shape, rotatedAt: entry.rotatedAt };
    },

    async vault_retrieve(input) {
      // The split is structural, so the older shape is refused rather than
      // quietly ignored: a caller asking a read tool for a value has not
      // understood that it cannot have one here, and saying nothing would leave
      // it believing otherwise.
      if ("unredacted" in input) {
        throw new CoreError(
          "TOOL_ERROR",
          "vault_retrieve returns a redacted preview and never a value; use vault_reveal, which requires operator approval on every call",
        );
      }
      return vault.retrieve(requireName(input, "vault_retrieve"));
    },

    async vault_reveal(input) {
      if ("unredacted" in input) {
        throw new CoreError("TOOL_ERROR", "vault_reveal always returns the value; the unredacted key is not accepted");
      }
      // The operator's standing instruction, not this call's approval, is what
      // a `redacted` vault enforces: no approval overrides it.
      return vault.retrieve(requireName(input, "vault_reveal"), { unredacted: true });
    },

    async vault_list() {
      return vault.list();
    },

    async vault_delete(input) {
      const name = requireName(input, "vault_delete");
      return { name, removed: await vault.delete(name) };
    },
  };
}

/** True when a wiring enables the tools. A missing block is inert, not disabled. */
export function vaultToolsEnabled(wiring: VaultWiring | undefined): boolean {
  return wiring !== undefined && wiring.config.enabled === true;
}
