import { expect, it } from 'vitest';
import { createTestConfig, createTestDb } from './mocks.js';
import { configureStandaloneModels, createStandaloneRegistry } from '../standalone/runtime.js';
import { ModelRegistry } from '../inference/registry.js';

it('propagates declared USD per million rates to native and worker gateway estimates', () => {
  const config = { ...createTestConfig(), standalone: true, inferenceModel: 'declared' };
  const model = { id: 'declared', provider: 'conway', pricing: { inputPerMillion: 1.5, outputPerMillion: 4 }, pricingKnown: true, pricingSource: 'operator_declared', billingMode: 'infrastructure' };
  const db = createTestDb();
  try {
    const registry = new ModelRegistry(db.raw); registry.initialize();
    configureStandaloneModels(registry, config, model);
    expect(registry.get('declared')).toMatchObject({ costPer1kInput: 15, costPer1kOutput: 40 });
    const workerRegistry = createStandaloneRegistry(config, model);
    for (const tier of ['cheap', 'fast', 'reasoning'] as const) {
      expect(workerRegistry.resolveModel(tier).model).toMatchObject({ costPerInputToken: 0.15, costPerOutputToken: 0.4 });
    }
  } finally { db.close(); }
});

it('does not present unknown infrastructure cost as a free model in tool discovery', async () => {
  const { createBuiltinTools } = await import('../agent/tools.js');
  const db = createTestDb();
  const config = { ...createTestConfig(), standalone: true, inferenceModel: 'unknown' };
  try {
    const registry = new ModelRegistry(db.raw); registry.initialize();
    configureStandaloneModels(registry, config);
    const output = await createBuiltinTools('').find(tool => tool.name === 'list_models')!.execute({}, {
      db, config, conway: { listModels: async () => [{ id: 'unknown', provider: 'conway', pricing: { inputPerMillion: 0, outputPerMillion: 0 }, pricingKnown: false, billingMode: 'infrastructure' }] },
    } as any);
    expect(output).toContain('unknown');
    expect(output).toContain('cost unknown');
    expect(output).not.toContain('$0');
    expect(output).not.toContain('cost: 0/0');
  } finally { db.close(); }
});
