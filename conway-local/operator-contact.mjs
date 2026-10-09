// Controller-owned email channel. Recipient and credentials never come from agent arguments.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';

const fail = (status, message) => Object.assign(new Error(message), { status });
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const email = value => typeof value === 'string' && value.length <= 254 && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(value);
function privateFile(filename, maxBytes) {
  let fd;
  try {
    if (!path.isAbsolute(filename)) throw new Error();
    fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid() || stat.size > maxBytes) throw new Error();
    return fs.readFileSync(fd, 'utf8');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function contactConfig(filename) {
  const fallback = { recipient: null, cooldownSeconds: 3600, transportReady: false, reason: 'smtp_not_configured' };
  try {
    const config = JSON.parse(privateFile(filename, 16384));
    if (!config || typeof config !== 'object' || Array.isArray(config) || !email(config.recipient) ||
        Object.keys(config).some(key => !['recipient', 'cooldownSeconds', 'smtp'].includes(key))) throw new Error();
    const cooldownSeconds = config.cooldownSeconds ?? 3600;
    if (!Number.isInteger(cooldownSeconds) || cooldownSeconds < 60 || cooldownSeconds > 604800) throw new Error();
    const base = { ...fallback, recipient: config.recipient, cooldownSeconds };
    if (config.smtp == null) return base;
    const smtp = config.smtp;
    if (!smtp || typeof smtp !== 'object' || Array.isArray(smtp) ||
        Object.keys(smtp).some(key => !['host', 'port', 'secure', 'from', 'user', 'passwordFile', 'allowInsecureLoopback'].includes(key)) ||
        typeof smtp.host !== 'string' || !/^[a-zA-Z0-9.-]{1,253}$/.test(smtp.host) ||
        !Number.isInteger(smtp.port) || smtp.port < 1 || smtp.port > 65535 ||
        typeof smtp.secure !== 'boolean' || !email(smtp.from)) throw new Error();
    const loopback = smtp.allowInsecureLoopback === true && smtp.host === '127.0.0.1';
    if (smtp.allowInsecureLoopback !== undefined && (typeof smtp.allowInsecureLoopback !== 'boolean' || (smtp.allowInsecureLoopback && !loopback))) throw new Error();
    if (loopback && (smtp.user !== undefined || smtp.passwordFile !== undefined)) throw new Error();
    let auth;
    if (smtp.user !== undefined || smtp.passwordFile !== undefined) {
      if (typeof smtp.user !== 'string' || !smtp.user || smtp.user.length > 256 || /[\r\n\0]/.test(smtp.user) || typeof smtp.passwordFile !== 'string') throw new Error();
      const pass = privateFile(smtp.passwordFile, 4096).trim();
      if (!pass || /[\r\n\0]/.test(pass)) throw new Error();
      auth = { user: smtp.user, pass };
    }
    return { ...base, reason: null, transportReady: true, from: smtp.from, transport: {
      host: smtp.host, port: smtp.port, secure: smtp.secure, auth,
      requireTLS: !smtp.secure && !loopback, ignoreTLS: loopback,
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
      connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 10000, dnsTimeout: 5000,
      disableFileAccess: true, disableUrlAccess: true, maxRecipients: 1,
      logger: false, debug: false,
    } };
  } catch (error) { return { ...fallback, reason: error.code === 'ENOENT' ? 'smtp_not_configured' : 'invalid_contact_config' }; }
}
function validate(sender, input) {
  if (typeof sender !== 'string' || !/^0x[\da-f]{40}$/i.test(sender)) throw fail(400, 'Invalid sender');
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['subject', 'message', 'purpose', 'idempotencyKey'].includes(key))) throw fail(400, 'Unexpected contact argument');
  const { subject, message, purpose = 'general', idempotencyKey } = input;
  if (typeof subject !== 'string' || !subject.trim() || subject.length > 160 || /[\r\n\0]/.test(subject) ||
      typeof message !== 'string' || !message.trim() || Buffer.byteLength(message) > 16384 || message.includes('\0') ||
      typeof purpose !== 'string' || !/^[a-z][a-z0-9_-]{0,47}$/.test(purpose) ||
      (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || !/^[a-zA-Z0-9:_-]{1,128}$/.test(idempotencyKey)))) throw fail(400, 'Invalid contact subject, message, purpose or idempotency key');
  return { sender: sender.toLowerCase(), payload: { subject: subject.trim(), message: message.trim(), purpose }, idempotencyKey };
}
function receipt(row) {
  return {
    id: row.id, status: row.status, reason: row.reason, recipient: row.recipient,
    createdAt: new Date(row.created_ms).toISOString(), updatedAt: new Date(row.updated_ms).toISOString(),
    deliveryConfirmed: false,
    note: row.status === 'smtp_accepted' ? 'SMTP server accepted this email; inbox delivery is not confirmed.' :
      row.status === 'uncertain' ? 'Email outcome is unknown. Reconcile this receipt against delivery evidence before deciding whether another attempt is needed.' :
      row.status === 'queued' ? 'Request persisted in the controller outbox. No email has been sent.' :
      row.status === 'delivering' ? 'SMTP attempt is in progress; delivery is not confirmed.' : 'SMTP did not accept this email.',
  };
}

