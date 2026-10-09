#!/usr/bin/env node
// Generate a native Supervisor configuration. This command never launches services.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readActivation, readPrivateJson } from './desktop/boundary.mjs';

function cleanPath(value) {
  if (typeof value !== 'string' || !value || /[\r\n\0%;]/.test(value)) throw new Error('Use an explicit path without control characters, percent or semicolon');
  return path.resolve(value);
}
const quoted = value => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

export function prepareSupervision({ app = fileURLToPath(new URL('..', import.meta.url)), state, work, control, monitor = false, isolated = false }) {
  app = cleanPath(app); state = cleanPath(state); work = cleanPath(work); control = cleanPath(control);
  if (isolated) {
    if (process.getuid?.() !== 0) throw new Error('Isolated supervision requires the root controller');
    const boundary = fs.lstatSync(control);
    if (!boundary.isDirectory() || boundary.uid !== 0 || (boundary.mode & 0o077) !== 0) throw new Error('Isolated supervision requires private root-owned control storage');
    const application = fs.lstatSync(app);
    if (!application.isDirectory() || application.uid !== 0 || (application.mode & 0o022) !== 0) throw new Error('Isolated supervision requires immutable root-owned application storage');
  }
  const config = readPrivateJson(path.join(state, 'automaton.json'));
  if (config.standalone !== true) throw new Error('This supervisor profile requires an initialized standalone configuration');
  const origin = new URL(config.conwayApiUrl);
  if (origin.origin !== 'http://127.0.0.1:8787' || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) {
    throw new Error('Initialize the dedicated gateway at http://127.0.0.1:8787 before preparing supervision');
  }
  if (!fs.statSync(path.join(state, 'wallet.json')).isFile()) throw new Error('Initialize the dedicated wallet first');
  for (const dir of [app, state, work]) if (!fs.statSync(dir).isDirectory()) throw new Error('Application, state and workspace must already exist');
  // Reusing the initialized gateway DB is essential: a fresh one does not know
  // the API key provisioned into automaton.json, even if its URL is identical.
  if (typeof config.conwayApiKey !== 'string' || !config.conwayApiKey || typeof config.walletAddress !== 'string') throw new Error('Agent identity is incomplete');
  const gateway = new DatabaseSync(path.join(control, 'control.db'), { readOnly: true });
  try {
    const hash = createHash('sha256').update(config.conwayApiKey).digest('hex');
    const account = gateway.prepare('SELECT address FROM api_keys WHERE hash = ?').get(hash);
    if (account?.address !== config.walletAddress.toLowerCase()) throw new Error('Agent credentials do not match this gateway database');
  } finally { gateway.close(); }
  fs.mkdirSync(control, { recursive: true, mode: 0o700 });
  const pidPath = path.join(control, 'supervisord.pid');
  if (fs.existsSync(pidPath)) {
    const pid = Number(fs.readFileSync(pidPath, 'utf8').trim());
    if (Number.isSafeInteger(pid) && pid > 1) {
      let active = false;
      try { process.kill(pid, 0); active = true; } catch (error) { if (error.code !== 'ESRCH') active = true; }
      if (active) throw new Error('Supervisor is already active; stop it before replacing its configuration');
    }
  }
  const environment = [
    ['AUTOMATON_DIR', state], ['AUTOMATON_WORKSPACE', work],
    ['DB_PATH', path.join(control, 'control.db')], ['HOST', '127.0.0.1'], ['PORT', '8787'],
    ['CONWAY_API_URL', origin.origin],
  ].map(([key, value]) => `${key}=${quoted(value)}`).join(',');
  const program = (name, script, args, priority, enabled = true) => `
[program:${name}]
command=${isolated && name === 'agent' ? `${quoted(process.execPath)} ${quoted(path.join(app, 'conway-local/desktop/boundary.mjs'))} run ` : ''}${quoted(process.execPath)} ${quoted(path.join(app, script))} ${args}
directory=${app}
environment=${environment}
priority=${priority}
autostart=${enabled}
autorestart=unexpected
exitcodes=0,78
startsecs=2
startretries=5
stopsignal=TERM
stopwaitsecs=30
stopasgroup=true
killasgroup=true
stdout_logfile=${path.join(control, `${name}.log`)}
stdout_logfile_maxbytes=5MB
stdout_logfile_backups=2
redirect_stderr=true
`;
  const text = `[unix_http_server]
file=${path.join(control, 'supervisor.sock')}
chmod=0600

[supervisord]
nodaemon=true
${isolated ? 'user=root\n' : ''}umask=0077
logfile=${path.join(control, 'supervisord.log')}
logfile_maxbytes=5MB
logfile_backups=2
pidfile=${pidPath}
childlogdir=${control}

[rpcinterface:supervisor]
supervisor.rpcinterface_factory=supervisor.rpcinterface:make_main_rpcinterface

[supervisorctl]
serverurl=unix://${path.join(control, 'supervisor.sock')}
${program('gateway', 'conway-local/server.mjs', 'serve', 10)}
${program('agent', 'dist/index.js', '--run', 20, isolated ? readActivation(control) : true)}
${program('runpod-observer', 'conway-local/runpod-status.mjs', '--watch', 30, monitor)}
`;
  const destination = path.join(control, 'supervisord.conf');
  fs.writeFileSync(destination, text, { mode: 0o600 });
  fs.chmodSync(destination, 0o600);
  return destination;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: {
      'state-dir': { type: 'string' }, 'work-dir': { type: 'string' }, 'control-dir': { type: 'string' },
      monitor: { type: 'boolean', default: false },
    } });
    const configPath = prepareSupervision({ state: values['state-dir'], work: values['work-dir'], control: values['control-dir'], monitor: values.monitor });
    console.log(JSON.stringify({ prepared: configPath, started: false,
      start: ['supervisord', '-n', '-c', configPath], status: ['supervisorctl', '-c', configPath, 'status'],
      note: 'Keep state, workspace and control directories on persistent storage. This restarts processes inside a running host/pod, not a stopped pod.' }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
