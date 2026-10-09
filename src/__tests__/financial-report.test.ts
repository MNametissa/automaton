import { afterEach, describe, expect, it } from 'vitest';
import { BUILTIN_TASKS } from '../heartbeat/tasks.js';
import { createBuiltinTools } from '../agent/tools.js';
import { PaymentLedger } from '../payments/ledger.js';
import { createDatabase, inferenceInsertCost } from '../state/database.js';
import { createTestConfig, createTestDb, createTestIdentity, MockConwayClient } from './mocks.js';
import type { AutomatonDatabase, TransactionType } from '../types.js';

const databases: AutomatonDatabase[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture() {
  const db = createTestDb();
  databases.push(db);
  let sequence = 0;
  const add = (type: string, amountCents?: number, operationRef?: string) => db.insertTransaction({
    id: `transaction-${++sequence}`, type: type as TransactionType, amountCents,
    operationRef: operationRef ?? (['consumption', 'x402_payment'].includes(type) ? `event:${sequence}` : undefined),
    description: 'Recorded event', timestamp: new Date().toISOString(),
  });
  const report = async () => {
    await BUILTIN_TASKS.colony_financial_report({} as any, {
      db, identity: createTestIdentity(), config: createTestConfig(), conway: new MockConwayClient(),
    });
    return JSON.parse(db.getKV('last_colony_financial_report')!);
  };
  return { db, add, report };
}

describe('colony financial accounting', () => {
  it('keeps a $10 contribution and $10 prepaid purchase out of revenue and charges only $3 consumption', async () => {
    const f = fixture();
    f.add('capital_contribution', 1000);
    f.add('credit_purchase', 1000);
    f.add('consumption', 300);
    expect(await f.report()).toMatchObject({
      revenueCents: 0, expenseCents: 300, netCents: -300,
      capitalContributionsCents: 1000, prepaidPurchasesCents: 1000,
      recordedPaymentCashOutCents: 1000,
      consumptionCents: 300, recordedOperatingNetCents: -300,
      profitCents: null,
    });
  });

  it('distinguishes customer sales from contributions and transfers within the colony', async () => {
    const f = fixture();
    f.add('customer_revenue', 1500);
    f.add('capital_contribution', 1000);
    f.add('internal_transfer_out', 400);
    f.add('internal_transfer_in', 200);
    f.add('consumption', 300);
    expect(await f.report()).toMatchObject({
      revenueCents: 1500, expenseCents: 300, netCents: 1200,
      internalTransfersOutCents: 400, internalTransfersInCents: 200,
      profitCents: null,
      completeness: { scope: 'local_recorded_transactions', profitComplete: false, historyTruncated: false },
    });
  });

  it('keeps ambiguous historical transfers and funding requests visible without inventing sales or costs', async () => {
    const f = fixture();
    f.add('transfer_in', 1000);
    f.add('transfer_out', 700);
    f.add('funding_request', 500);
    f.db.raw.prepare('INSERT INTO transactions(id,type,amount_cents) VALUES (?,?,?)').run('legacy', 'legacy_unknown', 50);
    const report = await f.report();
    expect(report).toMatchObject({
      revenueCents: 0, expenseCents: 0,
      unclassifiedCents: 2250, unclassifiedTransactionCount: 4,
      completeness: { classificationComplete: false, profitComplete: false },
    });
    expect(report.unclassifiedByType).toEqual({
      transfer_in: { count: 1, amountCents: 1000 },
      transfer_out: { count: 1, amountCents: 700 },
      funding_request: { count: 1, amountCents: 500 },
      legacy_unknown: { count: 1, amountCents: 50 },
    });
  });

  it('counts confirmed x402 consumption once, while keeping unlinked inference estimates separate', async () => {
    const f = fixture();
    const ledger = new PaymentLedger(f.db.raw);
    const id = ledger.reserve({ operationKey: 'inference-request', payer: 'payer', recipient: 'provider',
      asset: 'usdc', network: 'eip155:8453', amountAtomic: '3700000', domain: 'example.com', kind: 'x402_fetch' },
      { totalCents: 1000, dailyCents: 1000, maxSingleCents: 1000 });
    ledger.submitted(id, 'nonce');
    ledger.confirm(id, 'confirmed-hash');
    ledger.confirm(id, 'confirmed-hash');
    f.add('inference', 300);
    inferenceInsertCost(f.db.raw, { sessionId: 'session', turnId: null, model: 'test-model', provider: 'test',
      inputTokens: 10, outputTokens: 10, costCents: 300, latencyMs: 1, tier: 'normal', taskType: 'agent_turn', cacheHit: false });
    expect(await f.report()).toMatchObject({
      expenseCents: 370, consumptionCents: 370, x402ConsumptionCents: 370,
      recordedPaymentCashOutCents: 370,
      unverifiedConsumptionCents: 300, estimatedInferenceCostCents: 300,
      transactionCount: 2, completeness: { profitComplete: false },
    });
  });

  it('preserves sub-cent settled payments and does not floor them away', async () => {
    const f = fixture();
    f.add('x402_payment', 0.0001);
    f.add('credit_purchase', 0.0002);
    expect(await f.report()).toMatchObject({ expenseCents: 0.0001, prepaidPurchasesCents: 0.0002 });
  });

  it('counts a confirmed payment and consumption view of the same operation only once', async () => {
    const f = fixture();
    const ledger = new PaymentLedger(f.db.raw);
    const id = ledger.reserve({ operationKey: 'request', payer: 'payer', recipient: 'provider', asset: 'usdc',
      network: 'eip155:8453', amountAtomic: '3000000', domain: 'example.com', kind: 'x402_fetch' },
      { totalCents: 1000, dailyCents: 1000, maxSingleCents: 1000 });
    ledger.submitted(id, 'nonce'); ledger.confirm(id, 'confirmed-hash');
    f.add('consumption', 300, `payment:${id}`);
    expect(await f.report()).toMatchObject({ expenseCents: 300, recordedPaymentCashOutCents: 300,
      duplicateExpenseTransactionCount: 1, completeness: { expenseDeduplicationComplete: true } });
    expect(f.db.getRecentTransactions(2).every(tx => tx.operationRef === `payment:${id}`)).toBe(true);
  });

  it('counts two genuinely distinct operations even when their amounts match', async () => {
    const f = fixture();
    f.add('consumption', 300, 'inference:one');
    f.add('x402_payment', 300, 'payment:two');
    expect(await f.report()).toMatchObject({ expenseCents: 600, duplicateExpenseTransactionCount: 0,
      completeness: { expenseDeduplicationComplete: true } });
  });

  it('marks conflicting views of one operation unresolved instead of silently choosing an amount', async () => {
    const f = fixture();
    f.add('consumption', 300, 'request:one');
    f.add('x402_payment', 200, 'request:one');
    const report = await f.report();
    expect(report).toMatchObject({ expenseCents: 0, unresolvedExpenseOperationCount: 1,
      unresolvedExpenseTransactionCount: 2, profitCents: null,
      completeness: { expenseDeduplicationComplete: false, classificationComplete: false } });
    expect(report.unresolvedExpenseOperations).toEqual([{ operationRef: 'request:one', amountsCents: [200, 300], transactionCount: 2 }]);
  });

  it('keeps a prepaid purchase separate from consumption sharing its purchase reference', async () => {
    const f = fixture();
    f.add('credit_purchase', 1000, 'purchase:one');
    f.add('consumption', 300, 'purchase:one');
    expect(await f.report()).toMatchObject({ prepaidPurchasesCents: 1000, expenseCents: 300,
      recordedPaymentCashOutCents: 1000, duplicateExpenseTransactionCount: 0 });
  });

  it('keeps unreferenced historical expense records unverified rather than claiming they are distinct', async () => {
    const f = fixture();
    const write = f.db.raw.prepare('INSERT INTO transactions(id,type,amount_cents) VALUES (?,?,?)');
    write.run('legacy-consumption', 'consumption', 300);
    write.run('legacy-payment', 'x402_payment', 300);
    expect(await f.report()).toMatchObject({ expenseCents: 0, unverifiedConsumptionCents: 600,
      completeness: { expenseDeduplicationComplete: false, classificationComplete: false } });
  });

  it('requires a stable operation reference for new explicit consumption and payment writes', () => {
    const f = fixture();
    for (const type of ['consumption', 'x402_payment'] as const) {
      expect(() => f.db.insertTransaction({ id: type, type, amountCents: 300, description: '', timestamp: '' })).toThrow(/operation reference/i);
      expect(() => f.db.insertTransaction({ id: type, type, amountCents: 300, operationRef: ' ', description: '', timestamp: '' })).toThrow(/operation reference/i);
    }
  });

  it('migrates v13 payments using proven attempt identities while preserving unknown history', () => {
    const f = fixture();
    const ledger = new PaymentLedger(f.db.raw);
    const id = ledger.reserve({ operationKey: 'migrate', payer: 'payer', recipient: 'provider', asset: 'usdc',
      network: 'eip155:8453', amountAtomic: '3000000', domain: 'example.com', kind: 'x402_fetch' },
      { totalCents: 1000, dailyCents: 1000, maxSingleCents: 1000 });
    ledger.submitted(id, 'nonce'); ledger.confirm(id, 'hash');
    f.db.raw.prepare('INSERT INTO transactions(id,type,amount_cents) VALUES (?,?,?)').run('legacy', 'consumption', 300);
    const hasRef = (f.db.raw.prepare('PRAGMA table_info(transactions)').all() as any[]).some(row => row.name === 'operation_ref');
    if (hasRef) f.db.raw.exec('DROP INDEX idx_transactions_operation_ref; ALTER TABLE transactions DROP COLUMN operation_ref; DELETE FROM schema_version WHERE version>=14');
    const file = f.db.raw.name;
    f.db.close(); databases.splice(databases.indexOf(f.db), 1);
    const restored = createDatabase(file); databases.push(restored);
    expect(restored.getRecentTransactions(2).find(tx => tx.id === `payment:${id}`)?.operationRef).toBe(`payment:${id}`);
    expect(restored.getRecentTransactions(2).find(tx => tx.id === 'legacy')?.operationRef).toBeUndefined();
    expect(restored.raw.prepare('SELECT MAX(version) AS version FROM schema_version').get()).toEqual({ version: 14 });
  });

  it('includes older transactions beyond the most recent 5000 entries', async () => {
    const f = fixture();
    f.add('customer_revenue', 2500);
    f.db.raw.prepare("UPDATE transactions SET created_at='2000-01-01' WHERE type='customer_revenue'").run();
    f.db.raw.transaction(() => { for (let n = 0; n < 5001; n++) f.add('credit_check'); })();
    expect(await f.report()).toMatchObject({
      revenueCents: 2500, transactionCount: 5002,
      completeness: { historyTruncated: false },
    });
  });

  it('flags malformed historical amounts instead of clamping them into valid accounting', async () => {
    const f = fixture();
    f.db.raw.prepare('INSERT INTO transactions(id,type,amount_cents) VALUES (?,?,?)').run('invalid', 'customer_revenue', -100);
    f.db.raw.prepare('INSERT INTO transactions(id,type) VALUES (?,?)').run('missing', 'consumption');
    expect(await f.report()).toMatchObject({
      revenueCents: 0, expenseCents: 0, invalidAmountTransactionCount: 2,
      completeness: { classificationComplete: false, profitComplete: false },
    });
  });

  it('validates new classifications and amounts at the transaction writer while retaining legacy reads', () => {
    const f = fixture();
    expect(() => f.add('mistyped_revenue', 100)).toThrow(/transaction type/i);
    expect(() => f.add('consumption', -1)).toThrow(/amount/i);
    expect(() => f.add('consumption', NaN)).toThrow(/amount/i);
    expect(() => f.add('consumption', Number.MAX_SAFE_INTEGER + 1)).toThrow(/amount/i);
    expect(() => f.add('customer_revenue')).toThrow(/amount/i);
    f.add('consumption', 0.0001);
    expect(f.db.getRecentTransactions(1)[0]).toMatchObject({ type: 'consumption', amountCents: 0.0001 });
  });

  it('records a confirmed child funding transfer within the colony without treating it as consumption', async () => {
    const f = fixture();
    f.db.insertChild({ id: 'child', name: 'Child', address: '0x1111111111111111111111111111111111111111',
      sandboxId: 'child-sandbox', genesisPrompt: '', fundedAmountCents: 0, status: 'healthy', createdAt: new Date().toISOString() });
    const tool = createBuiltinTools('test-sandbox').find(tool => tool.name === 'fund_child')!;
    await tool.execute({ child_id: 'child', amount_cents: 500 }, {
      db: f.db, conway: new MockConwayClient(), config: createTestConfig(), identity: createTestIdentity(),
    } as any);
    expect(f.db.getRecentTransactions(1)[0]).toMatchObject({ type: 'internal_transfer_out', amountCents: 500 });
    expect(await f.report()).toMatchObject({ expenseCents: 0, internalTransfersOutCents: 500, fundedToChildrenCents: 500 });
  });
});