export function createOperatorContact({ db, configPath = '/control/operator-contact.json', clock = Date.now, createTransport = options => nodemailer.createTransport(options) }) {
  db.exec(`CREATE TABLE IF NOT EXISTS operator_contact_outbox (
    id TEXT PRIMARY KEY, sender TEXT NOT NULL, request_key TEXT NOT NULL, payload TEXT NOT NULL,
    recipient TEXT, status TEXT NOT NULL, reason TEXT, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL, attempted_ms INTEGER,
    UNIQUE(sender,request_key));
    CREATE INDEX IF NOT EXISTS operator_contact_created ON operator_contact_outbox(created_ms);`);
  if (!db.prepare('PRAGMA table_info(operator_contact_outbox)').all().some(column => column.name === 'attempted_ms')) db.exec('ALTER TABLE operator_contact_outbox ADD COLUMN attempted_ms INTEGER');
  // Initialization runs once per controller startup. Acceptance before a crash is unknowable.
  db.prepare("UPDATE operator_contact_outbox SET status='uncertain', reason='delivery_interrupted', updated_ms=? WHERE status='delivering'").run(clock());
  const rowById = id => db.prepare('SELECT * FROM operator_contact_outbox WHERE id=?').get(id);
  function cooldown(config, exceptId) {
    const latest = db.prepare('SELECT id, MAX(created_ms,COALESCE(attempted_ms,0)) event_ms FROM operator_contact_outbox WHERE id<>? ORDER BY event_ms DESC LIMIT 1').get(exceptId ?? '');
    const remaining = latest ? latest.event_ms + config.cooldownSeconds * 1000 - clock() : 0;
    return remaining > 0 ? { status: 'cooldown', existingRequestId: latest.id, retryAfterSeconds: Math.ceil(remaining / 1000), deliveryConfirmed: false, note: 'Contact rate limit reached. This request was not queued or sent.' } : null;
  }
  const update = (id, status, reason, recipient) => db.prepare('UPDATE operator_contact_outbox SET status=?, reason=?, recipient=COALESCE(?,recipient), updated_ms=? WHERE id=?').run(status, reason, recipient ?? null, clock(), id);
  async function dispatch(row, config) {
    if (row.status !== 'queued') return receipt(row);
    if (!config.transportReady) { update(row.id, 'queued', config.reason, config.recipient); return receipt(rowById(row.id)); }
    const limited = cooldown(config, row.id);
    if (limited) return { ...limited, note: 'Contact rate limit reached. This existing request remains queued without sending.', queuedRequestId: row.id };
    const claimed = db.prepare("UPDATE operator_contact_outbox SET status='delivering', reason=NULL, recipient=?, attempted_ms=?, updated_ms=? WHERE id=? AND status='queued'").run(config.recipient, clock(), clock(), row.id);
    if (!claimed.changes) return receipt(rowById(row.id));
    const payload = JSON.parse(row.payload);
    let transport, timer;
    try {
      transport = createTransport(config.transport);
      const result = await Promise.race([
        transport.sendMail({ from: config.from, to: config.recipient,
          envelope: { from: config.from, to: [config.recipient] },
          subject: payload.subject, text: `${payload.message}\n\nAgent: ${row.sender}\nPurpose: ${payload.purpose}\nReceipt: ${row.id}`,
          messageId: `<${row.id}@automaton.local>`, disableFileAccess: true, disableUrlAccess: true }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('delivery deadline')), 15000); }),
      ]);
      const accepted = result?.accepted?.some(value => typeof value === 'string' && value.toLowerCase() === config.recipient.toLowerCase());
      update(row.id, accepted ? 'smtp_accepted' : 'failed', accepted ? null : 'smtp_recipient_rejected', config.recipient);
    } catch (error) {
      // Only errors proved to precede message submission are safe to call failed.
      const knownFailure = ['EAUTH', 'EENVELOPE', 'EDNS'].includes(error.code) || ['CONN', 'EHLO', 'HELO', 'STARTTLS', 'AUTH', 'MAIL FROM', 'RCPT TO'].includes(error.command);
      update(row.id, knownFailure ? 'failed' : 'uncertain', knownFailure ? 'smtp_not_accepted' : 'smtp_outcome_unknown', config.recipient);
    } finally { clearTimeout(timer); try { transport?.close(); } catch { /* Preserve the recorded outcome. */ } }
    return receipt(rowById(row.id));
  }
  return {
    async request(sender, input) {
      const valid = validate(sender, input), config = contactConfig(configPath), now = clock();
      const payload = JSON.stringify(valid.payload), key = valid.idempotencyKey ? `key:${valid.idempotencyKey}` : `content:${digest(payload)}`;
      let row;
      db.exec('BEGIN IMMEDIATE');
      try {
        row = db.prepare('SELECT * FROM operator_contact_outbox WHERE sender=? AND request_key=?').get(valid.sender, key);
        if (row && row.payload !== payload) throw fail(409, 'Idempotency key belongs to different contact content');
        if (!row) {
          const limited = cooldown(config);
          if (limited) {
            db.exec('COMMIT');
            return limited;
          }
          const id = `oc_${crypto.randomUUID()}`;
          db.prepare("INSERT INTO operator_contact_outbox(id,sender,request_key,payload,recipient,status,reason,created_ms,updated_ms) VALUES(?,?,?,?,?,'queued',?,?,?)")
            .run(id, valid.sender, key, payload, config.recipient, config.reason, now, now);
          row = rowById(id);
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return dispatch(row, config);
    },
    status(sender) {
      if (typeof sender !== 'string' || !/^0x[\da-f]{40}$/i.test(sender)) throw fail(400, 'Invalid sender');
      const config = contactConfig(configPath);
      return { transportReady: config.transportReady, reason: config.reason, recipient: config.recipient,
        cooldownSeconds: config.cooldownSeconds, deliveryConfirmed: false,
        requests: db.prepare('SELECT * FROM operator_contact_outbox WHERE sender=? ORDER BY created_ms DESC LIMIT 20').all(sender.toLowerCase()).map(receipt) };
    },
  };
}
