import type { AutomatonConfig, ModelInfo } from '../types.js';
import { ProviderRegistry, type ModelTier } from '../inference/provider-registry.js';
import type { ModelRegistry } from '../inference/registry.js';

/** Use one explicit gateway for planner/workers, never ambient provider credentials. */
export function createStandaloneRegistry(config: AutomatonConfig, model?: ModelInfo | null): ProviderRegistry {
  const rates = modelRates(model);
  const tiers: ModelTier[] = ['reasoning', 'fast', 'cheap'];
  return new ProviderRegistry([{
    id: 'standalone', name: 'Local gateway', baseUrl: `${config.conwayApiUrl.replace(/\/$/, '')}/v1`,
    apiKeyEnvVar: 'UNUSED_STANDALONE_KEY', priority: 1, enabled: true,
    maxRequestsPerMinute: 60, maxTokensPerMinute: 100_000,
    models: tiers.map(tier => ({
      id: config.inferenceModel, tier, contextWindow: 32768,
      maxOutputTokens: config.maxTokensPerTurn,
      costPerInputToken: rates.input / 10, costPerOutputToken: rates.output / 10,
      supportsTools: true, supportsVision: false, supportsStreaming: false,
    })),
  }], {
    reasoning: { preferredProvider: 'standalone', fallbackOrder: [] },
    fast: { preferredProvider: 'standalone', fallbackOrder: [] },
    cheap: { preferredProvider: 'standalone', fallbackOrder: [] },
  }, 0, { standalone: config.conwayApiKey });
}

/** Disable the paid baseline before selecting a model in the native inference router. */
export function configureStandaloneModels(registry: ModelRegistry, config: AutomatonConfig, model?: ModelInfo | null): void {
  for (const model of registry.getAll()) registry.setEnabled(model.modelId, false);
  const rates = modelRates(model);
  const now = new Date().toISOString();
  registry.upsert({
    modelId: config.inferenceModel, provider: 'conway', displayName: config.inferenceModel,
    tierMinimum: 'dead', costPer1kInput: rates.input * 10, costPer1kOutput: rates.output * 10,
    maxTokens: config.maxTokensPerTurn, contextWindow: 32768,
    supportsTools: true, supportsVision: false, parameterStyle: 'max_tokens',
    enabled: model?.available !== false, lastSeen: now, createdAt: now, updatedAt: now,
  });
}

/** Computational estimates only. Missing rates use a numeric routing placeholder;
 * startup accounting retains pricingKnown:false and actual expense unknown.
 * Native rates are hundredths of cents/1k; worker rates are credits/1k (100 credits/USD).
 */
function modelRates(model?: ModelInfo | null): { input: number; output: number } {
  const valid = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  if (model?.pricingKnown === false || !valid(model?.pricing?.inputPerMillion) || !valid(model?.pricing?.outputPerMillion)) return { input: 0, output: 0 };
  return { input: model.pricing.inputPerMillion, output: model.pricing.outputPerMillion };
}
