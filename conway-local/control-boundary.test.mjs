import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import * as boundary from './desktop/boundary.mjs';
import { prepareSupervision } from './supervision.mjs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

// Removing the allowlist would leak provider keys and runtime injection flags.
test('agent environment exposes workspace tools without controller secrets or injection options', () => {
  const actual = boundary.agentEnvironment({ PATH: '/usr/bin', DISPLAY: ':99', LOG_LEVEL: 'debug',
    UPSTREAM_KEY: 'private', OPENAI_API_KEY: 'private', DB_PATH: '/control/control.db',
    OPERATOR_BRIDGE_TOKEN_FILE: '/control/bridge-token', NODE_OPTIONS: '--require=/workspace/inject.cjs',
    PYTHONPATH: '/workspace/override', AUTOMATON_BROWSER_CLI: '/opt/browser-tools/cli.js' }, { state: '/state', work: '/workspace' });
  assert.equal(actual.PATH, '/usr/bin');
  assert.equal(actual.DISPLAY, ':99');
  assert.equal(actual.AUTOMATON_BROWSER_CLI, '/opt/browser-tools/cli.js');
  assert.equal(actual.AUTOMATON_WORKSPACE, '/workspace');
  for (const key of ['UPSTREAM_KEY', 'OPENAI_API_KEY', 'DB_PATH', 'OPERATOR_BRIDGE_TOKEN_FILE', 'NODE_OPTIONS', 'PYTHONPATH']) assert.equal(actual[key], undefined);
});

