// Fixed state operations. The controller invokes this immutable helper as UID 1000.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { readPrivateJson } from './desktop/boundary.mjs';

export function stateOperation({ stateDir, binding, operation, parameters = {} }) {
  if (!['validate', 'submit', 'status', 'receipt'].includes(operation)) throw new Error('Invalid state operation');
  const config = readPrivateJson(path.join(stateDir, 'automaton.json'));
  if (typeof config.dbPath !== 'string' || !config.dbPath ||
      !/^0x[\da-f]{40}$/i.test(config.walletAddress) || !/^0x[\da-f]{40}$/i.test(config.creatorAddress)) throw new Error('Invalid state configuration');
  const dbPath = config.dbPath.startsWith('~/') ? path.join(os.homedir(), config.dbPath.slice(2)) : path.resolve(stateDir, config.dbPath);
  const agent = config.walletAddress.toLowerCase(), creator = config.creatorAddress.toLowerCase();
  const stat = fs.lstatSync(dbPath);
  if (!stat.isFile() || stat.isSymbolicLink() || (binding &&
      (dbPath !== binding.dbPath || agent !== binding.agent || creator !== binding.creator || fs.realpathSync(dbPath) !== binding.dbPath))) throw new Error('Invalid state binding');
  const state = new DatabaseSync(dbPath);
  try {
    state.exec('PRAGMA busy_timeout=3000');
    state.prepare('SELECT id, status, raw_content, to_address, retry_count FROM inbox_messages LIMIT 0').all();
    state.prepare('SELECT source, reason, payload FROM wake_events LIMIT 0').all();
    let value;
    if (operation === 'submit') {
      const { content, requestHash, idempotencyKey } = parameters;
      if (typeof content !== 'string' || Buffer.byteLength(content) > 65536 ||
          !/^[0-9a-f]{64}$/.test(requestHash) || (idempotencyKey !== undefined &&
          (typeof idempotencyKey !== 'string' || idempotencyKey.length > 256))) throw new Error('Invalid submission');
      const key = idempotencyKey === undefined ? `request:${crypto.randomUUID()}` : `key:${idempotencyKey}`;
      const id = `op_${crypto.createHash('sha256').update(`${agent}:${creator}:${key}`).digest('hex')}`;
      state.exec('BEGIN IMMEDIATE');
      try {
        state.exec(`CREATE TABLE IF NOT EXISTS operator_bridge_receipts (
          id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
        const existing = state.prepare('SELECT request_hash FROM operator_bridge_receipts WHERE id=?').get(id);
        if (existing && existing.request_hash !== requestHash) throw Object.assign(new Error('Idempotency key already belongs to a different conversation'), { status: 409 });
        if (!existing) {
          const envelope = `[Operator receipt: ${id}; reply_to: ${id}; recipient: ${creator}]\n${content}`;
          state.prepare(`INSERT INTO inbox_messages (id, from_address, to_address, content, raw_content, status)
            VALUES (?,?,?,?,?,'received')`).run(id, creator, agent, envelope, content);
          state.prepare('INSERT INTO wake_events(source, reason, payload) VALUES(?,?,?)')
            .run('operator', 'Operator message received', JSON.stringify({ messageId: id }));
          state.prepare('INSERT INTO operator_bridge_receipts(id,request_hash) VALUES(?,?)').run(id, requestHash);
        }
        state.exec('COMMIT'); value = id;
      } catch (error) { state.exec('ROLLBACK'); throw error; }
    } else if (operation === 'receipt') {
      if (!/^op_[0-9a-f]{64}$/.test(parameters.id)) throw new Error('Invalid receipt');
      value = state.prepare('SELECT status FROM inbox_messages WHERE id=?').get(parameters.id)?.status ?? null;
    } else if (operation === 'status') {
      const persisted = state.prepare("SELECT value FROM kv WHERE key='agent_state'").get()?.value;
      value = {
        agentState: ['setup', 'waking', 'running', 'sleeping', 'low_compute', 'critical', 'dead'].includes(persisted) ? persisted : 'unknown',
        pendingMessages: state.prepare("SELECT COUNT(*) n FROM inbox_messages WHERE status IN ('received','in_progress')").get().n,
        failedMessages: state.prepare("SELECT id, received_at AS receivedAt FROM inbox_messages WHERE status='failed' ORDER BY received_at DESC LIMIT 20").all(),
        pendingTasks: state.prepare("SELECT COUNT(*) n FROM task_graph WHERE status IN ('pending','assigned','running','blocked')").get().n,
        goals: state.prepare('SELECT id, title, status FROM goals ORDER BY created_at DESC LIMIT 20').all(),
        tasks: state.prepare('SELECT id, goal_id AS goalId, title, status FROM task_graph ORDER BY created_at DESC LIMIT 30').all(),
      };
    }
    return { agent, creator, value };
  } finally { state.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.getuid?.() === 0) throw new Error('State helper must be unprivileged');
    let size = 0; const chunks = [];
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 128 * 1024) throw new Error('State request too large');
      chunks.push(chunk);
    }
    const result = stateOperation(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const output = JSON.stringify({ result });
    if (Buffer.byteLength(output) > 256 * 1024) throw new Error('State response too large');
    process.stdout.write(output);
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error.status === 409 ? 409 : 503 }));
    process.exitCode = 1;
  }
}
