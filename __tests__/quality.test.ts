import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { unlink } from 'node:fs/promises';
import {
  appendQualityRun,
  loadQualityRuns,
  formatQualityTrend,
  gradeToGpa,
  type QualityRun,
} from '../src/quality.js';

const QUALITY_FILE = process.env.FAB_QUALITY_FILE!;

async function cleanup() {
  try {
    await unlink(QUALITY_FILE);
  } catch {
    /* ignore */
  }
}

function run(overrides: Partial<QualityRun> = {}): QualityRun {
  return {
    ts: '2026-06-22T00:00:00.000Z',
    workflow: 'feature-build',
    profile: 'code',
    decision: 'approve',
    attempts: 1,
    internal: { architecture: 'B+', security: 'A-' },
    ...overrides,
  };
}

describe('quality', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('loadQualityRuns returns [] when no file exists', async () => {
    expect(await loadQualityRuns()).toEqual([]);
  });

  it('appendQualityRun + loadQualityRuns roundtrips records in order', async () => {
    await appendQualityRun(run({ ts: '2026-06-20T00:00:00.000Z', workflow: 'a' }));
    await appendQualityRun(run({ ts: '2026-06-21T00:00:00.000Z', workflow: 'b' }));
    const runs = await loadQualityRuns();
    expect(runs.map((r) => r.workflow)).toEqual(['a', 'b']);
    expect(runs[0].internal).toEqual({ architecture: 'B+', security: 'A-' });
  });

  it('appends as JSONL (one record per line), tolerating a trailing newline', async () => {
    await appendQualityRun(run());
    await appendQualityRun(run());
    const runs = await loadQualityRuns();
    expect(runs).toHaveLength(2);
  });

  it('preserves optional external grades and drift', async () => {
    await appendQualityRun(
      run({
        external: { architecture: 'B', security: 'A-' },
        drift: { drifted: ['architecture'], maxDrift: 1 },
      }),
    );
    const [r] = await loadQualityRuns();
    expect(r.external).toEqual({ architecture: 'B', security: 'A-' });
    expect(r.drift).toEqual({ drifted: ['architecture'], maxDrift: 1 });
  });

  describe('gradeToGpa', () => {
    it('maps letters with +/- to a 0–4.3 scale', () => {
      expect(gradeToGpa('A+')).toBeCloseTo(4.3);
      expect(gradeToGpa('A')).toBe(4);
      expect(gradeToGpa('A-')).toBeCloseTo(3.7);
      expect(gradeToGpa('B')).toBe(3);
      expect(gradeToGpa('F')).toBe(0);
    });

    it('returns null for N/A so it is excluded from averages', () => {
      expect(gradeToGpa('N/A')).toBeNull();
    });

    it('floors at 0 (no negative GPA)', () => {
      expect(gradeToGpa('F')).toBe(0);
    });
  });

  describe('formatQualityTrend', () => {
    it('reports an empty-state message with no runs', () => {
      expect(formatQualityTrend([])).toMatch(/No quality runs recorded/);
    });

    it('prefers external grades over internal for the trend', () => {
      const out = formatQualityTrend([
        run({ internal: { architecture: 'A' }, external: { architecture: 'C' } }),
      ]);
      // External C (2.00) wins over internal A (4.00).
      expect(out).toMatch(/architecture\s+1\s+2\.00\s+2\.00/);
    });

    it('counts approvals, calibration coverage and drift in the footer', () => {
      const out = formatQualityTrend([
        run({
          decision: 'approve',
          external: { architecture: 'B' },
          drift: { drifted: [], maxDrift: 0 },
        }),
        run({ decision: 'reject' }),
      ]);
      expect(out).toMatch(/2 runs/);
      expect(out).toMatch(/50% approved/);
      expect(out).toMatch(/50% calibrated/);
      expect(out).toMatch(/0% drifted/);
    });
  });
});
