import type { AutomatonConfig } from '../types.js';
import { ProviderRegistry, type ModelTier } from '../inference/provider-registry.js';
import type { ModelRegistry } from '../inference/registry.js';

/** Use one explicit gateway for planner/workers, never ambient provider credentials. */
export function createStandaloneRegistry(config: AutomatonConfig): ProviderRegistry {
  const tiers: ModelTier[] = ['reasoning', 'fast', 'cheap'];
  return new ProviderRegistry([{
    id: 'standalone', name: 'Local gateway', baseUrl: `${config.conwayApiUrl.replace(/\/$/, '')}/v1`,
    apiKeyEnvVar: 'UNUSED_STANDALONE_KEY', priority: 1, enabled: true,
    maxRequestsPerMinute: 60, maxTokensPerMinute: 100_000,
    models: tiers.map(tier => ({
      id: config.inferenceModel, tier, contextWindow: 32768,
      maxOutputTokens: config.maxTokensPerTurn,
      costPerInputToken: 0, costPerOutputToken: 0,
      supportsTools: true, supportsVision: false, supportsStreaming: false,
    })),
  }], {
    reasoning: { preferredProvider: 'standalone', fallbackOrder: [] },
    fast: { preferredProvider: 'standalone', fallbackOrder: [] },
    cheap: { preferredProvider: 'standalone', fallbackOrder: [] },
  }, 0, { standalone: config.conwayApiKey });
}

/** Disable the paid baseline before selecting a model in the native inference router. */
export function configureStandaloneModels(registry: ModelRegistry, config: AutomatonConfig): void {
  for (const model of registry.getAll()) registry.setEnabled(model.modelId, false);
  const now = new Date().toISOString();
  registry.upsert({
    modelId: config.inferenceModel, provider: 'conway', displayName: config.inferenceModel,
    tierMinimum: 'dead', costPer1kInput: 0, costPer1kOutput: 0,
    maxTokens: config.maxTokensPerTurn, contextWindow: 32768,
    supportsTools: true, supportsVision: false, parameterStyle: 'max_tokens',
    enabled: true, lastSeen: now, createdAt: now, updatedAt: now,
  });
}
