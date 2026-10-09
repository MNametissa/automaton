import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConwayClient } from '../conway/client.js';
import { createInferenceClient } from '../conway/inference.js';
import { ResilientHttpClient } from '../conway/http-client.js';
import { createSocialClient } from '../social/client.js';
import { privateKeyToAccount } from 'viem/accounts';
import { generatePrivateKey } from 'viem/accounts';
import { executeTool, createBuiltinTools } from '../agent/tools.js';
import { startupAssessmentResponses } from './startup-audit-fixtures.js';

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('standalone boundaries', () => {
  it('discovers custom models without sending its key to Conway', async () => {
    const destinations: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => { destinations.push(String(url)); return json({ data: [{ id: 'local', provider: 'conway' }] }); });
    const client = createConwayClient({ apiUrl: 'https://gateway.example', apiKey: 'local-secret', sandboxId: '' });
    expect((await client.listModels())[0].id).toBe('local');
    expect(destinations).toEqual(['https://gateway.example/v1/models']);
  });
  it('uses an explicit loopback control plane', async () => {
    vi.stubGlobal('fetch', async () => json({ balance_cents: 37 }));
    const client = createConwayClient({ apiUrl: 'http://127.0.0.1:8787', apiKey: 'local-secret', sandboxId: '' });
    expect(await client.getCreditsBalance()).toBe(37);
  });
  it('accepts bracketed IPv6 loopback but rejects remote HTTP', async () => {
    vi.stubGlobal('fetch', async () => json({ ok: true }));
    const client = new ResilientHttpClient({ allowHttpOnLoopback: true, maxRetries: 0 });
    expect((await client.request('http://[::1]:8787/health')).status).toBe(200);
    await expect(client.request('http://example.com/health')).rejects.toThrow('HTTPS required');
  });
  it('relays inference through an explicit loopback gateway', async () => {
    vi.stubGlobal('fetch', async () => json({ choices: [{ message: { role: 'assistant', content: 'answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    const client = createInferenceClient({ apiUrl: 'http://127.0.0.1:8787', apiKey: 'local-secret', defaultModel: 'local', maxTokens: 10 });
    expect((await client.chat([{ role: 'user', content: 'question' }])).message.content).toBe('answer');
  });
  it('supports local messaging without permitting remote cleartext', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    vi.stubGlobal('fetch', async () => json({ unread: 2 }));
    expect(await createSocialClient('http://127.0.0.1:8787', account).unreadCount()).toBe(2);
    expect(() => createSocialClient('http://example.com', account)).toThrow('HTTPS');
  });
  it('loads isolated state and standalone overrides without inherited paid keys', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-config-')); dirs.push(dir);
    vi.stubEnv('AUTOMATON_DIR', dir);
    vi.stubEnv('CONWAY_API_URL', 'http://127.0.0.1:8787');
    fs.writeFileSync(path.join(dir, 'automaton.json'), JSON.stringify({ name: 'test', standalone: true, conwayApiKey: 'local-key', conwayApiUrl: 'https://old.example', openaiApiKey: 'old-key', inferenceModel: 'local', dbPath: '/old/state.db', skillsDir: '/old/skills', heartbeatConfigPath: '/old/heartbeat.yml' }));
    vi.resetModules();
    const { loadConfig } = await import('../config.js');
    const config = loadConfig();
    expect(config?.conwayApiUrl).toBe('http://127.0.0.1:8787');
    expect(config?.socialRelayUrl).toBe('http://127.0.0.1:8787');
    expect(config?.dbPath).toBe(path.join(dir, 'state.db'));
    expect(config?.skillsDir).toBe(path.join(dir, 'skills'));
    expect(config?.heartbeatConfigPath).toBe(path.join(dir, 'heartbeat.yml'));
    expect(config?.openaiApiKey).toBeUndefined();
    expect(config?.anthropicApiKey).toBeUndefined();
  });
  it('blocks financial and remote resource tools in the zero-spend profile', async () => {
    let executed = false;
    const tool = { name: 'topup_credits', execute: async () => { executed = true; return 'paid'; } } as any;
    const result = await executeTool('topup_credits', {}, [tool], { config: { standalone: true } } as any);
    expect(result.error).toMatch(/standalone/i);
    expect(executed).toBe(false);
  });
});

describe('standalone runtime integration', () => {
  it('keeps planning and all model tiers on the local gateway despite ambient keys', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'ambient-paid-key');
    vi.stubEnv('GROQ_API_KEY', 'ambient-paid-key');
    const { createStandaloneRegistry, configureStandaloneModels } = await import('../standalone/runtime.js');
    const { createTestDb, createTestConfig } = await import('./mocks.js');
    const { ModelRegistry } = await import('../inference/registry.js');
    const { InferenceRouter } = await import('../inference/router.js');
    const { InferenceBudgetTracker } = await import('../inference/budget.js');
    const { DEFAULT_MODEL_STRATEGY_CONFIG } = await import('../types.js');
    const config = { ...createTestConfig(), standalone: true, conwayApiUrl: 'http://127.0.0.1:8787', conwayApiKey: 'local-key', inferenceModel: 'local' };
    const providers = createStandaloneRegistry(config);
    for (const tier of ['reasoning', 'fast', 'cheap'] as const) {
      const resolved = providers.resolveModel(tier);
      expect(resolved.model.id).toBe('local');
      expect(resolved.client.baseURL).toBe('http://127.0.0.1:8787/v1');
      expect(resolved.client.apiKey).toBe('local-key');
      expect(providers.resolveCandidates(tier)).toHaveLength(1);
    }
    const db = createTestDb();
    try {
      const registry = new ModelRegistry(db.raw); registry.initialize();
      configureStandaloneModels(registry, config);
      const budget = new InferenceBudgetTracker(db.raw, { ...DEFAULT_MODEL_STRATEGY_CONFIG, inferenceModel: 'local', lowComputeModel: 'local', criticalModel: 'local' });
      const router = new InferenceRouter(db.raw, registry, budget);
      for (const tier of ['high', 'normal', 'low_compute', 'critical'] as const) expect(router.selectModel(tier, 'agent_turn')?.modelId).toBe('local');
    } finally { db.close(); }
    expect(process.env.OPENAI_API_KEY).toBe('ambient-paid-key');
  });
  it('does not query blockchain balances during standalone heartbeats', async () => {
    const { buildTickContext } = await import('../heartbeat/tick-context.js');
    const { createTestDb, MockConwayClient } = await import('./mocks.js');
    const destinations: string[] = [];
    vi.stubGlobal('fetch', async (url: unknown) => { destinations.push(String(url)); return json({ jsonrpc: '2.0', id: 1, result: '0x0' }); });
    const db = createTestDb();
    try {
      const context = await buildTickContext(db.raw, new MockConwayClient(), { entries: [], defaultIntervalMs: 1000, lowComputeMultiplier: 4 }, '0x1111111111111111111111111111111111111111', 'evm', true);
      expect(context.usdcBalance).toBe(0);
      expect(destinations).toEqual([]);
    } finally { db.close(); }
  });
});

it('runs an action, persists its evidence, then resumes using the configured local model', async () => {
  const { runAgentLoop } = await import('../agent/loop.js');
  const { createTestDb, createTestConfig, createTestIdentity, MockConwayClient, MockInferenceClient, toolCallResponse } = await import('./mocks.js');
  const db = createTestDb();
  const config = { ...createTestConfig(), standalone: true, inferenceModel: 'local', maxTurnsPerCycle: 2 };
  const conway = new MockConwayClient();
  vi.spyOn(conway, 'listModels').mockResolvedValue([{ id: 'local', provider: 'conway' }]);
  const destinations: string[] = [];
  vi.stubGlobal('fetch', async (url: unknown) => { destinations.push(String(url)); throw new Error('Network forbidden in this test'); });
  try {
    const inference = new MockInferenceClient([
      ...startupAssessmentResponses(config),
      toolCallResponse([{ name: 'exec', arguments: { command: 'echo evidence' } }]),
      toolCallResponse([{ name: 'sleep', arguments: { duration_seconds: 1, reason: 'checkpoint' } }]),
    ]);
    await runAgentLoop({ identity: createTestIdentity(), config, db, conway, inference });
    expect(JSON.parse(db.getKV('startup.audit')!).assessment.status).toBe('complete');
    expect(db.getRecentTurns(10).some(t => t.toolCalls.some(c => c.name === 'exec' && c.result.includes('exit_code')))).toBe(true);
    expect(inference.calls.every(call => call.options?.model === 'local')).toBe(true);
    const previousTurns = db.getTurnCount();
    const resumed = new MockInferenceClient([toolCallResponse([{ name: 'sleep', arguments: { duration_seconds: 1, reason: 'resume verified' } }])]);
    await runAgentLoop({ identity: createTestIdentity(), config, db, conway, inference: resumed });
    expect(db.getTurnCount()).toBeGreaterThan(previousTurns);
    expect(JSON.stringify(resumed.calls[0].messages)).toContain('echo evidence');
    expect(destinations).toEqual([]);
  } finally { db.close(); }
});

it('keeps shell and relative files in the assigned workspace', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-work-')); dirs.push(workspace);
  vi.stubEnv('AUTOMATON_WORKSPACE', workspace);
  const client = createConwayClient({ apiUrl: 'http://127.0.0.1:8787', apiKey: 'local', sandboxId: '' });
  await client.writeFile('result.txt', 'local evidence');
  expect(fs.readFileSync(path.join(workspace, 'result.txt'), 'utf8')).toBe('local evidence');
  expect((await client.exec('pwd')).stdout.trim()).toBe(workspace);
  expect(await client.readFile('result.txt')).toBe('local evidence');
  const result = await executeTool('write_file', { path: 'via-tool.txt', content: 'tool evidence' }, createBuiltinTools(''), { config: { standalone: true }, conway: client } as any);
  expect(result.error).toBeUndefined();
  expect(fs.readFileSync(path.join(workspace, 'via-tool.txt'), 'utf8')).toBe('tool evidence');
});

it('versions the isolated state without committing wallet or API credentials', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "standalone-state '")); dirs.push(dir);
  vi.stubEnv('AUTOMATON_DIR', dir); vi.stubEnv('AUTOMATON_WORKSPACE', dir);
  fs.writeFileSync(path.join(dir, 'automaton.json'), JSON.stringify({ conwayApiKey: 'secret' }));
  fs.writeFileSync(path.join(dir, 'wallet.json'), JSON.stringify({ privateKey: 'secret' }));
  fs.writeFileSync(path.join(dir, 'WORKLOG.md'), 'checkpoint evidence');
  vi.resetModules();
  const { initStateRepo } = await import('../git/state-versioning.js');
  const { createConwayClient: create } = await import('../conway/client.js');
  const client = create({ apiUrl: 'http://127.0.0.1:8787', apiKey: 'local', sandboxId: '' });
  await initStateRepo(client);
  const tracked = await client.exec('git ls-files');
  expect(tracked.exitCode).toBe(0);
  expect(tracked.stdout).toContain('WORKLOG.md');
  expect(tracked.stdout).not.toContain('wallet.json');
  expect(tracked.stdout).not.toContain('automaton.json');
});
