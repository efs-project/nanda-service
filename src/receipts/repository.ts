import type { EfsScribeReceipt } from "./schema.js";

export interface ReceiptIndex {
  authenticatedSubject: string;
  idempotencyKey?: string;
}

export interface ReceiptRepository {
  save(receipt: EfsScribeReceipt, index: ReceiptIndex): Promise<void>;
  get(receiptId: string): Promise<EfsScribeReceipt | undefined>;
  getLatestByPath(path: string, attester?: string): Promise<EfsScribeReceipt | undefined>;
  getByIdempotency(
    authenticatedSubject: string,
    idempotencyKey: string
  ): Promise<EfsScribeReceipt | undefined>;
}

export class InMemoryReceiptRepository implements ReceiptRepository {
  private readonly receipts = new Map<string, EfsScribeReceipt>();
  private readonly idempotency = new Map<string, string>();
  private readonly latestByPath = new Map<string, string>();
  private readonly latestByPathAndAttester = new Map<string, string>();

  async save(receipt: EfsScribeReceipt, index: ReceiptIndex): Promise<void> {
    this.receipts.set(receipt.receipt_id, receipt);
    this.latestByPath.set(receipt.efs.path, receipt.receipt_id);
    this.latestByPathAndAttester.set(
      pathAttesterKey(receipt.efs.path, receipt.agent_lens.attester),
      receipt.receipt_id
    );
    if (index.idempotencyKey !== undefined) {
      this.idempotency.set(
        idempotencyKey(index.authenticatedSubject, index.idempotencyKey),
        receipt.receipt_id
      );
    }
  }

  async get(receiptId: string): Promise<EfsScribeReceipt | undefined> {
    return this.receipts.get(receiptId);
  }

  async getLatestByPath(path: string, attester?: string): Promise<EfsScribeReceipt | undefined> {
    const receiptId =
      attester === undefined
        ? this.latestByPath.get(path)
        : this.latestByPathAndAttester.get(pathAttesterKey(path, attester));
    if (receiptId === undefined) {
      return undefined;
    }
    return this.receipts.get(receiptId);
  }

  async getByIdempotency(
    authenticatedSubject: string,
    idempotencyKeyValue: string
  ): Promise<EfsScribeReceipt | undefined> {
    const receiptId = this.idempotency.get(idempotencyKey(authenticatedSubject, idempotencyKeyValue));
    if (receiptId === undefined) {
      return undefined;
    }
    return this.receipts.get(receiptId);
  }
}

function idempotencyKey(authenticatedSubject: string, key: string): string {
  return `${authenticatedSubject}\0${key}`;
}

function pathAttesterKey(path: string, attester: string): string {
  return `${path}\0${attester.toLowerCase()}`;
}
