import { afterEach, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Hex, type TransactionReceipt } from 'viem';
import { createTestConfig, createTestDb } from './mocks.js';
import { paymentContext } from '../payments/context.js';
import { matchesPayment, reconcilePendingPayments, reconcilePayment } from '../payments/settlement.js';
import { x402Fetch } from '../conway/x402.js';
import { topupCredits } from '../conway/topup.js';
import { BUILTIN_TASKS } from '../heartbeat/tasks.js';

const payer = '0x1111111111111111111111111111111111111111';
const recipient = '0x2222222222222222222222222222222222222222';
const asset = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const hash = `0x${'ab'.repeat(32)}` as Hex;
const nonce = `0x${'cd'.repeat(32)}` as Hex;
const events = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
]);
const handles: ReturnType<typeof createTestDb>[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const db of handles.splice(0)) db.close(); });

function fixture(anchor?: bigint) {
  const db = createTestDb(); handles.push(db);
  const ctx = paymentContext(createTestConfig({ paymentLimits: { totalCents: 1000, dailyCents: 1000, maxSingleCents: 1000 } }), db.raw, 'x402_fetch');
  const id = ctx.ledger.reserve({ operationKey: 'fixture', payer, recipient, asset, network: 'eip155:8453', domain: 'api.conway.tech', kind: 'x402_fetch', amountAtomic: '370000' }, ctx.limits);
  if (anchor !== undefined) ctx.ledger.anchor(id, anchor);
  ctx.ledger.submitted(id, nonce); ctx.ledger.uncertain(id, anchor === undefined ? hash : undefined);
  return { db, ctx, id };
}

function recoveryRpc(options: { finalized?: bigint; logs?: ReturnType<typeof receipt>['logs']; raw?: unknown; fail?: string; proof?: ReturnType<typeof receipt> } = {}) {
  const requests: { method: string; params: any[] }[] = [];
  vi.stubGlobal('fetch', vi.fn((_url, init) => {
    const request = JSON.parse(init.body); requests.push(request);
    if (request.method === options.fail) throw new Error('RPC unavailable');
    const result = request.method === 'eth_getBlockByNumber' ? { number: `0x${(options.finalized ?? 5000n).toString(16)}`, transactions: [] }
      : request.method === 'eth_getLogs' ? ('raw' in options ? options.raw : options.logs ?? [])
      : request.method === 'eth_getTransactionReceipt' ? options.proof ?? receipt() : '0x1389';
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  }));
  return requests;
}

it('scans at most 2000 finalized blocks per wake and resumes the next page without releasing the budget', async () => {
  const { ctx, id } = fixture(100n);
  const requests = recoveryRpc();
  expect(await reconcilePendingPayments(ctx.ledger)).toBe(0);
  expect(ctx.ledger.get(id)).toMatchObject({ status: 'uncertain', scan_next_block: '2100' });
  expect(await reconcilePendingPayments(ctx.ledger)).toBe(0);
  expect(ctx.ledger.get(id)?.scan_next_block).toBe('4100');
  expect(requests.filter(r => r.method === 'eth_getLogs').map(r => r.params[0])).toMatchObject([
    { fromBlock: '0x64', toBlock: '0x833' }, { fromBlock: '0x834', toBlock: '0x1003' },
  ]);
  const used = ctx.ledger.summary() as { budgetCents: number }[];
  expect(used[0].budgetCents).toBe(37);
});

it.each(['eth_getBlockByNumber', 'eth_getLogs', 'eth_getTransactionReceipt'])('keeps the page on %s failure', async fail => {
  const { ctx, id } = fixture(100n);
  recoveryRpc({ fail, logs: [receipt().logs[0]] });
  expect(await reconcilePendingPayments(ctx.ledger)).toBe(0);
  expect(ctx.ledger.get(id)).toMatchObject({ status: 'uncertain', scan_next_block: '100', tx_hash: null });
});

