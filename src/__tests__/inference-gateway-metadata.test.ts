import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConwayClient } from '../conway/client.js';

const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('gateway inference metadata', () => {
  it('keeps declared prices and marks unknown infrastructure prices as estimates', async () => {
    vi.stubGlobal('fetch', async () => response({ data: [
      { id: 'declared', provider: 'conway', available: true, billing_mode: 'infrastructure', pricing: { input_per_million: 1.25, output_per_million: 3.5, source: 'operator_declared' } },
      { id: 'unknown', available: true, billing_mode: 'infrastructure', pricing: { input_per_million: null, output_per_million: null, source: 'unknown_infrastructure_expense' } },
      { id: 'unavailable', available: false, pricing: { input_per_million: 0, output_per_million: 0 } },
    ] }));
    const models = await createConwayClient({ apiUrl: 'http://127.0.0.1:8787', apiKey: 'private', sandboxId: '' }).listModels();
    expect(models.map(m => m.id)).toEqual(['declared', 'unknown']);
    expect(models[0]).toMatchObject({ pricingKnown: true, billingMode: 'infrastructure', pricingSource: 'operator_declared', pricing: { inputPerMillion: 1.25, outputPerMillion: 3.5 } });
    expect(models[1]).toMatchObject({ pricingKnown: false, billingMode: 'infrastructure', pricingSource: 'unknown_infrastructure_expense' });
  });

  it('reads status only from the authenticated gateway with redirect denial and a deadline', async () => {
    const requested: { url: string; options: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: unknown, options: RequestInit) => {
      requested.push({ url: String(url), options });
      return response({ mode: 'remote', state: 'awaiting_budget', ready: false, model: 'declared', billing_mode: 'infrastructure', provider_balance_microusd: null, infrastructure_expense_microusd: null, effective_external_spend_limit_microusd: null, declared_prepaid_allowance_microusd: 0, api_key: 'should-not-be-returned' });
    });
    const client = createConwayClient({ apiUrl: 'http://127.0.0.1:8787', apiKey: 'private', sandboxId: '' });
    const state = await client.getInferenceStatus!();
    expect(state).toMatchObject({ state: 'awaiting_budget', ready: false, provider_balance_microusd: null, infrastructure_expense_microusd: null });
    expect(JSON.stringify(state)).not.toContain('should-not-be-returned');
    expect(requested).toHaveLength(1);
    expect(requested[0].url).toBe('http://127.0.0.1:8787/v1/inference/status');
    expect(requested[0].options.headers).toMatchObject({ Authorization: 'private' });
    expect(requested[0].options.redirect).toBe('error');
    expect(requested[0].options.signal).toBeInstanceOf(AbortSignal);
  });

  it('rejects oversized or invalid status metadata without reporting provider funds', async () => {
    const client = createConwayClient({ apiUrl: 'http://127.0.0.1:8787', apiKey: 'private', sandboxId: '' });
    vi.stubGlobal('fetch', async () => response({ detail: 'x'.repeat(20000) }));
    await expect(client.getInferenceStatus!()).rejects.toThrow(/status response too large/);
    vi.stubGlobal('fetch', async () => response({ ready: true }));
    await expect(client.getInferenceStatus!()).rejects.toThrow(/Invalid inference status/);
  });
});
