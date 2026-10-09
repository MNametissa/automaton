import { afterEach, expect, it, vi } from 'vitest';
import { createTestDb, createTestConfig } from './mocks.js';
import { x402Fetch } from '../conway/x402.js';
import { topupCredits } from '../conway/topup.js';
import { paymentContext } from '../payments/context.js';
import { parseMaxAmountRequired } from '../conway/x402-protocol.js';

const payer = '0x1111111111111111111111111111111111111111';
const recipient = '0x2222222222222222222222222222222222222222';
const asset = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const handles: ReturnType<typeof createTestDb>[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const db of handles.splice(0)) db.close(); });
function fixture() {
  const db = createTestDb(); handles.push(db);
  const config = createTestConfig({ paymentLimits: { maxSingleCents: 1000, dailyCents: 1000, totalCents: 1000 } });
  const ctx = paymentContext(config, db.raw, 'x402_fetch');
  const signer = { address: payer, signTypedData: vi.fn().mockResolvedValue('0xsignature') } as any;
  return { db, ctx, signer };
}
function quote(amount = '370000') {
  return reply({ x402Version: 1, accepts: [{ scheme: 'exact', network: 'base', maxAmountRequired: amount, asset, payTo: recipient, maxTimeoutSeconds: 60 }] }, 402);
}

it('uses atomic units for small v1 amounts, never guessed dollars', () => {
  expect(parseMaxAmountRequired('370000', 1)).toBe(370000n);
  expect(() => parseMaxAmountRequired('0.37', 1)).toThrow();
});
it('will not sign without an explicit durable budget', async () => {
  const { signer } = fixture();
  vi.stubGlobal('fetch', vi.fn().mockImplementation(() => quote()));
  expect((await x402Fetch('https://api.conway.tech/data', signer)).success).toBe(false);
  expect(signer.signTypedData).not.toHaveBeenCalled();
});
it('blocks a topup quote exceeding the requested amount before signing', async () => {
  const { signer, ctx } = fixture();
  vi.stubGlobal('fetch', vi.fn().mockImplementation(() => quote('6000000')));
  const result = await topupCredits('https://api.conway.tech', signer, 5, undefined, ctx);
  expect(result.success).toBe(false);
  expect(signer.signTypedData).not.toHaveBeenCalled();
});
it('retains an uncertain payment and prevents a new signature on retry', async () => {
  const { signer, ctx, db } = fixture();
  const fetch = vi.fn().mockImplementationOnce(() => quote()).mockRejectedValueOnce(new Error('connection lost')).mockImplementation(() => quote());
  vi.stubGlobal('fetch', fetch);
  const first = await x402Fetch('https://api.conway.tech/data', signer, 'GET', undefined, undefined, 100, undefined, ctx);
  expect(first.paymentStatus).toBe('uncertain');
  expect(db.raw.prepare('SELECT status FROM payment_attempts').get()).toEqual({ status: 'uncertain' });
  await x402Fetch('https://api.conway.tech/data', signer, 'GET', undefined, undefined, 100, undefined, ctx);
  expect(signer.signTypedData).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[1][1]).toMatchObject({ redirect: 'error', retries: 0 });
});
it('does not treat HTTP success as a confirmed payment or invent credits', async () => {
  const { signer, ctx } = fixture();
  vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => quote('5000000')).mockResolvedValueOnce(reply({})));
  const result = await topupCredits('https://api.conway.tech', signer, 5, undefined, ctx);
  expect(result.success).toBe(false);
  expect(result.creditsCentsAdded).toBeUndefined();
});
it('releases a failed signature before any paid request', async () => {
  const { signer, ctx, db } = fixture(); signer.signTypedData.mockRejectedValue(new Error('signer offline'));
  const fetch = vi.fn().mockImplementation(() => quote()); vi.stubGlobal('fetch', fetch);
  await x402Fetch('https://api.conway.tech/data', signer, 'GET', undefined, undefined, 100, undefined, ctx);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(db.raw.prepare('SELECT status FROM payment_attempts').get()).toEqual({ status: 'released' });
});
it('records no payment for a free response', async () => {
  const { signer, ctx, db } = fixture();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ free: true })));
  expect((await x402Fetch('https://api.conway.tech/data', signer, 'GET', undefined, undefined, 100, undefined, ctx)).success).toBe(true);
  expect(db.raw.prepare('SELECT * FROM payment_attempts').all()).toEqual([]);
  expect(signer.signTypedData).not.toHaveBeenCalled();
});

