import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { runVerification } from '../verification/runner.js';
import { requireGoalVerification, verifyTask, verifyGoal, taskIsVerified } from '../verification/tasks.js';
import { createTestDb } from './mocks.js';
import { createGoal, decomposeGoal, completeTask, refreshGoalStatus } from '../orchestration/task-graph.js';
import { getGoalById, getTasksByGoal } from '../state/database.js';
import { createBuiltinTools } from '../agent/tools.js';

const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function workspace() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verification-')); dirs.push(dir); return dir; }

it('does not accept missing checks or a narrative claiming tests passed', async () => {
  expect((await runVerification(undefined, workspace())).status).toBe('failed');
  expect((await runVerification('tests passed validation complete', workspace())).status).toBe('failed');
});
it('executes a software check and observes an actual repair', async () => {
  const root = workspace();
  const checks = [{ kind: 'node', script: 'stats.mjs', input: '[1,2,3]', expectedExit: 0, expectedJson: { sum: 6 } }];
  fs.writeFileSync(path.join(root, 'stats.mjs'), 'console.log(JSON.stringify({sum:0}));');
  expect((await runVerification(checks, root)).status).toBe('failed');
  fs.writeFileSync(path.join(root, 'stats.mjs'), "import fs from 'node:fs'; console.log(JSON.stringify({sum:JSON.parse(fs.readFileSync(0,'utf8')).reduce((a,b)=>a+b,0)}));");
  expect((await runVerification(checks, root)).status).toBe('passed');
});
it('refuses workspace escapes including symlinks', async () => {
  const root = workspace(), other = workspace();
  fs.writeFileSync(path.join(other, 'outside.mjs'), 'console.log(1)');
  fs.symlinkSync(path.join(other, 'outside.mjs'), path.join(root, 'escape.mjs'));
  expect((await runVerification([{ kind: 'node', script: 'escape.mjs', expectedExit: 0 }], root)).status).toBe('failed');
});
it('aborts a hanging check and caps runaway output', async () => {
  const root = workspace(); fs.writeFileSync(path.join(root, 'hang.mjs'), 'setInterval(()=>{},100);');
  const abort = new AbortController(); setTimeout(() => abort.abort(), 50);
  expect((await runVerification([{ kind: 'node', script: 'hang.mjs', expectedExit: 0 }], root, abort.signal)).status).toBe('failed');
  fs.writeFileSync(path.join(root, 'flood.mjs'), 'while(true) process.stdout.write("x".repeat(10000));');
  expect((await runVerification([{ kind: 'node', script: 'flood.mjs', expectedExit: 0 }], root)).status).toBe('failed');
});
it('checks live local HTTP status and JSON, and refuses external destinations and redirects', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') res.end('{"status":"ok"}');
    else if (req.url === '/redirect') { res.writeHead(302, { location: 'https://example.com' }); res.end(); }
    else { res.writeHead(404); res.end('missing'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  try {
    expect((await runVerification([{ kind: 'http', url: `http://127.0.0.1:${port}/health`, expectedStatus: 200, expectedJson: { status: 'ok' } }], workspace())).status).toBe('passed');
    expect((await runVerification([{ kind: 'http', url: `http://127.0.0.1:${port}/missing`, expectedStatus: 404 }], workspace())).status).toBe('passed');
    for (const url of [`http://127.0.0.1:${port}/redirect`, 'https://example.com']) expect((await runVerification([{ kind: 'http', url, expectedStatus: 200 }], workspace())).status).toBe('failed');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
it('rejects fabricated quotes and does not mistake valid citations for semantic proof', async () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, 'sources.json'), JSON.stringify({ sources: [{ id: 'S1', text: 'The value is 12.' }] }));
  const checks = [{ kind: 'citations', report: 'report.json', sources: 'sources.json' }];
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ claims: [{ text: 'The value is 99.', quotes: [{ sourceId: 'S1', text: 'The value is 99.' }] }] }));
  expect((await runVerification(checks, root)).status).toBe('failed');
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ claims: [{ text: 'The value is 99.', quotes: [{ sourceId: 'S1', text: 'The value is 12.' }] }] }));
  expect((await runVerification(checks, root)).status).toBe('inconclusive');
});
it('keeps a strict goal active after self-reported success and persists independently executed evidence', async () => {
  const state = createTestDb();
  try {
    const goal = createGoal(state.raw, 'Verified goal', 'Build checked software');
    requireGoalVerification(state.raw, goal.id);
    decomposeGoal(state.raw, goal.id, [{ parentId: null, goalId: goal.id, title: 'Work', description: 'Build it', status: 'running', assignedTo: null, agentRole: 'executor', priority: 50, dependencies: [], result: null }]);
    const task = getTasksByGoal(state.raw, goal.id)[0];
    completeTask(state.raw, task.id, { success: true, output: 'Everything passed', artifacts: [], costCents: 0, duration: 1 });
    expect(getGoalById(state.raw, goal.id)?.status).toBe('active');
    expect(taskIsVerified(state.raw, task.id)).toBe(false);
    const root = workspace(); fs.writeFileSync(path.join(root, 'check.mjs'), 'console.log(42)');
    await verifyTask(state.raw, task.id, 'Output 42', [{ kind: 'node', script: 'check.mjs', expectedExit: 0, expectedJson: 42 }], root);
    expect(taskIsVerified(state.raw, task.id)).toBe(true);
    expect(await verifyGoal(state.raw, goal.id)).toBe(true);
    refreshGoalStatus(state.raw, goal.id);
    expect(getGoalById(state.raw, goal.id)?.status).toBe('completed');
    fs.writeFileSync(path.join(root, 'check.mjs'), 'console.log(0)');
    expect(taskIsVerified(state.raw, task.id)).toBe(false);
    refreshGoalStatus(state.raw, goal.id);
    expect(getGoalById(state.raw, goal.id)?.status).toBe('active');
    state.raw.prepare("UPDATE task_graph SET result=? WHERE id=?").run(JSON.stringify({ success: true, output: 'Changed' }), task.id);
    expect(taskIsVerified(state.raw, task.id)).toBe(false);
  } finally { state.close(); }
});

