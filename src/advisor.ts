import type { CustomTool, TeamRole } from './types.js';

// ── Senior advisor escalation — fab's own mechanism, deliberately NOT the
// native advisor tool ──────────────────────────────────────────────────
//
// `consult_advisor` is a custom, client-executed tool: a gated role escalates
// one hard decision to a senior Opus advisor (`callAdvisor` makes a separate
// `/v1/messages` call). Three invariants make this fab-specific rather than a
// drop-in for Anthropic's native advisor tool (beta `advisor-tool-2026-03-01`):
//
//   1. Role-gating — only `ADVISOR_ROLES` get the tool, applied at deploy time
//      by `advisorToolsFor` (bin/fab.ts). The native tool is just an entry in a
//      request/agent toolset and carries no role policy of its own.
//   2. Per-SESSION call budget — `streamWithAdvisor` caps escalations across a
//      whole multi-turn session (`maxAdvisorCalls`, default 3). The native
//      tool's `max_uses` is a per-REQUEST cap only; the docs state it has "no
//      built-in conversation-level cap", so a per-session budget there means
//      hand-stripping `advisor_tool_result` blocks from history (fragile).
//   3. Separate pinned Opus — `callAdvisor` always targets `ADVISOR_MODEL`
//      regardless of the caller's model, uniformly across all four transports
//      (the interception lives in the shared stream consumer).
//
// Availability also rules out a swap: the native advisor tool is beta on the
// Claude API and Claude Platform on AWS only — not Bedrock/Vertex/Foundry and
// not in the Managed Agents toolset, i.e. neither fab's default (managed-agents)
// nor regulated (Bedrock) path. Verified against platform.claude.com docs,
// 2026-06. Revisit only if the native tool gains a per-conversation budget AND
// Managed Agents support.

const BASE = 'https://api.anthropic.com';
const ADVISOR_MODEL = 'claude-opus-4-8';

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

/**
 * Call Opus as a senior advisor. Returns the advisor's response text.
 */
export async function callAdvisor(
  apiKey: string,
  question: string,
  context: string,
  agentRole: string,
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

  return body.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
}
