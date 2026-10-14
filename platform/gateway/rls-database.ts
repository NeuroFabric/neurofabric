import crypto from "node:crypto";

export interface RLSContext {
  currentUserId: string;
  currentTenantId: string;
  clearance: "LEVEL 5" | "LEVEL 4" | "LEVEL 3" | "LEVEL 2";
  permissions: string[];
}

export interface RLSTableRow {
  id: string;
  owner_user_id: string;
  tenant_id: string;
  [key: string]: unknown;
}

export function derivePasswordPBKDF2Sync(password: string, email: string): string {
  const salt = `neurofabric-salt-2026:${email.trim().toLowerCase()}`;
  return crypto.pbkdf2Sync(password, salt, 100_000, 32, "sha256").toString("hex");
}

export class SovereignRLSDatabase {
  private tables: Record<string, RLSTableRow[]> = {
    users: [],
    sessions: [],
    telemetry_logs: [],
    patch_proposals: [],
    circuit_breakers: [],
    merkle_ledger: [],
    access_requests: [],
  };

  constructor() {
    this.seedDatabase();
  }

  private assertRLSContext(ctx: RLSContext) {
    if (!ctx || !ctx.currentUserId || !ctx.currentTenantId) {
      throw new Error("RLS_VIOLATION: Missing authenticated currentUserId or currentTenantId.");
    }
  }

  public selectOwnRows<T extends RLSTableRow>(tableName: string, ctx: RLSContext): T[] {
    this.assertRLSContext(ctx);
    const table = this.tables[tableName];
    if (!table) throw new Error(`RLS_ERROR: Unknown table ${tableName}`);
    return table.filter(
      (row) => row.owner_user_id === ctx.currentUserId && row.tenant_id === ctx.currentTenantId
    ) as T[];
  }

  public insertOwnRow<T extends RLSTableRow>(tableName: string, row: T, ctx: RLSContext): T {
    this.assertRLSContext(ctx);
    const table = this.tables[tableName];
    if (!table) throw new Error(`RLS_ERROR: Unknown table ${tableName}`);
    if (row.owner_user_id !== ctx.currentUserId || row.tenant_id !== ctx.currentTenantId) {
      throw new Error(
        `RLS_POLICY_DENIED: User ${ctx.currentUserId} cannot write rows owned by ${row.owner_user_id}`
      );
    }
    table.unshift(row);
    return row;
  }

  public updateOwnRow<T extends RLSTableRow>(
    tableName: string,
    id: string,
    updater: (existing: T) => T,
    ctx: RLSContext
  ): T {
    this.assertRLSContext(ctx);
    if (tableName === "merkle_ledger" || tableName === "telemetry_logs") {
      throw new Error(`RLS_IMMUTABLE_TABLE: Table ${tableName} is append-only and forbids UPDATE.`);
    }
    const table = this.tables[tableName];
    const idx = table.findIndex(
      (r) => r.id === id && r.owner_user_id === ctx.currentUserId && r.tenant_id === ctx.currentTenantId
    );
    if (idx === -1) {
      throw new Error(`RLS_ROW_NOT_FOUND_OR_FORBIDDEN: Row ${id} is not owned by ${ctx.currentUserId}`);
    }
    const updated = updater(table[idx] as T);
    if (updated.owner_user_id !== ctx.currentUserId || updated.tenant_id !== ctx.currentTenantId) {
      throw new Error("RLS_POLICY_DENIED: Cannot transfer row ownership across users.");
    }
    table[idx] = updated;
    return updated;
  }

  private seedDatabase() {
    const defaultPwd = "Sovereign#2026!Key";
    this.tables.users = [
      {
        id: "iam-1",
        owner_user_id: "iam-1",
        tenant_id: "org-neurofabric-prod",
        email: "rishabh.sharma@neurofabric.io",
        name: "Rishabh Sharma",
        role: "Principal Systems Architect (Root)",
        clearance: "LEVEL 5",
        status: "ACTIVE",
        password_pbkdf2: derivePasswordPBKDF2Sync(defaultPwd, "rishabh.sharma@neurofabric.io"),
      },
      {
        id: "iam-2",
        owner_user_id: "iam-2",
        tenant_id: "org-neurofabric-prod",
        email: "ananya.verma@neurofabric.io",
        name: "Ananya Verma",
        role: "Staff SecOps & DPDP Compliance Lead",
        clearance: "LEVEL 4",
        status: "ACTIVE",
        password_pbkdf2: derivePasswordPBKDF2Sync(defaultPwd, "ananya.verma@neurofabric.io"),
      },
      {
        id: "iam-3",
        owner_user_id: "iam-3",
        tenant_id: "org-neurofabric-prod",
        email: "vikram.aditya@neurofabric.io",
        name: "Vikram Aditya",
        role: "Senior On-Call SRE",
        clearance: "LEVEL 3",
        status: "ACTIVE",
        password_pbkdf2: derivePasswordPBKDF2Sync(defaultPwd, "vikram.aditya@neurofabric.io"),
      },
      {
        id: "iam-4",
        owner_user_id: "iam-4",
        tenant_id: "org-neurofabric-prod",
        email: "karan.mehta@neurofabric.io",
        name: "Karan Mehta",
        role: "External CERT-In / SEBI Auditor",
        clearance: "LEVEL 2",
        status: "SUSPENDED",
        password_pbkdf2: derivePasswordPBKDF2Sync(defaultPwd, "karan.mehta@neurofabric.io"),
      },
    ];
  }

  public verifyUserCredentials(email: string, clientPbkdf2Hex: string, totpCode: string) {
    const cleanEmail = email.trim().toLowerCase();
    const userRow = this.tables.users.find((u) => String(u.email).toLowerCase() === cleanEmail);
    if (!userRow) {
      return { ok: false, code: 401, error: "INVALID_CREDENTIALS" };
    }
    if (userRow.status !== "ACTIVE") {
      return { ok: false, code: 403, error: `ACCOUNT_${userRow.status}` };
    }
    const expectedHex = String(userRow.password_pbkdf2);
    const a = Buffer.from(expectedHex, "hex");
    const b = Buffer.from(clientPbkdf2Hex.padEnd(64, "0").slice(0, 64), "hex");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { ok: false, code: 401, error: "INVALID_PASSWORD_DIGEST" };
    }
    if (!/^\d{6}$/.test(totpCode) || totpCode === "000000") {
      return { ok: false, code: 401, error: "INVALID_TOTP_CODE" };
    }
    return { ok: true, code: 200, user: userRow };
  }
}

export const rlsDb = new SovereignRLSDatabase();
