import { createHash } from "node:crypto";
import type { Database } from "better-sqlite3";

const STATE_KEY = "quality.state";

export interface QualityState {
  score: number;
  failureEvents: number;
  failedAttempts: number;
  verifiedGoals: number;
  recoveredGoals: number;
}

export interface QualityFailure {
  taskId: string;
  goalId: string;
  attempt: number;
  kind: "execution" | "verification";
  detail: string;
}

function read(db: Database, key: string): string | undefined {
  return (db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined)?.value;
}

function write(db: Database, key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))").run(key, value);
}

function key(kind: string, ...parts: (string | number)[]): string {
  return `quality.${kind}.${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
}

function bounded(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.trunc(value)))
    : fallback;
}

function requireId(value: string): void {
  if (typeof value !== "string" || !value.trim()) throw new Error("Quality feedback requires a nonempty ID");
}

/** Durable counters are observations from the runtime, never claims from a model. */
export function getQualityState(db: Database): QualityState {
  const raw = read(db, STATE_KEY);
  let parsed: Partial<QualityState> = {};
  if (raw !== undefined) {
    try {
      const value: unknown = JSON.parse(raw);
      if (value && typeof value === "object" && !Array.isArray(value)) parsed = value;
    } catch { /* A damaged score must not grant additional turns. */ }
  }
  return {
    score: bounded(parsed.score, -10, 10, raw === undefined ? 0 : -10),
    failureEvents: bounded(parsed.failureEvents, 0, Number.MAX_SAFE_INTEGER, 0),
    failedAttempts: bounded(parsed.failedAttempts, 0, Number.MAX_SAFE_INTEGER, 0),
    verifiedGoals: bounded(parsed.verifiedGoals, 0, Number.MAX_SAFE_INTEGER, 0),
    recoveredGoals: bounded(parsed.recoveredGoals, 0, Number.MAX_SAFE_INTEGER, 0),
  };
}

/** Count a distinct observed error once, including across retries of the observer. */
export function recordQualityFailure(db: Database, failure: QualityFailure): QualityState {
  requireId(failure.taskId);
  requireId(failure.goalId);
  if (!Number.isSafeInteger(failure.attempt) || failure.attempt < 0) {
    throw new Error("Quality feedback attempt must be a nonnegative safe integer");
  }
  if (failure.kind !== "execution" && failure.kind !== "verification") {
    throw new Error("Unsupported quality failure kind");
  }
  if (typeof failure.detail !== "string") throw new Error("Quality failure detail must be a string");

  return db.transaction(() => {
    const state = getQualityState(db);
    const eventKey = key("failure", failure.taskId, failure.kind, failure.attempt, failure.detail.trim().replace(/\s+/g, " "));
    if (read(db, eventKey) !== undefined) return state;

    const attemptKey = key("attempt", failure.taskId, failure.attempt);
    if (read(db, attemptKey) === undefined) {
      state.failedAttempts = Math.min(Number.MAX_SAFE_INTEGER, state.failedAttempts + 1);
      write(db, attemptKey, "1");
    }
    state.failureEvents = Math.min(Number.MAX_SAFE_INTEGER, state.failureEvents + 1);
    const nextScore = Math.max(-10, state.score - 2);
    const goalKey = key("failed-goal", failure.goalId);
    // At the score floor an uncharged error cannot manufacture a recovery bonus.
    const recoveryCredit = Math.max(Number(read(db, goalKey)) || 0, Math.min(1, state.score - nextScore));
    write(db, goalKey, String(Math.min(1, recoveryCredit)));
    state.score = nextScore;
    write(db, eventKey, "1");
    write(db, STATE_KEY, JSON.stringify(state));
    return state;
  }).immediate();
}

/** Call only after every required goal check has freshly passed independent verification. */
export function recordQualitySuccess(db: Database, goalId: string): QualityState {
  requireId(goalId);
  return db.transaction(() => {
    const state = getQualityState(db);
    const verifiedKey = key("verified-goal", goalId);
    if (read(db, verifiedKey) !== undefined) return state;

    const recoveryCredit = read(db, key("failed-goal", goalId));
    const bonus = recoveryCredit === "1" ? 1 : 0;
    state.score = Math.min(10, state.score + 3 + bonus);
    state.verifiedGoals = Math.min(Number.MAX_SAFE_INTEGER, state.verifiedGoals + 1);
    if (recoveryCredit !== undefined) state.recoveredGoals = Math.min(Number.MAX_SAFE_INTEGER, state.recoveredGoals + 1);
    // A goal can earn at most four points in its entire lifetime. With its failure
    // penalty, recovery earns no more net credit than a clean verified goal.
    write(db, verifiedKey, "1");
    write(db, STATE_KEY, JSON.stringify(state));
    return state;
  }).immediate();
}

/** Adjust worker effort only; this never changes money, permissions, or the hard cap. */
export function qualityTurnLimit(db: Database, configuredMax: number): number {
  const maximum = bounded(configuredMax, 1, Number.MAX_SAFE_INTEGER, 1);
  const { score } = getQualityState(db);
  const factor = score <= -6 ? 0.5 : score < 0 ? 0.75 : score > 0 ? 1.25 : 1;
  return Math.max(1, Math.min(maximum, Math.floor(maximum * (0.8 * factor))));
}