it('waits for finalized history and rejects a candidate with the wrong transfer amount', async () => {
  const { ctx, id } = fixture(100n);
  let requests = recoveryRpc({ finalized: 99n });
  expect(await reconcilePendingPayments(ctx.ledger)).toBe(0);
  expect(requests.some(r => r.method === 'eth_getLogs')).toBe(false);
  requests = recoveryRpc({ logs: [receipt().logs[0]], proof: receipt(nonce, 1n) });
  expect(await reconcilePendingPayments(ctx.ledger)).toBe(0);
  expect(ctx.ledger.get(id)).toMatchObject({ status: 'uncertain', scan_next_block: '100', tx_hash: null });
});

it('does not confirm removed or out-of-range event candidates', async () => {
  const { ctx, id } = fixture(100n);
  recoveryRpc({ logs: [{ ...receipt().logs[0], removed: true }] });
  expect(await reconcilePendingPayments(ctx.ledger)).toBe(0);
  recoveryRpc({ logs: [{ ...receipt().logs[0], blockNumber: '0x63' }] });
  expect(await reconcilePendingPayments(ctx.ledger)).toBe(0);
  expect(ctx.ledger.get(id)?.scan_next_block).toBe('100');
});

it.each(['malformed', 'wrong nonce', 'wrong contract'])('never advances a nonempty page containing %s', async variant => {
  const { ctx, id } = fixture(100n);
  const log = variant === 'malformed' ? { ...receipt().logs[0], topics: [] }
    : variant === 'wrong nonce' ? receipt(hash).logs[0]
    : { ...receipt().logs[0], address: recipient };
  recoveryRpc({ logs: [log] });
  expect(await reconcilePendingPayments(ctx.ledger)).toBe(0);
  expect(ctx.ledger.get(id)).toMatchObject({ scan_next_block: '100', status: 'uncertain', tx_hash: null });
});

it.each(['', null, {}])('rejects a non-array RPC result %j without advancing', async raw => {
  const { ctx, id } = fixture(100n);
  recoveryRpc({ raw });
  expect(await reconcilePendingPayments(ctx.ledger)).toBe(0);
  expect(ctx.ledger.get(id)?.scan_next_block).toBe('100');
});

it('leaves legacy attempts without an anchor held instead of guessing a search range', async () => {
  const { ctx, id, db } = fixture();
  db.raw.prepare('UPDATE payment_attempts SET tx_hash=NULL').run();
  const requests = recoveryRpc();
  expect(await reconcilePendingPayments(ctx.ledger)).toBe(0);
  expect(requests).toHaveLength(0);
  expect(ctx.ledger.get(id)?.status).toBe('uncertain');
});

function receipt(authorizationNonce = nonce, amount = 370000n) {
  const logs = [
    { topics: encodeEventTopics({ abi: events, eventName: 'AuthorizationUsed', args: { authorizer: payer, nonce: authorizationNonce } }), data: '0x' },
    { topics: encodeEventTopics({ abi: events, eventName: 'Transfer', args: { from: payer, to: recipient } }), data: encodeAbiParameters([{ type: 'uint256' }], [amount]) },
  ].map((log, i) => ({ ...log, address: asset, blockHash: hash, blockNumber: '0x64', transactionHash: hash, transactionIndex: '0x0', logIndex: `0x${i}`, removed: false }));
  return { transactionHash: hash, transactionIndex: '0x0', blockHash: hash, blockNumber: '0x64', from: payer, to: asset,
    cumulativeGasUsed: '0x5208', gasUsed: '0x5208', effectiveGasPrice: '0x1', contractAddress: null,
    logs, logsBloom: `0x${'00'.repeat(256)}`, status: '0x1', type: '0x2' };
}
function typedReceipt(): TransactionReceipt {
  return { ...receipt(), status: 'success', blockNumber: 100n } as unknown as TransactionReceipt;
}
function rpcReply(body: string, value = receipt(), head = '0x65') {
  const request = JSON.parse(body);
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id,
    result: request.method === 'eth_getTransactionReceipt' ? value
      : request.method === 'eth_getBlockByNumber' ? { number: '0x64', hash, transactions: [] } : head }));
}

