#!/usr/bin/env node
// Initializes operator-owned agent state. It never starts the agent or funds a wallet.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { isAddress } from 'viem';

const missionPacket = JSON.parse(fs.readFileSync(new URL('./missions.json', import.meta.url), 'utf8'));
const missions = Object.fromEntries(missionPacket.missions.map(mission => [mission.id,
  `${mission.id}: ${mission.request}\nAcceptance: ${mission.acceptance.join('; ')}`]));

try {
  const { values } = parseArgs({ options: {
    'state-dir': { type: 'string' }, 'api-url': { type: 'string' },
    model: { type: 'string', default: 'local' }, creator: { type: 'string' },
    mission: { type: 'string', default: 'all' }, status: { type: 'boolean' },
  } });
  if (!values['state-dir']) throw new Error('--state-dir is required (use dedicated storage, not personal state)');
  const stateDir = path.resolve(values['state-dir']);
  const configPath = path.join(stateDir, 'automaton.json');
  if (values.status) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    console.log(JSON.stringify({ name: config.name, standalone: config.standalone, apiUrl: config.conwayApiUrl,
      model: config.inferenceModel, stateDir, externalSpendLimitCents: 0, accountingMode: 'simulation' }, null, 2));
  } else {
    if (fs.existsSync(configPath)) throw new Error('Configuration already exists; refusing to overwrite it');
    if (!values['api-url']) throw new Error('--api-url is required');
    const api = new URL(values['api-url']);
    if (api.username || api.password || api.search || api.hash || api.pathname !== '/') throw new Error('Use an API origin without credentials or path');
    if (api.protocol !== 'https:' && !(api.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(api.hostname))) throw new Error('HTTPS required except on loopback');
    if (!values.creator || !isAddress(values.creator)) throw new Error('--creator must be an EVM address');
    if (values.mission !== 'all' && !missions[values.mission]) throw new Error('--mission must be software, website, report or all');
    if (!values.model.trim()) throw new Error('--model cannot be empty');
    process.env.AUTOMATON_DIR = stateDir;
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const { provision, registerParent } = await import('../dist/identity/provision.js');
    const { createConfig, saveConfig } = await import('../dist/config.js');
    const { writeDefaultHeartbeatConfig, loadHeartbeatConfig, saveHeartbeatConfig } = await import('../dist/heartbeat/config.js');
    const { apiKey, walletAddress } = await provision(api.origin);
    await registerParent(values.creator, api.origin);
    const genesisPrompt = (values.mission === 'all' ? Object.values(missions) : [missions[values.mission]]).join('\n\n') +
      '\n\nAfter task execution, run verify_task with concrete acceptance checks. Passing keywords or worker declarations are not evidence. Tests prove only the supplied cases. Report citation checks do not establish semantic support; retain unresolved findings explicitly.';
    const config = {
      ...createConfig({ name: 'standalone', genesisPrompt, creatorAddress: values.creator,
        registeredWithConway: false, sandboxId: '', walletAddress, apiKey }),
      standalone: true, conwayApiUrl: api.origin, socialRelayUrl: api.origin,
      inferenceModel: values.model, logLevel: 'debug', maxChildren: 0, maxTurnsPerCycle: 20,
      dbPath: path.join(stateDir, 'state.db'), skillsDir: path.join(stateDir, 'skills'),
      heartbeatConfigPath: path.join(stateDir, 'heartbeat.yml'),
    };
    writeDefaultHeartbeatConfig(config.heartbeatConfigPath);
    const heartbeat = loadHeartbeatConfig(config.heartbeatConfigPath);
    for (const entry of heartbeat.entries) if (['check_usdc_balance', 'check_for_updates'].includes(entry.name)) entry.enabled = false;
    saveHeartbeatConfig(heartbeat, config.heartbeatConfigPath);
    saveConfig(config);
    console.log(`Initialized ${stateDir}. Allocation remains zero; no payment made. Start only in the dedicated runtime environment.`);
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
