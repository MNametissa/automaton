#!/usr/bin/env node
// OpenAI protocol adapter for the existing durable Automaton inbox, not an inference client.
// Requires initialized state + gateway databases. Missing setup returns 503.
// An initialized but dormant agent accepts queued work; no acknowledgement claims it is alive.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { stateOperation } from './operator-state.mjs';
import { agentEnvironment } from './desktop/boundary.mjs';

const MODEL = 'i-am-alive';
const MAX_BODY = 64 * 1024;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const failure = (status, message) => Object.assign(new Error(message), { status, publicMessage: message });
const unavailable = () => failure(503, 'Automaton state or relay is unavailable or unconfigured. Initialize and start the local runtime; no message was fabricated.');

export function readBridgeTokenFile(filename) {
  let fd;
  try {
    fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 4096) throw new Error();
    const token = fs.readFileSync(fd, 'utf8').trim();
    if (token.length < 32 || /\s/.test(token)) throw new Error();
    return token;
  } catch { throw new Error('Bridge token must be a private regular file containing at least 32 non-whitespace characters'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(value));
}

function readBody(req) {
  if (Number(req.headers['content-length']) > MAX_BODY) {
    req.resume();
    return Promise.reject(failure(413, 'Request exceeds the 64 KiB limit'));
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(failure(413, 'Request exceeds the 64 KiB limit')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > MAX_BODY) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(failure(400, 'Invalid JSON request')); }
    });
    req.on('error', () => reject(failure(400, 'Incomplete request')));
    req.on('aborted', () => reject(failure(400, 'Incomplete request')));
  });
}

function validateChat(body) {
  if (!body || body.model !== MODEL || (body.stream !== undefined && typeof body.stream !== 'boolean') ||
      !Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 512) {
    throw failure(400, 'Use model i-am-alive, text messages, and an optional boolean stream');
  }
  const messages = body.messages.map(message => {
    if (!message || !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string') {
      throw failure(400, 'Only text system, user and assistant messages are supported');
    }
    return { role: message.role, content: message.content };
  });
  const last = messages.findLast(message => message.role === 'user');
  if (!last?.content.trim()) throw failure(400, 'A non-empty user message is required');
  return { content: last.content, hash: digest(JSON.stringify(messages)) };
}

// Never open agent-owned SQLite files with the controller's privileges. The
// wrapper clears supplementary groups and drops UID/GID before native SQLite.
function callState(stateDir, binding, operation, parameters = {}) {
  const request = { stateDir, binding, operation, parameters };
  if (process.getuid?.() !== 0) {
    try { return Promise.resolve(stateOperation(request)); }
    catch (error) { return Promise.reject(error.status === 409 ? failure(409, error.message) : unavailable()); }
  }
  if (!binding) return Promise.reject(unavailable());
  const payload = JSON.stringify(request);
  if (Buffer.byteLength(payload) > 128 * 1024) return Promise.reject(unavailable());
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./desktop/boundary.mjs', import.meta.url)),
      'run', process.execPath, fileURLToPath(new URL('./operator-state.mjs', import.meta.url))],
      { cwd: '/', detached: true, env: agentEnvironment({}, { state: stateDir }), stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks = []; let size = 0, settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) {
        // Include the SQLite helper, which is a child of the privilege wrapper.
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
        reject(error);
      } else resolve(result);
    };
    const timer = setTimeout(() => finish(unavailable()), 6000);
    child.on('error', () => finish(unavailable()));
    child.stdin.on('error', () => finish(unavailable()));
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > 256 * 1024) finish(unavailable()); else chunks.push(chunk);
    });
    child.on('close', code => {
      try {
        const output = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (output.error === 409) finish(failure(409, 'Idempotency key already belongs to a different conversation'));
        else if (code !== 0 || !output.result) finish(unavailable());
        else finish(null, output.result);
      } catch { finish(unavailable()); }
    });
    child.stdin.end(payload);
  });
}

async function openRuntime(stateDir, controlDbPath, binding) {
  let control;
  try {
    const identity = await callState(stateDir, binding, 'validate');
    if (!fs.statSync(controlDbPath).isFile()) throw new Error();
    control = new DatabaseSync(controlDbPath, { readOnly: true });
    control.exec('PRAGMA busy_timeout=3000');
    control.prepare('SELECT id, from_addr, to_addr, content, created_at, reply_to FROM messages LIMIT 0').all();
    return { control, agent: identity.agent, creator: identity.creator,
      async stateOperation(operation, parameters) {
        const result = await callState(stateDir, binding, operation, parameters);
        if (result.agent !== identity.agent || result.creator !== identity.creator) throw unavailable();
        return result.value;
      }, close() { control.close(); } };
  } catch { control?.close(); throw unavailable(); }
}

function replies(runtime, id) {
  return runtime.control.prepare(`SELECT id, content, created_at AS createdAt FROM messages
    WHERE reply_to=? AND lower(from_addr)=? AND lower(to_addr)=? ORDER BY id ASC LIMIT 20`)
    .all(id, runtime.agent, runtime.creator);
}

async function status(runtime) {
  const { control, agent, creator } = runtime;
  return {
    ...await runtime.stateOperation('status'), runtime: 'unverified', model: 'unverified',
    note: 'Persisted state is not a liveness check. Model availability is unverified; queued work may wait until the runtime and model are started.',
    messages: control.prepare(`SELECT id, content, reply_to AS replyTo, created_at AS createdAt FROM messages
      WHERE lower(from_addr)=? AND lower(to_addr)=? ORDER BY id DESC LIMIT 10`).all(agent, creator),
  };
}

