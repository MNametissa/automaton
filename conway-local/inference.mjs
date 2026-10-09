import fs from 'node:fs';
import path from 'node:path';

const invalid = (field) => new Error(`Invalid inference ${field}`);
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
function fields(value, allowed, required = allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !(key in value))) throw invalid('configuration fields');
}
function integer(value, min, max, field) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw invalid(field);
}
function privateEntry(file, directory = false) {
  const stat = fs.lstatSync(file);
  if (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) throw invalid(directory ? 'private directory' : 'regular file');
  if (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw invalid('private controller ownership/permissions');
  return stat;
}
function readPrivate(file, maxBytes) {
  const expected = privateEntry(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const actual = fs.fstatSync(fd);
    if (actual.ino !== expected.ino || actual.dev !== expected.dev || actual.size < 1 || actual.size > maxBytes) throw invalid('private file size/identity');
    return fs.readFileSync(fd, 'utf8');
  } finally { fs.closeSync(fd); }
}
function hasPrivateKey(file) {
  if (!file) return false;
  try {
    const stat = privateEntry(file);
    if (stat.size < 1 || stat.size > 8192) throw invalid('private key size');
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function withCompletion(inference) {
  return {
    ...inference,
    async complete(body) {
      const unavailable = inference.availabilityError();
      if (unavailable) return unavailable;
      if (body.stream || !Array.isArray(body.messages) || !body.messages.length) return [400, { error: 'non-streaming messages required' }];
      if (body.model && body.model !== inference.model) return [400, { error: 'unknown model' }];
      let requestBody;
      try { requestBody = inference.requestBody(body); }
      catch (error) { return [error.status || 400, { error: error.message }]; }
      try {
        const key = inference.authorization();
        const signal = AbortSignal.timeout(inference.timeout);
        const response = await fetch(inference.endpoint, {
          method: 'POST', redirect: 'error', signal,
          headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
          body: JSON.stringify(requestBody),
        });
        try { return [response.status, await response.json()]; }
        catch {
          if (signal.aborted) throw signal.reason;
          return [502, { error: 'upstream returned invalid JSON' }];
        }
      } catch (error) {
        return [error.name === 'TimeoutError' ? 504 : 502, { error: error.name === 'TimeoutError' ? 'upstream timeout' : 'upstream unavailable' }];
      }
    },
  };
}

// A controller declaration authorizes an existing dedicated endpoint; this
// gateway neither provisions infrastructure nor verifies its provider balance.
// Token-billed providers require their own billing/token contract before use.
export function loadInference(env = process.env, { controlRoot = '/control' } = {}) {
  if (!env.INFERENCE_CONFIG_FILE) {
    const endpoint = (env.UPSTREAM_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
    const url = new URL(endpoint);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('External inference requires controller provider configuration');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid UPSTREAM_URL');
    const timeout = Number(env.UPSTREAM_TIMEOUT_MS || 60_000);
    if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('Invalid UPSTREAM_TIMEOUT_MS');
    const model = env.MODEL_ID || 'local';
    return withCompletion({
      endpoint: `${endpoint}/v1/chat/completions`, model, timeout,
      status: () => ({ mode: 'local', state: 'ready', ready: true, model, billing_mode: 'local', provider_balance_microusd: null, effective_external_spend_limit_microusd: 0, infrastructure_expense_microusd: null }),
      catalog: () => ({ id: model, provider: 'conway', available: true, pricing: { input_per_million: 0, output_per_million: 0, source: 'local_zero_spend' } }),
      availabilityError: () => null,
      requestBody: (body) => ({ ...body, model }),
      authorization: () => env.UPSTREAM_KEY || '',
    });
  }
  const providers = path.join(controlRoot, 'providers');
  if (env.INFERENCE_CONFIG_FILE !== path.join(providers, 'inference.json')) throw invalid('config path');
  for (const name of ['UPSTREAM_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY']) {
    if (env[name]) throw invalid('environment credentials; use controller private key file');
  }
  if (env.UPSTREAM_URL) throw invalid('UPSTREAM_URL; choose endpoint in controller configuration');
  privateEntry(controlRoot, true);
  privateEntry(providers, true);
  let config;
  try { config = JSON.parse(readPrivate(env.INFERENCE_CONFIG_FILE, 16384)); }
  catch (error) { if (error.message.startsWith('Invalid inference')) throw error; throw invalid('configuration JSON'); }
  fields(config, ['version', 'mode', 'billing_mode', 'enabled', 'approved', 'endpoint', 'model', 'api_key_file', 'pricing', 'limits', 'prepaid_allowance_microusd', 'approval_expires_at'], ['version', 'mode', 'billing_mode', 'enabled', 'approved', 'limits', 'prepaid_allowance_microusd']);
  if (config.version !== 1 || config.mode !== 'remote' || !['infrastructure', 'token'].includes(config.billing_mode) || typeof config.enabled !== 'boolean' || typeof config.approved !== 'boolean') throw invalid('mode/approval');
  integer(config.prepaid_allowance_microusd, 0, Number.MAX_SAFE_INTEGER, 'prepaid allowance');
  if (config.approval_expires_at !== undefined && (typeof config.approval_expires_at !== 'string' || !Number.isFinite(Date.parse(config.approval_expires_at)))) throw invalid('approval expiry');
  if (config.model !== undefined && (typeof config.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(config.model))) throw invalid('model');
  if (config.endpoint !== undefined) {
    let url;
    try { url = new URL(config.endpoint); } catch { throw invalid('endpoint'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/v1/chat/completions') throw invalid('endpoint');
  }
  if (config.api_key_file !== undefined && (typeof config.api_key_file !== 'string' || path.dirname(config.api_key_file) !== providers || !/^[a-zA-Z0-9_-]+\.key$/.test(path.basename(config.api_key_file)))) throw invalid('key path');
  if (config.pricing !== undefined) {
    fields(config.pricing, ['input_microusd_per_million_tokens', 'output_microusd_per_million_tokens']);
    for (const value of Object.values(config.pricing)) integer(value, 0, Number.MAX_SAFE_INTEGER, 'declared pricing');
  }
  fields(config.limits, ['max_input_bytes', 'max_output_tokens', 'timeout_ms']);
  integer(config.limits.max_input_bytes, 1, 1024 * 1024, 'input byte bound');
  integer(config.limits.max_output_tokens, 1, 65536, 'output token bound');
  integer(config.limits.timeout_ms, 1, 120000, 'timeout bound');
  hasPrivateKey(config.api_key_file);
  const state = () => {
    if (!config.endpoint || !config.model) return 'awaiting_provider';
    if (!hasPrivateKey(config.api_key_file)) return 'awaiting_credentials';
    if (!config.approved) return 'awaiting_approval';
    if (!config.enabled) return 'disabled_by_operator';
    if (config.prepaid_allowance_microusd <= 0) return 'awaiting_budget';
    if (!config.approval_expires_at) return 'awaiting_approval_expiry';
    if (Date.parse(config.approval_expires_at) <= Date.now()) return 'approval_expired';
    if (config.billing_mode === 'token') return 'awaiting_provider_contract';
    return 'ready';
  };
  return withCompletion({
    endpoint: config.endpoint, model: config.model, timeout: config.limits.timeout_ms,
    status: () => ({ mode: 'remote', state: state(), ready: state() === 'ready', model: config.model ?? null, billing_mode: config.billing_mode, provider_balance_microusd: null, infrastructure_expense_microusd: null, effective_external_spend_limit_microusd: null, declared_prepaid_allowance_microusd: config.prepaid_allowance_microusd, allowance_source: 'operator_declaration_not_verified_provider_balance', budget_enforcement: 'not_metered_by_gateway', approval_expires_at: config.approval_expires_at ?? null, limits: { ...config.limits } }),
    catalog: () => ({ id: config.model ?? 'awaiting-provider', provider: 'conway', available: state() === 'ready', billing_mode: config.billing_mode, pricing: { input_per_million: config.pricing ? config.pricing.input_microusd_per_million_tokens / 1_000_000 : null, output_per_million: config.pricing ? config.pricing.output_microusd_per_million_tokens / 1_000_000 : null, source: config.pricing ? 'operator_declared' : 'unknown_infrastructure_expense' } }),
    availabilityError: () => state() === 'ready' ? null : [503, { error: `inference ${state()}` }],
    requestBody(body) {
      fields(body, ['model', 'messages', 'stream', 'max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'stop', 'seed', 'tools', 'tool_choice', 'response_format'], ['messages']);
      if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined) throw Object.assign(invalid('output token parameter'), { status: 400 });
      const parameter = body.max_completion_tokens !== undefined ? 'max_completion_tokens' : 'max_tokens';
      const result = { ...body, model: config.model, stream: false, [parameter]: body[parameter] ?? config.limits.max_output_tokens };
      try { integer(result[parameter], 1, config.limits.max_output_tokens, 'output token bound'); }
      catch (error) { throw Object.assign(error, { status: 400 }); }
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > config.limits.max_input_bytes) throw Object.assign(invalid('input byte bound'), { status: 413 });
      return result;
    },
    authorization() {
      if (state() !== 'ready') throw invalid('inference not ready');
      const value = readPrivate(config.api_key_file, 8192).trim();
      if (!value || /[\r\n]/.test(value)) throw invalid('key content');
      return value;
    },
  });
}
