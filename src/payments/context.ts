import type Database from 'better-sqlite3';
import type { AutomatonConfig } from '../types.js';
import { PaymentLedger, type PaymentLimits } from './ledger.js';

export interface PaymentContext {
  ledger: PaymentLedger;
  limits: PaymentLimits;
  allowedDomains: string[];
  kind: 'x402_fetch' | 'topup_credits';
  expectedCreditsCents?: number;
  /** Stable across retries; change only for an intentionally new purchase. */
  purchaseId?: string;
}

export function paymentContext(config: AutomatonConfig, db: Database.Database, kind: PaymentContext['kind'] = 'topup_credits'): PaymentContext {
  return {
    ledger: new PaymentLedger(db), kind,
    limits: config.standalone ? { totalCents: 0, dailyCents: 0, maxSingleCents: 0 }
      : config.paymentLimits ?? { totalCents: 0, dailyCents: 0, maxSingleCents: 0 },
    allowedDomains: config.treasuryPolicy?.x402AllowedDomains ?? ['conway.tech'],
  };
}
