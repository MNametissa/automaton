import { afterEach, expect, it, vi } from 'vitest';
import { BUILTIN_TASKS } from '../heartbeat/tasks.js';
import { insertGoal, insertTask } from '../state/database.js';
import { createTestConfig, createTestDb, createTestIdentity, MockConwayClient } from './mocks.js';

afterEach(() => vi.useRealTimers());
function fixture() {
  const db = createTestDb(); db.setAgentState('sleeping');
  const identity = createTestIdentity();
  const task = { db, identity, config: createTestConfig({ standalone: true }), conway: new MockConwayClient() };
  const tick = { creditBalance: 100 } as any;
  const goal = insertGoal(db.raw, { title: 'Deliver paid work', description: 'Prepare useful work' });
  return { db, task, tick, goal };
}

it('wakes for unplanned work, deduplicates a queued wake and throttles repeated nudges', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-09T10:00:00Z'));
  const f = fixture();
  try {
    expect((await BUILTIN_TASKS.check_work(f.tick, f.task)).shouldWake).toBe(true);
    expect((await BUILTIN_TASKS.check_work(f.tick, f.task)).shouldWake).toBe(false);
    vi.advanceTimersByTime(120001);
    f.db.raw.prepare("INSERT INTO wake_events(source,reason) VALUES ('heartbeat','work')").run();
    expect((await BUILTIN_TASKS.check_work(f.tick, f.task)).shouldWake).toBe(false);
    f.db.raw.prepare('DELETE FROM wake_events').run();
    expect((await BUILTIN_TASKS.check_work(f.tick, f.task)).shouldWake).toBe(true);
  } finally { f.db.close(); }
});

it.each(['no-budget', 'running', 'blocked-audit', 'paused-goal', 'dependencies'])('does not spend a wake on %s', async (reason) => {
  const f = fixture();
  try {
    if (reason === 'no-budget') f.tick.creditBalance = 0;
    if (reason === 'running') f.db.setAgentState('running');
    if (reason === 'blocked-audit') f.db.setKV('startup.audit', '{"status":"blocked"}');
    if (reason === 'paused-goal') f.db.raw.prepare("UPDATE goals SET status='paused' WHERE id=?").run(f.goal);
    if (reason === 'dependencies') {
      const running = insertTask(f.db.raw, { goalId: f.goal, title: 'Working', description: '', status: 'running', assignedTo: 'local://busy' });
      insertTask(f.db.raw, { goalId: f.goal, title: 'Wait', description: '', dependencies: [running] });
    }
    expect((await BUILTIN_TASKS.check_work(f.tick, f.task)).shouldWake).toBe(false);
  } finally { f.db.close(); }
});

it.each(['pending', 'completed', 'failed', 'assigned'])('wakes for %s work requiring parent attention', async (status) => {
  const f = fixture();
  try {
    insertTask(f.db.raw, { goalId: f.goal, title: 'Task', description: '', status: status as any,
      assignedTo: status === 'assigned' ? f.task.identity.address : null });
    expect((await BUILTIN_TASKS.check_work(f.tick, f.task)).shouldWake).toBe(true);
  } finally { f.db.close(); }
});
