import { exec } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRuntime } from '../src/runtime.js';
import { LANGUAGE_TOOLCHAIN } from '../src/standards.js';
import { PRE_HOOK_PHASES, type PreHookPhase } from '../src/prehook.js';
import { shellQuote, type ShellRunner } from '../src/workspace.js';
import { type RoleRunner, runGatePreHook, runMergeGate } from '../src/workflows.js';

// ── The pre-hook against a real workspace ───────────────────────────
//
// Every other runMergeGate test injects a stubbed pre-hook, and prehook.ts's
// default runner is excluded from the coverage floor because it shells out.
// Between those two, a gate that spawns nothing at all satisfies the rest of
// the suite. What is asserted here is the path from runMergeGate through
// runGatePreHook to a subprocess — a real workspace, the real
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
//
// The fixture is a git checkout of the artifact under gate, because that is
// what the pre-hook resolves against — a directory that merely holds a manifest
// is not the artifact. The identity questions are answered against a local bare
// repository rather than github.com, so this file stays offline; which trees
// count as the artifact is settled in the workspace cases, and what is settled
// here is that a real subprocess runs and what the roles are handed.

/** Printed by the passing fixture's `test` phase; a stub has no way to emit it. */
const OBSERVED_TOKEN = 'four-phase-pre-hook-observed-stdout';

const PHASE_LOG = 'phases.log';

const execAsync = promisify(exec);

/** The artifact the fixtures are checkouts of. */
const ARTIFACT = {
  token: 'unused-when-the-workspace-is-the-artifact',
  owner: 'nanohype',
  repo: 'gate-fixture',
  branch: 'feat/gate-fixture',
} as const;

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
  // The phases write into the tree; without this the first case would leave it
  // dirty and the next would be refused for work that is not the artifact's.
  await writeFile(join(dir, '.gitignore'), 'node_modules/\nphases.log\n');
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
  // The pre-hook identifies a workspace by its remote, its branch, its commit
  // against the remote branch, and whether anything is uncommitted. The fixture
  // satisfies all four against a bare repository beside it.
  const bare = `${dir}.git`;
  await execAsync(`git init -q --bare ${shellQuote(bare)}`);
  await execAsync(
    [
      `git init -q -b ${ARTIFACT.branch}`,
      'git add .gitignore package.json package-lock.json *.cjs',
      'git -c user.email=fixture@example.invalid -c user.name=fixture commit -q -m fixture',
      `git remote add origin ${shellQuote(bare)}`,
      `git push -q origin ${ARTIFACT.branch}`,
    ].join(' && '),
    { cwd: dir, shell: '/bin/sh' },
  );
  return dir;
}

/**
 * Answers the remote-identity question, refuses the fetch, and runs every other
 * git command for real.
 *
 * A local remote cannot be a github.com URL and git rewrites reach
 * `remote get-url` as well as the transport, so a fixture that disguised the
 * path would be testing the disguise. The fetch is refused because reaching for
 * the artifact over the network is out of scope here; that it is attempted, and
 * what the roles are told when it cannot happen, is what these cases assert.
 */
