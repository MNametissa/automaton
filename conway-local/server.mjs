#!/usr/bin/env node
// conway-local : remplaçant local de api.conway.tech pour automaton.
// Usage : node server.mjs [serve|status|fund <usd>|rate <cents/h>|inbox|say <texte>|kill]
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { verifyMessage, keccak256, toBytes } from "viem";
import { SiweMessage } from "siwe";
import { loadInference } from "./inference.mjs";
import { createOperatorContact } from "./operator-contact.mjs";

const env = process.env;
const PORT = Number(env.PORT || 8787);
const HOST = env.HOST || "127.0.0.1";
const DB_PATH = env.DB_PATH || new URL("./conway-local.db", import.meta.url).pathname;
const MAX_BODY = 1024 * 1024;
const initialInference = loadInference(env);
if (!["127.0.0.1", "localhost", "::1"].includes(HOST) && (!env.ROOT_ADDRESS || !env.TLS_CERT)) {
  throw new Error("Non-loopback listening requires ROOT_ADDRESS and TLS_CERT/TLS_KEY");
}
process.umask(0o077);

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
db.exec(`
  CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
  CREATE TABLE IF NOT EXISTS accounts (address TEXT PRIMARY KEY, funded REAL NOT NULL DEFAULT 0, spent REAL NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS api_keys (hash TEXT PRIMARY KEY, address TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS tokens (token TEXT PRIMARY KEY, address TEXT NOT NULL, expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS automatons (address TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS transfers (sender TEXT, request_key TEXT, payload TEXT, result TEXT, PRIMARY KEY(sender, request_key));
  CREATE TABLE IF NOT EXISTS message_receipts (digest TEXT PRIMARY KEY, message_id TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, from_addr TEXT, to_addr TEXT, content TEXT,
    signed_at TEXT, created_at TEXT, reply_to TEXT, read INTEGER NOT NULL DEFAULT 0);
`);

let operatorContact;

const getMeta = (k, d = null) => db.prepare("SELECT v FROM meta WHERE k=?").get(k)?.v ?? d;
const setMeta = (k, v) => db.prepare("INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, String(v));
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const rand = (n) => crypto.randomBytes(n).toString("hex");
const lower = (a) => String(a || "").toLowerCase();
const addressOk = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const fresh = (ts) => typeof ts === "string" && Number.isFinite(Date.parse(ts)) && Math.abs(Date.now() - Date.parse(ts)) <= 5 * 60_000;
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
function transaction(fn) {
  db.exec("BEGIN IMMEDIATE");
  try { const result = fn(); db.exec("COMMIT"); return result; }
  catch (e) { db.exec("ROLLBACK"); throw e; }
}
if (env.ROOT_ADDRESS) {
  if (!addressOk(env.ROOT_ADDRESS)) throw new Error("Invalid ROOT_ADDRESS");
  if (getMeta("root") && getMeta("root") !== lower(env.ROOT_ADDRESS)) throw new Error("ROOT_ADDRESS conflicts with existing database");
  setMeta("root", lower(env.ROOT_ADDRESS));
}

const ensureAccount = (addr) => db.prepare("INSERT OR IGNORE INTO accounts(address) VALUES(?)").run(lower(addr));
const account = (addr) => db.prepare("SELECT funded, spent FROM accounts WHERE address=?").get(lower(addr));
const balanceCents = (addr) => { const a = account(addr); return a ? Math.floor(a.funded - a.spent) : 0; };
const rate = () => Number(getMeta("rate_cents_per_hour", env.RATE_CENTS_PER_HOUR || 0));
function burnFor(addr) {
  const a = account(addr);
  const total = db.prepare("SELECT COALESCE(SUM(MAX(0, funded-spent)), 0) AS total FROM accounts").get().total;
  return total > 0 && a ? rate() * Math.max(0, a.funded - a.spent) / total : 0;
}

// Simulated infrastructure burn is shared across positive allocations. Moving an
// allocation to another wallet must not let it escape the configured hourly rate.
function tick() {
  transaction(() => {
    const now = Date.now();
    const last = Number(getMeta("last_tick", now));
    setMeta("last_tick", now);
    const total = db.prepare("SELECT COALESCE(SUM(MAX(0, funded-spent)), 0) AS total FROM accounts").get().total;
    if (total <= 0) return;
    const cost = Math.min(total, (rate() * Math.max(0, now - last)) / 3_600_000);
    if (cost > 0) db.prepare("UPDATE accounts SET spent = MIN(funded, spent + ? * (funded-spent) / ?) WHERE funded > spent").run(cost, total);
  });
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(c);
  }
  if (!size) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  }
  catch { throw Object.assign(new Error("invalid json"), { status: 400 }); }
}