it('recovers a lost HTTP response automatically from its authorization nonce without another signature', async () => {
  const db = createTestDb(); handles.push(db);
  const ctx = paymentContext(createTestConfig({ paymentLimits: { totalCents: 100, dailyCents: 100, maxSingleCents: 100 } }), db.raw, 'x402_fetch');
  let signedNonce = nonce;
  const signer = { address: payer, signTypedData: vi.fn(async args => { signedNonce = args.message.nonce; return '0xsignature'; }) } as any;
  const requests: any[] = [];
  const network = vi.fn((url, init) => {
    if (String(url).includes('api.conway.tech')) {
      if (new Headers(init.headers).has('X-Payment')) throw new Error('response lost after debit');
      return new Response(JSON.stringify({ x402Version: 1, accepts: [{ scheme: 'exact', network: 'base', maxAmountRequired: '370000', payTo: recipient, asset }] }), { status: 402 });
    }
    const request = JSON.parse(init.body); requests.push(request);
    const result = request.method === 'eth_getBlockByNumber' ? { number: '0x64', hash, transactions: [] }
      : request.method === 'eth_getLogs' ? [receipt(signedNonce).logs[0]]
      : request.method === 'eth_getTransactionReceipt' ? receipt(signedNonce) : '0x65';
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  });
  vi.stubGlobal('fetch', network);
  const first = await x402Fetch('https://api.conway.tech/data', signer, 'GET', undefined, undefined, 100, undefined, ctx);
  expect(first.paymentStatus).toBe('uncertain');
  expect(await reconcilePendingPayments(ctx.ledger)).toBe(1);
  expect(ctx.ledger.get(first.attemptId!)?.status).toBe('confirmed');
  expect(ctx.ledger.get(first.attemptId!)?.fulfilled).toBe(0);
  expect(requests.find(r => r.method === 'eth_getLogs').params[0]).toMatchObject({ address: asset, fromBlock: '0x64', toBlock: '0x64' });
  await x402Fetch('https://api.conway.tech/data', signer, 'GET', undefined, undefined, 100, undefined, ctx);
  expect(signer.signTypedData).toHaveBeenCalledTimes(1);
});

it('requires the precise token, payer, recipient, amount, authorization nonce and successful receipt', () => {
  const { ctx, id } = fixture();
  const row = ctx.ledger.get(id)!;
  expect(matchesPayment(row, typedReceipt())).toBe(true);
  for (const patch of [{ payer: recipient }, { recipient: payer }, { asset: payer }, { amount_atomic: '1' }, { nonce: hash }, { tx_hash: nonce }]) {
    expect(matchesPayment({ ...row, ...patch }, typedReceipt())).toBe(false);
  }
  expect(matchesPayment(row, { ...typedReceipt(), status: 'reverted' })).toBe(false);
  expect(matchesPayment(row, { ...typedReceipt(), logs: typedReceipt().logs.slice(1) })).toBe(false);
});

it('keeps a one-block receipt held and reconciles a later receipt exactly once', async () => {
  const { ctx, id, db } = fixture();
  let head = '0x64';
  vi.stubGlobal('fetch', vi.fn((_url, init) => rpcReply(init.body, receipt(), head)));
  expect(await reconcilePendingPayments(ctx.ledger)).toBe(0);
  expect(ctx.ledger.get(id)?.status).toBe('uncertain');
  head = '0x65';
  expect(await reconcilePendingPayments(ctx.ledger)).toBe(1);
  expect(await reconcilePendingPayments(ctx.ledger)).toBe(0);
  expect(db.raw.prepare('SELECT amount_cents FROM spend_tracking').all()).toEqual([{ amount_cents: 37 }]);
});

