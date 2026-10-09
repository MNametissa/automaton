#!/usr/bin/env node
// Generate local-only credentials once. Never print or overwrite them.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const target = path.join(root, '.standalone/desktop');
process.umask(0o077);
fs.mkdirSync(target, { recursive: true, mode: 0o700 });
const envPath = path.join(target, '.env');
if (fs.existsSync(envPath)) {
  console.log('Existing local deployment credentials preserved.');
} else {
  const token = randomBytes(32).toString('hex');
  const desktop = randomBytes(6).toString('base64url');
  fs.writeFileSync(path.join(target, 'bridge-token'), token, { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(path.join(target, 'desktop-password'), desktop, { mode: 0o600, flag: 'wx' });
  const vars = { ALIVE_BRIDGE_TOKEN: token, CREDS_KEY: randomBytes(32).toString('hex'),
    CREDS_IV: randomBytes(16).toString('hex'), JWT_SECRET: randomBytes(32).toString('hex'),
    JWT_REFRESH_SECRET: randomBytes(32).toString('hex') };
  fs.writeFileSync(envPath, Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
  console.log('Local credentials generated under .standalone/desktop (mode 0600). No services started.');
}
