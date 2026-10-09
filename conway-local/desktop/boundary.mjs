#!/usr/bin/env node
// Privilege boundary for the desktop profile. No model calls or allocations.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

export function prepareVncAuth(source, directory = '/run/vnc-auth') {
  if (process.getuid?.() !== 0) throw new Error('VNC authentication preparation requires the controller');
  fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
  const dir = fs.lstatSync(directory);
  if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error('VNC authentication directory must be a real directory');
  fs.chownSync(directory, 0, 0); fs.chmodSync(directory, 0o755);
  const input = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let password;
  try {
    const stat = fs.fstatSync(input);
    if (!stat.isFile() || stat.size > 4096) throw new Error('Desktop password must be a regular file');
    password = fs.readFileSync(input);
  } finally { fs.closeSync(input); }
  const filename = path.join(directory, 'password');
  const temporary = path.join(directory, `.password-${process.pid}-${Date.now()}`);
  fs.writeFileSync(temporary, password, { flag: 'wx', mode: 0o440 });
  fs.chmodSync(temporary, 0o440); fs.chownSync(temporary, 0, 1000);
  fs.renameSync(temporary, filename);
  return filename;
}

export function agentEnvironment(source = process.env, { state = '/state', work = '/workspace' } = {}) {
  const allowed = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'DISPLAY', 'LOG_LEVEL',
    'AUTOMATON_ANALYSIS_RUNTIME', 'AUTOMATON_BROWSER_CLI', 'AUTOMATON_BROWSER_EXECUTABLE', 'AUTOMATON_BROWSER_HEADED'];
  const env = Object.fromEntries(allowed.filter(key => typeof source[key] === 'string').map(key => [key, source[key]]));
  return { ...env, HOME: state, AUTOMATON_DIR: state, AUTOMATON_WORKSPACE: work,
    AUTOMATON_ANALYSIS_STATE: path.join(state, 'analysis'), AUTOMATON_BROWSER_STATE: path.join(state, 'browser') };
}

export function readPrivateJson(filename) {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024) throw new Error('Expected a private regular file');
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
}

export function readActivation(control) {
  const filename = path.join(control, 'agent-activation.json');
  try {
    const value = readPrivateJson(filename);
    if (typeof value.enabled !== 'boolean' || Object.keys(value).length !== 1) throw new Error('Invalid activation decision');
    return value.enabled;
  } catch (error) { if (error.code === 'ENOENT') return false; throw new Error('Invalid activation file: must be regular JSON with a boolean enabled flag', { cause: error }); }
}

export function writeActivation(control, enabled) {
  if (typeof enabled !== 'boolean') throw new Error('Invalid activation decision');
  const filename = path.join(control, 'agent-activation.json');
  if (fs.existsSync(filename) || fs.lstatSync(control).isSymbolicLink()) readActivation(control);
  const temporary = path.join(control, `.activation-${process.pid}-${Date.now()}`);
  fs.writeFileSync(temporary, JSON.stringify({ enabled }) + '\n', { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, filename);
}

// Fail closed on aliases before touching ownership. Existing data is preserved.
function secureControlTree(directory) {
  const paths = [];
  function scan(filename) {
    const stat = fs.lstatSync(filename);
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1)) throw new Error('Control storage must not contain symbolic or hard links');
    if (!stat.isDirectory() && !stat.isFile() && !stat.isSocket()) throw new Error('Unexpected control storage file type');
    paths.push([filename, stat.isDirectory()]);
    if (stat.isDirectory()) for (const child of fs.readdirSync(filename)) scan(path.join(filename, child));
  }
  scan(directory);
  for (const [filename, isDirectory] of paths) { fs.chownSync(filename, 0, 0); fs.chmodSync(filename, isDirectory ? 0o700 : 0o600); }
}

export function prepareDesktopBoundary({ state = '/state', work = '/workspace', control = '/control' } = {}) {
  if (process.getuid?.() !== 0) throw new Error('Desktop controller bootstrap must run as root');
  for (const dir of [state, work, control]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(dir).isDirectory()) throw new Error('Runtime directories must be real directories');
  }
  secureControlTree(control);
  fs.mkdirSync(path.join(control, 'providers'), { mode: 0o700, recursive: true });
  for (const dir of [state, work]) { fs.chownSync(dir, 0, 0); fs.chmodSync(dir, 0o700); fs.chownSync(dir, 1000, 1000); }
  const legacy = path.join(state, 'operator-identity.json');
  const privateIdentity = path.join(control, 'operator-identity.json');
  if (fs.existsSync(legacy)) {
    const identity = readPrivateJson(legacy);
    if (fs.existsSync(privateIdentity)) {
      if (JSON.stringify(readPrivateJson(privateIdentity)) !== JSON.stringify(identity)) throw new Error('Conflicting operator identities; refusing migration');
    } else fs.writeFileSync(privateIdentity, JSON.stringify(identity), { mode: 0o600, flag: 'wx' });
    fs.unlinkSync(legacy);
  }
  const enabled = readActivation(control);
  if (!fs.existsSync(path.join(control, 'agent-activation.json'))) writeActivation(control, false);
  return { enabled, identityPath: privateIdentity };
}

export function bindOperatorIdentity(control, config, dbPath) {
  const filename = path.join(control, 'operator-binding.json');
  const binding = { agent: config.walletAddress.toLowerCase(), creator: config.creatorAddress.toLowerCase(), dbPath };
  for (const address of [binding.agent, binding.creator]) if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error('Invalid operator binding identity');
  if (fs.existsSync(filename)) {
    if (JSON.stringify(readPrivateJson(filename)) !== JSON.stringify(binding)) throw new Error('Agent identity differs from the private operator binding');
  } else fs.writeFileSync(filename, JSON.stringify(binding), { flag: 'wx', mode: 0o600 });
  return filename;
}

// Supervisor itself runs as root. Every user program passes through this wrapper
// so environment inherited from root cannot reach native exec or browser tools.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, command, ...args] = process.argv.slice(2);
    if (mode !== 'run' || !command || !path.isAbsolute(command)) throw new Error('Use run with an absolute executable');
    const env = agentEnvironment(process.env, { state: process.env.AUTOMATON_DIR || '/state', work: process.env.AUTOMATON_WORKSPACE || '/workspace' });
    if (process.getuid() === 0) { process.setgroups([]); process.setgid(1000); process.setuid(1000); }
    if (process.getuid() !== 1000 || process.getgid() !== 1000) throw new Error('Agent programs require UID/GID 1000');
    const child = spawn(command, args, { env, stdio: 'inherit' });
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
    child.on('error', error => { console.error(error.message); process.exitCode = 78; });
    child.on('exit', code => { process.exitCode = code ?? 1; });
  } catch (error) { console.error(error.message); process.exitCode = 78; }
}
