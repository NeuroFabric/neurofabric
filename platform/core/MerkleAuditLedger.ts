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
  rca?: any;
  gitops?: any;
}

export class MerkleAuditLedger {
  private secret: string;
  private currentHash: string;
  private chain: LedgerEntry[] = [];

  constructor(secret: string = process.env.AUTH_SECRET || "neurofabric-enterprise-hmac-sha256-secret-key-2026") {
    this.secret = secret;
    this.currentHash = "0".repeat(64);
  }

  public computeEntryHash(prevHash: string, entry: LedgerEntry): string {
    const payload = `${prevHash}:${entry.token || entry.taskId}:${entry.status}:${entry.decidedAt || entry.createdAt}:${entry.approvedBy || "system"}`;
    return crypto.createHmac("sha256", this.secret).update(payload).digest("hex");
  }

  public append(entry: LedgerEntry): LedgerEntry {
    const record: LedgerEntry = { ...entry };
    record.prevHash = this.currentHash;
    record.merkleHash = this.computeEntryHash(this.currentHash, record);
    this.currentHash = record.merkleHash;
    this.chain.push(record);

    entry.prevHash = record.prevHash;
    entry.merkleHash = record.merkleHash;
    return record;
  }

  public getChain(): LedgerEntry[] {
    return [...this.chain];
  }

  public verifyChainIntegrity(entries?: LedgerEntry[]): {
    valid: boolean;
    chainLength: number;
    rootHash: string;
    verifiedAt: string;
    brokenAt?: string;
  } {
    const list = entries && entries.length > 0 ? entries : this.chain;
    if (!list || list.length === 0) {
      return {
        valid: true,
        chainLength: 0,
        rootHash: this.currentHash,
        verifiedAt: new Date().toISOString(),
      };
    }

    let prev = "0".repeat(64);
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const expected = this.computeEntryHash(prev, e);
      if (e.merkleHash && e.merkleHash !== expected) {
        return {
          valid: false,
          chainLength: list.length,
          rootHash: prev,
          verifiedAt: new Date().toISOString(),
          brokenAt: e.token || e.taskId || `index-${i}`,
        };
      }
      prev = e.merkleHash || expected;
    }

    return {
      valid: true,
      chainLength: list.length,
      rootHash: prev,
      verifiedAt: new Date().toISOString(),
    };
  }
}

export const merkleAuditLedger = new MerkleAuditLedger();
