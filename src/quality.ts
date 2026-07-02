import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Grade, GradeDrift } from './gate.js';
import type { GateDecision } from './types.js';

// ── Quality trend — the factory's own grade record ──────────────────
//
// The merge gate grades every PR across the 9 QUALITY_RUBRIC dimensions,
// and the external-reviewer calibration re-grades cold. Until now those
// grades drove a single ship/block decision and were discarded. This
// module appends one record per gated run so the factory can answer the
// question it could not before: are my grades trending up or down across
// engagements?
//
// The log lives next to state.json under ~/.fab so the signal spans every
// repo the factory ships — a cross-engagement trend, not one working tree.
// Override with FAB_QUALITY_FILE (used by tests; an escape hatch) — mirrors
// FAB_STATE_FILE. Append-only JSONL: one self-describing record per line,
// cheap to write mid-pipeline and trivial to tail.

function qualityFile(): string {
  return process.env.FAB_QUALITY_FILE ?? join(homedir(), '.fab', 'quality.jsonl');
}

export interface QualityRun {
  ts: string; // ISO timestamp the run was recorded
  workflow: string; // workflow name (e.g. 'feature-build')
  profile: 'code' | 'docs'; // gate profile
  decision: GateDecision; // final gate outcome
  attempts: number; // 1-based revision attempts the gate took
  internal: Record<string, Grade>; // aggregate of the gate roles' QUALITY_GRADES
  external?: Record<string, Grade>; // external-reviewer cold grades (code profile, when parseable)
  drift?: GradeDrift; // calibration drift vs internal (present iff external is)
}

export async function appendQualityRun(run: QualityRun): Promise<void> {
  const file = qualityFile();
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(run) + '\n', 'utf-8');
}

export async function loadQualityRuns(): Promise<QualityRun[]> {
  try {
    const raw = await readFile(qualityFile(), 'utf-8');
    return raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as QualityRun);
  } catch {
    return [];
  }
}

/**
 * Map a letter grade to a 0–4.3 GPA so per-dimension trends are comparable.
 * +/- shift the base letter by 0.3 (F has no minus). N/A and anything
 * unrecognized return null and are excluded from averages — a dimension that
 * doesn't apply carries no signal.
 */
export function gradeToGpa(grade: Grade): number | null {
  if (grade === 'N/A') return null;
  const base: Record<string, number> = { A: 4, B: 3, C: 2, D: 1, F: 0 };
  const letter = grade.charAt(0);
  if (!(letter in base)) return null;
  let value = base[letter];
  if (grade.endsWith('+')) value += 0.3;
  if (grade.endsWith('-')) value -= 0.3;
  return Math.max(0, Math.min(4.3, value));
}

// The effective grade for a dimension prefers the cold external calibration
// (the more objective signal) and falls back to the internal gate grade.
function effectiveGrade(run: QualityRun, dim: string): Grade | undefined {
  return run.external?.[dim] ?? run.internal[dim];
}

const RECENT_WINDOW = 5;

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Render the quality trend across recorded runs as a per-dimension table:
 * overall GPA vs the recent window, with a direction arrow. Declining
 * dimensions are the point — they surface in red.
 */
export function formatQualityTrend(runs: QualityRun[]): string {
  const DIM = process.stdout.isTTY ? '\x1b[2m' : '';
  const BOLD = process.stdout.isTTY ? '\x1b[1m' : '';
  const RED = process.stdout.isTTY ? '\x1b[31m' : '';
  const GREEN = process.stdout.isTTY ? '\x1b[32m' : '';
  const RESET = process.stdout.isTTY ? '\x1b[0m' : '';

  if (runs.length === 0) return 'No quality runs recorded yet. Run a gated workflow first.';

  // Chronological order (records are appended in order, but sort defensively).
  const ordered = [...runs].sort((a, b) => a.ts.localeCompare(b.ts));

  // Per-dimension GPA series in run order, using the effective grade.
  const series = new Map<string, number[]>();
  for (const run of ordered) {
    const dims = new Set([...Object.keys(run.internal), ...Object.keys(run.external ?? {})]);
    for (const dim of dims) {
      const grade = effectiveGrade(run, dim);
      if (!grade) continue;
      const gpa = gradeToGpa(grade);
      if (gpa === null) continue;
      if (!series.has(dim)) series.set(dim, []);
      series.get(dim)!.push(gpa);
    }
  }

  const lines: string[] = [];
  lines.push(`${BOLD}QUALITY TREND${RESET}`);
  lines.push(
    `${BOLD}${'DIMENSION'.padEnd(18)} ${'N'.padStart(4)} ${'OVERALL'.padStart(8)} ${'RECENT'.padStart(8)} ${'TREND'.padStart(6)}${RESET}`,
  );

  for (const [dim, values] of [...series.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const overall = mean(values);
    const recent = mean(values.slice(-RECENT_WINDOW));
    const delta = recent - overall;
    const arrow =
      delta > 0.15 ? `${GREEN}↑${RESET}` : delta < -0.15 ? `${RED}↓${RESET}` : `${DIM}→${RESET}`;
    lines.push(
      `${dim.padEnd(18)} ${String(values.length).padStart(4)} ${overall.toFixed(2).padStart(8)} ${recent.toFixed(2).padStart(8)} ${arrow.padStart(6)}`,
    );
  }

  // Summary footer: run count, approval rate, calibration coverage, drift rate.
  const total = ordered.length;
  const approved = ordered.filter((r) => r.decision === 'approve').length;
  const calibrated = ordered.filter((r) => r.external && Object.keys(r.external).length > 0);
  const drifted = calibrated.filter((r) => (r.drift?.drifted.length ?? 0) > 0).length;
  const pct = (n: number, d: number) => (d === 0 ? 'n/a' : `${Math.round((n / d) * 100)}%`);
  lines.push(
    `${DIM}${total} runs · ${pct(approved, total)} approved · ${pct(calibrated.length, total)} calibrated · ${pct(drifted, calibrated.length)} drifted${RESET}`,
  );

  return lines.join('\n');
}
