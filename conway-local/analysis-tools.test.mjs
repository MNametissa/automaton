import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAnalysisTools, getAnalysisToolsReadiness } from '../dist/integrations/analysis-tools.js';

// The isolated Docker image sets this path and must execute this test offline.
test('installed REA and Mimic execute all five tools without network access', {
  skip: !process.env.AUTOMATON_ANALYSIS_RUNTIME,
}, async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'analysis-smoke-'));
  try {
    await mkdir(path.join(workspace, 'app'));
    await writeFile(path.join(workspace, 'app/package.json'), '{"name":"synthetic","version":"1.0.0","type":"module"}');
    await writeFile(path.join(workspace, 'app/index.js'), 'export const answer = 42;');
    const har = { log: { version: '1.2', creator: { name: 'synthetic', version: '1' }, entries: [{
      startedDateTime: '2026-01-01T00:00:00.000Z', time: 1,
      request: { method: 'GET', url: 'https://example.test/items', httpVersion: 'HTTP/1.1', cookies: [], headers: [], queryString: [], headersSize: -1, bodySize: 0 },
      response: { status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1', cookies: [], headers: [], content: { size: 2, mimeType: 'application/json', text: '[]' }, redirectURL: '', headersSize: -1, bodySize: 2 },
      cache: {}, timings: { send: 0, wait: 1, receive: 0 },
    }] } };
    await writeFile(path.join(workspace, 'capture.har'), JSON.stringify(har));
    const ready = await getAnalysisToolsReadiness({ workspace });
    assert.equal(ready.rea.available, true, JSON.stringify(ready.rea));
    assert.equal(ready.mimic.available, true, JSON.stringify(ready.mimic));
    for (const tool of createAnalysisTools({ workspace })) {
      const args = tool.name === 'rea_analyze_javascript' ? { path: 'app' }
        : ['mimic_learn', 'mimic_build_prompt'].includes(tool.name) ? { path: 'capture.har', host: 'example.test' } : { path: 'capture.har' };
      const result = JSON.parse(await tool.execute(args, {}));
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.exitCode, 0);
      assert.ok(result.stdout.length > 10, tool.name);
    }
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
