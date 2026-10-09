// Test de bout en bout : le vrai code client d'automaton (dist/) contre conway-local.
// Usage : node conway-local/test.mjs   (après npm run build à la racine)
import { spawn, spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";

const here = path.dirname(new URL(import.meta.url).pathname);
const dist = path.join(here, "..", "dist");
const server = path.join(here, "server.mjs");

if (!process.env.CL_TEST_CHILD) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conway-local-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1",
    "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", `${tmp}/key.pem`, "-out", `${tmp}/cert.pem`], { stdio: "ignore" });

  // Faux llama.cpp : répond à toute complétion.
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }));
  }).listen(0, "127.0.0.1");
  await new Promise((r) => upstream.once("listening", r));

  const env = { ...process.env, PORT: "0", DB_PATH: `${tmp}/db.sqlite`, TLS_CERT: `${tmp}/cert.pem`,
    TLS_KEY: `${tmp}/key.pem`, UPSTREAM_URL: `http://127.0.0.1:${upstream.address().port}` };
  const srv = spawn(process.execPath, [server, "serve"], { env, stdio: ["ignore", "pipe", "inherit"] });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("gateway startup timeout")), 5000);
    srv.once("exit", () => { clearTimeout(timer); reject(new Error("gateway exited")); });
    srv.stdout.once("data", data => { clearTimeout(timer); resolve(String(data).match(/https:\/\/127\.0\.0\.1:\d+/)[0]); });
  });

  // Asynchrone : le faux llama.cpp vit dans ce processus et doit continuer à répondre.
  const child = spawn(process.execPath, [new URL(import.meta.url).pathname], { stdio: "inherit",
    env: { ...env, CL_TEST_CHILD: "1", CL_TEST_URL: ready, AUTOMATON_DIR: `${tmp}/agent`, NODE_EXTRA_CA_CERTS: `${tmp}/cert.pem` } });
  const status = await new Promise((r) => child.on("exit", r));
  srv.kill();
  await new Promise(resolve => srv.once("exit", resolve));
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(status ?? 1);
}

// ─── Processus enfant : état isolé, certificat de test approuvé ───
const url = process.env.CL_TEST_URL;
const cli = (...a) => spawnSync(process.execPath, [server, ...a], { env: process.env, encoding: "utf8" }).stdout;
const { provision, registerParent } = await import(`${dist}/identity/provision.js`);
const { createConwayClient } = await import(`${dist}/conway/client.js`);
const { createInferenceClient } = await import(`${dist}/conway/inference.js`);
const { createSocialClient } = await import(`${dist}/social/client.js`);
const { getWallet } = await import(`${dist}/identity/wallet.js`);

const creator = "0x1111111111111111111111111111111111111111";
const child = "0x2222222222222222222222222222222222222222";

const { apiKey, walletAddress } = await provision(url);
assert.match(apiKey, /^cnwy_k_/);
console.log("ok  provisionnement SIWE (étape 2)");

await registerParent(creator, url);
const conway = createConwayClient({ apiUrl: url, apiKey, sandboxId: "" });
assert.equal(await conway.getCreditsBalance(), 0);
assert.match(cli("fund", "1.00"), /solde \$1\.00/);
assert.equal(await conway.getCreditsBalance(), 100);
console.log("ok  solde + recharge par le poste de contrôle");

const inference = createInferenceClient({ apiUrl: url, apiKey, defaultModel: "local", maxTokens: 64 });
const reply = await inference.chat([{ role: "user", content: "ping" }]);
assert.equal(reply.message?.content ?? reply.content, "pong");
console.log("ok  inférence relayée vers le modèle");

const t = await conway.transferCredits(child, 10, "test");
assert.equal(t.balanceAfterCents, 90);
await assert.rejects(conway.transferCredits(child, 10_000), /402/);
console.log("ok  transfert vers un enfant, refus au-delà du solde");

const { account } = await getWallet();
const social = createSocialClient(url, account);
await social.send(creator, "besoin d'aide : carte refusée");
assert.match(cli("inbox"), /carte refusée/);
cli("say", "essaie une autre approche");
assert.equal(await social.unreadCount(), 1);
const { messages } = await social.poll();
assert.equal(messages[0].content, "essaie une autre approche");
console.log("ok  messagerie agent ↔ créateur");

assert.match(cli("status"), new RegExp(walletAddress.toLowerCase()));
cli("kill");
assert.equal(await conway.getCreditsBalance(), 0);
await assert.rejects(inference.chat([{ role: "user", content: "ping" }]), /402/);
console.log("ok  mort à zéro : inférence coupée");

const bad = await fetch(`${url}/v1/credits/balance`, { headers: { Authorization: "cnwy_k_faux" } });
assert.equal(bad.status, 401);
console.log("ok  clé invalide refusée");
console.log("\nTous les tests passent.");
