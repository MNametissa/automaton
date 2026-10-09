#!/usr/bin/env node
// Provision a local USER account via LibreChat's native registration service.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const file = path.resolve(directory, '../../.standalone/desktop/login.json');
process.umask(0o077);
if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({
  email: 'mnametissa@localhost.test', name: 'MNametissa', username: 'mnametissa',
  password: randomBytes(24).toString('base64url'),
}, null, 2), { flag: 'wx', mode: 0o600 });
const payload = fs.readFileSync(file, 'utf8');
const script = `
require('module-alias')({base:'/app/api'});
const connect=require('/app/config/connect');
const mongoose=require('mongoose');
const {User}=require('@librechat/data-schemas').createModels(mongoose);
const {registerUser}=require('/app/api/server/services/AuthService');
let raw=''; process.stdin.on('data',d=>raw+=d); process.stdin.on('end',async()=>{
try {
 const data=JSON.parse(raw); await connect();
 const existing=await User.findOne({email:data.email});
 if(!existing){const r=await registerUser({...data,confirm_password:data.password},{emailVerified:true});if(r.status!==200)throw new Error('Registration failed');}
 await User.updateOne({email:data.email},{$set:{role:'USER'}});
 await mongoose.disconnect();process.exit(0);
}catch{process.exit(1);}});
`;
const result = spawnSync('docker', ['compose', '-f', path.join(directory, 'compose.yml'),
  'exec', '-T', 'librechat', 'node', '-e', script], { input: payload, encoding: 'utf8', timeout: 60000 });
if (result.status !== 0) {
  console.error('Local account provisioning failed; credentials were preserved. Check LibreChat readiness.');
  process.exitCode = 1;
} else console.log('Local USER account ready. Credentials: .standalone/desktop/login.json (0600).');
