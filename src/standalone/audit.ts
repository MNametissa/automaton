import { getBrowserReadiness } from '../integrations/browser.js';
import { getAnalysisToolsReadiness } from '../integrations/analysis-tools.js';
import { runtimeSkills, STARTUP_SKILLS } from '../skills/runtime.js';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { AutomatonTool, ToolContext, ToolCallResult, AutomatonDatabase, ModelInfo, GatewayInferenceStatus } from '../types.js';
import { getActiveGoals } from '../state/database.js';

// These connectors require services not provided by the standalone gateway.
export const UNAVAILABLE_STANDALONE_TOOLS = new Set([
  'topup_credits', 'transfer_usdc', 'check_usdc_balance', 'x402_fetch',
  'create_sandbox', 'delete_sandbox', 'list_sandboxes', 'spawn_child', 'fund_child',
  'start_child', 'check_child_status', 'verify_child_constitution', 'prune_dead_children',
  'register_domain', 'search_domains', 'manage_dns', 'register_erc8004',
  'discover_agents', 'give_feedback', 'check_reputation', 'install_mcp_server',
  'expose_port', 'remove_port', 'update_agent_card',
]);

export function standaloneTools(tools: AutomatonTool[], context: ToolContext): AutomatonTool[] {
  const unsupportedInstalled = new Set(context.db.getInstalledTools()
    .filter(t => !t.enabled || t.type === 'mcp' || !t.config?.command).map(t => t.name));
  return tools.filter(t => !UNAVAILABLE_STANDALONE_TOOLS.has(t.name) && !unsupportedInstalled.has(t.name));
}

