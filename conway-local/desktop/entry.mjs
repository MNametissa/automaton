#!/usr/bin/env node
// Local deployment bootstrap. No model calls, remote resources, or wallet funding.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { prepareSupervision } from '../supervision.mjs';
import { prepareDesktopBoundary, agentEnvironment, bindOperatorIdentity, readPrivateJson, prepareVncAuth } from './boundary.mjs';

process.umask(0o077);
const app = '/app', state = '/state', work = '/workspace', control = '/control';
const boundary = prepareDesktopBoundary({ state, work, control });
const secretDir = '/run/operator-secrets';
if (!fs.lstatSync(secretDir).isDirectory() || fs.lstatSync(secretDir).isSymbolicLink()) throw new Error('Private operator secret directory missing');
fs.chownSync(secretDir, 0, 0); fs.chmodSync(secretDir, 0o700);
const configPath = path.join(state, 'automaton.json');
const env = { ...agentEnvironment(process.env, { state, work }),
  HOME: control, DB_PATH: path.join(control, 'control.db'), HOST: '127.0.0.1', PORT: '8787',
  OPERATOR_BRIDGE_HOST: process.env.OPERATOR_BRIDGE_HOST || '127.0.0.1',
  OPERATOR_BRIDGE_PORT: process.env.OPERATOR_BRIDGE_PORT || '8788',
  OPERATOR_BRIDGE_TOKEN_FILE: path.join(secretDir, 'bridge_token'),
  OPERATOR_BINDING_FILE: path.join(control, 'operator-binding.json'),
  ...(fs.existsSync('/control/providers/inference.json')
    ? { INFERENCE_CONFIG_FILE: '/control/providers/inference.json' }
    : process.env.UPSTREAM_URL ? { UPSTREAM_URL: process.env.UPSTREAM_URL } : {}) };
const identityPath = boundary.identityPath;

if (!fs.existsSync(configPath)) {
  if (!fs.existsSync(identityPath)) {
    const privateKey = generatePrivateKey();
    fs.writeFileSync(identityPath, JSON.stringify({ privateKey, address: privateKeyToAccount(privateKey).address }), { mode: 0o600, flag: 'wx' });
  }
  const creator = readPrivateJson(identityPath).address;
  const gateway = spawn(process.execPath, ['conway-local/server.mjs', 'serve'], { cwd: app, env, stdio: ['ignore', 'ignore', 'inherit'] });
  const closed = once(gateway, 'exit');
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { await fetch('http://127.0.0.1:8787/health', { signal: AbortSignal.timeout(500) }); ready = true; break; } catch { await delay(100); }
    }
    if (!ready) throw new Error('Local gateway did not start');
    const initialized = spawnSync(process.execPath, ['/app/conway-local/desktop/boundary.mjs', 'run', process.execPath, '/app/conway-local/setup.mjs', '--state-dir', state,
      '--api-url', 'http://127.0.0.1:8787', '--creator', creator], { cwd: app, env: agentEnvironment(env, { state, work }), stdio: 'inherit', timeout: 30000 });
    if (initialized.status !== 0) throw new Error('Agent initialization failed');
    const profile = spawnSync(process.execPath, ['/app/conway-local/desktop/boundary.mjs', 'run', process.execPath, '--input-type=module', '-e', `
      import fs from 'node:fs';
      import { readPrivateJson } from '/app/conway-local/desktop/boundary.mjs';
      const config = readPrivateJson('/state/automaton.json');
      config.name = 'I AM Alive';
      config.genesisPrompt = fs.readFileSync('/app/profiles/i-am-alive/genesis.txt', 'utf8') +
        '\\n\\nOperator chat: messages delivered by the local operator bridge include a receipt ID. Answer the creator using send_message with reply_to equal to that exact receipt ID. Never claim a queued message is an executed task. Browser screenshots are artifacts; use DOM snapshots for text-only inference.';
      fs.writeFileSync('/state/automaton.json', JSON.stringify(config, null, 2), { mode: 0o600 });
      fs.copyFileSync('/app/profiles/i-am-alive/heartbeat.yml', '/state/heartbeat.yml');
    `], { cwd: app, env: agentEnvironment(env, { state, work }), stdio: 'inherit', timeout: 30000 });
    if (profile.status !== 0) throw new Error('Agent profile initialization failed');
  } finally { gateway.kill('SIGTERM'); await closed; }
}

const initializedState = spawnSync(process.execPath, ['/app/conway-local/desktop/boundary.mjs', 'run', process.execPath, '--input-type=module', '-e',
  `import { createDatabase } from '/app/dist/state/database.js'; import { loadBundledSkills } from '/app/dist/skills/bundled.js'; import { recoverDesktopBrowserProfiles } from '/app/conway-local/desktop/browser-recovery.mjs'; const db=createDatabase('/state/state.db'); loadBundledSkills(db); db.close(); const recovered=recoverDesktopBrowserProfiles('/state/browser'); console.log(JSON.stringify({browserStartupLocksRemoved:recovered}));`],
  { cwd: app, env: agentEnvironment(env, { state, work }), stdio: 'inherit', timeout: 30000 });
if (initializedState.status !== 0) throw new Error('Agent state initialization failed');
const config = prepareSupervision({ app, state, work, control, isolated: true });
const agentConfig = readPrivateJson(configPath);
if (fs.existsSync(identityPath)) {
  const identity = readPrivateJson(identityPath);
  if (privateKeyToAccount(identity.privateKey).address.toLowerCase() !== agentConfig.creatorAddress.toLowerCase() || identity.address.toLowerCase() !== agentConfig.creatorAddress.toLowerCase()) throw new Error('Private operator identity does not match agent creator');
}
bindOperatorIdentity(control, agentConfig, path.join(state, 'state.db'));
let text = fs.readFileSync(config, 'utf8');
const program = (name, command, priority, directory = app, unprivileged = true) => `
[program:${name}]
command=${unprivileged ? `${process.execPath} /app/conway-local/desktop/boundary.mjs run ` : ''}${command}
directory=${directory}
environment=DISPLAY=":99",HOME="${unprivileged ? state : control}",AUTOMATON_DIR="/state",AUTOMATON_WORKSPACE="/workspace",DB_PATH="/control/control.db"
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
const password = prepareVncAuth(path.join(secretDir, 'desktop_password'));
text += program('x-display', '/usr/bin/Xvfb :99 -screen 0 1440x900x24 -nolisten tcp -ac', 1);
text += program('window-manager', '/usr/bin/fluxbox', 2);
text += program('vnc', `/usr/bin/x11vnc -norc -nocmds -display :99 -localhost -forever -shared -rfbport 5900 -passwdfile ${password}`, 3);
text += program('browser-view', '/usr/bin/websockify --web=/usr/share/novnc 6080 127.0.0.1:5900', 4);
text += program('operator-bridge', `${process.execPath} /app/conway-local/operator-bridge.mjs`, 30, app, false);
fs.writeFileSync(config, text, { mode: 0o600 });
console.log(`Local services initialized; autonomous agent activation is ${boundary.enabled ? 'enabled by the persisted operator decision' : 'off'}. Wallets have not been funded.`);
const supervisor = spawn('/opt/supervisor/bin/supervisord', ['-n', '-c', config], { env: { ...env, DISPLAY: ':99', HOME: control }, stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => supervisor.kill(signal));
supervisor.on('exit', code => { process.exitCode = code ?? 1; });
