import type { CustomTool, TeamRole } from './types.js';
import { uploadCostEvent } from './cost.js';

const BASE = 'https://api.anthropic.com';
const ADVISOR_MODEL = 'claude-opus-4-6';

// Opus 4.6 pricing per million tokens
const ADVISOR_PRICING = { input: 15, output: 75 };

/**
 * Roles with access to the Opus advisor tool. Restricting this set keeps
 * Opus distribution in check — only phase leads + gate roles can escalate.
 * Specialist roles make decisions with their own context.
 */
export const ADVISOR_ROLES: ReadonlySet<TeamRole> = new Set<TeamRole>([
  'intake-analyst',
  'product',
  'design-lead',
  'agent-engineer',
  'pr-reviewer',
  'release-manager',
  'ops-sre',
  'cs-success',
  'sales-lead',
  'marketing-lead',
  'chief-of-staff',
  'external-reviewer',
]);

export function hasAdvisorAccess(role: TeamRole): boolean {
  return ADVISOR_ROLES.has(role);
}

export const ADVISOR_TOOL: CustomTool = {
  type: 'custom',
  name: 'consult_advisor',
  description:
    'LAST RESORT escalation to a senior Opus advisor. Only use when ALL of these are true: (1) the decision is irreversible or expensive to undo, (2) you have already exhausted the context you have, (3) a mistake here will block downstream work. Do NOT use for routine judgment calls, style preferences, implementation choices, or to "check your work." Each call is expensive and capped per session — spend wisely.',
  input_schema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The specific irreversible decision you need guidance on.' },
      context: {
        type: 'string',
        description:
          'What you considered, trade-offs identified, constraints, and why your current context is insufficient.',
      },
    },
    required: ['question', 'context'],
  },
};

interface AdvisorCallContext {
  sessionId?: string;
  agentRole?: string;
  workflow?: string;
}

/**
 * Call Opus as a senior advisor. Returns the advisor's response text.
 * Uploads a cost event tagged source='advisor' so the dashboard can see
 * Opus spend separately from managed-agents spend.
 */
export async function callAdvisor(
  apiKey: string,
  question: string,
  context: string,
  agentRole: string,
  callContext?: AdvisorCallContext,
): Promise<string> {
  const systemPrompt = `You are a senior technical advisor. A ${agentRole} agent on a startup team is escalating a decision to you because it requires deeper reasoning. Provide clear, actionable guidance. Be concise — the agent will act on your advice immediately.`;

  const userMessage = context ? `Question: ${question}\n\nContext: ${context}` : question;

  const res = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: {
      'X-Api-Key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: ADVISOR_MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Advisor call failed (${res.status}): ${text}`);
  }

  const body = (await res.json()) as {
    content: { type: string; text: string }[];
    usage?: { input_tokens: number; output_tokens: number };
  };

  // Fire-and-forget cost upload — tagged as advisor source for separate Opus tracking
  if (body.usage && callContext?.sessionId) {
    const costUsd =
      (body.usage.input_tokens / 1_000_000) * ADVISOR_PRICING.input +
      (body.usage.output_tokens / 1_000_000) * ADVISOR_PRICING.output;
    void uploadCostEvent({
      sessionId: callContext.sessionId,
      agentRole: callContext.agentRole ?? agentRole,
      workflow: callContext.workflow,
      model: ADVISOR_MODEL,
      inputTokens: body.usage.input_tokens,
      outputTokens: body.usage.output_tokens,
      costUsd,
      source: 'advisor',
      timestamp: new Date().toISOString(),
    });
  }

  return body.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
}