function apiKeyAddress(req) {
  const raw = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  return raw ? db.prepare("SELECT address FROM api_keys WHERE hash=?").get(sha(raw))?.address ?? null : null;
}

async function walletHeadersAddress(req, action) {
  const addr = lower(req.headers["x-wallet-address"]);
  const sig = req.headers["x-signature"];
  const ts = req.headers["x-timestamp"];
  if (!addressOk(addr) || !sig || !fresh(ts)) return null;
  const ok = await verifyMessage({ address: addr, message: `Conway:${action}:${addr}:${ts}`, signature: sig }).catch(() => false);
  return ok ? addr : null;
}

const routes = {
  "POST /v1/auth/nonce": async () => {
    const nonce = rand(16);
    db.prepare("INSERT INTO nonces VALUES(?,?)").run(nonce, Date.now() + 10 * 60_000);
    return [200, { nonce }];
  },

  "POST /v1/auth/verify": async (req) => {
    const { message, signature, chain_type } = await readJson(req);
    if (chain_type === "solana") return [400, { error: "solana non pris en charge" }];
    if (typeof message !== "string" || typeof signature !== "string") return [400, { error: "message/signature requis" }];
    let parsed;
    try { parsed = new SiweMessage(message); } catch { return [400, { error: "message SIWE invalide" }]; }
    const { address, nonce } = parsed;
    if (!addressOk(address) || !fresh(parsed.issuedAt) || parsed.domain !== (env.SIWE_DOMAIN || "conway.tech") || parsed.chainId !== 8453) return [401, { error: "invalid SIWE scope" }];
    let uri;
    try { uri = new URL(parsed.uri); } catch { return [401, { error: "invalid SIWE URI" }]; }
    if (uri.pathname !== "/v1/auth/verify" || (env.PUBLIC_URL && uri.origin !== new URL(env.PUBLIC_URL).origin)) return [401, { error: "invalid SIWE URI" }];
    if (parsed.expirationTime && (!Number.isFinite(Date.parse(parsed.expirationTime)) || Date.parse(parsed.expirationTime) <= Date.now())) return [401, { error: "expired SIWE message" }];
    if (parsed.notBefore && (!Number.isFinite(Date.parse(parsed.notBefore)) || Date.parse(parsed.notBefore) > Date.now())) return [401, { error: "SIWE message not active" }];
    if (!(await verifyMessage({ address, message, signature }).catch(() => false))) return [401, { error: "invalid signature" }];
    const row = db.prepare("DELETE FROM nonces WHERE nonce=? AND expires>=? RETURNING expires").get(nonce, Date.now());
    if (!row) return [401, { error: "Invalid or expired nonce" }];
    const token = rand(24);
    db.prepare("INSERT INTO tokens VALUES(?,?,?)").run(token, lower(address), Date.now() + 10 * 60_000);
    return [200, { access_token: token }];
  },

  "POST /v1/auth/api-keys": async (req) => {
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const row = db.prepare("SELECT address, expires FROM tokens WHERE token=?").get(token);
    if (!row || row.expires < Date.now()) return [401, { error: "invalid token" }];
    db.prepare("DELETE FROM tokens WHERE token=?").run(token);
    const key = `cnwy_k_${rand(24)}`;
    db.prepare("INSERT INTO api_keys VALUES(?,?)").run(sha(key), row.address);
    ensureAccount(row.address);
    if (!getMeta("root")) setMeta("root", row.address);
    return [200, { key, key_prefix: key.slice(0, 12) }];
  },

  "GET /v1/credits/balance": async (_req, addr) => {
    const balance = balanceCents(addr);
    const burn = burnFor(addr);
    return [200, { balance_cents: balance, burn_cents_per_hour: burn, runway_hours: burn ? balance / burn : null, accounting_mode: "simulation", provider_balance_cents: null, external_spend_limit_cents: loadInference(env).status().effective_external_spend_limit_microusd === 0 ? 0 : null, paused: getMeta("paused") === "1" }];
  },

  "GET /v1/credits/pricing": async () => [200, { tiers: [] }],

  "POST /v1/credits/transfer": async (req, from) => {
    const { to_address, amount_cents } = await readJson(req);
    const amount = Number(amount_cents);
    if (!/^0x[0-9a-fA-F]{40}$/.test(to_address || "") || !Number.isSafeInteger(amount) || amount <= 0) {
      return [400, { error: "to_address/amount_cents invalides" }];
    }
    const requestKey = req.headers["idempotency-key"];
    if (requestKey && (typeof requestKey !== "string" || requestKey.length > 200)) return [400, { error: "invalid idempotency key" }];
    const payload = JSON.stringify({ to: lower(to_address), amount });
    return transaction(() => {
      if (requestKey) {
        const previous = db.prepare("SELECT payload, result FROM transfers WHERE sender=? AND request_key=?").get(from, requestKey);
        if (previous) return previous.payload === payload ? [200, JSON.parse(previous.result)] : [409, { error: "idempotency key reused with different transfer" }];
      }
      if (balanceCents(from) < amount) return [402, { error: "insufficient credits" }];
      ensureAccount(to_address);
      db.prepare("UPDATE accounts SET spent = spent + ? WHERE address=?").run(amount, from);
      db.prepare("UPDATE accounts SET funded = funded + ? WHERE address=?").run(amount, lower(to_address));
      const result = { transfer_id: rand(8), status: "completed", to_address, amount_cents: amount, balance_after_cents: balanceCents(from) };
      if (requestKey) db.prepare("INSERT INTO transfers VALUES(?,?,?,?)").run(from, requestKey, payload, JSON.stringify(result));
      return [200, result];
    });
  },

  "GET /v1/models": async () => [200, { data: [loadInference(env).catalog()] }],

  "GET /v1/inference/status": async () => [200, { ...loadInference(env).status(), paused: getMeta("paused") === "1" }],

  "POST /v1/operator/contact": async (req, addr) => [200, await operatorContact.request(addr, await readJson(req))],
  "GET /v1/operator/contact": async (_req, addr) => [200, operatorContact.status(addr)],

  // Mort réelle : sans crédit, plus d'inférence, quoi que l'agent modifie chez lui.
  "POST /v1/chat/completions": async (req, addr) => {
    if (balanceCents(addr) <= 0) return [402, { error: "insufficient local allocation" }];
    if (getMeta("paused") === "1") return [503, { error: "inference paused by operator" }];
    const body = await readJson(req);
    if (body.stream || !Array.isArray(body.messages) || !body.messages.length) return [400, { error: "non-streaming messages required" }];
    return loadInference(env).complete(body);
  },

  "GET /v1/sandboxes": async () => [200, { sandboxes: [] }],

  "POST /v1/automatons/register": async (req, addr) => {
    const body = await readJson(req);
    db.prepare("INSERT OR REPLACE INTO automatons VALUES(?,?)").run(addr, JSON.stringify(body));
    return [200, { automaton: { ...body, address: addr } }];
  },

  "POST /v1/automaton/register-parent": async (req, addr) => {
    if (addr !== getMeta("root")) return [403, { error: "root account required" }];
    const body = await readJson(req);
    const creator = body.creator_address || body.creatorAddress || body.parent_address;
    if (!addressOk(creator)) return [400, { error: "invalid creator address" }];
    if (getMeta("creator") && getMeta("creator") !== lower(creator)) return [409, { error: "creator already registered" }];
    setMeta("creator", lower(creator));
    return [200, { ok: true }];
  },

  "POST /v1/messages": async (req) => {
    const { from, to, content, signed_at, signature, reply_to } = await readJson(req);
    if (typeof content !== "string" || content.length > 100_000 || !addressOk(from) || !addressOk(to) || !fresh(signed_at) || !signature) return [400, { error: "champs manquants" }];
    const canonical = `Conway:send:${lower(to)}:${keccak256(toBytes(content))}:${signed_at}`;
    if (!(await verifyMessage({ address: lower(from), message: canonical, signature }).catch(() => false))) {
      return [401, { error: "invalid signature" }];
    }
    const digest = sha(`${lower(from)}:${canonical}`);
    const receipt = db.prepare("SELECT message_id FROM message_receipts WHERE digest=?").get(digest);
    if (receipt) return [200, { id: receipt.message_id }];
    const r = db.prepare("INSERT INTO messages(from_addr,to_addr,content,signed_at,created_at,reply_to) VALUES(?,?,?,?,?,?)")
      .run(lower(from), lower(to), content, signed_at, new Date().toISOString(), reply_to ?? null);
    db.prepare("INSERT INTO message_receipts VALUES(?,?)").run(digest, String(r.lastInsertRowid));
    return [200, { id: String(r.lastInsertRowid) }];
  },

  "POST /v1/messages/poll": async (req) => {
    const addr = await walletHeadersAddress(req, "poll");
    if (!addr) return [401, { error: "invalid wallet signature" }];
    const { cursor, limit } = await readJson(req);
    if (!Number.isSafeInteger(Number(cursor ?? 0)) || Number(cursor ?? 0) < 0 || !Number.isInteger(Number(limit ?? 50)) || Number(limit ?? 50) < 1 || Number(limit ?? 50) > 200) return [400, { error: "invalid cursor or limit" }];
    const rows = db.prepare("SELECT * FROM messages WHERE to_addr=? AND id>? ORDER BY id LIMIT ?")
      .all(addr, Number(cursor || 0), Math.min(Number(limit || 50), 200));
    for (const m of rows) db.prepare("UPDATE messages SET read=1 WHERE id=?").run(m.id);
    const messages = rows.map((m) => ({
      id: String(m.id), from: m.from_addr, to: m.to_addr, content: m.content,
      signedAt: m.signed_at, createdAt: m.created_at, replyTo: m.reply_to ?? undefined,
    }));
    return [200, { messages, next_cursor: rows.length ? String(rows.at(-1).id) : cursor }];
  },

  "GET /v1/messages/count": async (req) => {
    const addr = await walletHeadersAddress(req, "poll");
    if (!addr) return [401, { error: "invalid wallet signature" }];
    return [200, { unread: db.prepare("SELECT COUNT(*) n FROM messages WHERE to_addr=? AND read=0").get(addr).n }];
  },
};
routes["POST /v1/credits/transfers"] = routes["POST /v1/credits/transfer"];

