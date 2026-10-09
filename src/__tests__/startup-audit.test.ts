import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb, createTestConfig, createTestIdentity, MockConwayClient, MockInferenceClient, toolCallResponse } from './mocks.js';
import { runAgentLoop } from '../agent/loop.js';

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-audit-')); dirs.push(workspace);
  vi.stubEnv('AUTOMATON_WORKSPACE', workspace);
  const db = createTestDb();
  const conway = new MockConwayClient();
  vi.spyOn(conway, 'listModels').mockResolvedValue([{ id: 'local', provider: 'conway' }]);
  const config = { ...createTestConfig(), standalone: true, inferenceModel: 'local', genesisPrompt: 'Build and verify a local website', dbPath: path.join(workspace, 'state.db'), maxTurnsPerCycle: 1 };
  const inference = new MockInferenceClient([toolCallResponse([{ name: 'sleep', arguments: { duration_seconds: 1 } }])]);
  return { db, conway, config, inference, identity: createTestIdentity() };
}

it('persists an honest audit before inference and advertises only executable profile tools', async () => {
  const f = fixture();
  f.db.installTool({ id: 'fake-mcp', name: 'mcp:browser', type: 'mcp', enabled: true, installedAt: new Date().toISOString(), config: { command: 'browser' } });
  const chat = f.inference.chat.bind(f.inference);
  vi.spyOn(f.inference, 'chat').mockImplementation(async (...args) => {
    expect(JSON.parse(f.db.getKV('startup.audit')!)).toMatchObject({ status: 'ready', externalSpendLimitCents: 0, mission: f.config.genesisPrompt });
    return chat(...args);
  });
  try {
    await runAgentLoop(f);
    expect(f.inference.calls).toHaveLength(1);
    const audit = JSON.parse(f.db.getKV('startup.audit')!);
    expect(audit.tools).toContain('self_audit');
    expect(audit.tools).toContain('browser_action');
    expect(audit.browser.browserVerified).toBe(false);
    expect(audit.tools).not.toContain('x402_fetch');
    expect(audit.tools).not.toContain('mcp:browser');
    const advertised = f.inference.calls[0].options?.tools?.map(t => t.function.name);
    expect(advertised).toContain('self_audit');
    expect(advertised).not.toContain('create_sandbox');
    expect(JSON.stringify(f.inference.calls[0].messages)).toContain('STARTUP AUDIT');
  } finally { f.db.close(); }
});

it.each(['mission', 'model', 'workspace', 'allocation'])('waits without inference when %s is unavailable', async (missing) => {
  const f = fixture();
  if (missing === 'mission') f.config.genesisPrompt = '';
  if (missing === 'model') vi.mocked(f.conway.listModels).mockResolvedValue([]);
  if (missing === 'workspace') vi.stubEnv('AUTOMATON_WORKSPACE', '/nonexistent/automaton-audit-workspace');
  if (missing === 'allocation') f.conway.creditsCents = 0;
  try {
    await runAgentLoop(f);
    const audit = JSON.parse(f.db.getKV('startup.audit')!);
    expect(audit.status).toBe('blocked');
    expect(audit.blockers.join(' ')).toMatch(new RegExp(missing, 'i'));
    expect(f.inference.calls).toHaveLength(0);
    expect(f.db.getAgentState()).toBe('sleeping');
  } finally { f.db.close(); }
});

it('delivers requested skill content through the main agent tool loop', async () => {
  const f = fixture();
  f.inference = new MockInferenceClient([toolCallResponse([
    { name: 'use_skill', arguments: { name: 'trailofbits:insecure-defaults' } },
    { name: 'sleep', arguments: { duration_seconds: 1 } },
  ])]);
  try {
    await runAgentLoop(f);
    expect(f.db.getKV('skills.loaded:main:trailofbits:insecure-defaults:SKILL.md:0')).toBeDefined();
    const messages = JSON.stringify(f.inference.calls[0].messages);
    expect(messages).toContain('ponytail:ponytail');
    expect(messages).toContain('writing:writing-clearly-and-concisely');
  } finally { f.db.close(); }
});