it('shares the topup hold with generic fetch and ignores URL fragments', async () => {
  const { signer, ctx } = fixture();
  vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => quote('5000000')).mockRejectedValueOnce(new Error('lost')).mockImplementation(() => quote('5000000')));
  await topupCredits('https://api.conway.tech', signer, 5, undefined, ctx);
  await x402Fetch(`https://api.conway.tech/pay/5/${payer}#retry`, signer, 'GET', undefined, undefined, 500, undefined, ctx);
  await x402Fetch(`https://api.conway.tech/pay/5/${payer}`, signer, 'GET', undefined, undefined, 500, undefined, { ...ctx, purchaseId: 'different' });
  expect(signer.signTypedData).toHaveBeenCalledTimes(1);
});

it.each(['permit2', 'erc7710', 'unknown'])('rejects unsupported transfer method %s before signing', async assetTransferMethod => {
  const { signer, ctx } = fixture();
  vi.stubGlobal('fetch', vi.fn(() => reply({ x402Version: 2, accepts: [{ scheme: 'exact', network: 'eip155:8453', amount: '370000', payTo: recipient, asset, extra: { assetTransferMethod } }] }, 402)));
  await x402Fetch('https://api.conway.tech/data', signer, 'GET', undefined, undefined, 100, undefined, ctx);
  expect(signer.signTypedData).not.toHaveBeenCalled();
});

it('signs the correct USDC domain on Base Sepolia', async () => {
  const { signer, ctx } = fixture();
  vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => reply({ x402Version: 2, accepts: [{ scheme: 'exact', network: 'eip155:84532', amount: '370000', payTo: recipient, asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', extra: { name: 'USDC', version: '2' } }] }, 402)).mockResolvedValueOnce(reply({})));
  await x402Fetch('https://api.conway.tech/data', signer, 'GET', undefined, undefined, 100, undefined, ctx);
  expect(signer.signTypedData.mock.calls[0][0].domain).toMatchObject({ name: 'USDC', version: '2', chainId: 84532 });
});

it.each(['http://api.conway.tech/data', 'https://evil.example/data'])('does not pay an unauthorized destination %s', async url => {
  const { signer, ctx } = fixture();
  vi.stubGlobal('fetch', vi.fn(() => quote()));
  await x402Fetch(url, signer, 'GET', undefined, undefined, 100, undefined, ctx);
  expect(signer.signTypedData).not.toHaveBeenCalled();
});

it.each(['escrow', 'upfront'])('does not sign unsupported payment flow %s', async paymentFlow => {
  const { signer, ctx } = fixture();
  vi.stubGlobal('fetch', vi.fn(() => reply({ x402Version: 2, accepts: [{ scheme: 'exact', network: 'eip155:8453', amount: '370000', payTo: recipient, asset, extra: { paymentFlow } }] }, 402)));
  await x402Fetch('https://api.conway.tech/data', signer, 'GET', undefined, undefined, 100, undefined, ctx);
  expect(signer.signTypedData).not.toHaveBeenCalled();
});

it('enforces zero in standalone even if paid limits were configured', async () => {
  const { signer, db } = fixture();
  const ctx = paymentContext(createTestConfig({ standalone: true, paymentLimits: { totalCents: 1000, dailyCents: 1000, maxSingleCents: 1000 } }), db.raw, 'x402_fetch');
  vi.stubGlobal('fetch', vi.fn(() => quote()));
  expect((await x402Fetch('https://api.conway.tech/data', signer, 'GET', undefined, undefined, 100, undefined, ctx)).success).toBe(false);
  expect(signer.signTypedData).not.toHaveBeenCalled();
});
