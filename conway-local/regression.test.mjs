import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { keccak256, toBytes } from 'viem';
import { SiweMessage } from 'siwe';
import { DatabaseSync } from 'node:sqlite';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conway-regression-'));
const root = privateKeyToAccount(generatePrivateKey());
const other = privateKeyToAccount(generatePrivateKey());
let server, upstream, base, env, key, otherKey;
let behavior = 'ok';
const children = [];
async function start() {
  const p = spawn(process.execPath, ['conway-local/server.mjs', 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(p);
  let output = '';
  const ready = new Promise((resolve, reject) => {
    p.once('exit', (code) => reject(new Error(`server exited ${code}: ${output}`)));
    p.stderr.on('data', (b) => { output += b; });
    p.stdout.on('data', (b) => {
      output += b;
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match && match[1] !== '0') resolve(`http://127.0.0.1:${match[1]}`);
    });
  });
  base = await Promise.race([ready, new Promise((_, reject) => { const t = setTimeout(() => reject(new Error(`startup timeout: ${output}`)), 5000); t.unref(); })]);
  return p;
}
const cli = (...args) => spawnSync(process.execPath, ['conway-local/server.mjs', ...args], { env, encoding: 'utf8' });
async function req(route, body, auth = key, headers = {}) {
  return fetch(`${base}${route}`, { signal: AbortSignal.timeout(2000), method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function signed(account, nonce) {
  const message = new SiweMessage({ domain: 'conway.tech', address: account.address, statement: 'Local test', uri: `${base}/v1/auth/verify`, version: '1', chainId: 8453, nonce, issuedAt: new Date().toISOString() }).prepareMessage();
  return { message, signature: await account.signMessage({ message }) };
}
async function provision(account) {
  const { nonce } = await (await req('/v1/auth/nonce', {})).json();
  const verify = await req('/v1/auth/verify', await signed(account, nonce));
  assert.equal(verify.status, 200);
  const { access_token } = await verify.json();
  const response = await req('/v1/auth/api-keys', {}, `Bearer ${access_token}`);
  assert.equal(response.status, 200);
  return (await response.json()).key;
}
before(async () => {
  upstream = http.createServer(async (_req, res) => {
    if (behavior === 'hang') return;
    if (behavior === 'invalid') { res.end('not json'); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }));
  }).listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const probe = http.createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DB_PATH: path.join(dir, 'state.db'), UPSTREAM_URL: `http://127.0.0.1:${upstream.address().port}`, UPSTREAM_TIMEOUT_MS: '100', ROOT_ADDRESS: root.address, RATE_CENTS_PER_HOUR: '0', LOG_LEVEL: 'debug' };
  server = await start();
  key = await provision(root);
  otherKey = await provision(other);
  assert.equal(cli('fund', '1').status, 0);
});
after(async () => {
  for (const child of children) { if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); } }
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('non-root account cannot replace the creator', async () => {
  assert.equal((await req('/v1/automaton/register-parent', { creatorAddress: root.address })).status, 200);
  assert.equal((await req('/v1/automaton/register-parent', { creatorAddress: other.address }, otherKey)).status, 403);
});
test('invalid signature does not consume a valid nonce', async () => {
  const { nonce } = await (await req('/v1/auth/nonce', {})).json();
  const payload = await signed(root, nonce);
  assert.equal((await req('/v1/auth/verify', { ...payload, signature: await other.signMessage({ message: payload.message }) })).status, 401);
  assert.equal((await req('/v1/auth/verify', payload)).status, 200);
  assert.equal((await req('/v1/auth/verify', payload)).status, 401);
});
test('transfer retries with the same key debit only once, including after restart', async () => {
  const payload = { to_address: other.address, amount_cents: 10 };
  const headers = { 'Idempotency-Key': 'test-transfer-1' };
  const first = await (await req('/v1/credits/transfer', payload, key, headers)).json();
  const second = await (await req('/v1/credits/transfer', payload, key, headers)).json();
  assert.equal(second.transfer_id, first.transfer_id);
  server.kill(); await once(server, 'exit'); server = await start();
  const third = await (await req('/v1/credits/transfers', payload, key, headers)).json();
  assert.equal(third.transfer_id, first.transfer_id);
  assert.equal((await (await req('/v1/credits/balance')).json()).balance_cents, 90);
  assert.equal((await req('/v1/credits/transfer', { ...payload, amount_cents: 11 }, key, headers)).status, 409);
});
test('signed messages reject stale timestamps and deduplicate retries', async () => {
  async function message(at) {
    const content = 'hello';
    return { from: root.address, to: other.address, content, signed_at: at, signature: await root.signMessage({ message: `Conway:send:${other.address.toLowerCase()}:${keccak256(toBytes(content))}:${at}` }) };
  }
  assert.equal((await req('/v1/messages', await message('bad-date'))).status, 400);
  assert.equal((await req('/v1/messages', await message('2000-01-01T00:00:00.000Z'))).status, 400);
  const payload = await message(new Date().toISOString());
  const a = await (await req('/v1/messages', payload)).json();
  const b = await (await req('/v1/messages', payload)).json();
  assert.equal(a.id, b.id);
});
test('poll rejects a signed invalid timestamp and invalid limits', async () => {
  for (const ts of ['bad-date', new Date().toISOString()]) {
    const signature = await other.signMessage({ message: `Conway:poll:${other.address.toLowerCase()}:${ts}` });
    const response = await req('/v1/messages/poll', { limit: -1 }, null, { 'x-wallet-address': other.address, 'x-signature': signature, 'x-timestamp': ts });
    assert.ok([400, 401].includes(response.status));
  }
});
test('invalid monetary values fail without corrupting the ledger', () => {
  for (const args of [['fund', 'Infinity'], ['fund', '0.001'], ['rate', 'Infinity'], ['fund', '-1']]) assert.notEqual(cli(...args).status, 0, args.join(' '));
});
test('budget reports a local allocation, never verified provider funds', async () => {
  const state = await (await req('/v1/credits/balance')).json();
  assert.equal(state.accounting_mode, 'simulation');
  assert.equal(state.provider_balance_cents, null);
  assert.equal(state.external_spend_limit_cents, 0);
});
test('upstream invalid JSON returns a gateway error', async () => {
  behavior = 'invalid';
  assert.equal((await req('/v1/chat/completions', { model: 'local', messages: [{ role: 'user', content: 'ping' }] })).status, 502);
  behavior = 'ok';
});
test('upstream stalls are bounded by a timeout', async () => {
  behavior = 'hang';
  let response;
  try { response = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { authorization: key, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'local', messages: [{ role: 'user', content: 'ping' }] }), signal: AbortSignal.timeout(2000) }); } finally { behavior = 'ok'; }
  assert.equal(response.status, 504);
});
test('pause blocks every account and funding does not resume it', async () => {
  assert.equal(cli('pause').status, 0);
  assert.equal(cli('fund', '1').status, 0);
  const body = { model: 'local', messages: [{ role: 'user', content: 'ping' }] };
  assert.equal((await req('/v1/chat/completions', body)).status, 503);
  assert.equal((await req('/v1/chat/completions', body, otherKey)).status, 503);
  assert.equal(cli('resume').status, 0);
  assert.equal((await req('/v1/chat/completions', body)).status, 200);
});
test('each account reports its actual share of the simulated burn', async () => {
  assert.equal(cli('rate', '36').status, 0);
  try {
    const primary = await (await req('/v1/credits/balance')).json();
    const secondary = await (await req('/v1/credits/balance', undefined, otherKey)).json();
    assert.ok(Math.abs(primary.burn_cents_per_hour - 34.2) < 0.001);
    assert.ok(Math.abs(secondary.burn_cents_per_hour - 1.8) < 0.001);
    assert.ok(primary.runway_hours > 0 && secondary.runway_hours > 0);
  } finally { assert.equal(cli('rate', '0').status, 0); }
});
test('transferring allocation cannot escape the simulated infrastructure burn', async () => {
  const balance = (await (await req('/v1/credits/balance')).json()).balance_cents;
  assert.equal((await req('/v1/credits/transfer', { to_address: other.address, amount_cents: balance })).status, 200);
  assert.equal(cli('rate', '3600').status, 0);
  const ledger = new DatabaseSync(env.DB_PATH);
  ledger.prepare('UPDATE meta SET v=? WHERE k=?').run(String(Date.now() - 3_600_000), 'last_tick');
  ledger.close();
  const response = await req('/v1/chat/completions', { model: 'local', messages: [{ role: 'user', content: 'ping' }] }, otherKey);
  assert.equal(response.status, 402);
});
