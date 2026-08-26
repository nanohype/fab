import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PRE_HOOK_PHASES,
  type CommandRunner,
  formatPreHookTranscripts,
  runFourPhasePreHook,
} from '../src/prehook.js';
import { LANGUAGE_TOOLCHAIN } from '../src/standards.js';
import type { Language } from '../src/types.js';

// MERGE_GATE_CONTRACT's first requirement is the only step in the gate that
// observes instead of asking. These hold it to that: the phases it runs come
// from the standard rather than a second list, a non-zero exit stops it, and a
// tree it cannot run against reports `unavailable` rather than passing.

const ok: CommandRunner = async () => ({ exit: 0, stdout: 'fine', stderr: '' });
const present = async () => true;

describe('runFourPhasePreHook', () => {
  it('runs the contract phases in order, taking commands from LANGUAGE_TOOLCHAIN', async () => {
    const seen: string[] = [];
    const run: CommandRunner = async (command) => {
      seen.push(command);
      return { exit: 0, stdout: '', stderr: '' };
    };
    const result = await runFourPhasePreHook({
      cwd: '/w',
      language: 'typescript',
      run,
      exists: present,
    });
    expect(result.status).toBe('ok');
    // Derived from the standard, not restated here: if a toolchain command
    // changes upstream this follows it, and a second list cannot drift.
    expect(seen).toEqual(PRE_HOOK_PHASES.map((p) => LANGUAGE_TOOLCHAIN.typescript[p]));
    expect(result.transcripts.map((t) => t.phase)).toEqual([...PRE_HOOK_PHASES]);
  });

  it('stops at the first non-zero exit and reports which phase failed', async () => {
    const seen: string[] = [];
    const run: CommandRunner = async (command) => {
      seen.push(command);
      return command === LANGUAGE_TOOLCHAIN.typescript.lint
        ? { exit: 2, stdout: '', stderr: 'lint blew up' }
        : { exit: 0, stdout: '', stderr: '' };
    };
    const result = await runFourPhasePreHook({
      cwd: '/w',
      language: 'typescript',
      run,
      exists: present,
    });
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('lint failed');
    // test and docs are never attempted — there is nothing to learn from them
    // once lint has failed, and running them would bury the real failure.
    expect(seen).toHaveLength(3);
    expect(result.transcripts.at(-1)).toMatchObject({ phase: 'lint', exit: 2 });
  });

  it('reports unavailable — not ok — when the tree has no manifest', async () => {
    // The defect this closes was a check whose absence read as a pass. A
    // missing checkout must be its own outcome.
    const result = await runFourPhasePreHook({
      cwd: '/w',
      language: 'go',
      run: ok,
      exists: async () => false,
    });
    expect(result.status).toBe('unavailable');
    expect(result.status).not.toBe('ok');
    expect(result.reason).toContain(LANGUAGE_TOOLCHAIN.go.manifest);
    expect(result.transcripts).toEqual([]);
  });

  it('dispatches every language the standard declares', async () => {
    // The map is the denominator: a language added upstream is covered here
    // without this test being edited.
    for (const language of Object.keys(LANGUAGE_TOOLCHAIN) as Language[]) {
      const seen: string[] = [];
      const result = await runFourPhasePreHook({
        cwd: '/w',
        language,
        run: async (command) => {
          seen.push(command);
          return { exit: 0, stdout: '', stderr: '' };
        },
        exists: present,
      });
      expect(result.status, `${language} pre-hook`).toBe('ok');
      expect(seen, `${language} commands`).toEqual(
        PRE_HOOK_PHASES.map((p) => LANGUAGE_TOOLCHAIN[language][p]),
      );
    }
  });
});

describe('formatPreHookTranscripts', () => {
  it('renders a TRANSCRIPTS block carrying the captured output', async () => {
    const result = await runFourPhasePreHook({
      cwd: '/w',
      language: 'typescript',
      exists: present,
      run: async (command) => ({
        exit: 0,
        stdout: `ran ${command}`,
        stderr: '',
      }),
    });
    const block = formatPreHookTranscripts(result);
    expect(block.startsWith('TRANSCRIPTS:')).toBe(true);
    expect(block).toContain('exit: 0');
    expect(block).toContain('ran npm ci');
    expect(block).toContain('phase: docs');
  });

  it('says so when no phase ran, rather than rendering an empty block', async () => {
    const block = formatPreHookTranscripts({ status: 'unavailable', transcripts: [] });
    expect(block).toContain('ran no phases');
  });
});

describe('the default availability check reads the real filesystem', () => {
  // `exists` decides whether the pre-hook runs at all, so a fault here is a
  // silent skip of the only mechanical step in the gate. Exercised against the
  // real fs rather than the injected stub the tests above use.
  it('finds a manifest that is present and reports unavailable when it is absent', async () => {
    const ran: string[] = [];
    const run: CommandRunner = async (command) => {
      ran.push(command);
      return { exit: 0, stdout: '', stderr: '' };
    };

    // This repository is the fixture: it is a typescript tree with a real
    // package.json, so the default check must find it.
    const here = await runFourPhasePreHook({ cwd: process.cwd(), language: 'typescript', run });
    expect(here.status).toBe('ok');
    expect(ran).toHaveLength(PRE_HOOK_PHASES.length);

    ran.length = 0;
    const nowhere = await runFourPhasePreHook({
      cwd: join(process.cwd(), 'no-such-directory-for-prehook-test'),
      language: 'typescript',
      run,
    });
    expect(nowhere.status).toBe('unavailable');
    expect(ran).toEqual([]);
  });
});
