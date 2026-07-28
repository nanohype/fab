/**
 * Usage aggregation tests.
 *
 * This is what `fab usage` reports and what the budget limit is checked
 * against, so an aggregation bug is a wrong number on a spend decision.
 *
 * The assertions are about the aggregation contract — role attribution,
 * grouping, ordering, the `since` window, and totals agreeing with their parts
 * — not about dollar amounts. `pricing.ts` owns the rate table and is tested
 * where it lives; asserting a hardcoded cost here would only pin the rates in
 * a second place and break both files on the next price change.
 */

import { describe, expect, it } from 'vitest';
import type { AnthropicAgents } from '../src/api.js';
import { aggregateUsage, formatUsageReport } from '../src/usage.js';
import type { FabState, Session, TeamRole } from '../src/types.js';

function session(overrides: {
  id: string;
  agentId?: string;
  model?: string;
  input: number;
  output: number;
  title?: string;
  createdAt?: string;
}): Session {
  return {
    id: overrides.id,
    agent: {
      id: overrides.agentId ?? 'agent_x',
      model: { id: overrides.model ?? 'claude-sonnet-4-6' },
    },
    environment_id: null,
    status: 'idle',
    title: overrides.title ?? null,
    metadata: {},
    usage: { input_tokens: overrides.input, output_tokens: overrides.output },
    stats: { duration_seconds: 1, active_seconds: 1 },
    created_at: overrides.createdAt ?? '2026-07-20T00:00:00Z',
    updated_at: '2026-07-20T00:00:00Z',
    archived_at: null,
    type: 'session',
  } as unknown as Session;
}

function api(sessions: Session[]): AnthropicAgents {
  return {
    listSessions: async () => ({ data: sessions, has_more: false }),
  } as unknown as AnthropicAgents;
}

function state(agents: Array<{ agentId: string; role: TeamRole }>): FabState {
  return { agents } as unknown as FabState;
}

const PR_REVIEWER = 'pr-reviewer' as TeamRole;
const BACKEND = 'backend' as TeamRole;

describe('aggregateUsage', () => {
  it('attributes a session to the role whose agent ran it', async () => {
    const report = await aggregateUsage(
      api([session({ id: 's1', agentId: 'agent_pr', input: 1000, output: 500 })]),
      state([{ agentId: 'agent_pr', role: PR_REVIEWER }]),
    );

    expect(report.roles).toHaveLength(1);
    expect(report.roles[0]).toMatchObject({ role: PR_REVIEWER, sessionCount: 1 });
  });

  it("attributes a session with no matching agent to 'unknown' rather than dropping it", async () => {
    // Spend from a deleted or externally-created agent is still spend. Dropping
    // it would make the report's total quietly disagree with the bill.
    const report = await aggregateUsage(
      api([session({ id: 's1', agentId: 'agent_gone', input: 1000, output: 500 })]),
      state([{ agentId: 'agent_pr', role: PR_REVIEWER }]),
    );

    expect(report.roles[0].role).toBe('unknown');
    expect(report.totalInput).toBe(1000);
  });

  it('folds several sessions of one role into a single row', async () => {
    const report = await aggregateUsage(
      api([
        session({ id: 's1', agentId: 'agent_pr', input: 1000, output: 200 }),
        session({ id: 's2', agentId: 'agent_pr', input: 3000, output: 800 }),
      ]),
      state([{ agentId: 'agent_pr', role: PR_REVIEWER }]),
    );

    expect(report.roles).toHaveLength(1);
    expect(report.roles[0]).toMatchObject({
      sessionCount: 2,
      inputTokens: 4000,
      outputTokens: 1000,
    });
  });

  it('orders roles by cost, most expensive first', async () => {
    const report = await aggregateUsage(
      api([
        session({ id: 's1', agentId: 'agent_be', input: 100, output: 10 }),
        session({ id: 's2', agentId: 'agent_pr', input: 500_000, output: 100_000 }),
      ]),
      state([
        { agentId: 'agent_pr', role: PR_REVIEWER },
        { agentId: 'agent_be', role: BACKEND },
      ]),
    );

    expect(report.roles.map((r) => r.role)).toEqual([PR_REVIEWER, BACKEND]);
    expect(report.roles[0].cost).toBeGreaterThan(report.roles[1].cost);
  });

  it('reports totals that agree with the per-role rows', async () => {
    const report = await aggregateUsage(
      api([
        session({ id: 's1', agentId: 'agent_pr', input: 1000, output: 200 }),
        session({ id: 's2', agentId: 'agent_be', input: 2000, output: 300 }),
      ]),
      state([
        { agentId: 'agent_pr', role: PR_REVIEWER },
        { agentId: 'agent_be', role: BACKEND },
      ]),
    );

    expect(report.totalInput).toBe(3000);
    expect(report.totalOutput).toBe(500);
    expect(report.totalCost).toBeCloseTo(
      report.roles.reduce((sum, r) => sum + r.cost, 0),
      10,
    );
  });

  it('excludes sessions older than the since window', async () => {
    const report = await aggregateUsage(
      api([
        session({
          id: 'old',
          agentId: 'agent_pr',
          input: 9000,
          output: 9000,
          createdAt: '2026-06-01T00:00:00Z',
        }),
        session({
          id: 'new',
          agentId: 'agent_pr',
          input: 1000,
          output: 100,
          createdAt: '2026-07-20T00:00:00Z',
        }),
      ]),
      state([{ agentId: 'agent_pr', role: PR_REVIEWER }]),
      new Date('2026-07-01T00:00:00Z'),
    );

    expect(report.totalInput).toBe(1000);
    expect(report.topSessions.map((s) => s.id)).toEqual(['new']);
  });

  it('caps the session list at ten, keeping the most expensive', async () => {
    const sessions = Array.from({ length: 15 }, (_, i) =>
      session({ id: `s${i}`, agentId: 'agent_pr', input: (i + 1) * 1000, output: 100 }),
    );
    const report = await aggregateUsage(
      api(sessions),
      state([{ agentId: 'agent_pr', role: PR_REVIEWER }]),
    );

    expect(report.topSessions).toHaveLength(10);
    expect(report.topSessions[0].id).toBe('s14');
    // Every role's spend still counts toward the total, not just the top ten.
    expect(report.roles[0].sessionCount).toBe(15);
  });

  it('returns an empty report rather than throwing when there are no sessions', async () => {
    const report = await aggregateUsage(api([]), state([]));

    expect(report).toMatchObject({ roles: [], topSessions: [], totalInput: 0, totalCost: 0 });
  });
});

describe('formatUsageReport', () => {
  it('renders the roles, the totals, and the window', async () => {
    const report = await aggregateUsage(
      api([
        session({
          id: 's1',
          agentId: 'agent_pr',
          input: 1_500_000,
          output: 2000,
          title: 'gate run',
        }),
      ]),
      state([{ agentId: 'agent_pr', role: PR_REVIEWER }]),
    );

    const text = formatUsageReport(report, '2026-07-01');

    expect(text).toContain(PR_REVIEWER);
    expect(text).toContain('2026-07-01');
    // Large token counts are abbreviated so the columns stay readable.
    expect(text).toContain('1.5M');
  });

  it('renders an empty report without crashing', () => {
    const text = formatUsageReport({
      roles: [],
      topSessions: [],
      totalInput: 0,
      totalOutput: 0,
      totalCost: 0,
    });
    expect(typeof text).toBe('string');
  });
});
