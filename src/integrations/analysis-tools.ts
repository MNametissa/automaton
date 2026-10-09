/** Offline REA/Mimic adapters. Install with conway-local/install-analysis-tools.mjs. */
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isSensitiveFile } from "../agent/policy-rules/path-protection.js";
import type { AutomatonTool } from "../types.js";

export interface AnalysisToolOptions {
  workspace?: string;
  runtime?: string;
  state?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}
export interface AnalysisCommandResult {
  command: string;
  args: string[];
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  error?: string;
}
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".json"]);
const BLOCKED_COMPONENT = /^(?:\.env(?:\..*)?|\.git|\.ssh|\.aws|\.azure|\.config|\.automaton|\.local-work|node_modules|wallet(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|id_rsa|id_ed25519)$/i;
const BLOCKED_EXTENSION = /\.(?:pem|key|p12|pfx|db|sqlite|sqlite3)$/i;
function settings(options: AnalysisToolOptions = {}) {
  const workspace = resolve(options.workspace ?? process.env.AUTOMATON_ANALYSIS_WORKSPACE ?? process.env.AUTOMATON_WORKSPACE ?? process.cwd());
  const runtime = resolve(options.runtime ?? process.env.AUTOMATON_ANALYSIS_RUNTIME ?? join(process.cwd(), ".local-work/tool-runtime"));
  return {
    workspace,
    runtime,
    state: resolve(options.state ?? process.env.AUTOMATON_ANALYSIS_STATE ?? (process.env.AUTOMATON_DIR ? join(process.env.AUTOMATON_DIR, "analysis") : runtime)),
    timeoutMs: Math.max(100, Math.min(options.timeoutMs ?? 60_000, 120_000)),
    maxOutputBytes: Math.max(128, Math.min(options.maxOutputBytes ?? 256_000, 1_000_000)),
  };
}
function sensitive(path: string): boolean {
  return isSensitiveFile(path) || path.split(/[\\/]/).some((part) => BLOCKED_COMPONENT.test(part) || BLOCKED_EXTENSION.test(part));
}
function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
async function checkedInput(workspace: string, input: unknown): Promise<string> {
  if (typeof input !== "string" || !input || isAbsolute(input) || input.includes("\0") || input.includes("\\")) {
    throw new Error("path must be a nonempty relative workspace path");
  }
  if (input.split("/").includes("..") || sensitive(input)) throw new Error("Sensitive or parent-traversing input path is not allowed");
  const root = await realpath(workspace);
  const candidate = resolve(root, input);
  const canonical = await realpath(candidate);
  if (!isWithin(root, canonical) || sensitive(relative(root, canonical))) throw new Error("Input resolves outside the permitted workspace or into sensitive files");
  // Reject symlinks in every path component, including links that stay in workspace.
  let current = root;
  for (const part of relative(root, candidate).split(sep).filter(Boolean)) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error("Symlink input paths are not allowed");
  }
  return canonical;
}
async function stageInput(source: string, destination: string, javascript: boolean): Promise<void> {
  let files = 0;
  let bytes = 0;
  let visited = 0;
  async function copy(path: string, dest: string, depth: number): Promise<void> {
    if (++visited > 5000) throw new Error("Analysis input exceeds 5000 filesystem entries");
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error("Symlinks inside analysis inputs are not allowed");
    if (depth > 24) throw new Error("Analysis input directory nesting exceeds 24 levels");
    if (info.isDirectory()) {
      if (!javascript) throw new Error("HAR input must be a regular .har file");
      await mkdir(dest, { recursive: true, mode: 0o700 });
      const entries = await readdir(path);
      if (entries.length > 5000) throw new Error("Analysis input directory is too large");
      for (const name of entries) {
        if (!sensitive(name)) await copy(join(path, name), join(dest, name), depth + 1);
      }
      return;
    }
    if (!info.isFile()) throw new Error("Analysis inputs must contain regular files only");
    if (javascript && !SOURCE_EXTENSIONS.has(extname(path).toLowerCase())) return;
    if (!javascript && extname(path).toLowerCase() !== ".har") throw new Error("HAR input must have the .har extension");
    files++;
    bytes += info.size;
    if (files > 1000 || bytes > MAX_INPUT_BYTES) throw new Error("Analysis input exceeds 1000 files or 16 MiB");
    await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
    await copyFile(path, dest, constants.COPYFILE_EXCL);
  }
  await copy(source, destination, 0);
  if (files === 0) throw new Error("No supported source files found in analysis input");
}

/** Shell-free child execution, capped output, scrubbed environment and process-group timeout. */
export async function runAnalysisCommand(command: string, args: string[], options: AnalysisToolOptions = {}): Promise<AnalysisCommandResult> {
  const config = settings(options);
  const home = join(config.state, "home");
  await mkdir(home, { recursive: true, mode: 0o700 });
  return new Promise((resolveResult) => {
    const result: AnalysisCommandResult = { command, args, exitCode: null, signal: null, stdout: "", stderr: "", timedOut: false, truncated: false };
    const child = spawn(command, args, {
      cwd: home,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        HOME: home,
        PATH: [dirname(process.execPath), join(config.runtime, "mimic/bin"), "/usr/bin", "/bin"].join(delimiter),
        LANG: "C.UTF-8",
        PYTHONNOUSERSITE: "1",
        PYTHONDONTWRITEBYTECODE: "1",
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_CACHE_HOME: join(home, ".cache"),
        NO_COLOR: "1",
      },
    });
    let size = 0;
    const chunks: { stdout: Buffer[]; stderr: Buffer[] } = { stdout: [], stderr: [] };
    const kill = () => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* Already exited. */ }
    };
    const timer = setTimeout(() => { result.timedOut = true; kill(); }, config.timeoutMs);
    for (const stream of ["stdout", "stderr"] as const) {
      child[stream].on("data", (data: Buffer) => {
        const remaining = config.maxOutputBytes - size;
        if (remaining > 0) chunks[stream].push(data.subarray(0, remaining));
        size += data.length;
        if (size > config.maxOutputBytes) { result.truncated = true; kill(); }
      });
    }
    child.on("error", (error) => { result.error = error.message; });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      result.exitCode = code;
      result.signal = signal;
      result.stdout = Buffer.concat(chunks.stdout).toString("utf8");
      result.stderr = Buffer.concat(chunks.stderr).toString("utf8");
      resolveResult(result);
    });
  });
}

