import type Database from 'better-sqlite3';
import { ulid } from 'ulid';

export interface PaymentLimits {
  totalCents: number;
  dailyCents: number;
  maxSingleCents: number;
}
export interface PaymentQuote {
  operationKey: string;
  payer: string;
  recipient: string;
  asset: string;
  network: string;
  amountAtomic: string;
  domain: string;
  kind: string;
  purchaseId?: string;
  requestFingerprint?: string;
}
export interface PaymentAttempt {
  id: string; operation_key: string; payer: string; recipient: string;
  asset: string; network: string; domain: string; kind: string;
  amount_atomic: string; reserved_cents: number;
  status: 'reserved' | 'submitted' | 'uncertain' | 'confirmed' | 'released';
  nonce: string | null; tx_hash: string | null; fulfilled: number;
  purchase_id: string; response_json: string | null; response_status: number | null;
  request_fingerprint: string;
  scan_start_block: string | null; scan_next_block: string | null;
}

export class PaymentLedger {
  constructor(private readonly db: Database.Database) {}

  reserve(quote: PaymentQuote, limits: PaymentLimits): string {
    for (const value of [limits.totalCents, limits.dailyCents, limits.maxSingleCents]) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid payment budget');
    }
    if (!/^\d+$/.test(quote.amountAtomic)) throw new Error('Invalid atomic amount');
    const amount = BigInt(quote.amountAtomic);
    if (amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid atomic amount');
    const cents = Number((amount + 9999n) / 10000n);
    return this.db.transaction(() => {
      const pending = this.db.prepare(`SELECT 1 FROM payment_attempts WHERE operation_key = ?
        AND status != 'released' AND (status != 'confirmed' OR fulfilled = 0 OR purchase_id = ?) LIMIT 1`).get(quote.operationKey, quote.purchaseId ?? '');
      if (pending) throw new Error('Unresolved payment for this operation; reconcile before retrying');
      const day = new Date().toISOString().slice(0, 10);
      const used = this.db.prepare(`SELECT COALESCE(SUM(reserved_cents),0) AS total,
        COALESCE(SUM(CASE WHEN status != 'confirmed' OR substr(settled_at,1,10) = ? THEN reserved_cents ELSE 0 END),0) AS daily
        FROM payment_attempts WHERE status != 'released'`).get(day) as { total: number; daily: number };
      if (cents > limits.maxSingleCents || used.total + cents > limits.totalCents || used.daily + cents > limits.dailyCents) {
        throw new Error('Payment budget exceeded (includes unresolved reservations)');
      }
      const id = ulid();
      this.db.prepare(`INSERT INTO payment_attempts
        (id,operation_key,payer,recipient,asset,network,domain,kind,amount_atomic,reserved_cents,status,created_at,purchase_id,request_fingerprint)
        VALUES (?,?,?,?,?,?,?,?,?,?,'reserved',?,?,?)`).run(id, quote.operationKey, quote.payer, quote.recipient,
          quote.asset, quote.network, quote.domain, quote.kind, quote.amountAtomic, cents, new Date().toISOString(), quote.purchaseId ?? '', quote.requestFingerprint ?? quote.operationKey);
      return id;
    }).immediate();
  }

