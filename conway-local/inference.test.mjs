import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import https from 'node:https';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';

// This catches a missing authenticated status route and a false claim of provider funds.
test('local gateway exposes authenticated inference allowance without provider balance', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inference-status-'));
  const dbPath = path.join(dir, 'gateway.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE api_keys(hash TEXT PRIMARY KEY, address TEXT NOT NULL)');
  db.prepare('INSERT INTO api_keys VALUES(?,?)').run(crypto.createHash('sha256').update('test-key').digest('hex'), '0x1111111111111111111111111111111111111111');
  db.close();
  const env = { ...process.env, PORT: '0', HOST: '127.0.0.1', DB_PATH: dbPath, UPSTREAM_URL: 'http://127.0.0.1:9', MODEL_ID: 'local' };
  delete env.INFERENCE_CONFIG_FILE;
  delete env.TLS_CERT;
  delete env.TLS_KEY;
  const child = spawn(process.execPath, ['conway-local/server.mjs', 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', b => { errors += b; });
  try {
    const base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`startup timeout ${errors}`)), 5000);
      child.once('exit', () => { clearTimeout(timer); reject(new Error(errors)); });
      child.stdout.on('data', b => {
        const match = String(b).match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      });
    });
    assert.equal((await fetch(`${base}/v1/inference/status`)).status, 401);
    const response = await fetch(`${base}/v1/inference/status`, { headers: { authorization: 'Bearer test-key' } });
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.equal(state.mode, 'local');
    assert.equal(state.effective_external_spend_limit_microusd, 0);
    assert.equal(state.provider_balance_microusd, null);
    assert.equal(state.model, 'local');
    assert.equal(state.ready, true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inference-config-'));
  const providers = path.join(root, 'providers');
  fs.mkdirSync(providers, { mode: 0o700 });
  const key = path.join(providers, 'provider.key');
  fs.writeFileSync(key, 'never-log-or-read-this-secret', { mode: 0o600 });
  const configFile = path.join(providers, 'inference.json');
  const config = {
    version: 1, mode: 'remote', billing_mode: 'infrastructure', enabled: false, approved: false,
    prepaid_allowance_microusd: 0, approval_expires_at: '2099-01-01T00:00:00.000Z',
    endpoint: 'https://api.example.invalid/v1/chat/completions', model: 'fixed-model', api_key_file: key,
    pricing: { input_microusd_per_million_tokens: 1_000_000, output_microusd_per_million_tokens: 2_000_000 },
    limits: { max_input_bytes: 1024, max_output_tokens: 128, timeout_ms: 1000 },
  };
  const write = () => fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
  write();
  try {
    const { loadInference } = await import('./inference.mjs');
    await run({ load: (extra = {}) => loadInference({ INFERENCE_CONFIG_FILE: configFile, ...extra }, { controlRoot: root }), config, configFile, root, providers, key, write });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('remote declaration waits for operator approval without claiming provider budget', async () => {
  await fixture(({ load, config, write }) => {
    const inference = load();
    assert.equal(inference.status().mode, 'remote');
    assert.equal(inference.status().state, 'awaiting_approval');
    assert.equal(inference.status().ready, false);
    assert.equal(inference.status().declared_prepaid_allowance_microusd, 0);
    assert.equal(inference.status().provider_balance_microusd, null);
    assert.equal(inference.catalog().id, 'fixed-model');
    assert.equal(inference.catalog().pricing.input_per_million, 1);
    assert.equal(inference.catalog().pricing.output_per_million, 2);
    assert.equal(inference.catalog().pricing.source, 'operator_declared');
    assert.equal(inference.catalog().available, false);
    assert.equal(inference.availabilityError()[0], 503);
    config.approved = true;
    config.enabled = true;
    write();
    assert.equal(load().status().state, 'awaiting_budget');
    config.prepaid_allowance_microusd = 10_000_000;
    write();
    const ready = load().status();
    assert.equal(ready.ready, true);
    assert.equal(ready.effective_external_spend_limit_microusd, null);
    assert.equal(ready.infrastructure_expense_microusd, null);
    assert.equal(ready.declared_prepaid_allowance_microusd, 10_000_000);
  });
});

test('missing provider credentials and expired approval prevent remote requests', async () => {
  await fixture(({ load, config, key, write }) => {
    config.approved = true;
    config.enabled = true;
    config.prepaid_allowance_microusd = 1;
    delete config.endpoint;
    write();
    assert.equal(load().status().state, 'awaiting_provider');
    config.endpoint = 'https://api.example.invalid/v1/chat/completions';
    fs.unlinkSync(key);
    write();
    assert.equal(load().status().state, 'awaiting_credentials');
    fs.writeFileSync(key, 'private-value', { mode: 0o600 });
    config.approval_expires_at = '2000-01-01T00:00:00.000Z';
    write();
    assert.equal(load().status().state, 'approval_expired');
  });
});

test('token billing reports declared prices and awaits a selected provider contract', async () => {
  await fixture(({ load, config, write }) => {
    config.billing_mode = 'token';
    config.approved = true;
    config.enabled = true;
    config.prepaid_allowance_microusd = 100_000;
    write();
    assert.equal(load().status().state, 'awaiting_provider_contract');
    assert.equal(load().catalog().pricing.input_per_million, 1);
    assert.equal(load().availabilityError()[0], 503);
  });
});

test('runtime config path is fixed to controller providers directory', async () => {
  await fixture(({ load, configFile, root }) => {
    assert.throws(() => load({ INFERENCE_CONFIG_FILE: path.join(root, 'elsewhere.json') }), /config path/);
    assert.throws(() => load({ INFERENCE_CONFIG_FILE: `${path.dirname(configFile)}/../providers/inference.json` }), /config path/);
  });
});

test('remote config refuses credentials from environment', async () => {
  await fixture(({ load }) => {
    for (const name of ['UPSTREAM_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY']) {
      assert.throws(() => load({ [name]: 'private-value' }), /environment credentials/);
    }
    assert.throws(() => load({ UPSTREAM_URL: 'https://untrusted.invalid' }), /UPSTREAM_URL/);
  });
});

test('controller config and key must be private regular files with no symlinks', async () => {
  await fixture(({ load, configFile, key, providers }) => {
    fs.chmodSync(configFile, 0o644);
    assert.throws(load, /private/);
    fs.chmodSync(configFile, 0o600);
    fs.chmodSync(key, 0o640);
    assert.throws(load, /private/);
    fs.chmodSync(key, 0o600);
    fs.chmodSync(providers, 0o755);
    assert.throws(load, /private/);
    fs.chmodSync(providers, 0o700);
    fs.renameSync(key, `${key}.actual`);
    fs.symlinkSync(`${key}.actual`, key);
    assert.throws(load, /regular file/);
    fs.unlinkSync(key);
    fs.renameSync(`${key}.actual`, key);
    fs.renameSync(configFile, `${configFile}.actual`);
    fs.symlinkSync(`${configFile}.actual`, configFile);
    assert.throws(load, /regular file/);
  });
});

test('strict config rejects endpoint tricks, arbitrary parameters, and invalid budget bounds', async () => {
  await fixture(({ load, config, write, root }) => {
    const original = structuredClone(config);
    const invalid = [
      { endpoint: 'http://api.example.invalid/v1/chat/completions' },
      { endpoint: 'https://user:secret@api.example.invalid/v1/chat/completions' },
      { endpoint: 'https://api.example.invalid/v1/chat/completions?key=secret' },
      { endpoint: 'https://api.example.invalid/v1/chat/completions#secret' },
      { endpoint: 'https://api.example.invalid/wrong-route' },
      { headers: { Authorization: 'secret' } },
      { command: 'touch /tmp/nope' },
      { api_key_file: path.join(root, 'provider.key') },
      { pricing: { ...original.pricing, input_microusd_per_million_tokens: -1 } },
      { prepaid_allowance_microusd: -1 },
      { prepaid_allowance_microusd: 0.01 },
      { limits: { ...original.limits, max_input_bytes: Number.MAX_SAFE_INTEGER } },
      { limits: { ...original.limits, max_output_tokens: 1000000 } },
    ];
    for (const override of invalid) {
      Object.assign(config, original, override);
      write();
      assert.throws(load, /Invalid inference/);
      for (const key of Object.keys(config)) if (!(key in original)) delete config[key];
    }
  });
});

test('remote declaration never reads the provider key', async () => {
  await fixture(({ load, key }) => {
    const original = fs.readFileSync;
    const keyStat = fs.statSync(key);
    let keyRead = false;
    fs.readFileSync = function(file, ...args) {
      const stat = typeof file === 'number' ? fs.fstatSync(file) : null;
      if (file === key || (stat?.ino === keyStat.ino && stat?.dev === keyStat.dev)) { keyRead = true; throw new Error('secret file read'); }
      return original.call(this, file, ...args);
    };
    try { assert.equal(load().status().ready, false); assert.equal(keyRead, false); }
    finally { fs.readFileSync = original; }
  });
});


test('approved dedicated endpoint forwards tools and enforces bounds without fallback or redirects', async () => {
  await fixture(async ({ root, config, configFile, providers, write }) => {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', `${root}/tls.key`, '-out', `${root}/tls.pem`], { stdio: 'ignore' });
    const received = [];
    let redirectCalls = 0;
    const upstream = https.createServer({ key: fs.readFileSync(`${root}/tls.key`), cert: fs.readFileSync(`${root}/tls.pem`) }, async (req, res) => {
      if (req.url === '/redirect-target') { redirectCalls++; res.end('{}'); return; }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      received.push({ body, authorization: req.headers.authorization });
      const content = body.messages[0].content;
      if (content === 'hang') return;
      if (content === 'body-hang') { res.writeHead(200, { 'content-type': 'application/json' }); res.flushHeaders(); return; }
      if (content === 'redirect') { res.writeHead(307, { location: '/redirect-target' }); res.end(); return; }
      if (content === 'invalid') { res.end('bad-json'); return; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'ping', arguments: '{}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    }).listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    config.endpoint = `https://127.0.0.1:${upstream.address().port}/v1/chat/completions`;
    config.approved = true;
    config.enabled = true;
    config.prepaid_allowance_microusd = 1_000_000;
    config.limits.timeout_ms = 1000;
    write();
    const script = `
      import { loadInference } from ${JSON.stringify(new URL('./inference.mjs', import.meta.url).href)};
      const env = { INFERENCE_CONFIG_FILE: ${JSON.stringify(configFile)} };
      const inference = loadInference(env, { controlRoot: ${JSON.stringify(root)} });
      const results = [];
      for (const body of [
        { messages: [{role:'user',content:'tools'}], tools: [{type:'function',function:{name:'ping',parameters:{type:'object',properties:{}}}}], tool_choice:'auto', max_tokens:64 },
        { messages: [{role:'user',content:'redirect'}] },
        { messages: [{role:'user',content:'invalid'}] },
        { messages: [{role:'user',content:'hang'}] },
        { messages: [{role:'user',content:'body-hang'}] },
        { messages: [{role:'user',content:'wrong-model'}], model:'another-model' },
        { messages: [{role:'user',content:'overflow'}], max_tokens:129 },
        { messages: [{role:'user',content:'x'.repeat(1024)}] },
        { messages: [{role:'user',content:'extra'}], arbitrary_header:'secret' },
      ]) {
        try { results.push(await inference.complete(body)); }
        catch (e) { results.push([e.status || 500,{error:e.message}]); }
      }
      console.log(JSON.stringify(results));
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, NODE_EXTRA_CA_CERTS: `${root}/tls.pem` }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', b => { stdout += b; });
    child.stderr.on('data', b => { stderr += b; });
    try {
      const [code] = await once(child, 'exit');
      assert.equal(code, 0, stderr);
      const results = JSON.parse(stdout);
      assert.deepEqual(results.map(item => item[0]), [200, 502, 502, 504, 504, 400, 400, 413, 400]);
      assert.equal(results[0][1].choices[0].message.tool_calls[0].function.name, 'ping');
      assert.equal(received.length, 5);
      assert.equal(received[0].body.model, 'fixed-model');
      assert.equal(received[0].body.max_tokens, 64);
      assert.equal(received[0].body.tools[0].function.name, 'ping');
      assert.equal(received[0].authorization, 'Bearer never-log-or-read-this-secret');
      assert.equal(redirectCalls, 0);
      assert.ok(!stdout.includes('never-log-or-read'));
      assert.ok(!stderr.includes('never-log-or-read'));
    } finally {
      upstream.closeAllConnections();
      await new Promise(resolve => upstream.close(resolve));
    }
  });
});
