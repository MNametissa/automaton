import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAnalysisTools, getAnalysisToolsReadiness, runAnalysisCommand } from "../integrations/analysis-tools.js";
import type { ToolContext } from "../types.js";

describe("analysis tool process and input security", () => {
  let root: string;
  let workspace: string;
  let runtime: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "analysis-adapter-test-"));
    workspace = join(root, "workspace");
    runtime = join(root, "runtime");
    await mkdir(workspace);
  });
  afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
  const context = {} as ToolContext;
  function execute(name: string, args: Record<string, unknown>) {
    return createAnalysisTools({ workspace, runtime }).find((tool) => tool.name === name)!.execute(args, context).then(JSON.parse);
  }
  it("registers the five offline adapters even when runtimes are absent and probes actual execution", async () => {
    expect(createAnalysisTools().map((tool) => tool.name)).toEqual(["rea_analyze_javascript", "rea_inspect_har", "mimic_hosts", "mimic_learn", "mimic_build_prompt"]);
    const readiness = await getAnalysisToolsReadiness({ workspace, runtime });
    expect(readiness.rea.available).toBe(false);
    expect(readiness.mimic.available).toBe(false);
  });
  it("rejects traversal, absolute paths, sensitive files, symlinks and CLI flags", async () => {
    await writeFile(join(workspace, "sample.har"), "{}");
    await symlink(join(workspace, "sample.har"), join(workspace, "link.har"));
    for (const path of ["../sample.har", "/etc/passwd", ".env", "wallet.json", "automaton.json", "config.json", "private-key.json", "link.har"]) {
      expect((await execute("mimic_hosts", { path })).ok).toBe(false);
    }
    expect((await execute("mimic_learn", { path: "sample.har", host: "--help" })).error).toMatch(/hostname/);
    expect((await execute("mimic_build_prompt", { path: "sample.har", host: "example.test", generator: "claude" })).error).toMatch(/Unexpected/);
  });
  it("refuses symlinks nested in source trees and cleans staged inputs", async () => {
    await mkdir(join(workspace, "app"));
    await writeFile(join(workspace, "app/main.js"), "export const answer = 42;");
    await symlink("/etc/passwd", join(workspace, "app/payload.json"));
    const result = await execute("rea_analyze_javascript", { path: "app" });
    expect(result.error).toMatch(/Symlinks/);
    expect(await readdir(join(runtime, "inputs"))).toEqual([]);
  });
  it("does not pass host secrets or shell-expand arguments", async () => {
    process.env.ANALYSIS_TEST_SECRET = "must-not-leak";
    try {
      const result = await runAnalysisCommand(process.execPath, ["-e", "console.log(JSON.stringify({secret:process.env.ANALYSIS_TEST_SECRET,home:process.env.HOME,arg:process.argv[1]}))", "$(touch injected)"], { workspace, runtime });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ home: join(runtime, "home"), arg: "$(touch injected)" });
    } finally { delete process.env.ANALYSIS_TEST_SECRET; }
  });
  it("uses the configured workspace and a separate writable state without moving runtime binaries", async () => {
    const state = join(root, "writable-state");
    vi.stubEnv("AUTOMATON_WORKSPACE", workspace);
    vi.stubEnv("AUTOMATON_ANALYSIS_RUNTIME", runtime);
    vi.stubEnv("AUTOMATON_ANALYSIS_STATE", state);
    await mkdir(join(runtime, "mimic/bin"), { recursive: true });
    await writeFile(join(runtime, "mimic/bin/python"), `#!${process.execPath}\nconsole.log(JSON.stringify({home:process.env.HOME,args:process.argv.slice(2)}));`, { mode: 0o755 });
    await writeFile(join(workspace, "fixture.har"), "{}");
    const tool = createAnalysisTools().find((item) => item.name === "mimic_hosts")!;
    const result = JSON.parse(await tool.execute({ path: "fixture.har" }, context));
    expect(result.ok).toBe(true);
    expect(result.command).toBe(join(runtime, "mimic/bin/python"));
    expect(JSON.parse(result.stdout).home).toBe(join(state, "home"));
    expect(await readdir(join(state, "inputs"))).toEqual([]);
    expect(await readdir(runtime)).toEqual(["mimic"]);
  });
  it("caps combined output and terminates a hung child", async () => {
    const verbose = await runAnalysisCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(1000000));setInterval(()=>{},1000)"], { workspace, runtime, maxOutputBytes: 1024 });
    expect(verbose.truncated).toBe(true);
    expect(Buffer.byteLength(verbose.stdout) + Buffer.byteLength(verbose.stderr)).toBeLessThanOrEqual(1024);
    const hung = await runAnalysisCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], { workspace, runtime, timeoutMs: 100 });
    expect(hung.timedOut).toBe(true);
    expect(hung.signal).toBe("SIGKILL");
  });
  it("always passes --har and --prompt-only and cleans the snapshot after execution", async () => {
    // A process fixture reports argv; separate opt-in integration smoke uses real CLIs.
    await mkdir(join(runtime, "mimic/bin"), { recursive: true });
    await writeFile(join(runtime, "mimic/bin/python"), `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));`, { mode: 0o755 });
    await writeFile(join(workspace, "fixture.har"), "{}");
    const result = await execute("mimic_build_prompt", { path: "fixture.har", host: "example.test" });
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.stdout)).toEqual(["-I", "-m", "mimic.cli", "gen", "example.test", "--har", expect.stringContaining("fixture.har"), "--prompt-only"]);
    expect(await readdir(join(runtime, "inputs"))).toEqual([]);
  });
});

