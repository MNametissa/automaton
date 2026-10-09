import { afterAll, afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase } from '../state/database.js';
import { PaymentLedger } from '../payments/ledger.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payment-ledger-'));
const handles: Database.Database[] = [];
afterEach(() => { for (const db of handles.splice(0)) db.close(); });
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const limits = { totalCents: 100, dailyCents: 100, maxSingleCents: 100 };
const quote = { operationKey: 'op', payer: 'payer', recipient: 'recipient', asset: 'asset', network: 'eip155:8453', amountAtomic: '370000', domain: 'example.com', kind: 'x402_fetch' };
function open() {
  const file = path.join(dir, `${Math.random()}.db`);
  const state = createDatabase(file); handles.push(state.raw);
  return { file, db: state.raw, ledger: new PaymentLedger(state.raw) };
}

it('reserves across connections and retains uncertain spend across a restart', () => {
  const { file, ledger } = open();
  const second = new Database(file); handles.push(second);
  const other = new PaymentLedger(second);
  const id = ledger.reserve({ ...quote, amountAtomic: '600000' }, limits);
  ledger.submitted(id, 'nonce');
  ledger.uncertain(id);
  expect(() => other.reserve({ ...quote, operationKey: 'other', amountAtomic: '600000' }, limits)).toThrow(/budget/i);
  expect(() => other.reserve(quote, limits)).toThrow(/unresolved/i);
  expect(other.get(id)?.status).toBe('uncertain');
  for (const connection of handles.splice(0)) connection.close();
  const restarted = createDatabase(file); handles.push(restarted.raw);
  const restored = new PaymentLedger(restarted.raw);
  expect(restored.get(id)?.status).toBe('uncertain');
  expect(() => restored.reserve(quote, limits)).toThrow(/unresolved/i);
});

it('records the exact amount once and releases only a pre-send failure', () => {
  const { db, ledger } = open();
  const id = ledger.reserve(quote, limits);
  ledger.submitted(id, 'nonce');
  ledger.confirm(id, '0xhash'); ledger.confirm(id, '0xhash');
  expect(db.prepare('SELECT amount_cents FROM spend_tracking').all()).toEqual([{ amount_cents: 37 }]);
  expect(db.prepare('SELECT amount_cents FROM transactions').all()).toEqual([{ amount_cents: 37 }]);
  expect(() => ledger.release(id)).toThrow(/state/i);
  ledger.fulfilled(id);
  const next = ledger.reserve({ ...quote, operationKey: 'new' }, limits);
  ledger.release(next);
  expect(ledger.get(next)?.status).toBe('released');
});

it('unresolved reservations still consume the next day budget', () => {
  const { db, ledger } = open();
  ledger.reserve({ ...quote, amountAtomic: '800000' }, limits);
  db.prepare("UPDATE payment_attempts SET created_at = '2000-01-01T00:00:00.000Z'").run();
  expect(() => ledger.reserve({ ...quote, operationKey: 'next' }, { ...limits, totalCents: 1000 })).toThrow(/budget/i);
});

it('defaults to zero and rejects invalid budgets before reservation', () => {
  const { ledger } = open();
  expect(() => ledger.reserve(quote, { totalCents: 0, dailyCents: 0, maxSingleCents: 0 })).toThrow(/budget/i);
  expect(() => ledger.reserve(quote, { ...limits, totalCents: NaN })).toThrow(/budget/i);
  expect(() => ledger.reserve(quote, { maxSingleCents: 100 } as any)).toThrow(/budget/i);
});

it('rounds reservations up while recording exact fractional cents', () => {
  const { db, ledger } = open();
  const id = ledger.reserve({ ...quote, amountAtomic: '1' }, limits);
  expect(ledger.get(id)?.reserved_cents).toBe(1);
  ledger.submitted(id, 'nonce'); ledger.confirm(id, 'hash');
  expect(db.prepare('SELECT amount_cents FROM spend_tracking').get()).toEqual({ amount_cents: 0.0001 });
});

it('migrates an existing v11 database without losing state', () => {
  const { db, file } = open();
  db.prepare("INSERT INTO kv (key,value) VALUES ('keep','existing')").run();
  db.exec('DROP TABLE payment_attempts; DELETE FROM schema_version WHERE version=12');
  db.close(); handles.splice(handles.indexOf(db), 1);
  const upgraded = createDatabase(file); handles.push(upgraded.raw);
  expect(upgraded.getKV('keep')).toBe('existing');
  const ledger = new PaymentLedger(upgraded.raw);
  expect(ledger.get(ledger.reserve(quote, limits))?.status).toBe('reserved');
  expect(upgraded.raw.prepare('SELECT MAX(version) AS version FROM schema_version').get()).toEqual({ version: 12 });
});

it('restores paid content after restart without authorizing another identical purchase', () => {
  const { db, ledger, file } = open();
  const id = ledger.reserve(quote, limits);
  ledger.submitted(id, 'nonce');
  ledger.delivery(id, { result: 'paid content' }, 200, true);
  ledger.confirm(id, 'hash');
  db.close(); handles.splice(handles.indexOf(db), 1);
  const restored = createDatabase(file); handles.push(restored.raw);
  const next = new PaymentLedger(restored.raw);
  expect(next.completed('op')).toMatchObject({ id, response_json: '{"result":"paid content"}', response_status: 200 });
  expect(() => next.reserve(quote, limits)).toThrow(/unresolved/i);
  expect(next.reserve({ ...quote, purchaseId: 'deliberate-next-purchase' }, limits)).toBeTruthy();
});
