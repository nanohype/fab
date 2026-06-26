import { beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory fs so collectSessionMetrics' read-modify-write of .fab-perf.json
// never touches the real working tree.
const files = new Map<string, string>();
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async (p: string) => {
    const v = files.get(p);
    if (v === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return v;
  }),
  writeFile: vi.fn(async (p: string, data: string) => {
    files.set(p, data);
  }),
}));

import { collectSessionMetrics, loadPerf } from '../src/perf.js';
import type { AnthropicAgents } from '../src/api.js';
import type { FabState } from '../src/types.js';

function fakeApi(events: unknown[]): AnthropicAgents {
  return {
    getSession: vi.fn(async () => ({
      agent: { id: 'agent-product' },
      usage: { input_tokens: 1200, output_tokens: 800 },
    })),
    listEvents: vi.fn(async () => ({ data: events })),
  } as unknown as AnthropicAgents;
}

const state = {
  agents: [{ agentId: 'agent-product', role: 'product' }],
} as unknown as FabState;

beforeEach(() => {
  files.clear();
});

describe('collectSessionMetrics', () => {
  it('folds a session into the per-role perf table', async () => {
    const api = fakeApi([
      { type: 'agent.message', content: [{ text: 'SELF-EVAL: PASS' }] },
      { type: 'agent.message', content: [{ text: 'Revising the plan' }] },
      { type: 'agent.custom_tool_use', name: 'consult_advisor' },
    ]);

    await collectSessionMetrics(api, 'sess-1', state);

    const perf = await loadPerf();
    expect(perf.product.sessions).toBe(1);
    expect(perf.product.totalInputTokens).toBe(1200);
    expect(perf.product.totalOutputTokens).toBe(800);
    expect(perf.product.selfEvalPass).toBe(1);
    expect(perf.product.revisions).toBe(1);
    expect(perf.product.advisorCalls).toBe(1);
    expect(perf.product.lastActive).not.toBe('');
  });

  it('accumulates across sessions for the same role', async () => {
    const api = fakeApi([]);
    await collectSessionMetrics(api, 'sess-1', state);
    await collectSessionMetrics(api, 'sess-2', state);

    const perf = await loadPerf();
    expect(perf.product.sessions).toBe(2);
    expect(perf.product.totalInputTokens).toBe(2400);
  });

  it('maps a session whose agent is not in state to the "unknown" role', async () => {
    const api = {
      getSession: vi.fn(async () => ({ agent: { id: 'ghost' }, usage: {} })),
      listEvents: vi.fn(async () => ({ data: [] })),
    } as unknown as AnthropicAgents;

    await collectSessionMetrics(api, 'sess-x', state);

    const perf = await loadPerf();
    expect(perf.unknown.sessions).toBe(1);
  });
});
