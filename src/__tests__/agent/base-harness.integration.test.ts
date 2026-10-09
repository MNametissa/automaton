import { loadBundledSkills } from '../../skills/bundled.js';
import { createTestDb } from '../mocks.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BaseHarness } from "../../agent/harnesses/base-harness.js";
import type { HarnessContext, HarnessTool } from "../../agent/harness-types.js";
import type { TaskNode, TaskResult } from "../../orchestration/task-graph.js";
import { AgentWorkspace } from "../../orchestration/workspace.js";
import { createInMemoryDb } from "../orchestration/test-db.js";
import { createTestConfig, createTestIdentity, MockConwayClient } from "../mocks.js";

class TestHarness extends BaseHarness {
  readonly id = "test";
  readonly description = "test harness";
  beforeTurnCalls = 0;

  buildSystemPrompt(): string {
    return "system prompt";
  }

  protected override beforeTurn(): void {
    this.beforeTurnCalls += 1;
  }

  getToolDefs(): HarnessTool[] {
    return [
      {
        name: "ping",
        description: "ping",
        parameters: { type: "object", properties: {} },
        execute: async () => "pong",
      },
      {
        name: "task_done",
        description: "done",
        parameters: {
          type: "object",
          properties: { summary: { type: "string" }, success: { type: "boolean" } },
          required: ["summary"],
        },
        execute: async (args) => `TASK_COMPLETE:${args.success === false ? 'FAILURE' : 'SUCCESS'}:${args.summary as string}`,
      },
    ];
  }
}

