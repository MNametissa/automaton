/**
 * Local Agent Worker
 *
 * Runs inference-driven task execution in-process as an async background task.
 * Each worker executes through a harness chosen by role via HarnessRegistry.
 */

import path from "node:path";
import { ulid } from "ulid";
import { createLogger } from "../observability/logger.js";
import type { HarnessContext, WorkerInferenceClient } from "../agent/harness-types.js";
import { buildWisdomFromGoal, createBudgetFromTask } from "../agent/harness-types.js";
import { HarnessRegistry } from "../agent/harness-registry.js";
import { assignTask, completeTask, failTask } from "./task-graph.js";
import type { TaskNode } from "./task-graph.js";
import { AgentWorkspace } from "./workspace.js";
import type {
  AutomatonConfig,
  AutomatonIdentity,
  AutomatonTool,
  ConwayClient,
  InputSource,
  SpendTrackerInterface,
  ToolContext,
} from "../types.js";
import type { Database } from "better-sqlite3";
import type { PolicyEngine } from "../agent/policy-engine.js";

const logger = createLogger("orchestration.local-worker");
const DEFAULT_ALLOWED_EDIT_ROOT = process.cwd();

interface LocalWorkerConfig {
  db: Database;
  inference: WorkerInferenceClient;
  conway: ConwayClient;
  maxTurns?: number;
  harnessRegistry: HarnessRegistry;
  identity: AutomatonIdentity;
  config: AutomatonConfig;
  allowedEditRoot?: string;
  tools?: AutomatonTool[];
  toolContext?: ToolContext;
  policyEngine?: PolicyEngine;
  spendTracker?: SpendTrackerInterface;
  inputSource?: InputSource;
}

export class LocalWorkerCapacityError extends Error {
  constructor() { super("Local worker capacity is full; retry on the next tick"); }
}

// A runtime keeps its database open across wake cycles. Never share workers
// between database connections or agent identities.
const runtimePools = new WeakMap<Database, Map<string, LocalWorkerPool>>();

export function getLocalWorkerPool(config: LocalWorkerConfig): LocalWorkerPool {
  let pools = runtimePools.get(config.db);
  if (!pools) {
    pools = new Map();
    runtimePools.set(config.db, pools);
  }
  const key = config.identity.address;
  let pool = pools.get(key);
  if (!pool) {
    pool = new LocalWorkerPool(config);
    pools.set(key, pool);
  } else {
    pool.configure(config);
  }
  return pool;
}

export async function shutdownLocalWorkers(db: Database, address: string): Promise<void> {
  const pools = runtimePools.get(db);
  const pool = pools?.get(address);
  if (pool) await pool.shutdown();
}

export class LocalWorkerPool {
  private activeWorkers = new Map<string, { promise: Promise<void>; abortController: AbortController }>();

  private stopping = false;

  constructor(private config: LocalWorkerConfig) {}

  configure(config: LocalWorkerConfig): void {
    this.config = config;
  }

  spawn(task: TaskNode): { address: string; name: string; sandboxId: string } {
    const limit = this.config.config.maxLocalWorkers ?? 4;
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error("maxLocalWorkers must be a positive integer");
    }
    if (this.stopping || this.activeWorkers.size >= limit) throw new LocalWorkerCapacityError();

    const workerId = `local-worker-${ulid()}`;
    const workerName = `worker-${task.agentRole ?? "generalist"}-${workerId.slice(-6)}`;
    const address = `local://${workerId}`;
    const abortController = new AbortController();

    // Claim synchronously before any harness work or another spawn can run.
    assignTask(this.config.db, task.id, address);
    const workerConfig = this.config;
    // Let the orchestrator register the child before a fast harness can finish.
    const workerPromise = new Promise<void>(resolve => setImmediate(resolve))
      .then(() => this.runWorker(workerId, task, abortController.signal, workerConfig))
      .catch((error) => {
        logger.error("Local worker crashed", error instanceof Error ? error : new Error(String(error)), {
          workerId,
          taskId: task.id,
        });
        try {
          failTask(
            this.config.db,
            task.id,
            `Worker crashed: ${error instanceof Error ? error.message : String(error)}`,
            true,
          );
        } catch {
          // Task may already be in a terminal state.
        }
      })
      .finally(() => {
        this.activeWorkers.delete(workerId);
        this.config.db.prepare("UPDATE children SET status = 'cleaned_up' WHERE address = ?").run(address);
      });