const fixtureGit: ShellRunner = async (command, cwd) => {
  if (command.includes('clone --depth 1')) {
    // Reaching for the artifact over the network is out of scope here; that a
    // fetch is attempted, and what the roles are told when it cannot happen, is
    // what these cases assert.
    return { exit: 128, stdout: '', stderr: 'fatal: no network in this fixture' };
  }
  if (command === 'git remote get-url origin') {
    return {
      exit: 0,
      stdout: `https://github.com/${ARTIFACT.owner}/${ARTIFACT.repo}.git\n`,
      stderr: '',
    };
  }
  try {
    const { stdout, stderr } = await execAsync(command, { cwd, encoding: 'utf-8' });
    return { exit: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { exit: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
};

/** The production pre-hook, with the git questions answered against the fixture. */
const localPreHook = (artifact: Parameters<typeof runGatePreHook>[0]) =>
  runGatePreHook(artifact, { run: fixtureGit });

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
    // Passing the artifact also arms CITATIONS prefetching. A 404 is the
    // documented non-blocking outcome, so the gate's decision here is the
    // pre-hook's and nothing else's.
    vi.stubGlobal('fetch', async () => new Response('not found', { status: 404 }));
  });

  afterEach(() => {
    logSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('rejects a failing phase before a role runs, and a process is what noticed', async () => {
    process.env.FAB_WORKSPACE = failing;
    const roles: string[] = [];
    const runRole: RoleRunner = async (_rt, role) => {
      roles.push(role);
      return APPROVE_WITH_EVIDENCE;
    };

    // The production pre-hook, with the git questions answered against the
    // fixture — the phases below are real subprocesses either way.
    const result = await runMergeGate(
      runtime,
      'wf',
      'docs',
      'ctx',
      ARTIFACT,
      runRole,
      localPreHook,
    );

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

    const result = await runMergeGate(
      runtime,
      'wf',
      'docs',
      'ctx',
      ARTIFACT,
      runRole,
      localPreHook,
    );

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

  it('passes over a workspace that is not the artifact, and reaches for the artifact', async () => {
    // A tree with the right manifest and the wrong identity is the defect this
    // closes: the phases would run, exit 0, and the transcripts would reach the
    // roles labelled observed while describing a different repository. The
    // artifact still exists on the remote, so the local tree is passed over and
    // the branch is fetched — here that fetch cannot happen, and the roles are
    // told the build is unverified rather than handed the wrong tree.
    process.env.FAB_WORKSPACE = passing;
    const seen: string[] = [];
    const runRole: RoleRunner = async (_rt, _role, message) => {
      seen.push(message);
      return APPROVE_WITH_EVIDENCE;
    };

    const elsewhere = { ...ARTIFACT, repo: 'a-different-repository' };
    const result = await runMergeGate(
      runtime,
      'wf',
      'docs',
      'ctx',
      elsewhere,
      runRole,
      localPreHook,
    );

    // Not a rejection — the build is unverified, which is a different thing
    // from broken, and the roles are told which.
    expect(result.decision).toBe('approve');
    expect(seen.length).toBeGreaterThan(0);
    for (const message of seen) {
      expect(message).toContain('DID NOT RUN');
      expect(message).toContain('UNVERIFIED');
      expect(message).toContain('a-different-repository');
      // The observed marker belongs to the other tree's transcripts; if it
      // reaches a role here, the wrong tree was run and reported as observed.
      expect(message).not.toContain(OBSERVED_TOKEN);
    }
  }, 120_000);

  it('passes over a workspace on a branch that is not the one under gate', async () => {
    process.env.FAB_WORKSPACE = passing;
    const seen: string[] = [];
    const runRole: RoleRunner = async (_rt, _role, message) => {
      seen.push(message);
      return APPROVE_WITH_EVIDENCE;
    };

    const otherBranch = { ...ARTIFACT, branch: 'feat/something-else' };
    await runMergeGate(runtime, 'wf', 'docs', 'ctx', otherBranch, runRole, localPreHook);

    // A loop over an empty list asserts nothing, so rejecting every gate would
    // otherwise survive this case.
    expect(seen.length).toBeGreaterThan(0);
    for (const message of seen) {
      expect(message).toContain('DID NOT RUN');
      expect(message).toContain('feat/something-else');
      expect(message).not.toContain(OBSERVED_TOKEN);
    }
  }, 120_000);

  it('runs the production default when no pre-hook is supplied', async () => {
    // Every other case here injects the git questions, which leaves the default
    // binding — process.env.FAB_WORKSPACE and the real shell runner wired into
    // runGatePreHook — exercised by nothing. This case takes the one path
    // through it that reaches an answer without a network: no artifact to name.
    process.env.FAB_WORKSPACE = passing;
    const seen: string[] = [];
    const runRole: RoleRunner = async (_rt, _role, message) => {
      seen.push(message);
      return APPROVE_WITH_EVIDENCE;
    };

    await runMergeGate(runtime, 'wf', 'docs', 'ctx', null, runRole);

    expect(seen.length).toBeGreaterThan(0);
    for (const message of seen) {
      expect(message).toContain('DID NOT RUN');
      expect(message).toContain('no artifact under gate');
      expect(message).not.toContain(OBSERVED_TOKEN);
    }
  }, 120_000);

  it('reads the declared workspace from the environment', async () => {
    // The other half of the default binding: which directory the git questions
    // are asked in comes from FAB_WORKSPACE, not from where fab was launched.
    process.env.FAB_WORKSPACE = passing;
    const asked: { command: string; cwd: string }[] = [];
    await runGatePreHook(ARTIFACT, {
      run: async (command, cwd) => {
        asked.push({ command, cwd });
        return { exit: 1, stdout: '', stderr: 'stop here' };
      },
    });
    expect(asked.length).toBeGreaterThan(0);
    expect(asked[0]!.cwd).toBe(passing);
  }, 120_000);

  it('reports no artifact as unverified rather than running somewhere', async () => {
    process.env.FAB_WORKSPACE = passing;
    const seen: string[] = [];
    const runRole: RoleRunner = async (_rt, _role, message) => {
      seen.push(message);
      return APPROVE_WITH_EVIDENCE;
    };

    await runMergeGate(runtime, 'wf', 'docs', 'ctx', null, runRole, localPreHook);

    expect(seen.length).toBeGreaterThan(0);
    for (const message of seen) {
      expect(message).toContain('no artifact under gate');
      expect(message).not.toContain(OBSERVED_TOKEN);
    }
  }, 120_000);
});
