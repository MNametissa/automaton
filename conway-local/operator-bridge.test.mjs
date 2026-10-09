import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createOperatorBridge, readBridgeTokenFile } from './operator-bridge.mjs';

const token = 'test-operator-token-with-at-least-32-characters';
const agent = `0x${'1'.repeat(40)}`;
const creator = `0x${'2'.repeat(40)}`;
let dir, state, control, server, origin;
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const body = content => ({ model: 'i-am-alive', messages: [{ role: 'user', content }] });

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-bridge-'));
  state = new DatabaseSync(path.join(dir, 'state.db'));
  state.exec(`CREATE TABLE inbox_messages (id TEXT PRIMARY KEY, from_address TEXT NOT NULL, content TEXT NOT NULL,
    received_at TEXT DEFAULT (datetime('now')), processed_at TEXT, reply_to TEXT, to_address TEXT, raw_content TEXT,
    status TEXT DEFAULT 'received', retry_count INTEGER DEFAULT 0, max_retries INTEGER DEFAULT 3);
    CREATE TABLE wake_events (id INTEGER PRIMARY KEY, source TEXT, reason TEXT, payload TEXT, consumed_at TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE goals (id TEXT, title TEXT, status TEXT, created_at TEXT);
    CREATE TABLE task_graph (id TEXT, goal_id TEXT, title TEXT, status TEXT, assigned_to TEXT, created_at TEXT);
    INSERT INTO kv VALUES ('agent_state', 'sleeping');
    INSERT INTO kv VALUES ('super_secret', 'PRIVATE-KEY-DO-NOT-LEAK');
    INSERT INTO goals VALUES ('g1', 'Test goal', 'active', '2026-01-01');
    INSERT INTO task_graph VALUES ('t1', 'g1', 'Test task', 'pending', NULL, '2026-01-01');`);
  control = new DatabaseSync(path.join(dir, 'control.db'));
  control.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY, from_addr TEXT, to_addr TEXT, content TEXT,
    created_at TEXT, reply_to TEXT, read INTEGER DEFAULT 0);
    CREATE TABLE api_keys (hash TEXT, address TEXT);
    INSERT INTO api_keys VALUES ('PRIVATE-KEY-DO-NOT-LEAK', 'secret');`);
  fs.writeFileSync(path.join(dir, 'automaton.json'), JSON.stringify({ dbPath: path.join(dir, 'state.db'), walletAddress: agent, creatorAddress: creator, conwayApiKey: 'PRIVATE-KEY-DO-NOT-LEAK' }));
  fs.writeFileSync(path.join(dir, 'wallet.json'), 'INVALID PRIVATE-KEY-DO-NOT-LEAK');
  await start();
});

afterEach(async () => {
  await new Promise(resolve => server.close(resolve));
  state.close(); control.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function start(options = {}) {
  server = createOperatorBridge({ stateDir: dir, controlDbPath: path.join(dir, 'control.db'), token, replyWaitMs: 0, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
}
const chat = (payload, extra = {}) => fetch(`${origin}/v1/chat/completions`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(payload) });
const outbound = (receipt, content, from = agent, to = creator) => control.prepare('INSERT INTO messages(from_addr,to_addr,content,created_at,reply_to) VALUES(?,?,?,?,?)').run(from, to, content, new Date().toISOString(), receipt);

test('controller binding pins database and identities against agent configuration changes', async () => {
  await new Promise(resolve => server.close(resolve));
  const bindingFile = path.join(dir, 'binding.json');
  fs.writeFileSync(bindingFile, JSON.stringify({ agent, creator, dbPath: path.join(dir, 'state.db') }), { mode: 0o600 });
  await start({ bindingFile });
  assert.equal((await chat(body('bound request'))).status, 200);
  fs.writeFileSync(path.join(dir, 'automaton.json'), JSON.stringify({ dbPath: path.join(dir, 'control.db'), walletAddress: creator, creatorAddress: agent }));
  assert.equal((await chat(body('tampered routing'))).status, 503);
  assert.equal(state.prepare('SELECT COUNT(*) n FROM inbox_messages').get().n, 1);
});

test('bound bridge rejects a symlink substituted for the state database', async () => {
  await new Promise(resolve => server.close(resolve));
  const bindingFile = path.join(dir, 'binding.json');
  fs.writeFileSync(bindingFile, JSON.stringify({ agent, creator, dbPath: path.join(dir, 'state.db') }), { mode: 0o600 });
  await start({ bindingFile });
  fs.renameSync(path.join(dir, 'state.db'), path.join(dir, 'saved.db'));
  fs.symlinkSync(path.join(dir, 'saved.db'), path.join(dir, 'state.db'));
  assert.equal((await chat(body('symlink request'))).status, 503);
});

test('auth protects models, status and writes; health is limited', async () => {
  for (const route of ['/v1/models', '/v1/status']) assert.equal((await fetch(origin + route)).status, 401);
  assert.equal((await fetch(origin + '/v1/chat/completions', { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(origin + '/v1/models', { headers: { authorization: 'Bearer wrong' } })).status, 401);
  const health = await (await fetch(origin + '/health')).json();
  assert.deepEqual(health, { service: 'operator-bridge', status: 'ok' });
  const models = await (await fetch(origin + '/v1/models', { headers })).json();
  assert.deepEqual(models.data.map(model => model.id), ['i-am-alive']);
  assert.equal(state.prepare('SELECT COUNT(*) n FROM inbox_messages').get().n, 0);
});

test('submits the last user text durably with server-owned routing and one wake event', async () => {
  const response = await chat({ ...body('old'), from: 'evil', dbPath: '/tmp/evil', messages: [{ role: 'user', content: 'old' }, { role: 'assistant', content: 'answer' }, { role: 'user', content: 'new request' }] });
  assert.equal(response.status, 200);
  const result = await response.json();
  const message = state.prepare('SELECT * FROM inbox_messages').get();
  assert.equal(message.raw_content, 'new request');
  assert.equal(message.from_address, creator); assert.equal(message.to_address, agent);
  assert.equal(message.id, result.receipt.id);
  assert.match(message.content, new RegExp(message.id));
  assert.equal(message.status, 'received');
  assert.equal(state.prepare('SELECT COUNT(*) n FROM wake_events').get().n, 1);
  assert.equal(result.receipt.status, 'queued');
  assert.match(result.choices[0].message.content, /queued/i);
  assert.match(result.choices[0].message.content, /not.*agent.*reply/i);
});

test('new identical instructions stay distinct; only explicit idempotency keys deduplicate', async () => {
  const payload = body('one instruction');
  const [one, two] = await Promise.all([chat(payload).then(r => r.json()), chat(payload).then(r => r.json())]);
  assert.notEqual(one.receipt.id, two.receipt.id);
  const keyed = await (await chat(body('second'), { 'idempotency-key': 'stable-key' })).json();
  const retried = await (await chat(body('second'), { 'idempotency-key': 'stable-key' })).json();
  assert.equal(keyed.receipt.id, retried.receipt.id);
  assert.equal((await chat(body('different'), { 'idempotency-key': 'stable-key' })).status, 409);
  assert.equal(state.prepare('SELECT COUNT(*) n FROM inbox_messages').get().n, 3);
  assert.equal(state.prepare('SELECT COUNT(*) n FROM wake_events').get().n, 3);
});

test('returns only native outbound replies matching receipt, agent and creator', async () => {
  const payload = body('correlate');
  const queued = await (await chat(payload, { 'idempotency-key': 'correlation-key' })).json();
  outbound('unrelated', 'wrong receipt');
  outbound(queued.receipt.id, 'wrong author', creator, creator);
  outbound(queued.receipt.id, 'wrong recipient', agent, agent);
  assert.equal((await (await chat(payload, { 'idempotency-key': 'correlation-key' })).json()).receipt.status, 'queued');
  outbound(queued.receipt.id, 'Confirmed native agent reply');
  const completed = await (await chat(payload, { 'idempotency-key': 'correlation-key' })).json();
  assert.equal(completed.choices[0].message.content, 'Confirmed native agent reply');
  assert.equal(completed.receipt.status, 'replied');
  assert.equal(control.prepare('SELECT SUM(read) n FROM messages').get().n, 0);
});

test('polls a correlated native reply and streams valid OpenAI SSE chunks', async () => {
  await new Promise(resolve => server.close(resolve));
  await start({ replyWaitMs: 1000, pollIntervalMs: 10 });
  const pending = chat({ ...body('stream'), stream: true });
  for (let i = 0; i < 100 && !state.prepare('SELECT id FROM inbox_messages').get(); i++) await new Promise(r => setTimeout(r, 10));
  outbound(state.prepare('SELECT id FROM inbox_messages').get().id, 'Native streamed reply');
  const response = await pending;
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const lines = (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6));
  assert.equal(lines.pop(), '[DONE]');
  const chunks = lines.map(JSON.parse);
  assert.equal(chunks.map(chunk => chunk.choices[0].delta.content || '').join(''), 'Native streamed reply');
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop');
});

test('status exposes only selected state and confirmed outbound messages, without pretending alive', async () => {
  outbound('r1', 'Confirmed outbound'); outbound('r2', 'other inbox', creator, agent);
  const response = await fetch(origin + '/v1/status', { headers });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.doesNotMatch(text, /PRIVATE-KEY|wallet|api_keys|super_secret|other inbox/);
  const status = JSON.parse(text);
  assert.equal(status.agentState, 'sleeping');
  assert.equal(status.runtime, 'unverified'); assert.equal(status.model, 'unverified');
  assert.equal(status.pendingTasks, 1);
  assert.equal(status.messages[0].content, 'Confirmed outbound');
  const command = await (await chat(body('/status'))).json();
  assert.match(command.choices[0].message.content, /sleeping/);
  assert.equal(state.prepare('SELECT COUNT(*) n FROM inbox_messages').get().n, 0);
});

test('rejects oversized, non-text, empty and unsupported model requests without mutations', async () => {
  assert.equal((await chat(body('x'.repeat(65536)))).status, 413);
  for (const payload of [body(''), { ...body('hi'), model: 'other' }, { ...body('hi'), stream: 'yes' }, { ...body('hi'), messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'secret' } }] }] }]) {
    assert.equal((await chat(payload)).status, 400);
  }
  assert.equal(state.prepare('SELECT COUNT(*) n FROM inbox_messages').get().n, 0);
});

test('missing configuration or database returns generic 503 and never creates state', async () => {
  fs.unlinkSync(path.join(dir, 'automaton.json'));
  const response = await chat(body('hello'));
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /PRIVATE-KEY|operator-bridge-.*\/|SQLITE/);
  assert.equal((await fetch(origin + '/v1/status', { headers })).status, 503);
});

test('private token file rejects symlinks, directories and group/world permissions', () => {
  const file = path.join(dir, 'token');
  fs.writeFileSync(file, token, { mode: 0o600 });
  assert.equal(readBridgeTokenFile(file), token);
  fs.chmodSync(file, 0o644); assert.throws(() => readBridgeTokenFile(file));
  fs.chmodSync(file, 0o600);
  fs.symlinkSync(file, path.join(dir, 'link')); assert.throws(() => readBridgeTokenFile(path.join(dir, 'link')));
  assert.throws(() => readBridgeTokenFile(dir));
});

test('receipts survive a bridge restart without submitting the same work twice', async () => {
  const first = await (await chat(body('survive restart'), { 'idempotency-key': 'restart-key' })).json();
  await new Promise(resolve => server.close(resolve));
  await start();
  const second = await (await chat(body('survive restart'), { 'idempotency-key': 'restart-key' })).json();
  assert.equal(second.receipt.id, first.receipt.id);
  assert.equal(state.prepare('SELECT COUNT(*) n FROM inbox_messages').get().n, 1);
  assert.equal(state.prepare('SELECT COUNT(*) n FROM wake_events').get().n, 1);
});

test('inbox insertion rolls back if its wake event cannot be persisted', async () => {
  state.exec("CREATE TRIGGER fail_wake BEFORE INSERT ON wake_events BEGIN SELECT RAISE(ABORT, 'PRIVATE-KEY-DO-NOT-LEAK'); END");
  const response = await chat(body('must be atomic'));
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /PRIVATE-KEY|SQLITE|fail_wake/);
  assert.equal(state.prepare('SELECT COUNT(*) n FROM inbox_messages').get().n, 0);
  assert.equal(state.prepare('SELECT COUNT(*) n FROM wake_events').get().n, 0);
});

test('refuses a missing configured database without silently creating a new runtime', async () => {
  const missing = path.join(dir, 'missing.db');
  fs.writeFileSync(path.join(dir, 'automaton.json'), JSON.stringify({ dbPath: missing, walletAddress: agent, creatorAddress: creator }));
  assert.equal((await chat(body('no runtime'))).status, 503);
  assert.equal(fs.existsSync(missing), false);
});


test('an interrupted request is reported honestly and is not silently replayed', async () => {
  const payload = body('interrupted work'), key = { 'idempotency-key': 'interrupted' };
  const first = await (await chat(payload, key)).json();
  state.prepare("UPDATE inbox_messages SET status='failed' WHERE id=?").run(first.receipt.id);
  const result = await (await chat(payload, key)).json();
  assert.equal(result.receipt.status, 'failed');
  assert.match(result.choices[0].message.content, /unknown/i);
  assert.equal(state.prepare('SELECT COUNT(*) n FROM inbox_messages').get().n, 1);
  assert.equal(state.prepare('SELECT COUNT(*) n FROM wake_events').get().n, 1);
  const snapshot = await (await fetch(origin + '/v1/status', { headers })).json();
  assert.equal(snapshot.failedMessages[0].id, first.receipt.id);
});