    this.activeWorkers.set(workerId, { promise: workerPromise, abortController });
    return { address, name: workerName, sandboxId: workerId };
  }

  getActiveCount(): number {
    return this.activeWorkers.size;
  }

  hasWorker(addressOrId: string): boolean {
    const id = addressOrId.replace("local://", "");
    return this.activeWorkers.has(id);
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    for (const [, worker] of this.activeWorkers) {
      worker.abortController.abort();
    }
    await Promise.allSettled([...this.activeWorkers.values()].map((worker) => worker.promise));
    this.activeWorkers.clear();
  }

  private async runWorker(workerId: string, task: TaskNode, signal: AbortSignal, config = this.config): Promise<void> {
    const requeueInterruptedTask = () => {
      config.db.prepare("UPDATE task_graph SET status = 'pending', assigned_to = NULL, started_at = NULL WHERE id = ? AND assigned_to = ? AND status IN ('assigned', 'running')")
        .run(task.id, `local://${workerId}`);
    };
    if (signal.aborted) {
      requeueInterruptedTask();
      return;
    }
    const harness = config.harnessRegistry.createForRole(task.agentRole);
    const workspace = new AgentWorkspace(task.goalId);
    const allowedEditRoot = path.resolve(config.allowedEditRoot ?? DEFAULT_ALLOWED_EDIT_ROOT);
    const workerIdentity = createWorkerIdentity(config.identity, workerId, task.agentRole);
    const context: HarnessContext = {
      workspaceRoot: workspace.basePath,
      allowedEditRoot,
      workspace,
      identity: workerIdentity,
      config: config.config,
      db: config.db,
      conway: config.conway,
      inference: {
        chat: async (params) => config.inference.chat(params),
      },
      budget: createBudgetFromTask(task),
      wisdom: buildWisdomFromGoal(config.db, task.goalId, workspace),
      abortSignal: signal,
      goalId: task.goalId,
      toolCatalog: config.tools,
      toolContext: config.toolContext
        ? {
            ...config.toolContext,
            identity: workerIdentity,
          }
        : undefined,
      policyEngine: config.policyEngine,
      spendTracker: config.spendTracker,
      inputSource: config.inputSource,
    };

    if (config.maxTurns) {
      context.budget.maxTurns = config.maxTurns;
    }
    if (harness.id === "orchestrator" && !config.maxTurns) {
      context.budget.maxTurns = Math.max(context.budget.maxTurns, 50);
    }

    logger.info(
      `[WORKER ${workerId}] Starting task "${task.title}" (${task.id}), role: ${task.agentRole ?? "generalist"}, harness: ${harness.id}`,
    );

    try {
      await harness.initialize(task, context);
      if (signal.aborted) {
        requeueInterruptedTask();
        return;
      }
      const result = await harness.execute();

      if (result.success) {
        completeTask(config.db, task.id, result);
        logger.info("Local worker completed task", {
          workerId,
          taskId: task.id,
          title: task.title,
          duration: result.duration,
          harness: harness.id,
        });
      } else if (signal.aborted) {
        requeueInterruptedTask();
      } else {
        failTask(config.db, task.id, result.output || "Task reported failure", true);
        logger.warn("Local worker reported task failure", {
          workerId,
          taskId: task.id,
          title: task.title,
          harness: harness.id,
          output: result.output.slice(0, 200),
        });
      }
    } catch (error) {
      if (signal.aborted) {
        requeueInterruptedTask();
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[WORKER ${workerId}] Harness execution failed: ${message}`);
      failTask(config.db, task.id, message, true);
    }
  }
}

function createWorkerIdentity(
  parentIdentity: AutomatonIdentity,
  workerId: string,
  role: string | null,
): AutomatonIdentity {
  return {
    ...parentIdentity,
    name: `worker-${role ?? "generalist"}-${workerId.slice(-6)}`,
    address: `local://${workerId}`,
    sandboxId: workerId,
  };
}