/** Probe executables, not just manifests or installed paths. */
export async function getAnalysisToolsReadiness(options: AnalysisToolOptions = {}) {
  const config = settings(options);
  const probes = [
    ["rea", process.execPath, [join(config.runtime, "rea/node_modules/rea-agents/scripts/rea.mjs"), "--version"]],
    ["mimic", join(config.runtime, "mimic/bin/python"), ["-I", "-m", "mimic.cli", "--help"]],
  ] as const;
  const results = await Promise.all(probes.map(async ([name, command, args]) => {
    try {
      const result = await runAnalysisCommand(command, [...args], { ...config, timeoutMs: 15_000 });
      return [name, { available: result.exitCode === 0 && !result.timedOut && !result.truncated && !result.error, ...result }] as const;
    } catch (error) {
      return [name, { available: false, error: error instanceof Error ? error.message : String(error) }] as const;
    }
  }));
  return Object.fromEntries(results) as Record<"rea" | "mimic", { available: boolean; error?: string; stdout?: string; stderr?: string; exitCode?: number | null }>;
}

export function createAnalysisTools(options: AnalysisToolOptions = {}): AutomatonTool[] {
  const definitions = [
    ["rea_analyze_javascript", "Statically analyze a workspace JavaScript/TypeScript file or directory using REA; does not execute target code. Stages at most 1000 source/JSON files (16 MiB), excluding credentials, dependency directories, and source maps.", "rea", "analyze-javascript-application", false],
    ["rea_inspect_har", "Inspect a workspace HAR capture offline with REA. Never fetches captured URLs.", "rea", "inspect-web-network-capture", false],
    ["mimic_hosts", "List hosts from an authorized workspace HAR capture using Mimic, entirely offline.", "mimic", "hosts", false],
    ["mimic_learn", "List captured endpoints for a host in an authorized workspace HAR using Mimic, entirely offline.", "mimic", "learn", true],
    ["mimic_build_prompt", "Build a Python client generation prompt from an authorized HAR using Mimic gen --prompt-only. Returns text only; never invokes Claude/OpenCode or paid inference. Captured bodies may be included in the returned prompt.", "mimic", "gen", true],
  ] as const;
  return definitions.map(([name, description, backend, subcommand, needsHost]) => ({
    name, description, category: "vm", riskLevel: "safe",
    parameters: {
      type: "object", additionalProperties: false,
      properties: {
        path: { type: "string", description: "Relative path beneath AUTOMATON_ANALYSIS_WORKSPACE or AUTOMATON_WORKSPACE (defaults to working directory). HAR commands require a .har file." },
        ...(needsHost ? { host: { type: "string", description: "Exact captured hostname, without scheme, port, or path." } } : {}),
      },
      required: needsHost ? ["path", "host"] : ["path"],
    },
    async execute(args) {
      const config = settings(options);
      let temporary: string | undefined;
      try {
        const allowed = new Set(needsHost ? ["path", "host"] : ["path"]);
        if (Object.keys(args).some((key) => !allowed.has(key))) throw new Error("Unexpected tool argument");
        if (needsHost && (typeof args.host !== "string" || !/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$/.test(args.host))) throw new Error("host must be a plain hostname");
        const input = await checkedInput(config.workspace, args.path);
        const staging = join(config.state, "inputs");
        await mkdir(staging, { recursive: true, mode: 0o700 });
        temporary = await mkdtemp(join(staging, "analysis-"));
        const staged = join(temporary, basename(input));
        await stageInput(input, staged, subcommand === "analyze-javascript-application");
        const command = backend === "rea" ? process.execPath : join(config.runtime, "mimic/bin/python");
        const argv = backend === "rea"
          ? [join(config.runtime, "rea/node_modules/rea-agents/scripts/rea.mjs"), subcommand, staged, ...(subcommand === "inspect-web-network-capture" ? ["har"] : []), "--json"]
          : ["-I", "-m", "mimic.cli", subcommand, ...(needsHost ? [args.host as string] : []), "--har", staged, ...(subcommand === "gen" ? ["--prompt-only"] : [])];
        const result = await runAnalysisCommand(command, argv, config);
        let backendError = false;
        if (backend === "rea" && result.stdout.trim().startsWith("{")) {
          try { const parsed = JSON.parse(result.stdout); backendError = Boolean(parsed.error || parsed.ok === false); } catch { /* Truncation is reported separately. */ }
        }
        return JSON.stringify({ ok: result.exitCode === 0 && !result.error && !result.timedOut && !result.truncated && !backendError, tool: name, input: args.path, ...result });
      } catch (error) {
        return JSON.stringify({ ok: false, tool: name, error: error instanceof Error ? error.message : String(error) });
      } finally {
        if (temporary) await rm(temporary, { recursive: true, force: true });
      }
    },
  }));
}
