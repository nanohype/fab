import { exec } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { LANGUAGE_TOOLCHAIN } from './standards.js';
import type { Language } from './types.js';

// ── Four-phase pre-hook ─────────────────────────────────────────────
//
// MERGE_GATE_CONTRACT's first requirement is a mechanical check that runs
// install → build → lint → test → docs from a checkout and REJECTs on any
// non-zero exit before an LLM gate role is invoked. Everything else in the
// gate is a model reporting on its own work; this is the one step that
// observes rather than asks, which is why it runs first and why its result is
// not something a role can write.
//
// The phases and their commands come from LANGUAGE_TOOLCHAIN, so a language
// added to the standard is dispatched here without a second list to maintain.
//
// A pre-hook that could not run is NOT a pre-hook that passed. `unavailable`
// is a distinct outcome from `failed` and from `ok`, and callers are required
// to handle it rather than falling through — the whole defect this closes was
// a check whose absence read as a pass.

const execAsync = promisify(exec);

/** The phases, in the order the contract runs them. */
export const PRE_HOOK_PHASES = ['install', 'build', 'lint', 'test', 'docs'] as const;
export type PreHookPhase = (typeof PRE_HOOK_PHASES)[number];

export interface PhaseTranscript {
  phase: PreHookPhase;
  command: string;
  exit: number;
  stdout: string;
  stderr: string;
}

export type PreHookStatus = 'ok' | 'failed' | 'unavailable';

export interface PreHookResult {
  status: PreHookStatus;
  /** Captured output per phase actually run, in order. */
  transcripts: PhaseTranscript[];
  /** Why the run failed or could not happen. Absent when status is 'ok'. */
  reason?: string;
}

/** Runs one shell command in `cwd` and reports its exit code and output. */
export type CommandRunner = (
  command: string,
  cwd: string,
) => Promise<{ exit: number; stdout: string; stderr: string }>;

// Bound to `exec` because the toolchain entries are shell command lines
// ("npm ci", "go build ./..."), not argv arrays. Excluded from the coverage
// floor for the same reason attribution.ts's runner is: it shells out, so
// covering it would mean running a real build inside the unit suite.
/* v8 ignore start */
export const shellRunner: CommandRunner = async (command, cwd) => {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: 15 * 60_000,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf-8',
    });
    return { exit: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      exit: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message ?? '',
    };
  }
};
/* v8 ignore stop */

export interface PreHookOptions {
  cwd: string;
  language: Language;
  run?: CommandRunner;
  /** Injected for tests; defaults to a real filesystem check. */
  exists?: (path: string) => Promise<boolean>;
}

const realExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * Run the four-phase contract against a checkout.
 *
 * Stops at the first non-zero exit: the contract rejects on any failure, and
 * the phases are ordered so a later one cannot be meaningful once an earlier
 * one has failed — there is nothing to lint if the install did not complete.
 *
 * Returns `unavailable` when the tree carries no manifest for the declared
 * language. That is deliberately not `failed`: the difference between "the
 * build is broken" and "there was nothing here to build" matters to the caller,
 * and collapsing them would let a mis-pathed workspace read as a broken repo —
 * or, worse in the other direction, let a missing checkout read as a pass.
 */
export async function runFourPhasePreHook(opts: PreHookOptions): Promise<PreHookResult> {
  const toolchain = LANGUAGE_TOOLCHAIN[opts.language];
  const run = opts.run ?? shellRunner;
  const exists = opts.exists ?? realExists;

  if (!(await exists(join(opts.cwd, toolchain.manifest)))) {
    return {
      status: 'unavailable',
      transcripts: [],
      reason: `no ${toolchain.manifest} in ${opts.cwd} — nothing to run the ${opts.language} four-phase contract against`,
    };
  }

  const transcripts: PhaseTranscript[] = [];
  for (const phase of PRE_HOOK_PHASES) {
    const command = toolchain[phase];
    const { exit, stdout, stderr } = await run(command, opts.cwd);
    transcripts.push({ phase, command, exit, stdout, stderr });
    if (exit !== 0) {
      return {
        status: 'failed',
        transcripts,
        reason: `${phase} failed: \`${command}\` exited ${exit}`,
      };
    }
  }

  return { status: 'ok', transcripts };
}

/**
 * Render the transcripts as the TRANSCRIPTS block EVIDENCE_CONTRACT defines,
 * so the observed run — not a role's account of it — is what the gate roles
 * receive and what reaches the PR.
 */
export function formatPreHookTranscripts(result: PreHookResult): string {
  if (result.transcripts.length === 0) return 'TRANSCRIPTS:\n  (pre-hook ran no phases)';
  const body = result.transcripts
    .map((t) => {
      const indent = (s: string) =>
        s.trimEnd().length === 0
          ? '        (empty)'
          : s
              .trimEnd()
              .split('\n')
              .map((l) => `        ${l}`)
              .join('\n');
      return [
        `  - command: ${t.command}`,
        `    phase: ${t.phase}`,
        `    exit: ${t.exit}`,
        '    stdout: |',
        indent(t.stdout),
        '    stderr: |',
        indent(t.stderr),
      ].join('\n');
    })
    .join('\n');
  return `TRANSCRIPTS:\n${body}`;
}
