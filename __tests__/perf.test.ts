import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory fs so the read-modify-write of .fab-perf.json never touches the
// real working tree.
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

import {
  formatPerfReport,
  loadPerf,
  recordSessionMetrics,
  type SessionObservation,
} from '../src/perf.js';

const observation = (over: Partial<SessionObservation> = {}): SessionObservation => ({
  role: 'product',
  inputTokens: 1200,
  outputTokens: 800,
  costUsd: 0.25,
  advisorCalls: 1,
  selfEvalPass: 1,
  selfEvalFail: 0,
  revisions: 0,
  ...over,
});

beforeEach(() => {
  files.clear();
});

describe('recordSessionMetrics', () => {
  it('folds one session into the per-role table', async () => {
    await recordSessionMetrics(observation());

    const perf = await loadPerf();
    expect(perf.product.sessions).toBe(1);
    expect(perf.product.totalInputTokens).toBe(1200);
    expect(perf.product.totalOutputTokens).toBe(800);
    expect(perf.product.totalCostUsd).toBeCloseTo(0.25, 6);
    expect(perf.product.selfEvalPass).toBe(1);
    expect(perf.product.advisorCalls).toBe(1);
    expect(perf.product.lastActive).not.toBe('');
  });

  it('accumulates across sessions for the same role', async () => {
    await recordSessionMetrics(observation());
    await recordSessionMetrics(observation());

    const perf = await loadPerf();
    expect(perf.product.sessions).toBe(2);
    expect(perf.product.totalInputTokens).toBe(2400);
    expect(perf.product.totalCostUsd).toBeCloseTo(0.5, 6);
  });

  it('keeps one role out of another role’s row', async () => {
    await recordSessionMetrics(observation({ role: 'product' }));
    await recordSessionMetrics(observation({ role: 'pr-reviewer', inputTokens: 7 }));

    const perf = await loadPerf();
    expect(perf.product.totalInputTokens).toBe(1200);
    expect(perf['pr-reviewer'].totalInputTokens).toBe(7);
  });

  it('serializes concurrent records rather than losing one to the other', async () => {
    // A parallel workflow batch runs several role sessions at once, and each
    // ends with a read-modify-write of one file. Two that interleave read the
    // same table and the second write erases the first increment.
    await Promise.all([
      recordSessionMetrics(observation()),
      recordSessionMetrics(observation()),
      recordSessionMetrics(observation()),
    ]);

    const perf = await loadPerf();
    expect(perf.product.sessions).toBe(3);
  });

  it('prints the cost that was recorded, not one re-derived from the tokens', async () => {
    // The table is the surface an operator reads and an exporter would publish.
    // Re-pricing the stored token counts here would put a second number beside
    // the one the ceiling acted on, and the two disagree by construction: the
    // record carries the transport's billed total where it reported one, and a
    // recompute has neither that nor the per-request model.
    await recordSessionMetrics(observation({ inputTokens: 10, outputTokens: 20, costUsd: 1.23 }));

    const report = formatPerfReport(await loadPerf());
    // The role's own line, not the report: a total computed one way and a row
    // computed another both appear in it, and matching anywhere would accept
    // the disagreement this pins.
    const lines = report.split('\n');
    expect(lines.find((l) => l.startsWith('product'))).toContain('$1.23');
    expect(lines.find((l) => l.includes('TOTAL'))).toContain('$1.23');
  });

  it('reads a table written before a field existed as zero, not as a gap', async () => {
    // A row on disk is whatever the version that wrote it knew about. Read back
    // short of a field, it renders as an empty column rather than a zero, and a
    // total over it is NaN.
    files.set(
      join(process.cwd(), '.fab-perf.json'),
      JSON.stringify({ product: { sessions: 1, totalInputTokens: 10 } }),
    );
    const perf = await loadPerf();
    expect(perf.product?.totalCostUsd).toBe(0);
    expect(perf.product?.selfEvalFail).toBe(0);
  });
});