export async function auditStartup(context: ToolContext, tools: AutomatonTool[]): Promise<StartupAudit> {
  const { config, db, conway } = context;
  const blockers: string[] = [];
  const workspace = path.resolve(process.env.AUTOMATON_WORKSPACE || process.cwd());
  const mission = config.genesisPrompt.trim();
  if (!mission) blockers.push('mission: no objective configured');
  try {
    if (!fs.statSync(workspace).isDirectory()) throw new Error('not a directory');
    fs.accessSync(workspace, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
  } catch { blockers.push('workspace: assigned directory is not accessible and writable'); }
  const integrity = db.raw.pragma('quick_check', { simple: true });
  if (integrity !== 'ok') blockers.push('state: database integrity check failed');
  let allocationCents: number | null = null;
  let modelAdvertised = false;
  let modelMetadata: ModelInfo | null = null;
  let inferenceProviderStatus: GatewayInferenceStatus | null = null;
  let inferenceStatusError: string | null = null;
  try {
    allocationCents = await conway.getCreditsBalance();
    if (!Number.isFinite(allocationCents) || allocationCents <= 0) blockers.push('allocation: no positive local allowance');
  } catch { blockers.push('allocation: gateway is unavailable'); }
  try {
    modelMetadata = (await conway.listModels()).find(m => m.id === config.inferenceModel) ?? null;
    modelAdvertised = modelMetadata !== null;
    if (!modelAdvertised) blockers.push('model: configured model is not advertised by the gateway');
    else if (modelMetadata?.available === false) blockers.push('model: configured model is unavailable at the gateway');
  } catch { blockers.push('model: gateway catalog is unavailable'); }
  // Optional native client method uses the authenticated gateway and a bounded timeout.
  // Legacy/mock clients never trigger a direct fallback fetch to their configured URL.
  if (conway.getInferenceStatus) {
    try { inferenceProviderStatus = await conway.getInferenceStatus(); }
    catch (error) { inferenceStatusError = error instanceof Error ? error.message : String(error); }
  }
  if (inferenceProviderStatus && !inferenceProviderStatus.ready) blockers.push(`model: inference provider is ${inferenceProviderStatus.state}`);
  if (inferenceProviderStatus?.model && inferenceProviderStatus.model !== config.inferenceModel) blockers.push('model: provider status does not match configured model');
  const monetary = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const infrastructureExpense = monetary(inferenceProviderStatus?.infrastructure_expense_microusd);
  const externalSpendLimit = monetary(inferenceProviderStatus?.effective_external_spend_limit_microusd);
  const accountingStatus = {
    actualExpenseStatus: infrastructureExpense === null ? 'unknown' : 'gateway_reported',
    infrastructureExpenseMicrousd: infrastructureExpense,
    providerBalanceMicrousd: monetary(inferenceProviderStatus?.provider_balance_microusd),
    declaredPrepaidAllowanceMicrousd: monetary(inferenceProviderStatus?.declared_prepaid_allowance_microusd),
    allowanceSource: inferenceProviderStatus?.allowance_source ?? 'unknown',
    pricingKnown: modelMetadata?.pricingKnown === true,
    pricingSource: modelMetadata?.pricingSource ?? 'unknown',
    note: 'Catalog rates are estimates; declared prepaid allowance is not verified provider balance. Unknown infrastructure expense is not zero expense.',
  };
  const skills = runtimeSkills(db.raw).map(skill => ({ name: skill.name, description: skill.description }));
  for (const name of STARTUP_SKILLS) if (!skills.some(skill => skill.name === name)) blockers.push(`skills: required startup skill missing or disabled: ${name}`);
  const goals = getActiveGoals(db.raw).map(g => ({ id: g.id, title: g.title, status: g.status }));
  const tasks = db.raw.prepare('SELECT status, COUNT(*) AS count FROM task_graph GROUP BY status').all();
  const analysisTools = await getAnalysisToolsReadiness();
  const fingerprint = createHash('sha256').update(JSON.stringify({
    session: db.getKV('startup.audit.session') || 'direct-loop',
    mission, workspace, model: config.inferenceModel, gateway: config.conwayApiUrl,
    credentials: [config.conwayApiKey, config.openaiApiKey, config.anthropicApiKey],
    provider: inferenceProviderStatus && { mode: inferenceProviderStatus.mode, model: inferenceProviderStatus.model, billingMode: inferenceProviderStatus.billing_mode, allowanceSource: inferenceProviderStatus.allowance_source, limits: inferenceProviderStatus.limits, approvalExpiresAt: inferenceProviderStatus.approval_expires_at, declaredAllowanceMicrousd: inferenceProviderStatus.declared_prepaid_allowance_microusd, effectiveExternalSpendLimitMicrousd: inferenceProviderStatus.effective_external_spend_limit_microusd },
    modelMetadata,
    routing: config.modelStrategy, maxTokensPerTurn: config.maxTokensPerTurn,
    installedTools: db.getInstalledTools().map(t => ({ name: t.name, enabled: t.enabled, config: t.config })),
    tools: tools.map(t => t.name).sort(),
    skills: runtimeSkills(db.raw).map(s => ({ name: s.name, instructions: s.instructions })),
  })).digest('hex');
  const previous = readStartupAudit(db);
  const assessment: StartupAssessment = previous?.fingerprint === fingerprint && previous.assessment
    ? previous.assessment : { status: 'pending', evidence: [], blockers: [], attempts: 0 };
  const audit = {
    bootId: previous?.fingerprint === fingerprint ? previous.bootId : randomUUID(), fingerprint,
    timestamp: new Date().toISOString(), preflightStatus: blockers.length ? 'blocked' : 'ready',
    status: blockers.length || assessment.status === 'blocked' ? 'blocked' : assessment.status === 'complete' ? 'ready' : 'pending', assessment,
    mission, workspace, stateIntegrity: integrity, model: config.inferenceModel, modelAdvertised,
    modelInferenceTested: assessment.inferenceVerified === true,
    modelMetadata, inferenceProviderStatus: inferenceProviderStatus ?? { state: 'unknown', ready: null, error: inferenceStatusError },
    accountingMode: inferenceProviderStatus?.billing_mode ?? 'unknown', accountingStatus,
    externalSpendLimitCents: externalSpendLimit === null ? null : externalSpendLimit / 10_000,
    interruptedOperatorMessages: db.raw.prepare("SELECT key, value FROM kv WHERE key LIKE 'operator.interrupted:%' ORDER BY updated_at DESC LIMIT 20").all(),
    allocationCents, goals, tasks, skills, previousTurns: db.getTurnCount(),
    tools: tools.map(t => t.name), blockers,
    browser: await getBrowserReadiness({ workspace }),
    analysisTools: Object.fromEntries(Object.entries(analysisTools).map(([name, result]) => [name, { available: result.available, error: result.error, exitCode: result.exitCode }])),
    limitations: ['Gateway provider metadata is reported, not independent proof of expense or provider balance. Missing metadata and unknown infrastructure expenses remain unknown.',
      'Tool inventory is registration, not a successful live test of every tool.',
      'Skill load receipts prove delivery of instructions, not model compliance.',
      'Browser readiness checks the CLI version only; live page interaction and model competence require separate tests. No executable MCP transport is provided.',
      'Acceptance checks establish their stated scope only; report semantics and missing criteria require additional evidence.'],
    recovery: 'Retry transient failures within limits; choose another authorized approach; checkpoint blocked work and continue independent goals. Retry unavailable prerequisites on a later wake. Reconcile interrupted operator requests against tool logs and confirmed effects before planning further work; never blindly replay an action with an unknown outcome. Never fabricate access, funds, or successful results.',
  };
  saveStartupAudit(db, audit);
  return audit;
}

export function createSelfAuditTool(getTools: () => AutomatonTool[]): AutomatonTool {
  return {
    name: 'self_audit', description: 'Refresh deterministic prerequisite observations for your own assessment. Preserves this boot assessment and its evidence; does not perform the model self-assessment or prove tool/model competence.',
    category: 'memory', riskLevel: 'safe', parameters: { type: 'object', properties: {} },
    execute: async (_args, context) => JSON.stringify(await auditStartup(context, getTools())),
  };
}

export interface StartupAssessment {
  status: 'pending' | 'blocked' | 'complete';
  attempts: number;
  evidence: ToolCallResult[];
  blockers: string[];
  inferenceVerified?: boolean;
  completedAt?: string;
  report?: Record<string, unknown>;
  operatorInputIds?: string[];
}
export interface StartupAudit {
  bootId: string; fingerprint: string; timestamp: string;
  preflightStatus: string; status: string; assessment: StartupAssessment;
  mission: string; workspace: string; model: string; modelInferenceTested: boolean;
  allocationCents: number | null; modelMetadata: ModelInfo | null; tools: string[]; blockers: string[];
  [key: string]: unknown;
}
/** Call once per actual runtime launch, never on an ordinary wake or manual refresh. */
export function beginStartupAuditSession(db: AutomatonDatabase): string {
  const id = randomUUID();
  db.setKV('startup.audit.session', id);
  // The prior completed launch is archived; it cannot advertise readiness for this launch.
  db.deleteKV('startup.audit');
  return id;
}
export function readStartupAudit(db: AutomatonDatabase): StartupAudit | undefined {
  try { return JSON.parse(db.getKV('startup.audit') || 'null') ?? undefined; } catch { return undefined; }
}
export function saveStartupAudit(db: AutomatonDatabase, audit: StartupAudit): void {
  db.setKV('startup.audit', JSON.stringify(audit));
  db.setKV(`startup.audit.boot:${audit.bootId}`, JSON.stringify(audit));
}

// Assessment permits scoped operator communication, never mission execution, purchases, task dispatch or arbitrary shell commands.
// Registered tools that are not probed remain explicitly unverified.
const STARTUP_PROBE_TOOLS = new Set([
  'self_audit', 'use_skill', 'list_skills', 'read_file', 'system_synopsis',
  'check_credits', 'payment_status', 'operator_contact_status', 'contact_operator', 'browser_status', 'git_status', 'git_log', 'git_diff',
]);
export function startupProbeTools(tools: AutomatonTool[]): AutomatonTool[] {
  return tools.filter(t => STARTUP_PROBE_TOOLS.has(t.name));
}

export function createCompleteStartupAuditTool(): AutomatonTool {
  const array = { type: 'array', items: { type: 'string' } };
  return {
    name: 'complete_startup_audit', category: 'memory', riskLevel: 'safe',
    description: 'Save YOUR structured startup decision journal after reviewing the objective, loading relevant skills and probing tools and using necessary scoped operator communication. Cite actual tool call IDs for observed capabilities. This is a concise evidence/decision report, never private chain of thought. Blockers prevent mission dispatch.',
    parameters: { type: 'object', properties: {
      objective: { type: 'string' }, goals: array, tools: array, skills: array,
      resources: array, constraints: array, decisionSummary: { type: 'string' },
      capabilities: { type: 'array', items: { type: 'object', properties: {
        name: { type: 'string' }, evidenceIds: array,
      }, required: ['name', 'evidenceIds'] } },
      unverified: array, blockers: array, nextActions: array,
    }, required: ['objective', 'goals', 'tools', 'skills', 'resources', 'constraints', 'decisionSummary', 'capabilities', 'unverified', 'blockers', 'nextActions'] },
    execute: async (args, { db }) => {
      const audit = readStartupAudit(db);
      if (!audit || !audit.assessment.inferenceVerified) throw new Error('Startup assessment requires a successful configured-model inference.');
      if (audit.preflightStatus !== 'ready') throw new Error('Startup prerequisites remain blocked.');
      if (typeof args.objective !== 'string' || !args.objective.trim()
        || typeof args.decisionSummary !== 'string' || !args.decisionSummary.trim()) throw new Error('Describe your objective and concise decision summary.');
      for (const key of ['goals', 'tools', 'skills', 'resources', 'constraints', 'unverified', 'blockers', 'nextActions']) {
        const value = args[key];
        if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !v.trim())
          || (!['unverified', 'blockers'].includes(key) && !value.length)) throw new Error(`A structured ${key} inventory is required.`);
      }
      const evidence = audit.assessment.evidence;
      const successful = evidence.filter(e => {
        if (e.error || /^(Blocked:|ERROR:|Error:)/i.test(e.result)) return false;
        try {
          const response = JSON.parse(e.result);
          return !(response && typeof response === 'object' &&
            (response.ok === false || response.error || ['error', 'failed', 'unknown', 'unavailable'].includes(response.status)));
        } catch { return true; } // Text observations and bounded JSON summaries remain native evidence.
      });
      if (!successful.some(e => e.name === 'use_skill') || !successful.some(e => !['use_skill', 'self_audit'].includes(e.name))) {
        throw new Error('Load a relevant skill and perform a read-only tool probe before completing your self-assessment.');
      }
      if (!(args.skills as string[]).some(name => successful.some(e => e.name === 'use_skill' && e.arguments.name === name))) {
        throw new Error('Skill inventory must include a skill you actually loaded.');
      }
      if (!Array.isArray(args.capabilities) || !args.capabilities.length) throw new Error('Observed capabilities with tool evidence are required.');
      for (const claim of args.capabilities) {
        if (!claim || typeof claim.name !== 'string' || !Array.isArray(claim.evidenceIds) || !claim.evidenceIds.length
          || claim.evidenceIds.some((id: unknown) => !successful.some(e => e.id === id && e.name === claim.name))) {
          throw new Error('Each observed capability must cite successful tool calls for that exact tool.');
        }
      }
      // The report is authored by the model. Add scope limits rather than certifying its semantic correctness.
      audit.assessment.report = { ...args, unverifiedTools: audit.tools.filter(name => !successful.some(e => e.name === name)),
        scope: 'Observed tool responses only; inventory and instruction delivery do not prove task competence.' };
      audit.assessment.blockers = args.blockers as string[];
      audit.assessment.status = audit.assessment.blockers.length ? 'blocked' : 'complete';
      audit.assessment.completedAt = new Date().toISOString();
      audit.status = audit.assessment.status === 'complete' ? 'ready' : 'blocked';
      saveStartupAudit(db, audit);
      return JSON.stringify({ bootId: audit.bootId, status: audit.assessment.status, blockers: audit.assessment.blockers });
    },
  };
}