it('does not starve later pending payments when earlier receipts stay unavailable', async () => {
  const { ctx } = fixture();
  for (let i = 0; i < 3; i++) {
    const id = ctx.ledger.reserve({ operationKey: String(i), payer, recipient, asset, network: 'eip155:8453', domain: 'api.conway.tech', kind: 'x402_fetch', amountAtomic: '370000' }, ctx.limits);
    ctx.ledger.submitted(id, nonce); ctx.ledger.uncertain(id, hash);
  }
  vi.stubGlobal('fetch', vi.fn((_url, init) => rpcReply(init.body, receipt(), '0x64')));
  await reconcilePendingPayments(ctx.ledger);
  await reconcilePendingPayments(ctx.ledger);
  const rows = ctx.ledger.pending();
  expect(rows).toHaveLength(4);
  expect(rows.every(row => (row as unknown as { checked_at: string }).checked_at)).toBe(true);
});

it.each([1, 2])('settles a full x402 v%s request using its signed nonce and exact amount', async version => {
  const { ctx, db } = fixture();
  let signedNonce = nonce;
  const signer = { address: payer, signTypedData: vi.fn(async args => { signedNonce = args.message.nonce; return '0xsignature'; }) } as any;
  const wire = { scheme: 'exact', network: version === 1 ? 'base' : 'eip155:8453',
    ...(version === 1 ? { maxAmountRequired: '370000' } : { amount: '370000' }), payTo: recipient, asset, maxTimeoutSeconds: 60 };
  let paid = false;
  vi.stubGlobal('fetch', vi.fn((url, init) => {
    if (String(url).includes('api.conway.tech')) {
      const header = new Headers(init.headers).get(version === 1 ? 'X-Payment' : 'PAYMENT-SIGNATURE');
      if (!header) return new Response(JSON.stringify({ x402Version: version, accepts: [wire] }), { status: 402 });
      const payload = JSON.parse(Buffer.from(header, 'base64').toString());
      expect(payload.payload.authorization.value).toBe('370000');
      expect(payload.payload.authorization.nonce).toBe(signedNonce);
      if (version === 2) expect(payload.accepted).toEqual(wire);
      else expect(payload.network).toBe('base');
      paid = true;
      return new Response(JSON.stringify({ delivered: true }), { headers: { 'PAYMENT-RESPONSE': Buffer.from(JSON.stringify({ success: true, transaction: hash })).toString('base64') } });
    }
    return rpcReply(init.body, receipt(signedNonce));
  }));
  const result = await x402Fetch('https://api.conway.tech/data', signer, 'GET', undefined, undefined, 100, undefined, ctx);
  expect(paid).toBe(true);
  expect(result).toMatchObject({ success: true, paymentStatus: 'confirmed', amountAtomic: '370000' });
  expect(db.raw.prepare('SELECT amount_cents FROM spend_tracking').all()).toEqual([{ amount_cents: 37 }]);
  const again = await x402Fetch('https://api.conway.tech/data#retry', signer, 'GET', undefined, undefined, 100, undefined, ctx);
  expect(again).toMatchObject({ success: true, replayed: true, response: { delivered: true }, attemptId: result.attemptId });
  expect(signer.signTypedData).toHaveBeenCalledTimes(1);
  expect(db.raw.prepare('SELECT response_json FROM payment_attempts WHERE id=?').get(result.attemptId)).toEqual({ response_json: '{"delivered":true}' });
  const fresh = await x402Fetch('https://api.conway.tech/data', signer, 'GET', undefined, undefined, 100, undefined, { ...ctx, purchaseId: 'explicit-next-purchase' });
  expect(fresh.success).toBe(true);
  expect(signer.signTypedData).toHaveBeenCalledTimes(2);
});

