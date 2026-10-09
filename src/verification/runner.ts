import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { isSensitiveFile } from '../agent/policy-rules/path-protection.js';

export interface CheckResult { kind: string; status: 'passed' | 'failed' | 'inconclusive'; detail: string }
export interface VerificationReport { status: CheckResult['status']; checkedAt: string; checks: CheckResult[] }
export const CHECKS_DESCRIPTION = 'Nonempty array of checks. node: {kind:"node",script:"relative.mjs",input:"stdin",expectedExit:0,expectedJson:{...}}; http: {kind:"http",url:"http://127.0.0.1:PORT/path",expectedStatus:200,expectedJson:{...}} or bodyIncludes; citations: {kind:"citations",report:"report.json",sources:"sources.json"}. Citation integrity cannot prove semantic support and stays inconclusive.';

function localFile(root: string, value: unknown): string {
  if (typeof value !== 'string' || !value || path.isAbsolute(value)) throw new Error('A relative workspace file is required');
  const base = fs.realpathSync(root);
  const resolved = fs.realpathSync(path.resolve(base, value));
  if (!resolved.startsWith(base + path.sep) || isSensitiveFile(resolved) || !fs.statSync(resolved).isFile()) throw new Error('File is outside the permitted workspace');
  return resolved;
}

function readJson(root: string, name: unknown): any {
  const file = localFile(root, name);
  if (fs.statSync(file).size > 256_000) throw new Error('Source or report exceeds 256 KB');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function runNode(root: string, check: Record<string, unknown>, signal?: AbortSignal): Promise<CheckResult> {
  const script = localFile(root, check.script);
  if (!/\.m?js$/.test(script)) throw new Error('Node checks require a .js or .mjs workspace script');
  if (!Number.isInteger(check.expectedExit) || Number(check.expectedExit) < 0 || Number(check.expectedExit) > 255) throw new Error('Specify expectedExit (0..255)');
  if (check.input !== undefined && (typeof check.input !== 'string' || check.input.length > 64_000)) throw new Error('Invalid stdin');
  return new Promise(resolve => {
    let output = '', diagnostic = '', failed = false, settled = false;
    const child = spawn(process.execPath, [script], { cwd: root, env: { PATH: process.env.PATH ?? '', LANG: 'C.UTF-8' },
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    const stop = () => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already exited */ }
    };
    const finish = (result: CheckResult) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted); stop(); resolve(result);
    };
    const aborted = () => finish({ kind: 'node', status: 'failed', detail: 'Verification aborted' });
    const timer = setTimeout(() => finish({ kind: 'node', status: 'failed', detail: 'Verification exceeded 5 seconds' }), 5000);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 64_000) { failed = true; stop(); } });
    child.stderr.on('data', chunk => { diagnostic += chunk; if (diagnostic.length > 64_000) { failed = true; stop(); } });
    child.stdin.on('error', () => {});
    child.on('error', () => finish({ kind: 'node', status: 'failed', detail: 'Cannot start verifier' }));
    child.on('close', code => {
      let passed = !failed && code === check.expectedExit;
      if ('expectedJson' in check) {
        try { passed &&= isDeepStrictEqual(JSON.parse(output), check.expectedJson); } catch { passed = false; }
      }
      finish({ kind: 'node', status: passed ? 'passed' : 'failed',
        detail: `exit=${code}; stdout=${output.slice(0, 2000)}; stderr=${diagnostic.slice(0, 1000)}` });
    });
    child.stdin.end(typeof check.input === 'string' ? check.input : '');
  });
}

async function runHttp(check: Record<string, unknown>, signal?: AbortSignal): Promise<CheckResult> {
  const url = new URL(String(check.url));
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('HTTP verification is restricted to loopback literals');
  if (!Number.isInteger(check.expectedStatus) || Number(check.expectedStatus) < 100 || Number(check.expectedStatus) > 599) throw new Error('Specify expectedStatus');
  if (check.bodyIncludes !== undefined && (typeof check.bodyIncludes !== 'string' || !check.bodyIncludes)) throw new Error('bodyIncludes must be nonempty');
  const timeout = AbortSignal.timeout(5000);
  const response = await fetch(url, { redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let text = '', bytes = 0;
  try {
    while (reader) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 64_000) throw new Error('HTTP body exceeds 64 KB');
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally { await reader?.cancel(); }
  let passed = response.status === check.expectedStatus;
  if ('expectedJson' in check) { try { passed &&= isDeepStrictEqual(JSON.parse(text), check.expectedJson); } catch { passed = false; } }
  if (typeof check.bodyIncludes === 'string') passed &&= text.includes(check.bodyIncludes);
  return { kind: 'http', status: passed ? 'passed' : 'failed', detail: `HTTP ${response.status}; checked ${bytes} bytes` };
}

function runCitations(root: string, check: Record<string, unknown>): CheckResult {
  const packet = readJson(root, check.sources), report = readJson(root, check.report);
  if (!Array.isArray(packet.sources) || !packet.sources.length || !Array.isArray(report.claims) || !report.claims.length) throw new Error('Nonempty sources and claims arrays are required');
  const sources = new Map<string, string>();
  for (const source of packet.sources) {
    if (typeof source?.id !== 'string' || !source.id || sources.has(source.id) || typeof source.text !== 'string' || !source.text) throw new Error('Invalid or duplicate source');
    sources.set(source.id, source.text);
  }
  for (const claim of report.claims) {
    if (typeof claim?.text !== 'string' || !claim.text.trim() || !Array.isArray(claim.quotes) || !claim.quotes.length) throw new Error('Every claim needs text and source quotes');
    for (const quote of claim.quotes) {
      if (typeof quote?.text !== 'string' || !quote.text.trim() || !sources.get(quote.sourceId)?.includes(quote.text)) throw new Error('Quote is missing from its identified source');
    }
  }
  return { kind: 'citations', status: 'inconclusive', detail: `${report.claims.length} claims have exact source quotes. Semantic support, completeness and calculations are not established by this check.` };
}

export async function runVerification(checks: unknown, root: string, signal?: AbortSignal): Promise<VerificationReport> {
  const results: CheckResult[] = [];
  if (!Array.isArray(checks) || checks.length === 0 || checks.length > 12) {
    results.push({ kind: 'contract', status: 'failed', detail: 'Provide 1..12 executable checks; prose and keyword matches are not evidence.' });
  } else for (const value of checks) {
    const kind = typeof value?.kind === 'string' ? value.kind : 'invalid';
    try {
      if (signal?.aborted) throw new Error('Verification aborted');
      if (kind === 'node') results.push(await runNode(root, value, signal));
      else if (kind === 'http') results.push(await runHttp(value, signal));
      else if (kind === 'citations') results.push(runCitations(root, value));
      else throw new Error('Unsupported verification check');
    } catch (error) { results.push({ kind, status: 'failed', detail: error instanceof Error ? error.message : String(error) }); }
  }
  return { status: results.some(r => r.status === 'failed') ? 'failed' : results.some(r => r.status === 'inconclusive') ? 'inconclusive' : 'passed',
    checkedAt: new Date().toISOString(), checks: results };
}
