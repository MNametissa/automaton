#!/usr/bin/env node
// Local deployment bootstrap. No model calls, remote resources, or wallet funding.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { prepareSupervision } from '../supervision.mjs';

process.umask(0o077);
const app = '/app', state = '/state', work = '/workspace', control = '/control';
for (const dir of [state, work, control]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const configPath = path.join(state, 'automaton.json');
const env = { ...process.env, AUTOMATON_DIR: state, AUTOMATON_WORKSPACE: work,
  DB_PATH: path.join(control, 'control.db'), HOST: '127.0.0.1', PORT: '8787' };

if (!fs.existsSync(configPath)) {
  const identityPath = path.join(state, 'operator-identity.json');
  if (!fs.existsSync(identityPath)) {
    const privateKey = generatePrivateKey();
    fs.writeFileSync(identityPath, JSON.stringify({ privateKey, address: privateKeyToAccount(privateKey).address }), { mode: 0o600, flag: 'wx' });
  }
  const creator = JSON.parse(fs.readFileSync(identityPath, 'utf8')).address;
  const gateway = spawn(process.execPath, ['conway-local/server.mjs', 'serve'], { cwd: app, env, stdio: ['ignore', 'ignore', 'inherit'] });
  const closed = once(gateway, 'exit');
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { await fetch('http://127.0.0.1:8787/health', { signal: AbortSignal.timeout(500) }); ready = true; break; } catch { await delay(100); }
    }
    if (!ready) throw new Error('Local gateway did not start');
    const initialized = spawnSync(process.execPath, ['conway-local/setup.mjs', '--state-dir', state,
      '--api-url', 'http://127.0.0.1:8787', '--creator', creator], { cwd: app, env, stdio: 'inherit', timeout: 30000 });
    if (initialized.status !== 0) throw new Error('Agent initialization failed');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.name = 'I AM Alive';
    config.genesisPrompt = fs.readFileSync(path.join(app, 'profiles/i-am-alive/genesis.txt'), 'utf8') +
      '\n\nOperator chat: messages delivered by the local operator bridge include a receipt ID. Answer the creator using send_message with reply_to equal to that exact receipt ID. Never claim a queued message is an executed task. Browser screenshots are artifacts; use DOM snapshots for text-only inference.';
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    fs.copyFileSync(path.join(app, 'profiles/i-am-alive/heartbeat.yml'), path.join(state, 'heartbeat.yml'));
  } finally { gateway.kill('SIGTERM'); await closed; }
}

const { createDatabase } = await import('../../dist/state/database.js');
const db = createDatabase(path.join(state, 'state.db'));
const { loadBundledSkills } = await import('../../dist/skills/bundled.js');
loadBundledSkills(db);
db.close();
const config = prepareSupervision({ app, state, work, control });
let text = fs.readFileSync(config, 'utf8');
// An explicit activation step is needed after a real local model is configured.
text = text.replace(/(\[program:agent\][\s\S]*?autostart=)true/, '$1false');
const program = (name, command, priority, directory = app) => `
[program:${name}]
command=${command}
directory=${directory}
environment=DISPLAY=":99",HOME="/state",AUTOMATON_DIR="/state",AUTOMATON_WORKSPACE="/workspace",DB_PATH="/control/control.db"
priority=${priority}
autostart=true
autorestart=unexpected
exitcodes=0,78
startsecs=2
startretries=5
stopasgroup=true
killasgroup=true
stdout_logfile=/control/${name}.log
stdout_logfile_maxbytes=5MB
stdout_logfile_backups=2
redirect_stderr=true
`;
const password = process.env.DESKTOP_PASSWORD_FILE || '/run/secrets/desktop_password';
if (!fs.statSync(password).isFile()) throw new Error('Desktop password file missing');
text += program('x-display', '/usr/bin/Xvfb :99 -screen 0 1440x900x24 -nolisten tcp -ac', 1);
text += program('window-manager', '/usr/bin/fluxbox', 2);
text += program('vnc', `/usr/bin/x11vnc -display :99 -localhost -forever -shared -rfbport 5900 -passwdfile ${password}`, 3);
text += program('browser-view', '/usr/bin/websockify --web=/usr/share/novnc 6080 127.0.0.1:5900', 4);
text += program('operator-bridge', `${process.execPath} /app/conway-local/operator-bridge.mjs`, 30);
fs.writeFileSync(config, text, { mode: 0o600 });
console.log('Local services initialized; autonomous inference remains stopped. Wallets have not been funded.');
const supervisor = spawn('/opt/supervisor/bin/supervisord', ['-n', '-c', config], { env: { ...env, DISPLAY: ':99', HOME: state }, stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => supervisor.kill(signal));
supervisor.on('exit', code => { process.exitCode = code ?? 1; });