// Run after installing the pinned tools: AUTOMATON_ANALYSIS_SMOKE=1 npx vitest run src/__tests__/analysis-tools.test.ts
describe.skipIf(process.env.AUTOMATON_ANALYSIS_SMOKE !== "1")("real pinned REA and Mimic", () => {
  it("executes static JS analysis and every offline HAR adapter using synthetic inputs", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "analysis-real-smoke-"));
    const runtime = process.env.AUTOMATON_ANALYSIS_RUNTIME ?? join(process.cwd(), ".local-work/tool-runtime");
    try {
      await mkdir(join(workspace, "app"));
      await writeFile(join(workspace, "app/package.json"), JSON.stringify({ name: "synthetic-analysis-smoke", version: "1.0.0", type: "module" }));
      await writeFile(join(workspace, "app/index.js"), "export function greet(name) { return `Hello ${name}`; }\n");
      await writeFile(join(workspace, "capture.har"), JSON.stringify({ log: { version: "1.2", creator: { name: "synthetic-test", version: "1" }, entries: [{ startedDateTime: "2026-01-01T00:00:00.000Z", time: 1, request: { method: "GET", url: "https://example.test/api/items", httpVersion: "HTTP/1.1", cookies: [], headers: [], queryString: [], headersSize: -1, bodySize: 0 }, response: { status: 200, statusText: "OK", httpVersion: "HTTP/1.1", cookies: [], headers: [{ name: "Content-Type", value: "application/json" }], content: { size: 12, mimeType: "application/json", text: '{"items":[]}' }, redirectURL: "", headersSize: -1, bodySize: 12 }, cache: {}, timings: { send: 0, wait: 1, receive: 0 } }] } }));
      const ready = await getAnalysisToolsReadiness({ workspace, runtime });
      expect(ready.rea.available).toBe(true);
      expect(ready.mimic.available).toBe(true);
      for (const tool of createAnalysisTools({ workspace, runtime })) {
        const args = tool.name === "rea_analyze_javascript" ? { path: "app" } : tool.name === "mimic_learn" || tool.name === "mimic_build_prompt" ? { path: "capture.har", host: "example.test" } : { path: "capture.har" };
        const result = JSON.parse(await tool.execute(args, {} as ToolContext));
        expect(result, `${tool.name}: ${JSON.stringify(result)}`).toMatchObject({ ok: true, exitCode: 0, timedOut: false, truncated: false });
        expect(result.stdout.length).toBeGreaterThan(10);
        if (tool.name === "mimic_hosts" || tool.name === "mimic_build_prompt") expect(result.stdout).toContain("example.test");
        if (tool.name === "mimic_learn") expect(result.stdout).toContain("/api/items");
      }
    } finally { await rm(workspace, { recursive: true, force: true }); }
  }, 120_000);
});
