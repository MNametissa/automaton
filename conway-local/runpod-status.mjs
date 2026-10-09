#!/usr/bin/env node
// Read-only observation; no inference, provisioning, payment or credential output.
import { parseArgs } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { getRunpodStatus } from '../dist/integrations/runpod.js';

try {
  const { values } = parseArgs({ options: { watch: { type: 'boolean', default: false } } });
  let stopped = false;
  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopped = true; controller.abort(); });
  do {
    const result = await getRunpodStatus();
    console.log(JSON.stringify(result));
    if (!values.watch) { process.exitCode = result.ok ? 0 : 1; break; }
    if (!stopped) await setTimeout(60_000, undefined, { signal: controller.signal }).catch(() => {});
  } while (!stopped);
} catch { console.error('Usage: node conway-local/runpod-status.mjs [--watch]'); process.exitCode = 1; }
