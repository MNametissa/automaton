import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startupAssessmentResponses } from "../startup-audit-fixtures.js";
import { HarnessRegistry } from "../../agent/harness-registry.js";
import { runAgentLoop } from "../../agent/loop.js";
import { LocalWorkerPool, getLocalWorkerPool, shutdownLocalWorkers } from "../../orchestration/local-worker.js";
import { Orchestrator } from "../../orchestration/orchestrator.js";
import { ColonyMessaging, LocalDBTransport } from "../../orchestration/messaging.js";
import { SimpleAgentTracker, SimpleFundingProtocol } from "../../orchestration/simple-tracker.js";
import { getReadyTasks, type TaskResult } from "../../orchestration/task-graph.js";
import { getTaskById } from "../../state/database.js";
import { createTestDb, createTestConfig, createTestIdentity, MockConwayClient, MockInferenceClient, noToolResponse } from "../mocks.js";

const success: TaskResult = { success: true, output: "done", artifacts: [], costCents: 0, duration: 1 };

// Unit fixtures must not query a real chain for their synthetic wallet.
vi.mock("../../conway/x402.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../conway/x402.js")>(),
  getUsdcBalance: vi.fn(async () => 0),
}));

describe("local worker lifecycle", () => {
  let db: ReturnType<typeof createTestDb>;
  let identity: ReturnType<typeof createTestIdentity>;
  let config: ReturnType<typeof createTestConfig>;
  let conway: MockConwayClient;
  let pool: LocalWorkerPool | undefined;
  let releases: Array<() => void>;
  let executions: string[];

  beforeEach(() => {
    db = createTestDb();
    identity = createTestIdentity();
    config = createTestConfig({ maxChildren: 0, maxTurnsPerCycle: 1 });
    conway = new MockConwayClient();
    pool = undefined;
    releases = [];
    executions = [];
    db.raw.prepare("INSERT INTO goals (id, title, description, status, created_at) VALUES ('goal', 'goal', 'goal', 'active', datetime('now'))").run();
    db.setKV("orchestrator.state", JSON.stringify({ phase: "executing", goalId: "goal", replanCount: 0 }));
    vi.spyOn(HarnessRegistry.prototype, "createForRole").mockImplementation(() => {
      let taskId = "";
      return {
        id: "deferred", description: "controlled test harness",
        initialize: async task => { taskId = task.id; },
        execute: async () => {
          executions.push(taskId);
          await new Promise<void>(resolve => releases.push(resolve));
          return success;
        },
        getToolDefs: () => [], buildSystemPrompt: () => "", buildTaskPrompt: () => "",
      };
    });
  });

  afterEach(async () => {
    await new Promise(resolve => setImmediate(resolve));
    releases.forEach(release => release());
    await pool?.shutdown();
    await new Promise(resolve => setImmediate(resolve));
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    db.close();
  });

  function task(id: string, status = "pending", assignedTo: string | null = null) {
    db.raw.prepare("INSERT INTO task_graph (id, goal_id, title, description, status, assigned_to, created_at) VALUES (?, 'goal', ?, 'work', ?, ?, datetime('now'))").run(id, id, status, assignedTo);
  }

  function makePool(maxLocalWorkers = 1) {
    pool = new LocalWorkerPool({
      db: db.raw, conway, identity, config: { ...config, maxLocalWorkers } as typeof config,
      harnessRegistry: new HarnessRegistry(), inference: { chat: async () => ({ content: "unused" }) },
    });
    return pool;
  }

  function orchestrator(workerPool = pool, standalone = true) {
    return new Orchestrator({
      db: db.raw, identity,
      agentTracker: new SimpleAgentTracker(db), funding: new SimpleFundingProtocol(conway, identity, db),
      messaging: new ColonyMessaging(new LocalDBTransport(db), db), inference: {} as any,
      isWorkerAlive: address => workerPool?.hasWorker(address) ?? false,
      config: { ...config, standalone, spawnAgent: (node: any) => workerPool?.spawn(node) },
    });
  }

  it("keeps overflow pending and starts it after capacity is released", async () => {
    task("first"); task("second");
    const workers = makePool();
    const orc = orchestrator();
    const tick = await orc.tick();
    await vi.waitFor(() => expect(executions).toHaveLength(1));
    expect(workers.getActiveCount()).toBe(1);
    expect(tick.tasksAssigned).toBe(1);
    expect(tick.tasksFailed).toBe(0);
    const queued = ["first", "second"].find(id => getTaskById(db.raw, id)?.status === "pending");
    expect(queued).toBeDefined();
    expect(getTaskById(db.raw, queued!)?.retryCount).toBe(0);
    expect(getTaskById(db.raw, queued!)?.assignedTo).toBeNull();
    releases[0]();
    await vi.waitFor(() => expect(workers.getActiveCount()).toBe(0));
    await orc.tick();
    await vi.waitFor(() => expect(executions).toHaveLength(2));
    expect(new Set(executions).size).toBe(2);
  });

  it("claims a task before execution and rejects duplicate spawn", async () => {
    task("single");
    const node = getReadyTasks(db.raw)[0];
    const workers = makePool(4);
    const child = workers.spawn(node);
    expect(getTaskById(db.raw, "single")?.assignedTo).toBe(child.address);
    expect(() => workers.spawn(node)).toThrow();
    await vi.waitFor(() => expect(executions).toEqual(["single"]));
  });

  it("does not overwrite a fast worker completion during assignment", async () => {
    task("fast");
    vi.mocked(HarnessRegistry.prototype.createForRole).mockReturnValue({
      id: "fast", description: "fast", initialize: async () => {}, execute: async () => success,
      getToolDefs: () => [], buildSystemPrompt: () => "", buildTaskPrompt: () => "",
    });
    makePool();
    const tick = await orchestrator().tick();
    await vi.waitFor(() => expect(pool!.getActiveCount()).toBe(0));
    expect(getTaskById(db.raw, "fast")?.status).toBe("completed");
    expect(getTaskById(db.raw, "fast")?.retryCount).toBe(0);
    expect(tick.tasksAssigned).toBe(1);
    expect(db.getChildren()[0]?.status).toBe("cleaned_up");
  });

  it.each(["assigned", "running"])("recovers a dead local worker's %s task and preserves parent work", async status => {
    task("orphan", status, "local://dead");
    task("parent", status, identity.address);
    const tracker = new SimpleAgentTracker(db);
    tracker.register({ address: "local://dead", name: "dead", role: "generalist", sandboxId: "dead" });
    makePool();
    await orchestrator().tick();
    await vi.waitFor(() => expect(executions).toEqual(["orphan"]));
    expect(getTaskById(db.raw, "orphan")?.assignedTo).not.toBe("local://dead");
    expect(getTaskById(db.raw, "parent")?.assignedTo).toBe(identity.address);
    expect(getTaskById(db.raw, "parent")?.status).toBe(status);
    expect(db.getChildren().find(child => child.address === "local://dead")?.status).toBe("cleaned_up");
  });

  it("never reuses a remote child for standalone work", async () => {
    task("local-task");
    new SimpleAgentTracker(db).register({ address: "0xremote", name: "remote", role: "generalist", sandboxId: "remote" });
    makePool();
    await orchestrator().tick();
    expect(getTaskById(db.raw, "local-task")?.assignedTo).toMatch(/^local:\/\//);
  });

  it("bounds the default local pool to four workers independently of maxChildren", async () => {
    for (let index = 0; index < 5; index++) task(`default-${index}`);
    pool = new LocalWorkerPool({
      db: db.raw, conway, identity, config,
      harnessRegistry: new HarnessRegistry(), inference: { chat: async () => ({ content: "unused" }) },
    });
    const tick = await orchestrator().tick();
    expect(pool.getActiveCount()).toBe(4);
    expect(tick.tasksAssigned).toBe(4);
    expect(getReadyTasks(db.raw)).toHaveLength(1);
  });

  it("isolates runtimes and refreshes dependencies only for future workers", async () => {
    const contexts: any[] = [];
    vi.mocked(HarnessRegistry.prototype.createForRole).mockImplementation(() => ({
      id: "context", description: "context", initialize: async (_task, context) => { contexts.push(context); },
      execute: async () => { await new Promise<void>(resolve => releases.push(resolve)); return success; },
      getToolDefs: () => [], buildSystemPrompt: () => "", buildTaskPrompt: () => "",
    }));
    const options = { db: db.raw, conway, identity, config, harnessRegistry: new HarnessRegistry(), inference: { chat: async () => ({ content: "old" }) } };
    pool = getLocalWorkerPool(options);
    task("old");
    pool.spawn(getReadyTasks(db.raw)[0]);
    await vi.waitFor(() => expect(contexts).toHaveLength(1));
    const refreshed = getLocalWorkerPool({ ...options, inference: { chat: async () => ({ content: "new" }) } });
    expect(refreshed).toBe(pool);
    expect(getLocalWorkerPool({ ...options, identity: { ...identity, address: "0xother" as any } })).not.toBe(pool);
    const otherDb = createTestDb();
    try {
      expect(getLocalWorkerPool({ ...options, db: otherDb.raw })).not.toBe(pool);
    } finally { otherDb.close(); }
    task("new");
    refreshed.spawn(getReadyTasks(db.raw)[0]);
    await vi.waitFor(() => expect(contexts).toHaveLength(2));
    expect((await contexts[0].inference.chat({ messages: [] })).content).toBe("old");
    expect((await contexts[1].inference.chat({ messages: [] })).content).toBe("new");
  });

  it("returns interrupted work to the queue without consuming retries on shutdown", async () => {
    let started = false;
    vi.mocked(HarnessRegistry.prototype.createForRole).mockImplementation(() => {
      let signal: AbortSignal;
      return {
        id: "abort", description: "abort", initialize: async (_task, context) => { signal = context.abortSignal!; },
        execute: async () => {
          started = true;
          await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
          return success;
        },
        getToolDefs: () => [], buildSystemPrompt: () => "", buildTaskPrompt: () => "",
      };
    });
    pool = getLocalWorkerPool({ db: db.raw, conway, identity, config, harnessRegistry: new HarnessRegistry(), inference: { chat: async () => ({ content: "unused" }) } });
    task("interrupted");
    pool.spawn(getReadyTasks(db.raw)[0]);
    await vi.waitFor(() => expect(started).toBe(true));
    await shutdownLocalWorkers(db.raw, identity.address);
    expect(getTaskById(db.raw, "interrupted")?.status).toBe("pending");
    expect(getTaskById(db.raw, "interrupted")?.retryCount).toBe(0);
    expect(getTaskById(db.raw, "interrupted")?.assignedTo).toBeNull();
    expect(pool.getActiveCount()).toBe(0);
    expect(() => pool!.spawn(getReadyTasks(db.raw)[0])).toThrow();
  });

  it.each([false, true])("retains a live worker across two real agent wake cycles (standalone=%s)", async standalone => {
    config.standalone = standalone;
    const destinations: string[] = [];
    if (standalone) {
      vi.spyOn(conway, "listModels").mockResolvedValue([{ id: config.inferenceModel, provider: "conway" }]);
      vi.stubGlobal("fetch", (url: unknown) => { destinations.push(String(url)); throw new Error("Network forbidden in standalone lifecycle test"); });
    }
    task("across-wakes");
    // Remote spawning is unavailable; both loops must use the same local fallback pool.
    vi.spyOn(conway, "createSandbox").mockRejectedValue(new Error("local test: no sandbox"));
    const inference = new MockInferenceClient([...(standalone ? startupAssessmentResponses(config, ["goal"]) : []), noToolResponse("Waiting for workers.")]);
    await runAgentLoop({ db, identity, config, conway, inference });
    await vi.waitFor(() => expect(executions).toEqual(["across-wakes"]));
    const address = getTaskById(db.raw, "across-wakes")?.assignedTo;
    await runAgentLoop({ db, identity, config, conway, inference });
    await new Promise(resolve => setImmediate(resolve));
    expect(getTaskById(db.raw, "across-wakes")?.assignedTo).toBe(address);
    expect(executions).toEqual(["across-wakes"]);
    if (standalone) {
      expect(JSON.parse(db.getKV("startup.audit")!).assessment.status).toBe("complete");
      expect(conway.createSandbox).not.toHaveBeenCalled();
      expect(destinations).toEqual([]);
    }
    releases.forEach(release => release());
    await vi.waitFor(() => expect(getTaskById(db.raw, "across-wakes")?.status).toBe("completed"));
  });
});
