import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';

const module = await import('./operator-contact.mjs').catch(() => ({}));
const address = '0x1111111111111111111111111111111111111111';
const request = { subject: 'Recharge needed', message: 'Reported balance: unknown. Please review funding.', purpose: 'recharge' };
function fixture(t, smtp = null, options = {}) {
  assert.equal(typeof module.createOperatorContact, 'function', 'operator contact channel must exist');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-contact-'));
  const db = new DatabaseSync(path.join(directory, 'outbox.db'));
  const configPath = path.join(directory, 'config.json');
  const config = { recipient: 'operator@example.com', cooldownSeconds: 3600, smtp };
  fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { db, directory, configPath, config, channel: module.createOperatorContact({ db, configPath, ...options }) };
}

test('missing SMTP persists an honest queued receipt across restarts without inventing financial facts', async t => {
  const f = fixture(t);
  const receipt = await f.channel.request(address, request);
  assert.equal(receipt.status, 'queued');
  assert.equal(receipt.reason, 'smtp_not_configured');
  assert.equal(receipt.deliveryConfirmed, false);
  const restarted = module.createOperatorContact({ db: f.db, configPath: f.configPath });
  const state = restarted.status(address);
  assert.equal(state.requests[0].id, receipt.id);
  assert.equal(state.requests[0].status, 'queued');
  assert.equal(JSON.parse(f.db.prepare('SELECT payload FROM operator_contact_outbox').get().payload).message, request.message);
});

test('recipient overrides and header injection cannot create an outbox record', async t => {
  const { channel, db } = fixture(t);
  for (const payload of [{ ...request, recipient: 'other@example.com' }, { ...request, subject: 'Hello\r\nBcc: other@example.com' }, { ...request, message: '' }]) {
    await assert.rejects(channel.request(address, payload), error => error.status === 400);
  }
  assert.equal(db.prepare('SELECT count(*) n FROM operator_contact_outbox').get().n, 0);
});

test('idempotent content is reused and changed content under the same key is rejected', async t => {
  const { channel, db } = fixture(t);
  const first = await channel.request(address, { ...request, idempotencyKey: 'recharge-1' });
  assert.equal((await channel.request(address, { ...request, idempotencyKey: 'recharge-1' })).id, first.id);
  await assert.rejects(channel.request(address, { ...request, subject: 'Different', idempotencyKey: 'recharge-1' }), error => error.status === 409);
  assert.equal(db.prepare('SELECT count(*) n FROM operator_contact_outbox').get().n, 1);
});

test('cooldown suppresses changed messages from another agent without creating a false send receipt', async t => {
  let now = 100000;
  const { channel, db } = fixture(t, null, { clock: () => now });
  const first = await channel.request(address, request);
  const suppressed = await channel.request('0x2222222222222222222222222222222222222222', { ...request, subject: 'Another request' });
  assert.equal(suppressed.status, 'cooldown');
  assert.equal(suppressed.existingRequestId, first.id);
  assert.equal(suppressed.retryAfterSeconds, 3600);
  assert.equal(db.prepare('SELECT count(*) n FROM operator_contact_outbox').get().n, 1);
  now += 3600001;
  assert.equal((await channel.request(address, { ...request, subject: 'New after cooldown' })).status, 'queued');
});

test('nonprivate or symlinked config queues safely and never uses its SMTP data', async t => {
  const f = fixture(t, { host: 'smtp.example.com', port: 465, secure: true, from: 'agent@example.com' });
  fs.chmodSync(f.configPath, 0o644);
  const queued = await f.channel.request(address, request);
  assert.equal(queued.status, 'queued');
  assert.equal(queued.reason, 'invalid_contact_config');
  fs.chmodSync(f.configPath, 0o600);
  fs.renameSync(f.configPath, path.join(f.directory, 'real.json'));
  fs.symlinkSync(path.join(f.directory, 'real.json'), f.configPath);
  assert.equal(f.channel.status(address).transportReady, false);
});

test('interrupted delivery becomes uncertain on restart and cannot be blindly repeated', async t => {
  const f = fixture(t);
  const queued = await f.channel.request(address, request);
  f.db.prepare("UPDATE operator_contact_outbox SET status='delivering' WHERE id=?").run(queued.id);
  const restarted = module.createOperatorContact({ db: f.db, configPath: f.configPath });
  const retried = await restarted.request(address, request);
  assert.equal(retried.id, queued.id);
  assert.equal(retried.status, 'uncertain');
  assert.equal(retried.reason, 'delivery_interrupted');
});