const PUBLIC = new Set(["POST /v1/auth/nonce", "POST /v1/auth/verify", "POST /v1/auth/api-keys",
  "POST /v1/messages", "POST /v1/messages/poll", "GET /v1/messages/count", "GET /v1/models"]);

export function createServer() {
  // Recover contact attempts only when the long-running controller starts, not
  // when a concurrent CLI status/fund command opens the same database.
  operatorContact ??= createOperatorContact({ db, configPath: env.OPERATOR_CONTACT_CONFIG || "/control/operator-contact.json" });
  const tls = env.TLS_CERT ? { cert: fs.readFileSync(env.TLS_CERT), key: fs.readFileSync(env.TLS_KEY) } : null;
  const handle = async (req, res) => {
    const started = Date.now();
    try {
      tick();
      const path = req.url.split("?")[0];
      const route = `${req.method} ${path}`;
      const handler = routes[route];
      if (!handler) {
        if (path.startsWith("/v1/sandboxes/") || path.startsWith("/v1/domains") || route === "POST /v1/sandboxes") {
          return send(res, 501, { error: "non disponible dans conway-local (sandboxes : phase 2, domaines : non pris en charge)" });
        }
        return send(res, 404, { error: "not found" });
      }
      let addr = null;
      if (!PUBLIC.has(route)) {
        addr = apiKeyAddress(req);
        if (!addr) return send(res, 401, { error: "invalid api key" });
      }
      const [status, body] = await handler(req, addr);
      send(res, status, body);
    } catch (e) {
      send(res, e.status || 500, { error: e.status ? e.message : "internal error" });
      if (!e.status) console.error(JSON.stringify({ level: "error", event: "request_failed", name: e.name }));
    } finally {
      if (env.LOG_LEVEL === "debug") console.error(JSON.stringify({ event: "request", method: req.method, path: req.url.split("?")[0], status: res.statusCode, duration_ms: Date.now() - started }));
    }
  };
  return tls ? https.createServer(tls, handle) : http.createServer(handle);
}

