import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTestDb, createTestConfig, createTestIdentity, MockConwayClient, MockInferenceClient, toolCallResponse } from './mocks.js';
import { runAgentLoop } from '../agent/loop.js';
import { createSelfAuditTool, beginStartupAuditSession } from '../standalone/audit.js';
import { createDatabase } from '../state/database.js';
import { startupAssessmentResponses } from './startup-audit-fixtures.js';

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
    expect(JSON.parse(f.db.getKV('startup.audit')!)).toMatchObject({ status: 'pending', externalSpendLimitCents: null, mission: f.config.genesisPrompt });
    return chat(...args);
  });
  try {
    await runAgentLoop(f);
    expect(f.inference.calls.length).toBeGreaterThan(0);
    expect(JSON.parse(f.db.getKV('startup.audit')!).assessment.status).toBe('blocked');
    const audit = JSON.parse(f.db.getKV('startup.audit')!);
    expect(audit.tools).toContain('self_audit');
    expect(audit.tools).toContain('browser_action');
    expect(audit.browser.browserVerified).toBe(false);
    expect(audit.tools).not.toContain('x402_fetch');
    expect(audit.tools).not.toContain('mcp:browser');
    const advertised = f.inference.calls[0].options?.tools?.map(t => t.function.name);
    expect(advertised).toContain('self_audit');
    expect(advertised).toContain('complete_startup_audit');
    expect(advertised).not.toContain('create_goal');
    expect(advertised).not.toContain('write_file');
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

function assessedInference(f: ReturnType<typeof fixture>) {
  const inference = new MockInferenceClient();
  let turn = 0;
  vi.spyOn(inference, 'chat').mockImplementation(async (messages, options) => {
    inference.calls.push({ messages, options });
    if (turn++ === 0) return toolCallResponse([
      { name: 'use_skill', arguments: { name: 'ponytail:ponytail' } },
      { name: 'list_skills', arguments: {} },
    ]);
    if (turn === 2) {
      const evidence = messages.filter(m => m.role === 'tool').map(m => m.tool_call_id!);
      return toolCallResponse([{ name: 'complete_startup_audit', arguments: {
        objective: f.config.genesisPrompt, goals: ['Build and verify a local website'],
        tools: ['list_skills'], skills: ['ponytail:ponytail'], resources: ['Assigned workspace and persisted state'],
        constraints: ['No external spending', 'Bounded inference'], decisionSummary: 'Use local file and browser tools for the website; verify browser interaction separately.',
        capabilities: [{ name: 'list_skills', evidenceIds: [evidence[1]] }],
        unverified: ['Live browser navigation'], blockers: [], nextActions: ['Inspect the workspace then implement the website'],
      } }]);
    }
    return toolCallResponse([{ name: 'sleep', arguments: { duration_seconds: 1 } }]);
  });
  return inference;
}

it('requires a model-authored assessment and real skill/probe evidence before mission dispatch', async () => {
  const f = fixture(); f.inference = assessedInference(f);
  try {
    await runAgentLoop(f);
    const audit = JSON.parse(f.db.getKV('startup.audit')!);
    expect(audit.status).toBe('ready');
    expect(audit.modelInferenceTested).toBe(true);
    expect(audit.assessment.status).toBe('complete');
    expect(audit.assessment.report.decisionSummary).toContain('verify browser interaction separately');
    expect(audit.assessment.evidence.map((e: { name: string }) => e.name)).toEqual(['use_skill', 'list_skills']);
    expect(f.inference.calls).toHaveLength(3);
    expect(f.inference.calls[0].options?.tools?.map(t => t.function.name)).not.toContain('create_goal');
    expect(f.inference.calls[2].options?.tools?.map(t => t.function.name)).toContain('create_goal');
    expect(f.db.getRecentTurns(10).some(t => t.input?.includes('STARTUP SELF-ASSESSMENT'))).toBe(true);
  } finally { f.db.close(); }
});

it('keeps the completed boot audit across reopened database connections, wakes and manual preflight refresh', async () => {
  const f = fixture(); f.inference = assessedInference(f);
  try {
    await runAgentLoop(f);
    const before = JSON.parse(f.db.getKV('startup.audit')!);
    // Refresh the same registered inventory: a manual check must preserve completion.
    const tools = before.tools.map((name: string) => ({ name, parameters: {}, description: '', category: 'memory' as const, riskLevel: 'safe' as const, execute: async () => '' }));
    await createSelfAuditTool(() => tools).execute({}, f);
    expect(JSON.parse(f.db.getKV('startup.audit')!).bootId).toBe(before.bootId);
    expect(JSON.parse(f.db.getKV('startup.audit')!).assessment.status).toBe('complete');
    const dbFile = f.db.raw.name;
    f.db.close();
    f.db = createDatabase(dbFile);
    f.inference = new MockInferenceClient([toolCallResponse([{ name: 'sleep', arguments: { duration_seconds: 1 } }])]);
    await runAgentLoop(f);
    expect(f.inference.calls).toHaveLength(1);
    expect(JSON.parse(f.db.getKV('startup.audit')!).bootId).toBe(before.bootId);
  } finally { f.db.close(); }
});

it('cannot fake successful startup when the configured model is unavailable', async () => {
  const f = fixture(); vi.spyOn(f.inference, 'chat').mockRejectedValue(new Error('local model offline'));
  try {
    await runAgentLoop(f);
    const audit = JSON.parse(f.db.getKV('startup.audit')!);
    expect(audit.status).toBe('blocked');
    expect(audit.assessment.status).toBe('blocked');
    expect(audit.assessment.blockers.join(' ')).toContain('local model offline');
    expect(audit.modelInferenceTested).toBe(false);
    expect(f.db.getKV('orchestrator.last_tick')).toBeUndefined();
    expect(f.db.getAgentState()).toBe('sleeping');
  } finally { f.db.close(); }
});

it('refuses a hardcoded-style report without model tool evidence', async () => {
  const f = fixture();
  f.inference = new MockInferenceClient([toolCallResponse([{ name: 'complete_startup_audit', arguments: { objective: f.config.genesisPrompt, goals: ['Website'], tools: ['read_file'], skills: ['ponytail:ponytail'], resources: ['Workspace'], constraints: ['Zero spend'], decisionSummary: 'Everything ready', capabilities: [{ name: 'read_file', evidenceIds: ['fabricated'] }], unverified: [], blockers: [], nextActions: ['Build'] } }])]);
  try {
    await runAgentLoop(f);
    expect(JSON.parse(f.db.getKV('startup.audit')!).assessment.status).toBe('blocked');
    expect(f.db.getKV('orchestrator.last_tick')).toBeUndefined();
    expect(f.db.getRecentTurns(10).flatMap(t => t.toolCalls).find(t => t.name === 'complete_startup_audit')?.error).toBeDefined();
  } finally { f.db.close(); }
});

it('blocks mission mutations attempted during assessment', async () => {
  const f = fixture();
  f.inference = new MockInferenceClient([toolCallResponse([
    { name: 'write_file', arguments: { path: 'should-not-exist.txt', content: 'mission work' } },
    { name: 'create_goal', arguments: { title: 'Dispatch commercial mission', description: 'Should be gated' } },
  ])]);
  try {
    await runAgentLoop(f);
    expect(f.conway.files).toEqual({});
    expect(f.db.raw.prepare('SELECT COUNT(*) AS n FROM goals').get()).toEqual({ n: 0 });
    const observations = JSON.parse(f.db.getKV('startup.audit')!).assessment.evidence;
    expect(observations.filter((e: { error?: string }) => e.error)).toHaveLength(2);
  } finally { f.db.close(); }
});

it('retries an unavailable model on the next wake without changing the boot identity', async () => {
  const f = fixture(); vi.spyOn(f.inference, 'chat').mockRejectedValue(new Error('temporarily offline'));
  try {
    await runAgentLoop(f);
    const bootId = JSON.parse(f.db.getKV('startup.audit')!).bootId;
    f.inference = assessedInference(f);
    await runAgentLoop(f);
    const audit = JSON.parse(f.db.getKV('startup.audit')!);
    expect(audit.bootId).toBe(bootId);
    expect(audit.assessment.status).toBe('complete');
    expect(audit.assessment.attempts).toBe(3);
  } finally { f.db.close(); }
});

it('requires a new assessment when the assigned objective changes', async () => {
  const f = fixture(); f.inference = assessedInference(f);
  try {
    await runAgentLoop(f);
    const oldBoot = JSON.parse(f.db.getKV('startup.audit')!).bootId;
    f.config.genesisPrompt = 'Inspect a different local project';
    f.inference = new MockInferenceClient();
    await runAgentLoop(f);
    const audit = JSON.parse(f.db.getKV('startup.audit')!);
    expect(audit.bootId).not.toBe(oldBoot);
    expect(audit.assessment.status).toBe('blocked');
    expect(JSON.parse(f.db.getKV(`startup.audit.boot:${oldBoot}`)!).assessment.status).toBe('complete');
    expect(f.inference.calls[0].options?.tools?.map(t => t.function.name)).not.toContain('create_goal');
  } finally { f.db.close(); }
});

it('bounds journal observations while retaining complete native tool logs', async () => {
  const f = fixture();
  f.conway.files['large-observation.txt'] = 'x'.repeat(30_000);
  f.inference = new MockInferenceClient([toolCallResponse([{ name: 'read_file', arguments: { path: 'large-observation.txt' } }])]);
  try {
    await runAgentLoop(f);
    const evidence = JSON.parse(f.db.getKV('startup.audit')!).assessment.evidence[0];
    expect(evidence.result.length).toBeLessThanOrEqual(2_100);
    expect(f.db.getRecentTurns(10).flatMap(t => t.toolCalls).find(t => t.name === 'read_file')?.result).toHaveLength(30_000);
  } finally { f.db.close(); }
});

it('requires the agent to assess itself again at each actual runtime startup', async () => {
  const f = fixture(); f.inference = assessedInference(f);
  try {
    beginStartupAuditSession(f.db);
    await runAgentLoop(f);
    const bootId = JSON.parse(f.db.getKV('startup.audit')!).bootId;
    beginStartupAuditSession(f.db);
    f.inference = new MockInferenceClient();
    await runAgentLoop(f);
    expect(JSON.parse(f.db.getKV('startup.audit')!).bootId).not.toBe(bootId);
    expect(JSON.parse(f.db.getKV('startup.audit')!).assessment.status).toBe('blocked');
    expect(f.inference.calls[0].options?.tools?.map(t => t.function.name)).toContain('complete_startup_audit');
  } finally { f.db.close(); }
});

it('requires renewed assessment when gateway credentials or routing change', async () => {
  const f = fixture(); f.inference = assessedInference(f);
  try {
    await runAgentLoop(f);
    const bootId = JSON.parse(f.db.getKV('startup.audit')!).bootId;
    f.config.conwayApiKey = 'new-private-gateway-key';
    f.inference = new MockInferenceClient();
    await runAgentLoop(f);
    const stored = f.db.getKV('startup.audit')!;
    expect(JSON.parse(stored).bootId).not.toBe(bootId);
    expect(JSON.parse(stored).assessment.status).toBe('blocked');
    expect(stored).not.toContain('new-private-gateway-key');
  } finally { f.db.close(); }
});

it('blocks a configured model that is advertised as unavailable', async () => {
  const f = fixture();
  vi.mocked(f.conway.listModels).mockResolvedValue([{ id: 'local', provider: 'conway', available: false }] as any);
  try {
    await runAgentLoop(f);
    const audit = JSON.parse(f.db.getKV('startup.audit')!);
    expect(audit.preflightStatus).toBe('blocked');
    expect(audit.blockers.join(' ')).toContain('unavailable');
    expect(f.inference.calls).toHaveLength(0);
  } finally { f.db.close(); }
});

it('discloses unknown provider expenses when an old client has no inference status method', async () => {
  const f = fixture();
  try {
    await runAgentLoop(f);
    const audit = JSON.parse(f.db.getKV('startup.audit')!);
    expect(audit.accountingMode).toBe('unknown');
    expect(audit.externalSpendLimitCents).toBeNull();
    expect(audit.accountingStatus.infrastructureExpenseMicrousd).toBeNull();
    expect(audit.accountingStatus.providerBalanceMicrousd).toBeNull();
    expect(audit.accountingStatus.actualExpenseStatus).toBe('unknown');
    expect(audit.inferenceProviderStatus.state).toBe('unknown');
  } finally { f.db.close(); }
});

it('records declared remote allowance without presenting it as verified balance or free infrastructure', async () => {
  const f = fixture();
  Object.assign(f.conway, { getInferenceStatus: async () => ({ mode: 'remote', state: 'ready', ready: true, model: 'local', billing_mode: 'infrastructure', provider_balance_microusd: null, infrastructure_expense_microusd: null, effective_external_spend_limit_microusd: null, declared_prepaid_allowance_microusd: 9_000_000, allowance_source: 'operator_declaration_not_verified_provider_balance' }) });
  try {
    await runAgentLoop(f);
    const audit = JSON.parse(f.db.getKV('startup.audit')!);
    expect(audit.accountingMode).toBe('infrastructure');
    expect(audit.accountingStatus.declaredPrepaidAllowanceMicrousd).toBe(9_000_000);
    expect(audit.accountingStatus.actualExpenseStatus).toBe('unknown');
    expect(audit.accountingStatus.infrastructureExpenseMicrousd).toBeNull();
    expect(audit.externalSpendLimitCents).toBeNull();
  } finally { f.db.close(); }
});

it('waits before inference when the gateway reports an unready provider', async () => {
  const f = fixture();
  Object.assign(f.conway, { getInferenceStatus: async () => ({ mode: 'remote', state: 'awaiting_budget', ready: false, model: 'local', billing_mode: 'infrastructure', provider_balance_microusd: null, infrastructure_expense_microusd: null, effective_external_spend_limit_microusd: null }) });
  try {
    await runAgentLoop(f);
    expect(JSON.parse(f.db.getKV('startup.audit')!).blockers.join(' ')).toContain('awaiting_budget');
    expect(f.inference.calls).toHaveLength(0);
  } finally { f.db.close(); }
});

it('distinguishes a local zero external spend limit from unknown infrastructure expense', async () => {
  const f = fixture();
  Object.assign(f.conway, { getInferenceStatus: async () => ({ mode: 'local', state: 'ready', ready: true, model: 'local', billing_mode: 'local', provider_balance_microusd: null, infrastructure_expense_microusd: null, effective_external_spend_limit_microusd: 0 }) });
  try {
    await runAgentLoop(f);
    const audit = JSON.parse(f.db.getKV('startup.audit')!);
    expect(audit.accountingMode).toBe('local');
    expect(audit.externalSpendLimitCents).toBe(0);
    expect(audit.accountingStatus.infrastructureExpenseMicrousd).toBeNull();
    expect(audit.accountingStatus.actualExpenseStatus).toBe('unknown');
  } finally { f.db.close(); }
});

it('permits necessary operator contact during assessment and preserves queued delivery evidence honestly', async () => {
  const f = fixture();
  let submissions = 0;
  const server = http.createServer(async (req, res) => {
    expect(req.url).toBe('/v1/operator/contact');
    expect(req.method).toBe('POST');
    expect(req.headers.authorization).toBe(`Bearer ${f.config.conwayApiKey}`);
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    expect(body.purpose).toBe('blocker');
    submissions++;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ id: 'startup-contact', status: 'queued', reason: 'smtp_not_configured', deliveryConfirmed: false }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  f.config.conwayApiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  f.inference = new MockInferenceClient([toolCallResponse([{ name: 'contact_operator', arguments: {
    subject: 'Necessary startup information', message: 'A required prerequisite needs operator input; email transport readiness remains unverified.', purpose: 'blocker', idempotencyKey: 'startup-blocker',
  } }])]);
  try {
    await runAgentLoop(f);
    expect(submissions).toBe(1);
    const receipt = JSON.parse(f.db.getKV('operator.contact.lastReceipt')!);
    expect(receipt).toMatchObject({ status: 'queued', reason: 'smtp_not_configured', deliveryConfirmed: false });
    const audit = JSON.parse(f.db.getKV('startup.audit')!);
    expect(audit.assessment.status).toBe('blocked');
    const observation = audit.assessment.evidence.find((e: { name: string }) => e.name === 'contact_operator');
    expect(observation.error).toBeUndefined();
    expect(JSON.parse(observation.result)).toEqual(receipt);
    expect(f.db.getRecentTurns(10).flatMap(t => t.toolCalls).find(t => t.name === 'contact_operator')?.result).toContain('smtp_not_configured');
    expect(f.db.getKV('orchestrator.last_tick')).toBeUndefined();
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    f.db.close();
  }
});

it('reads a creator reply while startup is blocked and leaves it unclaimed for normal reconciliation', async () => {
  const f = fixture();
  const responses = startupAssessmentResponses(f.config);
  const report = JSON.parse(responses[1].toolCalls![0].function.arguments);
  report.blockers = ['Required project location needs operator input'];
  report.nextActions = ['Read the operator reply on a later wake and continue the assessment'];
  responses[1].toolCalls![0].function.arguments = JSON.stringify(report);
  f.inference = new MockInferenceClient(responses);
  try {
    await runAgentLoop(f);
    expect(JSON.parse(f.db.getKV('startup.audit')!).assessment.status).toBe('blocked');
    const bootId = JSON.parse(f.db.getKV('startup.audit')!).bootId;
    const messageId = 'op_' + 'a'.repeat(64);
    f.db.raw.exec('CREATE TABLE operator_bridge_receipts (id TEXT PRIMARY KEY, request_hash TEXT NOT NULL)');
    f.db.raw.prepare('INSERT INTO operator_bridge_receipts (id,request_hash) VALUES (?,?)').run(messageId, 'b'.repeat(64));
    f.db.raw.prepare("INSERT INTO inbox_messages (id,from_address,to_address,content,raw_content,status) VALUES (?,?,?,?,?,'received')")
      .run(messageId, f.config.creatorAddress, f.identity.address, 'The requested project location is assigned-project-directory.', 'The requested project location is assigned-project-directory.');
    f.inference = new MockInferenceClient([...startupAssessmentResponses(f.config), toolCallResponse([{ name: 'sleep', arguments: { duration_seconds: 1 } }])]);
    const chat = f.inference.chat.bind(f.inference);
    vi.spyOn(f.inference, 'chat').mockImplementation(async (messages, options) => {
      if (f.inference.calls.length === 0) {
        expect(messages.some(m => m.role === 'user' && m.content.includes('assigned-project-directory'))).toBe(true);
        expect(messages.some(m => m.role === 'user' && m.content.includes('operator_bridge_receipt'))).toBe(true);
      }
      return chat(messages, options);
    });
    await runAgentLoop(f);
    const audit = JSON.parse(f.db.getKV('startup.audit')!);
    expect(audit.bootId).toBe(bootId);
    expect(audit.assessment.status).toBe('complete');
    expect(audit.assessment.operatorInputIds).toContain(messageId);
    expect(f.db.raw.prepare('SELECT status,retry_count,processed_at FROM inbox_messages WHERE id=?').get(messageId))
      .toEqual({ status: 'received', retry_count: 0, processed_at: null });
  } finally { f.db.close(); }
});

it('does not count a structured contact error as a successfully observed capability', async () => {
  const f = fixture();
  const responses = startupAssessmentResponses(f.config);
  const rejected = toolCallResponse([{ name: 'contact_operator', arguments: { subject: 'Need input', message: 'Request', recipient: 'other@example.com' } }]).toolCalls![0];
  responses[0].toolCalls!.push(rejected);
  const report = JSON.parse(responses[1].toolCalls![0].function.arguments);
  report.capabilities = [{ name: 'contact_operator', evidenceIds: [rejected.id] }];
  responses[1].toolCalls![0].function.arguments = JSON.stringify(report);
  f.inference = new MockInferenceClient(responses);
  try {
    await runAgentLoop(f);
    const audit = JSON.parse(f.db.getKV('startup.audit')!);
    expect(audit.assessment.status).toBe('blocked');
    const completion = f.db.getRecentTurns(10).flatMap(t => t.toolCalls).find(t => t.name === 'complete_startup_audit');
    expect(completion?.error).toContain('successful tool calls');
    expect(f.db.getKV('operator.contact.lastReceipt')).toBeUndefined();
  } finally { f.db.close(); }
});
