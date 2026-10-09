import type { HeartbeatTaskFn } from '../types.js';
import { getActiveGoals, getReadyTasks, getTasksByGoal } from '../state/database.js';

/** Deterministic work nudge, not an inference loop or a replacement for supervision. */
export const checkWork: HeartbeatTaskFn = async (tick, context) => {
  const { db, identity } = context;
  const quiet = { shouldWake: false };
  if (db.getAgentState() !== 'sleeping' || !Number.isFinite(tick.creditBalance) || tick.creditBalance <= 0) return quiet;
  try { if (JSON.parse(db.getKV('startup.audit') || '{}').status === 'blocked') return quiet; }
  catch { return quiet; }
  if (db.raw.prepare('SELECT 1 FROM wake_events WHERE consumed_at IS NULL LIMIT 1').get()) return quiet;
  const last = Date.parse(db.getKV('work.last_wake') || '');
  if (Number.isFinite(last) && Date.now() - last < 120_000) return quiet;
  const goals = getActiveGoals(db.raw);
  const activeIds = new Set(goals.map(goal => goal.id));
  let needsAttention = getReadyTasks(db.raw).some(task => activeIds.has(task.goalId));
  if (!needsAttention) needsAttention = goals.some(goal => {
    const tasks = getTasksByGoal(db.raw, goal.id);
    return tasks.length === 0 || tasks.every(task => task.status === 'completed')
      || tasks.some(task => task.status === 'failed'
        || (task.assignedTo === identity.address && ['assigned', 'running'].includes(task.status)));
  });
  if (!needsAttention) return quiet;
  db.setKV('work.last_wake', new Date().toISOString());
  return { shouldWake: true, message: 'Active goals need planning, ready task execution, failure recovery or final verification. Inspect persisted work and choose the next useful action within the current budget.' };
};