// ─── Poste de contrôle (CLI créateur, accès direct à la base) ───
const usd = (c) => `$${(c / 100).toFixed(2)}`;
const commands = {
  serve() {
    const server = createServer();
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
    server.listen(PORT, HOST, () => console.log(`conway-local sur ${env.TLS_CERT ? "https" : "http"}://${HOST}:${server.address().port} (inference ${initialInference.status().mode}: ${initialInference.status().state})`));
    const timer = setInterval(tick, 60_000);
    const stop = () => {
      clearInterval(timer);
      server.closeAllConnections();
      server.close(() => { db.close(); });
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  },
  status() {
    tick();
    const root = getMeta("root");
    if (!root) return console.log("Aucun automaton provisionné.");
    const a = account(root);
    const bal = balanceCents(root);
    console.log("Comptabilité simulée : allocation locale, aucun fonds fournisseur vérifié.");
    console.log(`inférence  ${JSON.stringify(loadInference(env).status())}`);
    console.log(`racine     ${root}\nfinancé    ${usd(a.funded)}\ndépensé    ${usd(a.spent)}\nsolde      ${usd(bal)}`);
    const burn = burnFor(root);
    console.log(`coût       ${usd(burn)}/h (part racine ; total ${usd(rate())}/h) → autonomie ${burn ? (bal / burn).toFixed(1) + " h" : "non calculée (part 0)"}`);
    console.log(`créateur   ${getMeta("creator", "(non enregistré)")}`);
    const unread = db.prepare("SELECT COUNT(*) n FROM messages WHERE to_addr=? AND read=0").get(getMeta("creator", "")).n;
    console.log(`messages   ${unread} non lu(s) pour vous`);
  },
  fund(amount) {
    const root = getMeta("root");
    const cents = Math.round(Number(amount) * 100);
    if (!root || !Number.isSafeInteger(cents) || cents <= 0 || !/^\d+(\.\d{1,2})?$/.test(amount || "")) throw failure("Usage : fund <usd> (allocation locale, après provisionnement)");
    tick();
    db.prepare("UPDATE accounts SET funded = funded + ? WHERE address=?").run(cents, root);
    console.log(`+${usd(cents)} → solde ${usd(balanceCents(root))}`);
  },
  rate(cents) {
    if (!Number.isSafeInteger(Number(cents)) || Number(cents) < 0) throw failure("Usage : rate <cents par heure> (entier positif ou zéro)");
    tick();
    setMeta("rate_cents_per_hour", Number(cents));
    console.log(`coût réglé à ${usd(Number(cents))}/h`);
  },
  inbox() {
    const creator = getMeta("creator");
    if (!creator) return console.log("Créateur non enregistré.");
    const rows = db.prepare("SELECT * FROM messages WHERE to_addr=? ORDER BY id DESC LIMIT 20").all(creator);
    for (const m of rows.reverse()) console.log(`#${m.id} ${m.created_at} ${m.read ? " " : "*"} ${m.from_addr}\n  ${m.content}\n`);
    db.prepare("UPDATE messages SET read=1 WHERE to_addr=?").run(creator);
  },
  say(...words) {
    const root = getMeta("root");
    const text = words.join(" ").trim();
    if (!root || !text) return console.log("Usage : say <message pour l'agent>");
    db.prepare("INSERT INTO messages(from_addr,to_addr,content,signed_at,created_at) VALUES(?,?,?,?,?)")
      .run(getMeta("creator", "creator"), root, text, new Date().toISOString(), new Date().toISOString());
    console.log("Message déposé dans la boîte de l'agent.");
  },
  pause() { setMeta("paused", "1"); console.log("Inférence suspendue pour tous les comptes. Les machines ne sont pas arrêtées."); },
  resume() { setMeta("paused", "0"); console.log("Inférence reprise, sous réserve du solde local."); },
  kill() {
    setMeta("paused", "1");
    const root = getMeta("root");
    if (!root) return console.log("Aucun automaton.");
    tick();
    db.prepare("UPDATE accounts SET spent = funded WHERE address=?").run(root);
    console.log("Solde racine à zéro et inférence suspendue pour tous les comptes. Les machines ne sont pas arrêtées.");
  },
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd = "serve", ...args] = process.argv.slice(2);
  try {
    if (!commands[cmd]) throw failure(`Commandes : ${Object.keys(commands).join(", ")}`);
    commands[cmd](...args);
  } catch (e) { console.error(e.message); process.exitCode = 1; }
  finally { if (cmd !== "serve") db.close(); }
}