// Losing the persisted decision on boot would restart an operator-stopped agent.
test('activation defaults off and preserves an explicit operator decision', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-activation-'));
  try {
    assert.equal(boundary.readActivation(root), false);
    boundary.writeActivation(root, true);
    assert.equal(boundary.readActivation(root), true);
    boundary.writeActivation(root, false);
    assert.equal(boundary.readActivation(root), false);
    fs.writeFileSync(path.join(root, 'agent-activation.json'), '{"enabled":"true"}');
    assert.throws(() => boundary.readActivation(root), /activation/);
    fs.unlinkSync(path.join(root, 'agent-activation.json'));
    fs.symlinkSync('/etc/passwd', path.join(root, 'agent-activation.json'));
    assert.throws(() => boundary.readActivation(root), /regular|symbolic|activation/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Running controller and agent as one UID would permit all these accesses.
test('real agent UID cannot alter control or signal controller; workspace and browser remain usable',
  { skip: process.getuid?.() !== 0, timeout: 30000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-os-'));
  fs.chmodSync(root, 0o755);
  const state = path.join(root, 'state'), work = path.join(root, 'work'), control = path.join(root, 'control');
  for (const dir of [state, work, control]) fs.mkdirSync(dir, { mode: 0o700 });
  fs.chownSync(control, 1000, 1000);
  fs.writeFileSync(path.join(control, 'control.db'), 'persisted budget');
  fs.chownSync(path.join(control, 'control.db'), 1000, 1000);
  fs.writeFileSync(path.join(state, 'operator-identity.json'), '{"privateKey":"test-only","address":"0x1234"}');
  const prepared = boundary.prepareDesktopBoundary({ state, work, control });
  assert.equal(prepared.enabled, false);
  assert.equal(fs.readFileSync(path.join(control, 'control.db'), 'utf8'), 'persisted budget');
  assert.equal(fs.existsSync(path.join(state, 'operator-identity.json')), false);
  fs.writeFileSync(path.join(control, 'providers/inference.key'), 'test-provider-secret');
  const sourcePassword = path.join(control, 'desktop-password');
  fs.writeFileSync(sourcePassword, 'test-view-password');
  const savedUmask = process.umask(0o077);
  const viewPassword = boundary.prepareVncAuth(sourcePassword, path.join(root, 'vnc-auth'));
  process.umask(savedUmask);
  const controller = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const closed = once(controller, 'exit');
  const socket = (await import('node:net')).createServer();
  await new Promise(resolve => socket.listen(path.join(control, 'supervisor.sock'), resolve));
  try {
    const code = `const fs=require('fs'); const failures=[];
      for(const file of ${JSON.stringify(['control.db', 'providers/inference.key', 'operator-identity.json', 'agent-activation.json'])}) {
        try { fs.readFileSync(${JSON.stringify(control)}+'/'+file); failures.push('read '+file); } catch(e) { if(e.code!=='EACCES') throw e; }
        try { fs.writeFileSync(${JSON.stringify(control)}+'/'+file,'changed'); failures.push('write '+file); } catch(e) { if(e.code!=='EACCES') throw e; }
      }
      try{process.kill(${controller.pid},'SIGTERM');failures.push('signal');}catch(e){if(e.code!=='EPERM')throw e;}
      try{fs.readFileSync('/proc/${controller.pid}/environ');failures.push('proc');}catch(e){if(e.code!=='EACCES')throw e;}
      fs.writeFileSync(${JSON.stringify(path.join(work, 'proof'))},'workspace usable');
      if(fs.readFileSync(${JSON.stringify(viewPassword)},'utf8')!=='test-view-password')throw Error('view auth unreadable');
      try{fs.writeFileSync(${JSON.stringify(viewPassword)},'changed');failures.push('view auth write');}catch(e){if(e.code!=='EACCES')throw e;}
      try{fs.chmodSync(${JSON.stringify(viewPassword)},0o600);failures.push('view auth chmod');}catch(e){if(e.code!=='EPERM')throw e;}
      const net=require('net');const s=net.connect(${JSON.stringify(path.join(control, 'supervisor.sock'))});
      s.on('connect',()=>{failures.push('socket');s.end();});s.on('error',e=>{if(e.code!=='EACCES')throw e;});
      s.on('close',()=>{if(failures.length)throw Error(failures.join(','));});`;
    const agent = spawnSync(process.execPath, ['conway-local/desktop/boundary.mjs', 'run', process.execPath, '-e', code],
      { env: { ...process.env, AUTOMATON_DIR: state, AUTOMATON_WORKSPACE: work }, encoding: 'utf8', timeout: 10000 });
    assert.equal(agent.status, 0, agent.stderr);
    assert.equal(fs.readFileSync(path.join(work, 'proof'), 'utf8'), 'workspace usable');
    const stoppablePid = path.join(work, 'stoppable.pid');
    const stoppable = spawn(process.execPath, ['conway-local/desktop/boundary.mjs', 'run', process.execPath, '-e',
      `require('fs').writeFileSync(${JSON.stringify(stoppablePid)},String(process.pid));setInterval(()=>{},1000)`],
      { env: { ...process.env, AUTOMATON_DIR: state, AUTOMATON_WORKSPACE: work }, stdio: 'ignore' });
    const stopped = once(stoppable, 'exit');
    for (let i = 0; i < 50; i++) {
      if (fs.existsSync(stoppablePid)) break;
      await delay(20);
    }
    assert.match(fs.readFileSync(`/proc/${stoppable.pid}/status`, 'utf8'), /^Uid:\s+1000\s+1000/m);
    assert.ok(fs.existsSync(stoppablePid));
    const agentPid = Number(fs.readFileSync(stoppablePid, 'utf8'));
    assert.equal(stoppable.kill('SIGTERM'), true);
    await stopped;
    assert.throws(() => process.kill(agentPid, 0), { code: 'ESRCH' });

    const browser = spawnSync(process.execPath, ['conway-local/desktop/boundary.mjs', 'run', '/usr/bin/chromium',
      '--headless', '--no-sandbox', '--disable-gpu', '--dump-dom', 'data:text/html,<title>boundary-browser-ok</title>'],
      { env: { ...process.env, AUTOMATON_DIR: state, AUTOMATON_WORKSPACE: work }, encoding: 'utf8', timeout: 15000 });
    assert.equal(browser.status, 0, browser.stderr);
    assert.match(browser.stdout, /boundary-browser-ok/);
    assert.equal(fs.statSync(control).uid, 0);
    assert.equal(fs.statSync(control).mode & 0o777, 0o700);
    await new Promise(resolve => socket.close(resolve));
    // Exercise the generated Supervisor profile, not only filesystem modes.
    const app = path.join(root, 'app');
    fs.mkdirSync(path.join(app, 'conway-local/desktop'), { recursive: true, mode: 0o755 });
    fs.mkdirSync(path.join(app, 'dist'), { mode: 0o755 });
    fs.writeFileSync(path.join(app, 'conway-local/desktop/boundary.mjs'), fs.readFileSync('conway-local/desktop/boundary.mjs'), { mode: 0o644 });
    fs.writeFileSync(path.join(app, 'conway-local/server.mjs'), 'setInterval(()=>{},1000)');
    fs.writeFileSync(path.join(app, 'dist/index.js'), 'setInterval(()=>{},1000)');
    fs.writeFileSync(path.join(state, 'wallet.json'), '{}');
    fs.writeFileSync(path.join(state, 'automaton.json'), JSON.stringify({ standalone: true, conwayApiUrl: 'http://127.0.0.1:8787', conwayApiKey: 'fixture-key', walletAddress: '0x1111111111111111111111111111111111111111' }));
    fs.unlinkSync(path.join(control, 'control.db'));
    const db = new DatabaseSync(path.join(control, 'control.db'));
    db.exec('CREATE TABLE api_keys(hash TEXT,address TEXT)');
    db.prepare('INSERT INTO api_keys VALUES(?,?)').run(createHash('sha256').update('fixture-key').digest('hex'), '0x1111111111111111111111111111111111111111'); db.close();
    const config = prepareSupervision({ app, state, work, control, isolated: true });
    const supervisorBin = process.env.SUPERVISORD_BIN || '/opt/supervisor/bin/supervisord';
    const supervisor = spawn(supervisorBin, ['-n', '-c', config], { stdio: 'ignore' });
    const supervisorExit = once(supervisor, 'exit');
    const ctl = path.join(path.dirname(supervisorBin), 'supervisorctl');
    try {
      let status;
      for (let i = 0; i < 50; i++) {
        status = spawnSync(ctl, ['-c', config, 'status'], { encoding: 'utf8', timeout: 2000 });
        if (status.stdout.includes('gateway') && status.stdout.includes('RUNNING')) break;
        await delay(100);
      }
      assert.match(status.stdout, /gateway\s+RUNNING/);
      assert.match(status.stdout, /agent\s+STOPPED/);
      const denied = spawnSync(process.execPath, ['conway-local/desktop/boundary.mjs', 'run', ctl, '-c', config, 'status'], { encoding: 'utf8', timeout: 3000 });
      assert.notEqual(denied.status, 0);
      assert.ok(fs.existsSync(config));
    } finally { supervisor.kill('SIGTERM'); await supervisorExit; }

  } finally { socket.close(); controller.kill('SIGTERM'); await closed; fs.rmSync(root, { recursive: true, force: true }); }
});

// Replacing root identity with agent-edited config would permit creator impersonation.
test('operator binding refuses identity and database redirection after initialization', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-binding-'));
  const config = { walletAddress: '0x1111111111111111111111111111111111111111', creatorAddress: '0x2222222222222222222222222222222222222222' };
  try {
    boundary.bindOperatorIdentity(root, config, '/state/state.db');
    assert.throws(() => boundary.bindOperatorIdentity(root, { ...config, creatorAddress: '0x3333333333333333333333333333333333333333' }, '/state/state.db'), /binding/);
    assert.throws(() => boundary.bindOperatorIdentity(root, config, '/control/control.db'), /binding/);
    assert.deepEqual(boundary.readPrivateJson(path.join(root, 'operator-binding.json')), {
      agent: '0x1111111111111111111111111111111111111111', creator: '0x2222222222222222222222222222222222222222', dbPath: '/state/state.db' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
