import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ToolContext } from '../types.js';
import { createTestConfig, createTestDb, createTestIdentity } from './mocks.js';

const module = await import('../integrations/operator-contact.js').catch(() => ({})) as {
  createOperatorContactTools?: () => import('../types.js').AutomatonTool[];
};
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function setup(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const db = createTestDb();
  cleanups.push(() => db.close());
  const config = createTestConfig({ conwayApiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, conwayApiKey: 'private-test-token' });
  const ctx = { config, db, identity: createTestIdentity() } as ToolContext;
  expect(module.createOperatorContactTools, 'contact tools should exist').toBeTypeOf('function');
  return { tools: module.createOperatorContactTools!(), ctx };
}

describe('operator contact tool', () => {
  it('submits only agent content to the authenticated local controller and reports queued honestly', async () => {
    const { tools, ctx } = await setup(async (req, res) => {
      expect(req.method).toBe('POST'); expect(req.url).toBe('/v1/operator/contact');
      expect(req.headers.authorization).toBe('Bearer private-test-token');
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual({ subject: 'Funding', message: 'Observed balance unknown', purpose: 'recharge', idempotencyKey: 'recharge-1' });
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ id: 'oc_1', status: 'queued', reason: 'smtp_not_configured', deliveryConfirmed: false }));
    });
    const tool = tools.find(t => t.name === 'contact_operator')!;
    expect(tool.riskLevel).toBe('caution');
    const output = JSON.parse(await tool.execute({ subject: 'Funding', message: 'Observed balance unknown', purpose: 'recharge', idempotencyKey: 'recharge-1' }, ctx));
    expect(output.status).toBe('queued'); expect(output.deliveryConfirmed).toBe(false);
    expect(JSON.parse(ctx.db.getKV('operator.contact.lastReceipt')!)).toEqual(output);
  });

  it('checks contact status without creating a contact request', async () => {
    const { tools, ctx } = await setup((req, res) => {
      expect(req.method).toBe('GET'); expect(req.url).toBe('/v1/operator/contact');
      res.end(JSON.stringify({ transportReady: false, requests: [] }));
    });
    const output = JSON.parse(await tools.find(t => t.name === 'operator_contact_status')!.execute({}, ctx));
    expect(output.transportReady).toBe(false); expect(output.requests).toEqual([]);
  });

  it('rejects transport/recipient overrides and invalid content before making a request', async () => {
    let requests = 0;
    const { tools, ctx } = await setup((_req, res) => { requests++; res.end('{}'); });
    const tool = tools.find(t => t.name === 'contact_operator')!;
    for (const args of [{ subject: 'Funding', message: 'Please review', recipient: 'other@example.com' }, { subject: 'Header\r\nBcc:other@example.com', message: 'Please review' }]) {
      expect(JSON.parse(await tool.execute(args, ctx)).error).toBe('invalid_contact_arguments');
    }
    expect(requests).toBe(0);
  });

  it('refuses external gateways and never forwards the credential to an external host', async () => {
    const { tools, ctx } = await setup((_req, res) => res.end('{}'));
    ctx.config.conwayApiUrl = 'https://example.com';
    const output = JSON.parse(await tools[0].execute({ subject: 'Funding', message: 'Please review' }, ctx));
    expect(output.error).toBe('local_controller_required');
  });

  it('preserves unknown submission outcome instead of claiming email was delivered on an invalid response', async () => {
    const { tools, ctx } = await setup((_req, res) => res.end('not json, secret=password'));
    const output = JSON.parse(await tools[0].execute({ subject: 'Funding', message: 'Please review' }, ctx));
    expect(output.status).toBe('unknown'); expect(output.deliveryConfirmed).toBe(false);
    expect(JSON.stringify(output)).not.toMatch(/secret|password/);
  });
});