it('reconciles a lost hash only when independent evidence matches the stored nonce', async () => {
  const { ctx, db, id } = fixture();
  db.raw.prepare('UPDATE payment_attempts SET tx_hash=NULL WHERE id=?').run(id);
  let proofNonce = hash;
  vi.stubGlobal('fetch', vi.fn((_url, init) => rpcReply(init.body, receipt(proofNonce))));
  expect(await reconcilePayment(ctx.ledger, id, hash)).toBe(false);
  expect(ctx.ledger.get(id)?.tx_hash).toBeNull();
  proofNonce = nonce;
  expect(await reconcilePayment(ctx.ledger, id, hash)).toBe(true);
  expect(ctx.ledger.get(id)).toMatchObject({ status: 'confirmed', tx_hash: hash, fulfilled: 0 });
  expect(await reconcilePayment(ctx.ledger, id, nonce)).toBe(false);
  expect(() => ctx.ledger.reserve({ operationKey: 'fixture', purchaseId: 'new', payer, recipient, asset, network: 'eip155:8453', domain: 'api.conway.tech', kind: 'x402_fetch', amountAtomic: '370000' }, ctx.limits)).toThrow(/unresolved/i);
});

it('heartbeat wakes after a verified debit and skips external lookups in standalone', async () => {
  const { db } = fixture();
  const fetch = vi.fn((_url, init) => rpcReply(init.body));
  vi.stubGlobal('fetch', fetch);
  const taskCtx = { db, config: createTestConfig({ standalone: true }) } as any;
  expect(await BUILTIN_TASKS.reconcile_payments({} as any, taskCtx)).toEqual({ shouldWake: false });
  expect(fetch).not.toHaveBeenCalled();
  taskCtx.config.standalone = false;
  expect(await BUILTIN_TASKS.reconcile_payments({} as any, taskCtx)).toMatchObject({ shouldWake: true });
});

it.each([false, true])('a confirmed topup does not repay on retry (delivered=%s)', async delivered => {
  const { ctx, db } = fixture();
  let signedNonce = nonce;
  const signer = { address: payer, signTypedData: vi.fn(async args => { signedNonce = args.message.nonce; return '0xsignature'; }) } as any;
  vi.stubGlobal('fetch', vi.fn((url, init) => {
    if (!String(url).includes('api.conway.tech')) return rpcReply(init.body, receipt(signedNonce, 5000000n));
    if (!new Headers(init.headers).has('X-Payment')) return new Response(JSON.stringify({ x402Version: 1, accepts: [{ scheme: 'exact', network: 'base', maxAmountRequired: '5000000', payTo: recipient, asset }] }), { status: 402 });
    return new Response(JSON.stringify(delivered ? { credits_cents: 500 } : {}), { headers: { 'X-PAYMENT-RESPONSE': Buffer.from(JSON.stringify({ transaction: hash })).toString('base64') } });
  }));
  const result = await topupCredits('https://api.conway.tech', signer, 5, undefined, ctx);
  expect(result).toMatchObject({ success: delivered, paymentStatus: 'confirmed' });
  const retry = await topupCredits('https://api.conway.tech', signer, 5, undefined, ctx);
  if (delivered) {
    expect(retry).toMatchObject({ success: true, replayed: true, creditsCentsAdded: 500 });
    const calls = vi.mocked(fetch).mock.calls.length;
    const changedTier = await x402Fetch(`https://api.conway.tech/pay/25/${payer}`, signer, 'GET', undefined, undefined, 2500, undefined, ctx);
    expect(changedTier).toMatchObject({ success: false, error: expect.stringMatching(/different request/) });
    const changedRecipient = await topupCredits('https://api.conway.tech', signer, 5, recipient, ctx);
    expect(changedRecipient.success).toBe(false);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(calls);
  }
  expect(signer.signTypedData).toHaveBeenCalledTimes(1);
  expect(db.raw.prepare('SELECT amount_cents FROM transactions').all()).toEqual([{ amount_cents: 500 }]);
});