  get(id: string): PaymentAttempt | undefined {
    return this.db.prepare('SELECT * FROM payment_attempts WHERE id = ?').get(id) as PaymentAttempt | undefined;
  }
  completed(operationKey: string, purchaseId = ''): PaymentAttempt | undefined {
    return this.db.prepare("SELECT * FROM payment_attempts WHERE operation_key=? AND purchase_id=? AND status='confirmed' AND fulfilled=1 AND response_json IS NOT NULL ORDER BY created_at DESC LIMIT 1").get(operationKey, purchaseId) as PaymentAttempt | undefined;
  }
  delivery(id: string, data: unknown, status: number, fulfilled: boolean): void {
    this.db.prepare('UPDATE payment_attempts SET response_json=?, response_status=?, fulfilled=? WHERE id=?')
      .run(JSON.stringify(data), status, fulfilled ? 1 : 0, id);
  }
  submitted(id: string, nonce: string): void {
    const result = this.db.prepare("UPDATE payment_attempts SET status='submitted', nonce=? WHERE id=? AND status='reserved'").run(nonce, id);
    if (!result.changes) throw new Error('Invalid payment state before submission');
  }
  anchor(id: string, block: bigint): void {
    if (block < 0n) throw new Error('Invalid recovery block');
    const result = this.db.prepare(`UPDATE payment_attempts SET scan_start_block=?, scan_next_block=?
      WHERE id=? AND status='reserved' AND scan_start_block IS NULL`).run(block.toString(), block.toString(), id);
    if (!result.changes) throw new Error('Cannot anchor this payment state');
  }
  advanceScan(id: string, from: bigint, next: bigint): void {
    if (next <= from) throw new Error('Invalid recovery cursor');
    // A stale concurrent scan must not move another worker's cursor backwards.
    this.db.prepare(`UPDATE payment_attempts SET scan_next_block=? WHERE id=? AND scan_next_block=?
      AND status IN ('submitted','uncertain') AND tx_hash IS NULL`).run(next.toString(), id, from.toString());
  }
  release(id: string): void {
    const result = this.db.prepare("UPDATE payment_attempts SET status='released' WHERE id=? AND status='reserved'").run(id);
    if (!result.changes) throw new Error('Cannot release a submitted payment state');
  }
  uncertain(id: string, hash?: string): void {
    this.db.prepare("UPDATE payment_attempts SET status='uncertain', tx_hash=COALESCE(?,tx_hash) WHERE id=? AND status IN ('submitted','uncertain')").run(hash ?? null, id);
  }
  fulfilled(id: string): void {
    this.db.prepare('UPDATE payment_attempts SET fulfilled=1 WHERE id=?').run(id);
  }
  pending(): PaymentAttempt[] {
    return this.db.prepare(`SELECT * FROM payment_attempts WHERE status IN ('submitted','uncertain')
      AND (tx_hash IS NOT NULL OR (nonce IS NOT NULL AND scan_next_block IS NOT NULL))
      ORDER BY COALESCE(checked_at,'') LIMIT 10`).all() as PaymentAttempt[];
  }
  checked(id: string): void {
    this.db.prepare('UPDATE payment_attempts SET checked_at=? WHERE id=?').run(new Date().toISOString(), id);
  }
  summary(): unknown[] {
    return this.db.prepare('SELECT status, COUNT(*) AS count, SUM(reserved_cents) AS budgetCents FROM payment_attempts GROUP BY status').all();
  }
  recent(): unknown[] {
    return this.db.prepare(`SELECT id, purchase_id, domain, kind, amount_atomic, reserved_cents, status, nonce,
      tx_hash, fulfilled, response_status, created_at, scan_start_block, scan_next_block
      FROM payment_attempts ORDER BY created_at DESC LIMIT 20`).all();
  }
  confirm(id: string, hash: string): void {
    this.db.transaction(() => {
      const row = this.get(id);
      if (!row || !['submitted', 'uncertain', 'confirmed'].includes(row.status)) throw new Error('Invalid payment state for confirmation');
      if (row.status === 'confirmed') {
        if (row.tx_hash !== hash) throw new Error('Conflicting settlement hash');
        return;
      }
      const now = new Date().toISOString();
      const actualCents = Number(BigInt(row.amount_atomic)) / 10000;
      this.db.prepare(`INSERT INTO spend_tracking
        (id,tool_name,amount_cents,recipient,domain,category,window_hour,window_day)
        VALUES (?,?,?,?,?,'x402',?,?)`).run(`payment:${id}`, row.kind, actualCents, row.recipient, row.domain, now.slice(0, 13), now.slice(0, 10));
      this.db.prepare(`INSERT INTO onchain_transactions (id,tx_hash,chain,operation,status,metadata)
        VALUES (?,?,?,?,'confirmed',?) ON CONFLICT(tx_hash) DO NOTHING`).run(id, hash, row.network, row.kind, JSON.stringify({ paymentAttemptId: id }));
      this.db.prepare(`INSERT INTO transactions (id,type,amount_cents,description) VALUES (?,?,?,?)`)
        .run(`payment:${id}`, row.kind === 'topup_credits' ? 'credit_purchase' : 'x402_payment', actualCents, `Confirmed payment ${hash}; attempt ${id}`);
      this.db.prepare("UPDATE payment_attempts SET status='confirmed', tx_hash=?, settled_at=? WHERE id=?").run(hash, now, id);
    }).immediate();
  }
}
