import { recordQualityFailure, recordQualitySuccess } from '../orchestration/quality.js';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getTaskById, getTasksByGoal, type TaskGraphRow } from '../state/database.js';
import { runVerification, type VerificationReport } from './runner.js';

interface Evidence { fingerprint: string; criteria: string; checks: unknown; report: VerificationReport; root: string; inputs: Record<string, string> }
function fingerprint(task: TaskGraphRow): string {
  return createHash('sha256').update(JSON.stringify([task.id, task.description, task.result])).digest('hex');
}
function successful(result: unknown): boolean {
  return !!result && typeof result === 'object' && 'success' in result && result.success === true;
}
function inputHashes(checks: unknown, root: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  if (!Array.isArray(checks)) return hashes;
  const base = fs.realpathSync(root);
  for (const check of checks) for (const key of ['script', 'report', 'sources']) {
    if (typeof check?.[key] !== 'string') continue;
    const file = path.resolve(base, check[key]);
    if (!fs.realpathSync(file).startsWith(base + path.sep) || !fs.statSync(file).isFile() || fs.statSync(file).size > 8_000_000) throw new Error('Invalid verification input');
    hashes[file] = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }
  return hashes;
}
function load(db: Database.Database, key: string): string | undefined {
  return (db.prepare('SELECT value FROM kv WHERE key=?').get(key) as { value: string } | undefined)?.value;
}
export function requireGoalVerification(db: Database.Database, goalId: string): void {
  db.prepare('INSERT OR REPLACE INTO kv (key,value) VALUES (?,?)').run(`verification.required:${goalId}`, 'true');
}
export function goalRequiresVerification(db: Database.Database, goalId: string): boolean {
  return load(db, `verification.required:${goalId}`) === 'true';
}
export function taskEvidence(db: Database.Database, taskId: string): Evidence | undefined {
  try {
    const raw = load(db, `verification.task:${taskId}`);
    return raw ? JSON.parse(raw) as Evidence : undefined;
  } catch { return undefined; }
}
export function taskIsVerified(db: Database.Database, taskId: string): boolean {
  const task = getTaskById(db, taskId), evidence = taskEvidence(db, taskId);
  try {
    return !!task && task.status === 'completed' && successful(task.result)
      && evidence?.report?.status === 'passed' && evidence.fingerprint === fingerprint(task)
      && JSON.stringify(evidence.inputs) === JSON.stringify(inputHashes(evidence.checks, evidence.root));
  } catch { return false; }
}
export function unverifiedTasks(db: Database.Database, goalId: string): string[] {
  return getTasksByGoal(db, goalId).filter(task => !taskIsVerified(db, task.id)).map(task => task.id);
}
export async function verifyTask(db: Database.Database, taskId: string, criteria: string, checks: unknown, root: string, signal?: AbortSignal): Promise<VerificationReport> {
  const task = getTaskById(db, taskId);
  if (!task || task.status !== 'completed' || !successful(task.result)) throw new Error('Only a successfully finished task can be verified');
  if (!criteria.trim()) throw new Error('State the acceptance criteria');
  const before = fingerprint(task);
  let inputs: Record<string, string> = {};
  try { inputs = inputHashes(checks, root); } catch { /* Runner records inaccessible inputs as failed checks. */ }
  const report = await runVerification(checks, root, signal);
  const current = getTaskById(db, taskId);
  if (!current || fingerprint(current) !== before) throw new Error('Task changed during verification; run the checks again');
  if (report.status === 'passed' && JSON.stringify(inputs) !== JSON.stringify(inputHashes(checks, root))) {
    report.status = 'failed'; report.checks.push({ kind: 'inputs', status: 'failed', detail: 'Checked inputs changed during execution; rerun verification' });
  }
  db.prepare('INSERT OR REPLACE INTO kv (key,value) VALUES (?,?)').run(`verification.task:${taskId}`,
    JSON.stringify({ fingerprint: before, criteria, checks, report, root, inputs } satisfies Evidence));
  if (report.status === 'failed') recordQualityFailure(db, { taskId, goalId: task.goalId, attempt: task.retryCount, kind: 'verification',
    detail: JSON.stringify(report.checks.filter(check => check.status === 'failed')) });
  return report;
}

// Only this asynchronous pass can authorize final goal completion. Individual task
// evidence does not observe imported modules or a changed live HTTP service.
function goalFingerprint(db: Database.Database, goalId: string): string {
  return createHash('sha256').update(JSON.stringify(getTasksByGoal(db, goalId).map(task =>
    [task.id, task.status, fingerprint(task), taskEvidence(db, task.id)]))).digest('hex');
}
export function goalIsVerified(db: Database.Database, goalId: string): boolean {
  return getTasksByGoal(db, goalId).length > 0 && !unverifiedTasks(db, goalId).length
    && load(db, `verification.goal:${goalId}`) === goalFingerprint(db, goalId);
}
export async function verifyGoal(db: Database.Database, goalId: string, signal?: AbortSignal): Promise<boolean> {
  db.prepare('DELETE FROM kv WHERE key=?').run(`verification.goal:${goalId}`);
  const tasks = getTasksByGoal(db, goalId);
  if (!tasks.length || unverifiedTasks(db, goalId).length) return false;
  const before = tasks.map(task => [task.id, fingerprint(task)]);
  let passed = true;
  for (const task of tasks) {
    const evidence = taskEvidence(db, task.id)!;
    const report = await verifyTask(db, task.id, evidence.criteria, evidence.checks, evidence.root, signal);
    if (report.status !== 'passed') passed = false;
  }
  const after = getTasksByGoal(db, goalId).map(task => [task.id, fingerprint(task)]);
  if (!passed || JSON.stringify(before) !== JSON.stringify(after) || unverifiedTasks(db, goalId).length) return false;
  db.prepare('INSERT OR REPLACE INTO kv (key,value) VALUES (?,?)').run(`verification.goal:${goalId}`, goalFingerprint(db, goalId));
  recordQualitySuccess(db, goalId);
  return true;
}
