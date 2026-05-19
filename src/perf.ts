import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AnthropicAgents } from './api.js';
import type { FabState } from './types.js';

const PERF_FILE = join(process.cwd(), '.fab-perf.json');

export interface RoleMetrics {
  sessions: number;
  selfEvalPass: number;
  selfEvalFail: number;
  advisorCalls: number;
  revisions: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  lastActive: string;
}

type PerfData = Record<string, RoleMetrics>;

const EMPTY_METRICS: RoleMetrics = {
  sessions: 0,
  selfEvalPass: 0,
  selfEvalFail: 0,
  advisorCalls: 0,
  revisions: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  lastActive: '',
};

export async function loadPerf(): Promise<PerfData> {
  try {
    const raw = await readFile(PERF_FILE, 'utf-8');
    return JSON.parse(raw) as PerfData;
  } catch {
    return {};
  }
}

async function savePerf(data: PerfData): Promise<void> {
  await writeFile(PERF_FILE, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/**
 * Scan a session's events and update perf metrics for all participating roles.
 */
export async function collectSessionMetrics(api: AnthropicAgents, sessionId: string, state: FabState): Promise<void> {
  const perf = await loadPerf();
  const agentIdToRole = new Map<string, string>();
  for (const a of state.agents) {
    agentIdToRole.set(a.agentId, a.role);
  }

  // Get session to identify the primary agent role
  const session = await api.getSession(sessionId);
  const primaryRole = agentIdToRole.get(session.agent?.id ?? '') ?? 'unknown';

  // Initialize metrics
  if (!perf[primaryRole]) perf[primaryRole] = { ...EMPTY_METRICS };
  perf[primaryRole].sessions++;
  perf[primaryRole].lastActive = new Date().toISOString();

  // Track tokens from session usage
  perf[primaryRole].totalInputTokens += session.usage.input_tokens ?? 0;
  perf[primaryRole].totalOutputTokens += session.usage.output_tokens ?? 0;

  // Scan events for self-eval and advisor patterns
  const result = await api.listEvents(sessionId, 100, 'asc');
  for (const event of result.data) {
    if (event.type === 'agent.message') {
      const text = event.content.map((c) => c.text).join('');
      if (text.includes('SELF-EVAL: PASS')) perf[primaryRole].selfEvalPass++;
      if (text.includes('SELF-EVAL: FAIL')) perf[primaryRole].selfEvalFail++;
      if (text.includes('Revising')) perf[primaryRole].revisions++;
    }
    if (event.type === 'agent.custom_tool_use' && event.name === 'consult_advisor') {
      perf[primaryRole].advisorCalls++;
    }
  }

  await savePerf(perf);
}

/**
 * Format perf data as a table.
 */
export function formatPerfReport(perf: PerfData): string {
  const DIM = process.stdout.isTTY ? '\x1b[2m' : '';
  const BOLD = process.stdout.isTTY ? '\x1b[1m' : '';
  const RESET = process.stdout.isTTY ? '\x1b[0m' : '';

  const roles = Object.entries(perf).sort((a, b) => b[1].sessions - a[1].sessions);

  if (roles.length === 0) return 'No performance data yet. Run some workflows first.';

  const lines: string[] = [];
  lines.push(
    `${BOLD}${'ROLE'.padEnd(22)} ${'SESS'.padStart(4)} ${'PASS'.padStart(4)} ${'FAIL'.padStart(4)} ${'ADV'.padStart(4)} ${'REV'.padStart(4)} ${'IN TOK'.padStart(10)} ${'OUT TOK'.padStart(10)} ${'COST'.padStart(8)}${RESET}`,
  );

  for (const [role, m] of roles) {
    const cost = (m.totalInputTokens / 1e6) * 3 + (m.totalOutputTokens / 1e6) * 15;
    lines.push(
      `${role.padEnd(22)} ${String(m.sessions).padStart(4)} ${String(m.selfEvalPass).padStart(4)} ${String(m.selfEvalFail).padStart(4)} ${String(m.advisorCalls).padStart(4)} ${String(m.revisions).padStart(4)} ${fmtTok(m.totalInputTokens).padStart(10)} ${fmtTok(m.totalOutputTokens).padStart(10)} ${('$' + cost.toFixed(2)).padStart(8)}`,
    );
  }

  const totals = roles.reduce(
    (acc, [_, m]) => ({
      sessions: acc.sessions + m.sessions,
      input: acc.input + m.totalInputTokens,
      output: acc.output + m.totalOutputTokens,
    }),
    { sessions: 0, input: 0, output: 0 },
  );
  const totalCost = (totals.input / 1e6) * 3 + (totals.output / 1e6) * 15;
  lines.push(
    `${DIM}${'TOTAL'.padEnd(22)} ${String(totals.sessions).padStart(4)} ${''.padStart(4)} ${''.padStart(4)} ${''.padStart(4)} ${''.padStart(4)} ${fmtTok(totals.input).padStart(10)} ${fmtTok(totals.output).padStart(10)} ${('$' + totalCost.toFixed(2)).padStart(8)}${RESET}`,
  );

  return lines.join('\n');
}

function fmtTok(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}