test('a real local SMTP acceptance records only server acceptance and delivers to the fixed recipient', async t => {
  let envelope = '', wire = '';
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.write('220 localhost SMTP\r\n');
    let buffer = '', data = false;
    socket.on('data', chunk => {
      buffer += chunk.toString();
      while (buffer.includes('\r\n')) {
        const index = buffer.indexOf('\r\n'), line = buffer.slice(0, index); buffer = buffer.slice(index + 2);
        if (data) { if (line === '.') { data = false; socket.write('250 accepted\r\n'); } else wire += line + '\n'; }
        else if (/^(EHLO|HELO)/.test(line)) socket.write('250-localhost\r\n250 PIPELINING\r\n');
        else if (/^RCPT TO:/.test(line)) { envelope = line; socket.write('250 ok\r\n'); }
        else if (/^DATA/.test(line)) { data = true; socket.write('354 send data\r\n'); }
        else if (/^QUIT/.test(line)) socket.end('221 bye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  const { channel } = fixture(t, { host: '127.0.0.1', port: server.address().port, secure: false, allowInsecureLoopback: true, from: 'agent@example.com' });
  const receipt = await channel.request(address, request);
  assert.equal(receipt.status, 'smtp_accepted');
  assert.equal(receipt.deliveryConfirmed, false);
  assert.match(receipt.note, /inbox/i);
  assert.equal(envelope, 'RCPT TO:<operator@example.com>');
  assert.match(wire, /Reported balance: unknown/);
  assert.equal((await channel.request(address, request)).id, receipt.id);
});

test('an ambiguous SMTP error is durably uncertain and its exception cannot leak secrets', async t => {
  let attempts = 0;
  const f = fixture(t, { host: 'smtp.example.com', port: 465, secure: true, from: 'agent@example.com' }, {
    createTransport: () => ({ sendMail: async () => { attempts++; throw Object.assign(new Error('smtp-password=secret'), { code: 'ECONNECTION', command: 'DATA' }); }, close() {} }),
  });
  const receipt = await f.channel.request(address, request);
  assert.equal(receipt.status, 'uncertain');
  assert.equal(receipt.reason, 'smtp_outcome_unknown');
  assert.equal((await f.channel.request(address, request)).id, receipt.id);
  assert.equal(attempts, 1);
  assert.doesNotMatch(JSON.stringify(f.channel.status(address)), /smtp-password|secret/);
});

test('sending an old queued request starts a fresh cooldown after SMTP configuration becomes available', async t => {
  let now = 100000;
  const f = fixture(t, null, { clock: () => now, createTransport: () => ({ sendMail: async () => ({ accepted: ['operator@example.com'], rejected: [], messageId: 'test', response: '250 ok' }), close() {} }) });
  await f.channel.request(address, request);
  now += 7200000;
  f.config.smtp = { host: 'smtp.example.com', port: 465, secure: true, from: 'agent@example.com' };
  fs.writeFileSync(f.configPath, JSON.stringify(f.config), { mode: 0o600 });
  assert.equal((await f.channel.request(address, request)).status, 'smtp_accepted');
  const next = await f.channel.request(address, { ...request, subject: 'Different' });
  assert.equal(next.status, 'cooldown');
  assert.equal(next.retryAfterSeconds, 3600);
});

test('gateway authenticates operator contact and returns only the callers durable receipts', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-contact-gateway-'));
  const dbPath = path.join(directory, 'gateway.db'), configPath = path.join(directory, 'config.json');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE api_keys(hash TEXT PRIMARY KEY,address TEXT NOT NULL)');
  for (const [key, sender] of [['test-key', address], ['other-key', '0x2222222222222222222222222222222222222222']]) {
    db.prepare('INSERT INTO api_keys VALUES(?,?)').run(crypto.createHash('sha256').update(key).digest('hex'), sender);
  }
  db.close();
  fs.writeFileSync(configPath, JSON.stringify({ recipient: 'operator@example.com', smtp: null }), { mode: 0o600 });
  const env = { ...process.env, HOST: '127.0.0.1', PORT: '0', DB_PATH: dbPath, OPERATOR_CONTACT_CONFIG: configPath, UPSTREAM_URL: 'http://127.0.0.1:9', ROOT_ADDRESS: address };
  for (const key of ['TLS_CERT', 'TLS_KEY', 'INFERENCE_CONFIG_FILE']) delete env[key];
  const child = spawn(process.execPath, ['conway-local/server.mjs', 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = ''; child.stderr.on('data', chunk => { errors += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`gateway startup timeout: ${errors}`)), 10000);
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`gateway exited: ${errors}`)); });
    child.stdout.on('data', chunk => { const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
  });
  assert.equal((await fetch(`${base}/v1/operator/contact`)).status, 401);
  assert.equal((await fetch(`${base}/v1/operator/contact`, { method: 'POST', body: JSON.stringify(request) })).status, 401);
  const result = await fetch(`${base}/v1/operator/contact`, { method: 'POST', headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
  assert.equal(result.status, 200);
  const queued = await result.json();
  assert.equal(queued.status, 'queued'); assert.equal(queued.deliveryConfirmed, false);
  const status = await (await fetch(`${base}/v1/operator/contact`, { headers: { Authorization: 'Bearer test-key' } })).json();
  assert.equal(status.requests[0].id, queued.id);
  assert.equal(status.transportReady, false);
  const other = await (await fetch(`${base}/v1/operator/contact`, { headers: { Authorization: 'Bearer other-key' } })).json();
  assert.deepEqual(other.requests, []);
});
