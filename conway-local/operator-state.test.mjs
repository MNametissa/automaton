import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createOperatorBridge } from './operator-bridge.mjs';
import { stateOperation } from './operator-state.mjs';

test('state helper accepts only fixed operations', () => {
  assert.throws(() => stateOperation({ stateDir: '/missing', operation: 'exec', parameters: { sql: 'anything' } }), /Invalid state operation/);
});

test('privileged bridge submits and inspects state as the agent while keeping relay private',
  { skip: process.getuid?.() !== 0, timeout: 20000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-state-'));
    fs.chmodSync(root, 0o755);
    const stateDir = path.join(root, 'state'), controlDir = path.join(root, 'control');
    fs.mkdirSync(stateDir, { mode: 0o700 }); fs.chownSync(stateDir, 1000, 1000);
    fs.mkdirSync(controlDir, { mode: 0o700 });
    const agent = `0x${'1'.repeat(40)}`, creator = `0x${'2'.repeat(40)}`;
    const dbPath = path.join(stateDir, 'state.db'), controlDbPath = path.join(controlDir, 'control.db');
    const token = 'fixture-bridge-token-at-least-32-characters';
    const bindingFile = path.join(controlDir, 'binding.json');
    fs.writeFileSync(bindingFile, JSON.stringify({ agent, creator, dbPath }), { mode: 0o600 });
    const config = path.join(stateDir, 'automaton.json');
    fs.writeFileSync(config, JSON.stringify({ walletAddress: agent, creatorAddress: creator, dbPath }), { mode: 0o600 });
    fs.chownSync(config, 1000, 1000);
    const state = new DatabaseSync(dbPath);
    state.exec(`CREATE TABLE inbox_messages(id TEXT PRIMARY KEY, from_address TEXT, to_address TEXT,
      content TEXT, raw_content TEXT, status TEXT, retry_count INTEGER, received_at TEXT);
      CREATE TABLE wake_events(source TEXT, reason TEXT, payload TEXT);
      CREATE TABLE kv(key TEXT, value TEXT);
      CREATE TABLE goals(id TEXT,title TEXT,status TEXT,created_at TEXT);
      CREATE TABLE task_graph(id TEXT,goal_id TEXT,title TEXT,status TEXT,created_at TEXT);
      INSERT INTO kv VALUES('agent_state','sleeping');`);
    state.close(); fs.chmodSync(dbPath, 0o600); fs.chownSync(dbPath, 1000, 1000);
    const control = new DatabaseSync(controlDbPath);
    control.exec('CREATE TABLE messages(id INTEGER PRIMARY KEY,from_addr TEXT,to_addr TEXT,content TEXT,created_at TEXT,reply_to TEXT)');
    fs.chmodSync(controlDbPath, 0o600);
    const server = createOperatorBridge({ stateDir, controlDbPath, token, bindingFile, replyWaitMs: 0 });
    try {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const origin = `http://127.0.0.1:${server.address().port}`;
      const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': 'fixture-request' };
      const chat = () => fetch(origin + '/v1/chat/completions', { method: 'POST', headers,
        body: JSON.stringify({ model: 'i-am-alive', messages: [{ role: 'user', content: 'fixture instruction' }] }) });
      const response = await chat(); assert.equal(response.status, 200);
      const queued = await response.json(); assert.equal(queued.receipt.status, 'queued');
      assert.equal(fs.statSync(dbPath).uid, 1000);
      assert.deepEqual(fs.readdirSync(stateDir).filter(name => fs.statSync(path.join(stateDir, name)).uid !== 1000), []);
      const inspection = new DatabaseSync(dbPath, { readOnly: true });
      assert.equal(inspection.prepare('SELECT COUNT(*) n FROM inbox_messages').get().n, 1);
      assert.equal(inspection.prepare('SELECT COUNT(*) n FROM wake_events').get().n, 1); inspection.close();
      control.prepare('INSERT INTO messages(from_addr,to_addr,content,reply_to) VALUES(?,?,?,?)')
        .run(agent, creator, 'fixture confirmed reply', queued.receipt.id);
      assert.equal((await (await chat()).json()).receipt.status, 'replied');
      const status = await (await fetch(origin + '/v1/status', { headers })).json();
      assert.equal(status.agentState, 'sleeping'); assert.equal(status.messages[0].content, 'fixture confirmed reply');
      fs.renameSync(dbPath, dbPath + '.saved'); fs.symlinkSync(controlDbPath, dbPath);
      assert.equal((await chat()).status, 503);
      assert.equal(control.prepare('SELECT COUNT(*) n FROM messages').get().n, 1);
    } finally {
      await new Promise(resolve => server.close(resolve)); control.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
