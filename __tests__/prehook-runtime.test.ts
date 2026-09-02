import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRuntime } from '../src/runtime.js';
import { LANGUAGE_TOOLCHAIN } from '../src/standards.js';
import { PRE_HOOK_PHASES, type PreHookPhase } from '../src/prehook.js';
import { type RoleRunner, runMergeGate } from '../src/workflows.js';

// ── The pre-hook against a real workspace ───────────────────────────
//
// Every other runMergeGate test injects a stubbed pre-hook, and prehook.ts's
// default runner is excluded from the coverage floor because it shells out.
// Between those two, the path from runMergeGate through resolvePreHook to a
// subprocess is asserted nowhere: a gate that spawns nothing at all satisfies
// the rest of the suite. That is the shape of the defect this closes, so the
// control has to be the shape of the fix — a real workspace, the real
// toolchain commands, and an observation a stub cannot forge.
//
// Each phase script appends its name to a file in the workspace. A stubbed
// runner returns transcripts; it does not write to disk. The file is therefore
// evidence that a process ran, and its contents are evidence of which phases
// ran and in what order.
//
// Two-sided by construction: the failing fixture must reject with no role
// invoked, and the passing fixture must approve with the observed stdout
// reaching the roles. A control that only ever sees one outcome cannot
// distinguish the gate from a constant.

/** Printed by the passing fixture's `test` phase; a stub has no way to emit it. */
const OBSERVED_TOKEN = 'four-phase-pre-hook-observed-stdout';

const PHASE_LOG = 'phases.log';

type PhaseSpec = { exit: number; stdout?: string };

/**
 * The npm script a toolchain command invokes: `npm run build` names `build`,
 * `npm test` names `test`. Returns null for a command that is not an npm script
 * call, which is how `install` (`npm ci`) is separated from the rest.
 */
function scriptName(command: string): string | null {
  const m = command.match(/^npm (?:run |run-script )?([\w:-]+)$/);
  return m && m[1] !== 'ci' && m[1] !== 'install' ? m[1] : null;
}

/**
 * A dependency-free npm package whose toolchain phases are one-line node
 * scripts. `npm ci` resolves against the empty lockfile without reaching the
 * registry, so the install phase is real without being a network dependency.
 *
 * The script names are derived from LANGUAGE_TOOLCHAIN's own commands rather
 * than restated, so a phase the standard renames is still dispatched here.
 */
async function fixture(phases: Record<string, PhaseSpec>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fab-prehook-'));
  const scripts: Record<string, string> = {};
  for (const [phase, spec] of Object.entries(phases)) {
    const name = scriptName(LANGUAGE_TOOLCHAIN.typescript[phase as PreHookPhase]);
    // A toolchain that stopped dispatching through npm would make this fixture
    // silently cover nothing, so it fails here instead.
    if (!name) throw new Error(`no npm script in the typescript toolchain's ${phase} command`);
    const file = `${phase}.cjs`;
    await writeFile(
      join(dir, file),
      [
        `require('node:fs').appendFileSync(${JSON.stringify(PHASE_LOG)}, ${JSON.stringify(`${phase}\n`)});`,
        spec.stdout ? `console.log(${JSON.stringify(spec.stdout)});` : '',
        `process.exit(${spec.exit});`,
      ]
        .filter(Boolean)
        .join('\n'),
    );
    scripts[name] = `node ${file}`;
  }
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.0', private: true, scripts }, null, 2),
  );
  await writeFile(
    join(dir, 'package-lock.json'),
    JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: { '': { name: 'fixture', version: '1.0.0' } },
    }),
  );
  return dir;
}

/** The phases the standard dispatches through an npm script, i.e. every one but install. */
const SCRIPTED_PHASES = PRE_HOOK_PHASES.filter((p) => scriptName(LANGUAGE_TOOLCHAIN.typescript[p]));

const APPROVE_WITH_EVIDENCE = [
  'GATE_VERDICT: APPROVE',
  'GATE_FEEDBACK: the observed transcripts are clean.',
  '',
  'TRANSCRIPTS:',
  '  - command: npm test',
  '    exit: 0',
  '',
  'CITATIONS:',
  '  - claim: the fixture declares its phases',
  '    file: package.json',
  '    line_range: 1-1',
  '',
  'QUALITY_GRADES:',
  '  documentation: B',
  '  consistency: B',
  '  security: B',
  '  systems: B',
  '  ai_systems: N/A',
].join('\n');

describe('runMergeGate drives the real pre-hook', () => {
  const runtime = {} as AgentRuntime;
  let passing: string;
  let failing: string;
  let priorWorkspace: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    passing = await fixture(
      Object.fromEntries(
        SCRIPTED_PHASES.map((p) => [
          p,
          p === 'test' ? { exit: 0, stdout: OBSERVED_TOKEN } : { exit: 0 },
        ]),
      ),
    );
    failing = await fixture(
      Object.fromEntries(SCRIPTED_PHASES.map((p) => [p, { exit: p === 'build' ? 3 : 0 }])),
    );
    priorWorkspace = process.env.FAB_WORKSPACE;
  });

  afterAll(() => {
    if (priorWorkspace === undefined) delete process.env.FAB_WORKSPACE;
    else process.env.FAB_WORKSPACE = priorWorkspace;
  });

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('rejects a failing phase before a role runs, and a process is what noticed', async () => {
    process.env.FAB_WORKSPACE = failing;
    const roles: string[] = [];
    const runRole: RoleRunner = async (_rt, role) => {
      roles.push(role);
      return APPROVE_WITH_EVIDENCE;
    };

    // No pre-hook argument: this is the production default, resolvePreHook.
    const result = await runMergeGate(runtime, 'wf', 'docs', 'ctx', null, runRole);

    expect(result.decision).toBe('reject');
    // Names the phase, so whoever reads the rejection knows what to re-run.
    expect(result.feedback).toContain('build failed');
    expect(result.feedback).toContain(LANGUAGE_TOOLCHAIN.typescript.build);
    // Unanimous APPROVE was on offer and was never asked for.
    expect(roles).toEqual([]);

    // The file exists only because a subprocess wrote it, and it stops where
    // the contract says the run stops.
    const log = await readFile(join(failing, PHASE_LOG), 'utf-8');
    expect(log.trim().split('\n')).toEqual(['build']);
  }, 120_000);

  it('approves a passing fixture and hands the roles the stdout it observed', async () => {
    process.env.FAB_WORKSPACE = passing;
    const seen: string[] = [];
    const runRole: RoleRunner = async (_rt, _role, message) => {
      seen.push(message);
      return APPROVE_WITH_EVIDENCE;
    };

    const result = await runMergeGate(runtime, 'wf', 'docs', 'ctx', null, runRole);

    expect(result.decision).toBe('approve');
    const log = await readFile(join(passing, PHASE_LOG), 'utf-8');
    expect(log.trim().split('\n')).toEqual([...SCRIPTED_PHASES]);

    expect(seen.length).toBeGreaterThan(0);
    for (const message of seen) {
      // Captured stdout of the run itself, not a role's account of it.
      expect(message).toContain(OBSERVED_TOKEN);
      expect(message).toContain(LANGUAGE_TOOLCHAIN.typescript.install);
    }
  }, 120_000);
});
