import { getAnalysisToolsReadiness } from '../integrations/analysis-tools.js';
import { runtimeSkills, STARTUP_SKILLS } from '../skills/runtime.js';
import fs from 'node:fs';
import path from 'node:path';
import type { AutomatonTool, ToolContext } from '../types.js';
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

export async function auditStartup(context: ToolContext, tools: AutomatonTool[]) {
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
  try {
    allocationCents = await conway.getCreditsBalance();
    if (!Number.isFinite(allocationCents) || allocationCents <= 0) blockers.push('allocation: no positive local allowance');
  } catch { blockers.push('allocation: gateway is unavailable'); }
  try {
    modelAdvertised = (await conway.listModels()).some(m => m.id === config.inferenceModel);
    if (!modelAdvertised) blockers.push('model: configured model is not advertised by the gateway');
  } catch { blockers.push('model: gateway catalog is unavailable'); }
  const skills = runtimeSkills(db.raw).map(skill => ({ name: skill.name, description: skill.description }));
  for (const name of STARTUP_SKILLS) if (!skills.some(skill => skill.name === name)) blockers.push(`skills: required startup skill missing or disabled: ${name}`);
  const goals = getActiveGoals(db.raw).map(g => ({ id: g.id, title: g.title, status: g.status }));
  const tasks = db.raw.prepare('SELECT status, COUNT(*) AS count FROM task_graph GROUP BY status').all();
  const analysisTools = await getAnalysisToolsReadiness();
  const audit = {
    timestamp: new Date().toISOString(), status: blockers.length ? 'blocked' : 'ready',
    mission, workspace, stateIntegrity: integrity, model: config.inferenceModel, modelAdvertised,
    modelInferenceTested: false, accountingMode: 'simulation', externalSpendLimitCents: 0,
    allocationCents, goals, tasks, skills, previousTurns: db.getTurnCount(),
    tools: tools.map(t => t.name), blockers,
    analysisTools: Object.fromEntries(Object.entries(analysisTools).map(([name, result]) => [name, { available: result.available, error: result.error, exitCode: result.exitCode }])),
    limitations: ['Tool inventory is registration, not a successful live test of every tool.',
      'Skill load receipts prove delivery of instructions, not model compliance.',
      'No executable MCP transport or browser/desktop adapter is provided.',
      'Acceptance checks establish their stated scope only; report semantics and missing criteria require additional evidence.'],
    recovery: 'Retry transient failures within limits; choose another authorized approach; checkpoint blocked work and continue independent goals. Retry unavailable prerequisites on a later wake. Never fabricate access, funds, or successful results.',
  };
  db.setKV('startup.audit', JSON.stringify(audit));
  return audit;
}

export function createSelfAuditTool(getTools: () => AutomatonTool[]): AutomatonTool {
  return {
    name: 'self_audit', description: 'Refresh mission, available tools, workspace, persisted goals, gateway model catalog and local allocation checks. Does not test model quality.',
    category: 'memory', riskLevel: 'safe', parameters: { type: 'object', properties: {} },
    execute: async (_args, context) => JSON.stringify(await auditStartup(context, getTools())),
  };
}
