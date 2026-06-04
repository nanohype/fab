import type { AnthropicAgents } from './api.js';
import type { FabState, Session, SessionUsage, TeamRole } from './types.js';

// ── Pricing — per-MTok rates by model tier (USD, mid-2026 rate card) ──
//
// Opus 4.x $5/$25, Sonnet 4.x $3/$15, Haiku 4.x $1/$5. Cache reads bill at
// 0.1x the input rate, 5-minute cache writes at 1.25x. fab sums the token
// counts the API returns per session — there is no client-side tokenizer — so
// these rates are the only thing to keep current as the rate card changes.

interface ModelRate {
  input: number;
  output: number;
}

const MODEL_RATES: Record<'opus' | 'sonnet' | 'haiku', ModelRate> = {
  opus: { input: 5, output: 25 },
  sonnet: { input: 3, output: 15 },
  haiku: { input: 1, output: 5 },
};

const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

function rateFor(modelId: string | undefined): ModelRate {
  const id = (modelId ?? '').toLowerCase();
  if (id.includes('opus')) return MODEL_RATES.opus;
  if (id.includes('haiku')) return MODEL_RATES.haiku;
  return MODEL_RATES.sonnet; // default covers sonnet and any unmapped id
}

// ── Types ───────────────────────────────────────────────────────────

interface RoleUsage {
  role: TeamRole | 'unknown';
  inputTokens: number;
  outputTokens: number;
  sessionCount: number;
  cost: number;
}

interface SessionEntry {
  id: string;
  role: TeamRole | 'unknown';
  title: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export interface UsageReport {
  roles: RoleUsage[];
  topSessions: SessionEntry[];
  totalInput: number;
  totalOutput: number;
  totalCost: number;
}

// ── Aggregation ─────────────────────────────────────────────────────

function estimateCost(usage: SessionUsage, modelId: string | undefined): number {
  const rate = rateFor(modelId);
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const inputCost =
    (usage.input_tokens / 1_000_000) * rate.input +
    (cacheRead / 1_000_000) * rate.input * CACHE_READ_MULTIPLIER +
    (cacheWrite / 1_000_000) * rate.input * CACHE_WRITE_MULTIPLIER;
  const outputCost = (usage.output_tokens / 1_000_000) * rate.output;
  return inputCost + outputCost;
}

function resolveRole(session: Session, state: FabState): TeamRole | 'unknown' {
  // Match by agent ID in fab state
  const agentId = session.agent?.id;
  if (!agentId) return 'unknown';
  const match = state.agents.find((a) => a.agentId === agentId);
  return match?.role ?? 'unknown';
}

export async function aggregateUsage(api: AnthropicAgents, state: FabState, since?: Date): Promise<UsageReport> {
  const result = await api.listSessions(100);
  let sessions = result.data;

  if (since) {
    sessions = sessions.filter((s) => new Date(s.created_at) >= since);
  }

  // Aggregate by role
  const roleMap = new Map<string, RoleUsage>();
  const sessionEntries: SessionEntry[] = [];

  for (const s of sessions) {
    const role = resolveRole(s, state);
    const input = s.usage.input_tokens;
    const output = s.usage.output_tokens;
    const cost = estimateCost(s.usage, s.agent?.model?.id);

    const existing = roleMap.get(role);
    if (existing) {
      existing.inputTokens += input;
      existing.outputTokens += output;
      existing.sessionCount++;
      existing.cost += cost;
    } else {
      roleMap.set(role, {
        role,
        inputTokens: input,
        outputTokens: output,
        sessionCount: 1,
        cost,
      });
    }

    sessionEntries.push({
      id: s.id,
      role,
      title: s.title ?? '',
      inputTokens: input,
      outputTokens: output,
      cost,
    });
  }

  const roles = [...roleMap.values()].sort((a, b) => b.cost - a.cost);
  const topSessions = sessionEntries.sort((a, b) => b.cost - a.cost).slice(0, 10);

  const totalInput = roles.reduce((sum, r) => sum + r.inputTokens, 0);
  const totalOutput = roles.reduce((sum, r) => sum + r.outputTokens, 0);
  const totalCost = roles.reduce((sum, r) => sum + r.cost, 0);

  return { roles, topSessions, totalInput, totalOutput, totalCost };
}

// ── Formatting ──────────────────────────────────────────────────────

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtCost(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function formatUsageReport(report: UsageReport, since?: string): string {
  const lines: string[] = [];

  const header = since ? `USAGE REPORT — since ${since}` : 'USAGE REPORT';
  lines.push(`${BOLD}${header}${RESET}\n`);

  // Role table
  const roleW = Math.max(4, ...report.roles.map((r) => r.role.length));
  lines.push(
    `${'ROLE'.padEnd(roleW)}  ${'INPUT'.padStart(10)}  ${'OUTPUT'.padStart(10)}  ${'SESSIONS'.padStart(8)}  ${'COST'.padStart(8)}`,
  );
  for (const r of report.roles) {
    lines.push(
      `${r.role.padEnd(roleW)}  ${fmtTokens(r.inputTokens).padStart(10)}  ${fmtTokens(r.outputTokens).padStart(10)}  ${String(r.sessionCount).padStart(8)}  ${fmtCost(r.cost).padStart(8)}`,
    );
  }
  lines.push(
    `${DIM}${'TOTAL'.padEnd(roleW)}  ${fmtTokens(report.totalInput).padStart(10)}  ${fmtTokens(report.totalOutput).padStart(10)}  ${''.padStart(8)}  ${fmtCost(report.totalCost).padStart(8)}${RESET}`,
  );

  // Top sessions
  if (report.topSessions.length > 0) {
    lines.push(`\n${BOLD}TOP SESSIONS${RESET}`);
    for (const s of report.topSessions.slice(0, 5)) {
      lines.push(`  ${s.id}  ${s.role.padEnd(18)}  ${fmtCost(s.cost).padStart(8)}  ${s.title}`);
    }
  }

  return lines.join('\n');
}
