import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it.each([30000, 500000])('budgets %i repetitive characters without blocking the agent event loop for seconds', async (size) => {
  const { stdout } = await promisify(execFile)(process.execPath, [
    '--import', 'tsx', '--input-type=module', '-e',
    `import { estimateTokens } from './src/agent/context.ts'; console.log(estimateTokens('x'.repeat(${size})));`,
  ], { timeout: 5000 });
  expect(Number(stdout.trim())).toBeGreaterThanOrEqual(size / 4);
}, 10000);
