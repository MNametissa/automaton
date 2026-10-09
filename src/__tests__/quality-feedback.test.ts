import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CREATE_TABLES } from "../state/schema.js";
import {
  getQualityState,
  qualityTurnLimit,
  recordQualityFailure,
  recordQualitySuccess,
} from "../orchestration/quality.js";

describe("durable quality feedback", () => {
  let db: Database.Database;
  let directory: string;
  let filename: string;
  const failure = { taskId: "task-1", goalId: "goal-1", attempt: 0, kind: "execution" as const, detail: "Command failed" };

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "quality-feedback-"));
    filename = path.join(directory, "state.db");
    db = new Database(filename);
    db.exec(CREATE_TABLES);
  });

  afterEach(() => {
    if (db.open) db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("persists a failure and does not count repeated polling after restart", () => {
    expect(qualityTurnLimit(db, 20)).toBe(16);
    recordQualityFailure(db, failure);
    db.close();
    db = new Database(filename);
    recordQualityFailure(db, { ...failure, detail: "  Command\n failed  " });
    expect(getQualityState(db)).toEqual({ score: -2, failureEvents: 1, failedAttempts: 1, verifiedGoals: 0, recoveredGoals: 0 });
    expect(qualityTurnLimit(db, 20)).toBe(12);
  });

  it("penalizes distinct errors but counts each failed task attempt once", () => {
    recordQualityFailure(db, failure);
    recordQualityFailure(db, { ...failure, kind: "verification", detail: "Wrong output" });
    recordQualityFailure(db, { ...failure, detail: "Timeout" });
    expect(getQualityState(db)).toMatchObject({ score: -6, failureEvents: 3, failedAttempts: 1 });
    recordQualityFailure(db, { ...failure, attempt: 1 });
    expect(getQualityState(db)).toMatchObject({ score: -8, failureEvents: 4, failedAttempts: 2 });
    expect(qualityTurnLimit(db, 20)).toBe(8);
  });

  it("rewards independently verified goals once even after restart", () => {
    recordQualitySuccess(db, "clean-goal");
    expect(getQualityState(db)).toMatchObject({ score: 3, verifiedGoals: 1, recoveredGoals: 0 });
    expect(qualityTurnLimit(db, 20)).toBe(20);
    db.close();
    db = new Database(filename);
    recordQualitySuccess(db, "clean-goal");
    expect(getQualityState(db)).toMatchObject({ score: 3, verifiedGoals: 1 });
  });

  it("rewards recovery without allowing repeated fail-success cycles to farm credit", () => {
    recordQualityFailure(db, failure);
    recordQualitySuccess(db, failure.goalId);
    expect(getQualityState(db)).toMatchObject({ score: 2, verifiedGoals: 1, recoveredGoals: 1 });
    recordQualitySuccess(db, failure.goalId);
    recordQualityFailure(db, { ...failure, attempt: 1 });
    recordQualitySuccess(db, failure.goalId);
    expect(getQualityState(db)).toMatchObject({ score: 0, failureEvents: 2, failedAttempts: 2, verifiedGoals: 1, recoveredGoals: 1 });
  });

  it("bounds scores and worker turns without modifying financial state", () => {
    db.prepare("INSERT INTO kv (key, value) VALUES (?, ?)").run("budget_cents", "0");
    for (let attempt = 0; attempt < 30; attempt++) recordQualityFailure(db, { ...failure, attempt });
    expect(getQualityState(db)).toMatchObject({ score: -10, failedAttempts: 30 });
    for (let goal = 0; goal < 30; goal++) recordQualitySuccess(db, `verified-${goal}`);
    expect(getQualityState(db)).toMatchObject({ score: 10, verifiedGoals: 30 });
    expect(qualityTurnLimit(db, 7)).toBe(7);
    expect(qualityTurnLimit(db, 2.9)).toBe(2);
    expect(qualityTurnLimit(db, 1)).toBe(1);
    expect(db.prepare("SELECT value FROM kv WHERE key = ?").get("budget_cents")).toEqual({ value: "0" });
  });

  it("does not create extra recovery credit for an error at the score floor", () => {
    for (let attempt = 0; attempt < 5; attempt++) recordQualityFailure(db, { ...failure, attempt });
    recordQualityFailure(db, { ...failure, taskId: "floor-task", goalId: "floor-goal" });
    recordQualitySuccess(db, "floor-goal");
    expect(getQualityState(db)).toMatchObject({ score: -7, recoveredGoals: 1, verifiedGoals: 1 });
  });

  it.each(["broken JSON", "null", "[]", '{"score":"Infinity"}'])("keeps malformed saved state conservative: %s", value => {
    db.prepare("INSERT INTO kv (key, value) VALUES (?, ?)").run("quality.state", value);
    expect(getQualityState(db)).toEqual({ score: -10, failureEvents: 0, failedAttempts: 0, verifiedGoals: 0, recoveredGoals: 0 });
    expect(qualityTurnLimit(db, 20)).toBe(8);
  });

  it("clamps out-of-range saved values before applying a new failure", () => {
    db.prepare("INSERT INTO kv (key, value) VALUES (?, ?)").run("quality.state", JSON.stringify({ score: 999, failedAttempts: -1, failureEvents: 1e100 }));
    recordQualityFailure(db, failure);
    expect(getQualityState(db)).toMatchObject({ score: 8, failedAttempts: 1, failureEvents: Number.MAX_SAFE_INTEGER });
    expect(qualityTurnLimit(db, Number.MAX_VALUE)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("rejects empty task and goal IDs before recording receipts", () => {
    expect(() => recordQualityFailure(db, { ...failure, taskId: " " })).toThrow();
    expect(() => recordQualityFailure(db, { ...failure, goalId: "" })).toThrow();
    expect(() => recordQualitySuccess(db, " ")).toThrow();
    expect(getQualityState(db)).toMatchObject({ score: 0, verifiedGoals: 0, failureEvents: 0 });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("uses one turn for invalid configuration %s", maximum => {
    expect(qualityTurnLimit(db, maximum)).toBe(1);
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid attempt %s before persisting a penalty", attempt => {
    expect(() => recordQualityFailure(db, { ...failure, attempt })).toThrow();
    expect(getQualityState(db)).toMatchObject({ score: 0, failedAttempts: 0 });
  });

  it("rolls back receipts and score together if the outer transaction fails", () => {
    expect(() => db.transaction(() => {
      recordQualityFailure(db, failure);
      throw new Error("rollback");
    })()).toThrow("rollback");
    expect(getQualityState(db)).toMatchObject({ score: 0, failureEvents: 0 });
    recordQualityFailure(db, failure);
    expect(getQualityState(db)).toMatchObject({ score: -2, failureEvents: 1 });
  });
});