function completion(res, content, receipt, streaming) {
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const base = { id, created: Math.floor(Date.now() / 1000), model: MODEL };
  if (!streaming) {
    json(res, 200, { ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], ...(receipt ? { receipt } : {}) });
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
  const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  chunk({ role: 'assistant', content });
  chunk({}, 'stop');
  res.end('data: [DONE]\n\n');
}

export function createOperatorBridge({ stateDir, controlDbPath, token, bindingFile, replyWaitMs = 20_000, pollIntervalMs = 200 }) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 4096 || /\s/.test(token)) throw new Error('Invalid bridge token');
  if (!Number.isFinite(replyWaitMs) || replyWaitMs < 0 || replyWaitMs > 25_000 || !Number.isFinite(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 1000) throw new Error('Invalid reply polling limit');
  const expected = Buffer.from(digest(token), 'hex');
  let binding;
  if (bindingFile) {
    const stat = fs.lstatSync(bindingFile);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid() || stat.size > 4096) throw new Error('Invalid controller binding');
    binding = JSON.parse(fs.readFileSync(bindingFile, 'utf8'));
    if (!/^0x[\da-f]{40}$/.test(binding.agent) || !/^0x[\da-f]{40}$/.test(binding.creator) ||
        binding.dbPath !== path.resolve(stateDir, 'state.db')) throw new Error('Invalid controller binding');
  }
  const server = http.createServer(async (req, res) => {
    let runtime;
    try {
      const route = new URL(req.url, 'http://bridge.local').pathname;
      if (req.method === 'GET' && route === '/health') { json(res, 200, { service: 'operator-bridge', status: 'ok' }); return; }
      const actual = req.headers.authorization;
      if (typeof actual !== 'string' || !actual.startsWith('Bearer ') || !crypto.timingSafeEqual(expected, Buffer.from(digest(actual.slice(7)), 'hex'))) {
        req.resume(); json(res, 401, { error: { message: 'Unauthorized', type: 'authentication_error' } }); return;
      }
      if (req.method === 'GET' && route === '/v1/models') {
        runtime = await openRuntime(stateDir, controlDbPath, binding);
        json(res, 200, { object: 'list', data: [{ id: MODEL, object: 'model', created: 0, owned_by: 'automaton' }] }); return;
      }
      if (req.method === 'GET' && route === '/v1/status') {
        runtime = await openRuntime(stateDir, controlDbPath, binding); json(res, 200, await status(runtime)); return;
      }
      if (req.method !== 'POST' || route !== '/v1/chat/completions') { req.resume(); json(res, 404, { error: { message: 'Not found' } }); return; }
      const body = await readBody(req);
      const input = validateChat(body);
      const idempotencyKey = req.headers['idempotency-key'];
      if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 256)) throw failure(400, 'Invalid Idempotency-Key');
      runtime = await openRuntime(stateDir, controlDbPath, binding);
      if (input.content.trim() === '/status') { completion(res, JSON.stringify(await status(runtime), null, 2), null, body.stream); return; }
      const id = await runtime.stateOperation('submit', { content: input.content, requestHash: input.hash, idempotencyKey });
      const deadline = Date.now() + replyWaitMs;
      let confirmed;
      do {
        confirmed = replies(runtime, id);
        if (confirmed.length || Date.now() >= deadline || res.destroyed) break;
        await delay(Math.min(pollIntervalMs, deadline - Date.now()));
      } while (true);
      if (res.destroyed) return;
      const persisted = await runtime.stateOperation('receipt', { id });
      const requestStatus = persisted === 'received' ? 'queued' : persisted || 'unknown';
      const receipt = { id, status: confirmed.length ? 'replied' : requestStatus };
      const content = confirmed.length ? confirmed.map(message => message.content).join('\n\n') :
        requestStatus !== 'queued' ? `Receipt: ${id}. Persisted request status: ${requestStatus}. No correlated agent reply is available. Effects may be unknown; inspect /status and tool evidence before resubmitting. This is not an agent reply.` :
        `Queued for Automaton. Receipt: ${id}. This is a bridge acknowledgement, not an agent reply. Runtime and model availability are unverified. Use /status to inspect persisted progress and confirmed outbound messages.`;
      completion(res, content, receipt, body.stream);
    } catch (error) {
      if (!res.headersSent && !res.destroyed) json(res, error.status || 503, { error: { message: error.publicMessage || unavailable().publicMessage, type: 'operator_bridge_error' } });
    } finally { runtime?.close(); }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.umask(0o077);
    const token = readBridgeTokenFile(process.env.OPERATOR_BRIDGE_TOKEN_FILE);
    const port = Number(process.env.OPERATOR_BRIDGE_PORT || 8788);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error();
    if (process.getuid() === 0 && !process.env.OPERATOR_BINDING_FILE) throw new Error('Privileged bridge requires controller binding');
    const server = createOperatorBridge({ stateDir: process.env.AUTOMATON_DIR, controlDbPath: process.env.DB_PATH, token, bindingFile: process.env.OPERATOR_BINDING_FILE });
    server.on('error', () => { console.error('Operator bridge could not listen'); process.exitCode = 1; });
    server.listen(port, process.env.OPERATOR_BRIDGE_HOST || '127.0.0.1', () => console.log('Operator bridge listening; runtime and model liveness are not implied'));
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { server.close(); server.closeAllConnections(); });
  } catch { console.error('Operator bridge configuration unavailable: check private token file, state directory and control database settings'); process.exitCode = 78; }
}
