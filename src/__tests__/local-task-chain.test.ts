import { expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb, createTestConfig, createTestIdentity, MockConwayClient } from './mocks.js';
import { HarnessRegistry } from '../agent/harness-registry.js';
import { LocalWorkerPool } from '../orchestration/local-worker.js';
import { Orchestrator } from '../orchestration/orchestrator.js';
import { SimpleAgentTracker, SimpleFundingProtocol } from '../orchestration/simple-tracker.js';
import { ColonyMessaging, LocalDBTransport } from '../orchestration/messaging.js';
import { createGoal, decomposeGoal } from '../orchestration/task-graph.js';
import { getTasksByGoal } from '../state/database.js';

it('executes dependent local tasks with fresh workers and no external funding', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-task-chain-'));
  vi.stubEnv('AUTOMATON_WORKSPACE', dir);
  const db = createTestDb();
  const identity = createTestIdentity();
  const config = createTestConfig({ standalone: true });
  const conway = new MockConwayClient();
  const transfer = vi.spyOn(conway, 'transferCredits');
  const completed: string[] = [];
  class Harness {
    id = 'fixture'; description = 'deterministic execution fixture'; title = '';
    async initialize(task: { title: string }) { this.title = task.title; }
    async execute() {
      await new Promise(resolve => setImmediate(resolve));
      completed.push(this.title);
      return { success: true, output: this.title, artifacts: [], costCents: 0, duration: 1 };
    }
    getToolDefs() { return []; }
    buildSystemPrompt() { return ''; }
    buildTaskPrompt() { return ''; }
  }
  const registry = new HarnessRegistry(); registry.register('fixture', Harness);
  const pool = new LocalWorkerPool({ db: db.raw, identity, config, conway, harnessRegistry: registry, inference: { chat: async () => ({ content: '' }) } });
  try {
    const goal = createGoal(db.raw, 'Two dependent tasks', 'first then second');
    decomposeGoal(db.raw, goal.id, ['first', 'second'].map((title, index) => ({ goalId: goal.id, title, description: title, parentId: null, status: 'pending', assignedTo: null, agentRole: 'fixture', priority: 50, dependencies: index ? ['first'] : [], result: null })));
    db.setKV('orchestrator.state', JSON.stringify({ phase: 'executing', goalId: goal.id, replanCount: 0, failedTaskId: null, failedError: null }));
    const orchestrator = new Orchestrator({ db: db.raw, identity, config: { spawnAgent: (task: any) => pool.spawn(task) }, agentTracker: new SimpleAgentTracker(db), funding: new SimpleFundingProtocol(conway, identity, db), messaging: new ColonyMessaging(new LocalDBTransport(db), db), inference: {} as any, isWorkerAlive: address => pool.hasWorker(address) });
    for (let tick = 0; tick < 6 && completed.length < 2; tick++) {
      await orchestrator.tick();
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(completed).toEqual(['first', 'second']);
    const tasks = getTasksByGoal(db.raw, goal.id);
    expect(tasks.every(task => task.status === 'completed')).toBe(true);
    expect(new Set(tasks.map(task => task.assignedTo)).size).toBe(2);
    expect(new SimpleAgentTracker(db).getIdle()).toEqual([]);
    expect(transfer).not.toHaveBeenCalled();
  } finally {
    await pool.shutdown(); db.close(); vi.restoreAllMocks(); vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