describe("agent/BaseHarness integration", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  function createTask(): TaskNode {
    return {
      id: "task-1",
      parentId: null,
      goalId: "goal-1",
      title: "Run test harness",
      description: "Use tools and finish",
      status: "assigned",
      assignedTo: "local://worker",
      agentRole: "generalist",
      priority: 50,
      dependencies: [],
      result: null,
      metadata: {
        estimatedCostCents: 5,
        actualCostCents: 0,
        maxRetries: 0,
        retryCount: 0,
        timeoutMs: 5_000,
        createdAt: new Date().toISOString(),
        startedAt: null,
        completedAt: null,
      },
    };
  }

  function createContext(): HarnessContext {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "base-harness-"));
    const workspace = new AgentWorkspace("goal-1", path.join(tempDir, "workspace"));
    const db = createInMemoryDb();
    return {
      workspaceRoot: workspace.basePath,
      allowedEditRoot: tempDir,
      workspace,
      identity: createTestIdentity(),
      config: createTestConfig(),
      db,
      conway: new MockConwayClient(),
      inference: {
        chat: async () => ({
          content: "",
          toolCalls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "ping", arguments: "{}" },
            },
            {
              id: "call-2",
              type: "function",
              function: { name: "task_done", arguments: JSON.stringify({ summary: "finished", success: true }) },
            },
          ],
        }),
      },
      budget: {
        maxTurns: 3,
        maxCostCents: 50,
        timeoutMs: 5_000,
        turnsUsed: 0,
        costUsedCents: 0,
        startedAt: 0,
      },
      wisdom: { conventions: [], successes: [], failures: [], gotchas: [] },
      abortSignal: new AbortController().signal,
      goalId: "goal-1",
    };
  }

  function browserFixture(context: HarnessContext, closeFails = false) {
    const cli = path.join(tempDir!, 'browser-cli.cjs');
    const log = path.join(tempDir!, 'browser-calls.jsonl');
    const browserState = path.join(tempDir!, 'browser-state');
    const mainProfile = path.join(browserState, 'main/profile/keep.txt');
    mkdirSync(path.dirname(mainProfile), { recursive: true });
    writeFileSync(mainProfile, 'main browser must remain untouched');
    writeFileSync(cli, `const fs=require('node:fs'),path=require('node:path');
      const args=process.argv.slice(2),command=args[2];
      fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({command,session:args[0]})+'\\n');
      if(command==='open'){const profile=args.find(a=>a.startsWith('--profile=')).slice(10);fs.mkdirSync(profile,{recursive:true});fs.writeFileSync(path.join(profile,'keep.txt'),'persistent worker profile');}
      if(command==='close'&&${JSON.stringify(closeFails)}){console.log(JSON.stringify({isError:true,error:'fixture close failure'}));process.exit(1);}
      console.log(JSON.stringify({ok:true}));`);
    vi.stubEnv('AUTOMATON_BROWSER_CLI', cli);
    vi.stubEnv('AUTOMATON_BROWSER_STATE', browserState);
    context.toolContext = { db: context.db, config: context.config, identity: context.identity, conway: context.conway } as any;
    return { mainProfile, workerProfile: path.join(browserState, 'task-1/profile/keep.txt'),
      calls: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [] };
  }

  it.each(['success', 'failure', 'budget'] as const)('closes the used worker browser on %s while retaining profiles and leaving main alone', async outcome => {
    const context = createContext();
    const fixture = browserFixture(context);
    let turns = 0;
    context.budget.maxTurns = outcome === 'budget' ? 1 : 3;
    context.inference = { chat: async () => ++turns === 1
      ? { content: '', toolCalls: [{ id: 'open', type: 'function', function: { name: 'browser_action', arguments: JSON.stringify({ action: 'open', url: 'about:blank' }) } }] }
      : { content: '', toolCalls: [{ id: 'done', type: 'function', function: { name: 'task_done', arguments: JSON.stringify({ summary: 'browser task complete', success: outcome === 'success' }) } }] } };
    const harness = new TestHarness();
    await harness.initialize(createTask(), context);
    try {
      if (outcome === 'budget') await expect(harness.execute()).rejects.toThrow(/Budget exhausted/);
      else expect((await harness.execute()).success).toBe(outcome === 'success');
      expect(fixture.calls()).toEqual([{ command: 'open', session: '-s=task-1' }, { command: 'close', session: '-s=task-1' }]);
      expect(readFileSync(fixture.workerProfile, 'utf8')).toBe('persistent worker profile');
      expect(readFileSync(fixture.mainProfile, 'utf8')).toBe('main browser must remain untouched');
    } finally { context.db.close(); }
  });

  it.each([false, true])('does not open or close a browser for a task without browser actions (status only: %s)', async statusOnly => {
    const context = createContext();
    const fixture = browserFixture(context);
    if (statusOnly) context.inference = { chat: async () => ({ content: '', toolCalls: [
      { id: 'status', type: 'function', function: { name: 'browser_status', arguments: '{}' } },
      { id: 'done', type: 'function', function: { name: 'task_done', arguments: JSON.stringify({ summary: 'done' }) } },
    ] }) };
    const harness = new TestHarness();
    await harness.initialize(createTask(), context);
    try {
      expect((await harness.execute()).success).toBe(true);
      expect(fixture.calls()).toEqual(statusOnly ? [{ command: 'list', session: '-s=task-1' }] : []);
    } finally { context.db.close(); }
  });

  it('preserves the original task failure if browser teardown also fails', async () => {
    const context = createContext();
    const fixture = browserFixture(context, true);
    context.budget.maxTurns = 1;
    context.inference = { chat: async () => ({ content: '', toolCalls: [{ id: 'open', type: 'function', function: { name: 'browser_action', arguments: JSON.stringify({ action: 'open', url: 'about:blank' }) } }] }) };
    const harness = new TestHarness();
    await harness.initialize(createTask(), context);
    try {
      await expect(harness.execute()).rejects.toThrow(/Budget exhausted/);
      expect(fixture.calls().map(call => call.command)).toEqual(['open', 'close']);
    } finally { context.db.close(); }
  });

  it('closes after a task pauses without routing lifecycle teardown through the denied action policy', async () => {
    const context = createContext();
    const fixture = browserFixture(context);
    const evaluate = vi.fn()
      .mockReturnValueOnce({ action: 'allow' })
      .mockReturnValue({ action: 'deny', reasonCode: 'operator.pause', humanMessage: 'Paused' });
    context.policyEngine = { evaluate, logDecision: vi.fn() } as any;
    context.budget.maxTurns = 1;
    context.inference = { chat: async () => ({ content: '', toolCalls: [{ id: 'open', type: 'function', function: { name: 'browser_action', arguments: JSON.stringify({ action: 'open' }) } }] }) };
    const harness = new TestHarness();
    await harness.initialize(createTask(), context);
    try {
      await expect(harness.execute()).rejects.toThrow(/Budget exhausted/);
      expect(fixture.calls().map(call => call.command)).toEqual(['open', 'close']);
      expect(evaluate).toHaveBeenCalledOnce();
    } finally { context.db.close(); }
  });

  it('does not clean up a policy-denied browser attempt or close twice after an explicit close', async () => {
    const context = createContext();
    const fixture = browserFixture(context);
    context.policyEngine = { evaluate: () => ({ action: 'deny', reasonCode: 'test', humanMessage: 'denied' }), logDecision: vi.fn() } as any;
    context.inference = { chat: async () => ({ content: '', toolCalls: [
      { id: 'open', type: 'function', function: { name: 'browser_action', arguments: JSON.stringify({ action: 'open' }) } },
      { id: 'done', type: 'function', function: { name: 'task_done', arguments: JSON.stringify({ summary: 'done' }) } },
    ] }) };
    const harness = new TestHarness();
    await harness.initialize(createTask(), context);
    try {
      await harness.execute();
      expect(fixture.calls()).toEqual([]);
      context.policyEngine = undefined;
      context.budget.turnsUsed = 0;
      context.inference = { chat: async () => ({ content: '', toolCalls: [
        { id: 'open', type: 'function', function: { name: 'browser_action', arguments: JSON.stringify({ action: 'open' }) } },
        { id: 'close', type: 'function', function: { name: 'browser_action', arguments: JSON.stringify({ action: 'close' }) } },
        { id: 'done', type: 'function', function: { name: 'task_done', arguments: JSON.stringify({ summary: 'done' }) } },
      ] }) };
      await harness.initialize(createTask(), context);
      await harness.execute();
      expect(fixture.calls().map(call => call.command)).toEqual(['open', 'close']);
    } finally { context.db.close(); }
  });

  it("executes tool calls and returns a TaskResult on task_done", async () => {
    const harness = new TestHarness();
    const task = createTask();
    const context = createContext();
    await harness.initialize(task, context);
    const result = await harness.execute();
    expect(result.success).toBe(true);
    expect(result.output).toBe("finished");
    expect(context.budget.turnsUsed).toBe(1);
    (context.db as any).close?.();
  });

  it('delivers startup skills and executes a skill invocation inside the worker loop', async () => {
    const context = createContext(), state = createTestDb(); context.db.close(); context.db = state.raw;
    loadBundledSkills(state);
    let turns = 0;
    context.inference = { chat: async params => {
      expect(params.messages[0].content).toContain('ponytail:ponytail');
      expect(params.tools?.map(tool => tool.function.name)).toContain('use_skill');
      turns++;
      if (turns === 1) return { content: '', toolCalls: [{ id: 'skill-call', type: 'function', function: { name: 'use_skill', arguments: JSON.stringify({ name: 'superpowers:verification-before-completion' }) } }] };
      expect(params.messages.some(message => message.role === 'tool' && String(message.content).includes('Verification Before Completion'))).toBe(true);
      return { content: '', toolCalls: [{ id: 'done-call', type: 'function', function: { name: 'task_done', arguments: JSON.stringify({ summary: 'Skill loaded', success: true }) } }] };
    } };
    try {
      const harness = new TestHarness(); await harness.initialize(createTask(), context);
      expect((await harness.execute()).success).toBe(true);
      expect(state.raw.prepare("SELECT count(*) AS n FROM kv WHERE key LIKE 'skills.loaded:task-1:superpowers:verification-before-completion:%'").get()).toEqual({ n: 1 });
    } finally { state.close(); }
  });

  it('routes worker browser actions through policy before attempting execution', async () => {
    const context = createContext(), state = createTestDb(); context.db.close(); context.db = state.raw;
    context.toolContext = { db: state, config: context.config, identity: context.identity, conway: context.conway } as any;
    const evaluate = vi.fn(() => ({ action: 'deny', reasonCode: 'test.pause', humanMessage: 'Paused by operator' }));
    context.policyEngine = { evaluate, logDecision: vi.fn() } as any;
    let turns = 0;
    context.inference = { chat: async params => {
      expect(params.tools?.map(tool => tool.function.name)).toContain('browser_action');
      if (++turns === 1) return { content: '', toolCalls: [{ id: 'browser-call', type: 'function', function: { name: 'browser_action', arguments: JSON.stringify({ action: 'open', url: 'about:blank' }) } }] };
      expect(params.messages.some(message => message.role === 'tool' && String(message.content).includes('Policy denied: test.pause'))).toBe(true);
      return { content: 'Stopped after policy denial' };
    } };
    try {
      const harness = new TestHarness(); await harness.initialize(createTask(), context); await harness.execute();
      expect(evaluate).toHaveBeenCalledOnce();
    } finally { state.close(); }
  });

  it("fails immediately when the turn budget is already exhausted", async () => {
    const harness = new TestHarness();
    const task = createTask();
    const context = createContext();
    context.budget.maxTurns = 0;
    await harness.initialize(task, context);
    await expect(harness.execute()).rejects.toThrow(/Budget exhausted: reached max turns/);
    (context.db as any).close?.();
  });

  it('does not accept a denied task_done merely because the model requested success', async () => {
    class DeniedHarness extends TestHarness {
      override getToolDefs(): HarnessTool[] {
        return [{ name: 'task_done', description: 'guarded', parameters: {}, execute: async () => 'NOT COMPLETE: evidence missing' }];
      }
    }
    const context = createContext(); context.budget.maxTurns = 1;
    const harness = new DeniedHarness(); await harness.initialize(createTask(), context);
    await expect(harness.execute()).rejects.toThrow(/Budget exhausted/);
    context.db.close();
  });

  it("does not consume turn budget or reset per-turn state on inference retry", async () => {
    const harness = new TestHarness();
    const task = createTask();
    const context = createContext();
    let callCount = 0;
    context.inference = {
      chat: async () => {
        callCount += 1;
        if (callCount === 1) {
          throw new Error("transient inference failure");
        }
        return {
          content: "",
          toolCalls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "task_done", arguments: JSON.stringify({ summary: "finished after retry", success: true }) },
            },
          ],
        };
      },
    };

    await harness.initialize(task, context);
    const result = await harness.execute();

    expect(result.output).toBe("finished after retry");
    expect(callCount).toBe(2);
    expect(context.budget.turnsUsed).toBe(1);
    expect(harness.beforeTurnCalls).toBe(1);
    (context.db as any).close?.();
  });
});
