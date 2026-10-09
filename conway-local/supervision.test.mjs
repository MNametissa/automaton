import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareSupervision } from './supervision.mjs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const supervisor = process.env.SUPERVISORD_BIN || path.resolve('.local-work/supervisor/bin/supervisord');
const ctl = path.join(path.dirname(supervisor), 'supervisorctl');
test('native supervisor restarts a crashed agent, preserves state and honors stop', { skip: !fs.existsSync(supervisor), timeout: 30000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-supervision-'));
  const app = path.join(root, 'app'), state = path.join(root, 'state'), work = path.join(root, 'work'), control = path.join(root, 'control');
  for (const dir of [path.join(app, 'dist'), path.join(app, 'conway-local'), state, work, control]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(state, 'automaton.json'), JSON.stringify({ standalone: true, conwayApiUrl: 'http://127.0.0.1:8787', conwayApiKey: 'test-key', walletAddress: '0x1234' }));
  const gateway = new DatabaseSync(path.join(control, 'control.db'));
  gateway.exec('CREATE TABLE api_keys (hash TEXT, address TEXT)');
  gateway.prepare('INSERT INTO api_keys VALUES (?, ?)').run(createHash('sha256').update('test-key').digest('hex'), '0x1234'); gateway.close();
  fs.writeFileSync(path.join(state, 'wallet.json'), '{}');
  fs.writeFileSync(path.join(app, 'conway-local/server.mjs'), 'setInterval(() => {}, 1000);');
  fs.writeFileSync(path.join(app, 'dist/index.js'), `
    const fs = require('fs'), path = require('path');
    const file = path.join(process.env.AUTOMATON_DIR, 'starts');
    fs.writeFileSync(file, String(Number(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 0) + 1));
    fs.writeFileSync(path.join(process.env.AUTOMATON_DIR, 'roots.json'), JSON.stringify({ app: process.cwd(), work: process.env.AUTOMATON_WORKSPACE }));
    setInterval(() => {}, 1000);
  `);
  const config = prepareSupervision({ app, state, work, control });
  const child = spawn(supervisor, ['-n', '-c', config], { stdio: 'ignore' });
  const exit = once(child, 'exit');
  const command = (...args) => spawnSync(ctl, ['-c', config, ...args], { encoding: 'utf8', timeout: 10000 });
  async function until(check) {
    const end = Date.now() + 10000;
    while (Date.now() < end) { if (check()) return; await delay(100); }
    throw new Error('Supervisor test timed out');
  }
  try {
    await until(() => command('status', 'agent').stdout.includes('RUNNING'));
    assert.equal(fs.readFileSync(path.join(state, 'starts'), 'utf8'), '1');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state, 'roots.json'), 'utf8')), { app, work });
    const pid = Number(command('pid', 'agent').stdout.trim());
    assert.ok(pid > 1); process.kill(pid, 'SIGKILL');
    await until(() => fs.readFileSync(path.join(state, 'starts'), 'utf8') === '2' && command('status', 'agent').stdout.includes('RUNNING'));
    assert.equal(command('stop', 'agent').status, 0);
    await delay(2400);
    assert.equal(fs.readFileSync(path.join(state, 'starts'), 'utf8'), '2');
    assert.match(command('status', 'agent').stdout, /STOPPED/);
    assert.equal(fs.statSync(config).mode & 0o777, 0o600);
  } finally { child.kill('SIGTERM'); await exit; fs.rmSync(root, { recursive: true, force: true }); }
});

test('preparation refuses unconfigured or remote-paid state instead of starting setup', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-supervision-invalid-'));
  try {
    const options = { app: root, state: root, work: root, control: path.join(root, 'control') };
    assert.throws(() => prepareSupervision(options));
    fs.writeFileSync(path.join(root, 'wallet.json'), '{}');
    fs.writeFileSync(path.join(root, 'automaton.json'), JSON.stringify({ standalone: false }));
    assert.throws(() => prepareSupervision(options), /standalone/);
    assert.ok(!fs.existsSync(path.join(root, 'control/supervisord.conf')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
