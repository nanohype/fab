import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const PERF_FILE = join(process.cwd(), '.fab-perf.json');

export interface RoleMetrics {
  sessions: number;
  selfEvalPass: number;
  selfEvalFail: number;
  advisorCalls: number;
  revisions: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  /**
   * What the run cost, as the ceiling priced it.
   *
   * Carried rather than derived from the token totals: the ceiling accumulates
   * per-request spans at the running model and the transport's own run total
   * replaces that at idle, and neither is recoverable from two summed counters
   * afterwards. A second pricing pass over a coarser input answers a different
   * question than the one a spend dashboard is asking.
   */
  totalCostUsd: number;
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
  totalCostUsd: 0,
  lastActive: '',
};

export async function loadPerf(): Promise<PerfData> {
  try {
    const raw = await readFile(PERF_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, Partial<RoleMetrics>>;
    // A table written before a field existed is missing it, and a row read back
    // short of one renders as a gap rather than a zero. Filling from the empty
    // row costs nothing and keeps a reader from having to know which fields are
    // older than which file.
    const filled: PerfData = {};
    for (const [role, m] of Object.entries(parsed)) filled[role] = { ...EMPTY_METRICS, ...m };
    return filled;
  } catch {
    return {};
  }
}

async function savePerf(data: PerfData): Promise<void> {
  await writeFile(PERF_FILE, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

// Serialize the read-modify-write of .fab-perf.json so concurrent role sessions
// (a parallel workflow batch) can't clobber each other's increments.
let writeChain: Promise<void> = Promise.resolve();

/**
 * What one role session produced, counted by the consumer that watched it.
 *
 * Every field is something the event stream carries, which is why this is the
 * shape recorded rather than a session id to go and ask about afterwards: the
 * stream is the one surface every transport has. A transport-specific read —
 * fetching the session and its events back from an API — measures the one
 * transport that has that API, and measures the others as zero.
 */
export interface SessionObservation {
  readonly role: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly advisorCalls: number;
  readonly selfEvalPass: number;
  readonly selfEvalFail: number;
  readonly revisions: number;
}

/**
 * Fold one session's observation into the per-role table.
 *
 * Serialized against any in-flight record so a parallel batch of role sessions
 * cannot lose an increment to a concurrent write.
 */
export function recordSessionMetrics(observation: SessionObservation): Promise<void> {
  const run = writeChain.then(() => recordSessionMetricsInner(observation));
  // Keep the chain alive even if one record rejects.
  writeChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

async function recordSessionMetricsInner(o: SessionObservation): Promise<void> {
  const perf = await loadPerf();
  const m = perf[o.role] ?? { ...EMPTY_METRICS };
  m.sessions += 1;
  m.totalInputTokens += o.inputTokens;
  m.totalOutputTokens += o.outputTokens;
  m.totalCostUsd += o.costUsd;
  m.advisorCalls += o.advisorCalls;
  m.selfEvalPass += o.selfEvalPass;
  m.selfEvalFail += o.selfEvalFail;
  m.revisions += o.revisions;
  m.lastActive = new Date().toISOString();
  perf[o.role] = m;
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
    lines.push(
      `${role.padEnd(22)} ${String(m.sessions).padStart(4)} ${String(m.selfEvalPass).padStart(4)} ${String(m.selfEvalFail).padStart(4)} ${String(m.advisorCalls).padStart(4)} ${String(m.revisions).padStart(4)} ${fmtTok(m.totalInputTokens).padStart(10)} ${fmtTok(m.totalOutputTokens).padStart(10)} ${('$' + m.totalCostUsd.toFixed(2)).padStart(8)}`,
    );
  }

  const totals = roles.reduce(
    (acc, [, m]) => ({
      sessions: acc.sessions + m.sessions,
      input: acc.input + m.totalInputTokens,
      output: acc.output + m.totalOutputTokens,
      cost: acc.cost + m.totalCostUsd,
    }),
    { sessions: 0, input: 0, output: 0, cost: 0 },
  );
  lines.push(
    `${DIM}${'TOTAL'.padEnd(22)} ${String(totals.sessions).padStart(4)} ${''.padStart(4)} ${''.padStart(4)} ${''.padStart(4)} ${''.padStart(4)} ${fmtTok(totals.input).padStart(10)} ${fmtTok(totals.output).padStart(10)} ${('$' + totals.cost.toFixed(2)).padStart(8)}${RESET}`,
  );

  return lines.join('\n');
}

function fmtTok(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}
