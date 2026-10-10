import crypto from "node:crypto";

export interface LedgerEntry {
  token: string;
  task_token?: string;
  taskId?: string;
  status: string;
  target?: string | null;
  subject?: any;
  approvedBy?: string | null;
  decidedAt?: string | null;
  reason?: string | null;
  createdAt?: string | null;
  prevHash?: string;
  merkleHash?: string;
  owaspRef?: string | null;
  nistRef?: string | null;
}

export class MerkleAuditLedger {
  private secret: string;
  private currentHash: string;

  constructor(secret: string = process.env.AUTH_SECRET || "neurofabric-enterprise-hmac-sha256-secret-key-2026") {
    this.secret = secret;
    this.currentHash = "0".repeat(64);
  }

  public computeEntryHash(prevHash: string, entry: LedgerEntry): string {
    const payload = `${prevHash}:${entry.token || entry.taskId}:${entry.status}:${entry.decidedAt || entry.createdAt}:${entry.approvedBy || "system"}`;
    return crypto.createHmac("sha256", this.secret).update(payload).digest("hex");
  }

  public append(entry: LedgerEntry): LedgerEntry {
    entry.prevHash = this.currentHash;
    entry.merkleHash = this.computeEntryHash(this.currentHash, entry);
    this.currentHash = entry.merkleHash;
    return entry;
  }

  public verifyChainIntegrity(entries: LedgerEntry[]): {
    valid: boolean;
    chainLength: number;
    rootHash: string;
    verifiedAt: string;
    brokenAt?: string;
  } {
    if (!entries || entries.length === 0) {
      return {
        valid: true,
        chainLength: 0,
        rootHash: this.currentHash,
        verifiedAt: new Date().toISOString(),
      };
    }

    let prev = "0".repeat(64);
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const expected = this.computeEntryHash(prev, e);
      if (e.merkleHash && e.merkleHash !== expected) {
        return {
          valid: false,
          chainLength: entries.length,
          rootHash: prev,
          verifiedAt: new Date().toISOString(),
          brokenAt: e.token || e.taskId || `index-${i}`,
        };
      }
      prev = e.merkleHash || expected;
      e.merkleHash = expected;
      e.prevHash = prev;
    }

    return {
      valid: true,
      chainLength: entries.length,
      rootHash: prev,
      verifiedAt: new Date().toISOString(),
    };
  }
}

export const merkleAuditLedger = new MerkleAuditLedger();
