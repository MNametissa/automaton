/** Agent-side access to the root-owned operator outbox. No SMTP credentials enter the agent. */
import type { AutomatonTool, ToolContext } from '../types.js';

function validContact(args: Record<string, unknown>): boolean {
  return !Object.keys(args).some(key => !['subject', 'message', 'purpose', 'idempotencyKey'].includes(key)) &&
    typeof args.subject === 'string' && !!args.subject.trim() && args.subject.length <= 160 && !/[\r\n\0]/.test(args.subject) &&
    typeof args.message === 'string' && !!args.message.trim() && Buffer.byteLength(args.message) <= 16384 && !args.message.includes('\0') &&
    (args.purpose === undefined || typeof args.purpose === 'string' && /^[a-z][a-z0-9_-]{0,47}$/.test(args.purpose)) &&
    (args.idempotencyKey === undefined || typeof args.idempotencyKey === 'string' && /^[a-zA-Z0-9:_-]{1,128}$/.test(args.idempotencyKey));
}
async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('invalid_response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if ((size += value.byteLength) > 65536) throw new Error('response_too_large');
      chunks.push(value);
    }
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid_response');
    return data as Record<string, unknown>;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function controllerRequest(ctx: ToolContext, body?: Record<string, unknown>): Promise<string> {
  let url: URL;
  try {
    const base = new URL(ctx.config.conwayApiUrl);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || !['http:', 'https:'].includes(base.protocol) ||
        base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error();
    url = new URL('/v1/operator/contact', base);
  } catch { return JSON.stringify({ ok: false, error: 'local_controller_required', deliveryConfirmed: false }); }
  if (!ctx.config.conwayApiKey) return JSON.stringify({ ok: false, error: 'missing_controller_credentials', deliveryConfirmed: false });
  try {
    const response = await fetch(url, { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bearer ${ctx.config.conwayApiKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return JSON.stringify({ ok: false, error: `controller_http_${response.status}`, status: body && response.status >= 500 ? 'unknown' : 'unavailable', deliveryConfirmed: false });
    }
    const result = await boundedJson(response);
    if (body ? !['queued', 'delivering', 'smtp_accepted', 'failed', 'uncertain', 'cooldown'].includes(String(result.status)) :
      typeof result.transportReady !== 'boolean' || !Array.isArray(result.requests)) throw new Error('invalid_response');
    // A server acceptance cannot establish inbox delivery.
    result.deliveryConfirmed = false;
    ctx.db.setKV(body ? 'operator.contact.lastReceipt' : 'operator.contact.lastStatus', JSON.stringify(result));
    return JSON.stringify(result);
  } catch {
    return JSON.stringify({ ok: false, error: 'controller_request_or_response_failed', status: body ? 'unknown' : 'unavailable', deliveryConfirmed: false,
      note: body ? 'Submission outcome is unknown. Check operator_contact_status before repeating the same content or idempotency key.' : 'Operator contact status could not be verified.' });
  }
}

export function createOperatorContactTools(): AutomatonTool[] {
  return [{
    name: 'contact_operator', category: 'conway', riskLevel: 'caution',
    description: 'Contact your configured operator by email with a subject and message you choose. The controller fixes the recipient, stores a durable receipt, deduplicates requests and applies a cooldown. Requires controller SMTP configuration; otherwise the request is queued without sending. SMTP acceptance does not confirm inbox delivery. Reuse content or idempotencyKey to reconcile an uncertain request. Cannot select recipients, credentials, transports, attachments or make purchases.',
    parameters: { type: 'object', additionalProperties: false, required: ['subject', 'message'], properties: {
      subject: { type: 'string', maxLength: 160, description: 'Email subject, without newlines.' },
      message: { type: 'string', maxLength: 16384, description: 'Your plain-text message; include only facts you can support and label unknowns.' },
      purpose: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,47}$', description: 'Optional purpose label, e.g. recharge, blocker, or update.' },
      idempotencyKey: { type: 'string', pattern: '^[a-zA-Z0-9:_-]{1,128}$', description: 'Optional durable request identity; reuse for the exact same message.' },
    } },
    async execute(args, ctx) {
      if (!validContact(args)) return JSON.stringify({ ok: false, error: 'invalid_contact_arguments', deliveryConfirmed: false });
      return controllerRequest(ctx, args);
    },
  }, {
    name: 'operator_contact_status', category: 'conway', riskLevel: 'safe',
    description: 'Read whether the operator email transport is configured and inspect your latest durable contact receipts. Does not send mail or retry uncertain delivery.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async execute(args, ctx) {
      if (Object.keys(args).length) return JSON.stringify({ ok: false, error: 'unexpected_arguments', deliveryConfirmed: false });
      return controllerRequest(ctx);
    },
  }];
}
