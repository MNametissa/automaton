/** Read-only Runpod observation. Provider funds are not an operator spending allowance. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { AutomatonTool } from '../types.js';

const QUERY = `query AliveStatus {
  myself {
    clientBalance currentSpendPerHr
    pods {
      id name desiredStatus costPerHr
      runtime {
        uptimeInSeconds
        gpus { gpuUtilPercent memoryUtilPercent }
        container { cpuPercent memoryPercent }
      }
    }
  }
}`;
interface Options {
  apiKey?: string;
  fetcher?: typeof fetch;
}
interface PodStatus {
  id: string; name: string; desiredStatus: string;
  costPerHourUsd: number | null; uptimeSeconds: number | null;
  gpu: { utilizationPercent: number | null; memoryPercent: number | null }[] | null;
  cpuPercent: number | null; memoryPercent: number | null;
}
type RunpodStatus = {
  ok: true; source: 'runpod'; scope: 'account'; retrievedAt: string;
  balanceUsd: number; spendPerHourUsd: number;
  estimatedAccountRunwayHours: number | null; pods: PodStatus[];
  note: string;
} | { ok: false; source: 'runpod'; attemptedAt: string; error: string };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_response');
  return value as Record<string, unknown>;
}
function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function string(value: unknown): string {
  if (typeof value !== 'string' || value.length > 256) throw new Error('invalid_response');
  return value;
}
function podStatus(value: unknown): PodStatus {
  const pod = record(value);
  const runtime = pod.runtime == null ? null : record(pod.runtime);
  const container = runtime?.container == null ? null : record(runtime.container);
  if (runtime?.gpus != null && !Array.isArray(runtime.gpus)) throw new Error('invalid_response');
  return {
    id: string(pod.id), name: string(pod.name), desiredStatus: string(pod.desiredStatus),
    costPerHourUsd: numeric(pod.costPerHr), uptimeSeconds: numeric(runtime?.uptimeInSeconds),
    gpu: runtime?.gpus == null ? null : (runtime.gpus as unknown[]).map(value => {
      const gpu = record(value);
      return { utilizationPercent: numeric(gpu.gpuUtilPercent), memoryPercent: numeric(gpu.memoryUtilPercent) };
    }),
    cpuPercent: numeric(container?.cpuPercent), memoryPercent: numeric(container?.memoryPercent),
  };
}

async function keyFromEnvironment(): Promise<string> {
  const file = process.env.RUNPOD_API_KEY_FILE;
  if (!file) return process.env.RUNPOD_API_KEY?.trim() ?? '';
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) !== 0) throw new Error('invalid_credentials_file');
    return (await handle.readFile('utf8')).trim();
  } finally { await handle.close(); }
}

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('invalid_response');
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 1_000_000) throw new Error('response_too_large');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function getRunpodStatus(options: Options = {}): Promise<RunpodStatus> {
  const attemptedAt = new Date().toISOString();
  const fail = (error: string): RunpodStatus => ({ ok: false, source: 'runpod', attemptedAt, error });
  let apiKey: string;
  try { apiKey = (options.apiKey ?? await keyFromEnvironment()).trim(); }
  catch { return fail('invalid_credentials_file'); }
  if (!apiKey) return fail('missing_credentials');
  if (apiKey.length > 4096 || /\s/.test(apiKey)) return fail('invalid_credentials');
  try {
    const url = new URL('https://api.runpod.io/graphql');
    // The documented GraphQL authentication is a query parameter. Never log this URL.
    url.searchParams.set('api_key', apiKey);
    const response = await (options.fetcher ?? fetch)(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: QUERY }),
    });
    if (!response.ok) { await response.body?.cancel(); return fail(`http_${response.status}`); }
    const body = record(await boundedJson(response));
    if (body.errors != null && (!Array.isArray(body.errors) || body.errors.length > 0)) return fail('graphql_error');
    const account = record(record(body.data).myself);
    const balance = numeric(account.clientBalance), spend = numeric(account.currentSpendPerHr);
    if (balance === null || spend === null || spend < 0 || !Array.isArray(account.pods)) return fail('invalid_response');
    const runway = spend > 0 ? Math.max(0, balance) / spend : null;
    return {
      ok: true, source: 'runpod', scope: 'account', retrievedAt: new Date().toISOString(),
      balanceUsd: balance, spendPerHourUsd: spend,
      estimatedAccountRunwayHours: runway !== null && Number.isFinite(runway) ? runway : null,
      pods: account.pods.map(podStatus),
      note: 'Account-wide provider observation, not an authorized budget or agent profit. Retrieval time is not a provider measurement timestamp. Runway assumes unchanged reported spend; invoices and other charges may differ.',
    };
  } catch {
    // Upstream error bodies and fetch exceptions may include the credential-bearing URL.
    return fail('request_or_response_failed');
  }
}

export function createRunpodStatusTool(): AutomatonTool {
  return {
    name: 'runpod_status', category: 'financial', riskLevel: 'safe',
    description: 'Read current Runpod account balance, reported hourly spend and pod telemetry. Requires operator-provided RUNPOD_API_KEY_FILE or RUNPOD_API_KEY. Never provisions, tops up or changes resources. Account funds are not your spending allowance.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(args, ctx) {
      if (Object.keys(args).length) return JSON.stringify({ ok: false, error: 'unexpected_arguments' });
      const status = await getRunpodStatus();
      ctx?.db?.setKV('runpod.snapshot', JSON.stringify(status));
      return JSON.stringify(status);
    },
  };
}
