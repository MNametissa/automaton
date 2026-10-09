import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

test('setup provisions a separate state directory, persists all missions, and refuses overwrite', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-setup-'));
  const state = path.join(tmp, 'agent');
  const env = { ...process.env, HOST: '127.0.0.1', PORT: '0', DB_PATH: path.join(tmp, 'control.db'), ROOT_ADDRESS: '', UPSTREAM_URL: 'http://127.0.0.1:8080' };
  const server = spawn(process.execPath, ['conway-local/server.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('startup timeout')), 5000);
      server.once('exit', () => { clearTimeout(timer); reject(new Error('server exited')); });
      server.stdout.on('data', data => { const match = String(data).match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
    });
    const args = ['conway-local/setup.mjs', '--state-dir', state, '--api-url', base, '--model', 'local', '--creator', '0x1111111111111111111111111111111111111111', '--mission', 'all'];
    const init = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(init.status, 0, init.stderr);
    const config = JSON.parse(fs.readFileSync(path.join(state, 'automaton.json'), 'utf8'));
    assert.equal(config.standalone, true);
    assert.equal(config.conwayApiUrl, base);
    assert.equal(config.socialRelayUrl, base);
    assert.equal(config.logLevel, 'debug');
    assert.equal(config.dbPath, path.join(state, 'state.db'));
    assert.equal(config.maxChildren, 0);
    assert.ok(config.genesisPrompt.includes('software') && config.genesisPrompt.includes('website') && config.genesisPrompt.includes('report'));
    assert.equal(fs.statSync(path.join(state, 'wallet.json')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(state, 'automaton.json')).mode & 0o777, 0o600);
    assert.equal(spawnSync(process.execPath, args, { env, encoding: 'utf8' }).status, 1);
    const balance = await (await fetch(`${base}/v1/credits/balance`, { headers: { authorization: config.conwayApiKey } })).json();
    assert.equal(balance.balance_cents, 0);
    assert.equal(balance.external_spend_limit_cents, 0);
    const status = spawnSync(process.execPath, ['conway-local/setup.mjs', '--state-dir', state, '--status'], { env, encoding: 'utf8' });
    assert.equal(status.status, 0);
    assert.ok(!status.stdout.includes(config.conwayApiKey));
  } finally {
    server.kill(); await once(server, 'exit');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
