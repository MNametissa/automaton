import { randomUUID } from 'node:crypto';
import type { AutomatonConfig, InferenceResponse } from '../types.js';
import { toolCallResponse } from './mocks.js';

/** Fake configured-model exchanges; real router, skills, tool execution and journal validation. */
export function startupAssessmentResponses(config: AutomatonConfig, goals = [config.genesisPrompt]): InferenceResponse[] {
  const probe = toolCallResponse([
    { name: 'use_skill', arguments: { name: 'ponytail:ponytail' } },
    { name: 'list_skills', arguments: {} },
    { name: 'system_synopsis', arguments: {} },
  ]);
  // Other tests reload mocks with vi.resetModules; these receipts must not share their counters.
  for (const call of probe.toolCalls ?? []) call.id = `startup_${randomUUID()}`;
  const report = toolCallResponse([{ name: 'complete_startup_audit', arguments: {
    objective: config.genesisPrompt, goals, tools: ['list_skills', 'system_synopsis'],
    skills: ['ponytail:ponytail'], resources: ['Assigned local workspace and persisted state'],
    constraints: ['Standalone gateway only', 'No external spending', 'Bounded startup tool and inference allowance'],
    decisionSummary: 'Use the available local tools for the assigned objective, preserve active work and verify each result before claiming success.',
    capabilities: [{ name: 'system_synopsis', evidenceIds: [probe.toolCalls![2].id] }],
    unverified: ['Live browser interaction and mission-specific result quality'], blockers: [],
    nextActions: ['Resume the authorized mission and preserve existing worker assignments'],
  } }]);
  for (const call of report.toolCalls ?? []) call.id = `startup_${randomUUID()}`;
  return [probe, report];
}