it('wires standalone goal creation through the actual verify_task tool to measured completion', async () => {
  const state = createTestDb(), root = workspace(); vi.stubEnv('AUTOMATON_WORKSPACE', root);
  try {
    const tools = createBuiltinTools(''); const context = { db: state, config: { standalone: true } } as any;
    await tools.find(t => t.name === 'create_goal')!.execute({ title: 'Measured task', description: 'Output the integer 42' }, context);
    const goal = state.raw.prepare('SELECT id FROM goals').get() as { id: string };
    decomposeGoal(state.raw, goal.id, [{ parentId: null, goalId: goal.id, title: 'Implement', description: 'Output 42', status: 'running', assignedTo: null, agentRole: 'executor', priority: 50, dependencies: [], result: null }]);
    const task = getTasksByGoal(state.raw, goal.id)[0];
    completeTask(state.raw, task.id, { success: true, output: 'Finished', artifacts: [], costCents: 0, duration: 1 });
    expect(getGoalById(state.raw, goal.id)?.status).toBe('active');
    fs.writeFileSync(path.join(root, 'check.mjs'), 'console.log(42)');
    const report = await tools.find(t => t.name === 'verify_task')!.execute({ task_id: task.id, criteria: 'Output 42', checks: [{ kind: 'node', script: 'check.mjs', expectedExit: 0, expectedJson: 42 }] }, context);
    expect(JSON.parse(report).status).toBe('passed');
    expect(getGoalById(state.raw, goal.id)?.status).toBe('completed');
  } finally { state.close(); }
});

it('reruns all goal checks when a later task invalidates an imported product', async () => {
  const state = createTestDb(), root = workspace();
  try {
    const goal = createGoal(state.raw, 'Integrated checks', 'Two tasks');
    requireGoalVerification(state.raw, goal.id);
    decomposeGoal(state.raw, goal.id, ['A', 'B'].map(title => ({ parentId: null, goalId: goal.id, title, description: title, status: 'running' as const, assignedTo: null, agentRole: 'executor', priority: 50, dependencies: [], result: null })));
    const [a, b] = getTasksByGoal(state.raw, goal.id);
    fs.writeFileSync(path.join(root, 'product.mjs'), 'export default 42;');
    fs.writeFileSync(path.join(root, 'check.mjs'), "import value from './product.mjs'; console.log(value);");
    const checks = [{ kind: 'node', script: 'check.mjs', expectedExit: 0, expectedJson: 42 }];
    completeTask(state.raw, a.id, { success: true, output: 'A', artifacts: [], costCents: 0, duration: 1 });
    await verifyTask(state.raw, a.id, 'Output 42', checks, root);
    fs.writeFileSync(path.join(root, 'product.mjs'), 'export default 0;');
    completeTask(state.raw, b.id, { success: true, output: 'B', artifacts: [], costCents: 0, duration: 1 });
    await verifyTask(state.raw, b.id, 'Output 0', [{ ...checks[0], expectedJson: 0 }], root);
    expect(await verifyGoal(state.raw, goal.id)).toBe(false);
    refreshGoalStatus(state.raw, goal.id);
    expect(getGoalById(state.raw, goal.id)?.status).toBe('active');
    expect(taskIsVerified(state.raw, a.id)).toBe(false);
  } finally { state.close(); }
});
