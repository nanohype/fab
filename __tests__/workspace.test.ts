import { describe, it, expect } from 'vitest';
import {
  type GateArtifact,
  identifyWorkspace,
  parseGitHubRemote,
  redact,
  resolveGateWorkspace,
  type ShellRunner,
  workspaceMismatch,
} from '../src/workspace.js';

const ARTIFACT: GateArtifact = {
  owner: 'nanohype',
  repo: 'fab',
  branch: 'feat/thing',
  token: 'ghp_secret_token_value',
};

const ok = (stdout = '') => ({ exit: 0, stdout, stderr: '' });
const fail = (stderr = '') => ({ exit: 1, stdout: '', stderr });

/** Records every command it is given and answers from a lookup. */
function runner(answers: Record<string, { exit: number; stdout: string; stderr: string }>) {
  const commands: string[] = [];
  const run: ShellRunner = async (command) => {
    commands.push(command);
    for (const [needle, answer] of Object.entries(answers)) {
      if (command.includes(needle)) return answer;
    }
    return ok();
  };
  return { commands, run };
}

const checkoutOf = (remote: string, branch: string) =>
  runner({
    'remote get-url': ok(`${remote}\n`),
    'rev-parse --abbrev-ref': ok(`${branch}\n`),
  });

describe('parseGitHubRemote', () => {
  it.each([
    ['git@github.com:nanohype/fab.git', 'nanohype/fab'],
    ['git@github.com:nanohype/fab', 'nanohype/fab'],
    ['https://github.com/nanohype/fab.git', 'nanohype/fab'],
    ['https://github.com/nanohype/fab', 'nanohype/fab'],
    ['https://x-access-token:tok@github.com/nanohype/fab.git', 'nanohype/fab'],
    ['  https://github.com/nanohype/fab.git\n', 'nanohype/fab'],
  ])('reads %s', (url, expected) => {
    // A checkout made by `gh` and one made by `git clone` disagree on the form.
    expect(parseGitHubRemote(url)).toBe(expected);
  });

  it.each([
    'https://gitlab.com/nanohype/fab.git',
    'git@example.com:nanohype/fab.git',
    '',
    'origin',
  ])('returns null for %s', (url) => {
    expect(parseGitHubRemote(url)).toBeNull();
  });
});

describe('workspaceMismatch', () => {
  it('accepts the artifact', () => {
    expect(
      workspaceMismatch(
        { remote: 'git@github.com:nanohype/fab.git', branch: 'feat/thing' },
        ARTIFACT,
      ),
    ).toBeNull();
  });

  it('ignores case in the repository name but not the branch', () => {
    // GitHub treats owner/repo case-insensitively; git refs are case-sensitive.
    expect(
      workspaceMismatch(
        { remote: 'https://github.com/NanoHype/Fab', branch: 'feat/thing' },
        ARTIFACT,
      ),
    ).toBeNull();
    expect(
      workspaceMismatch(
        { remote: 'https://github.com/nanohype/fab', branch: 'Feat/Thing' },
        ARTIFACT,
      ),
    ).toMatch(/not the branch under gate/);
  });

  it('names what it found and what it wanted', () => {
    expect(
      workspaceMismatch(
        { remote: 'https://github.com/other/repo', branch: 'feat/thing' },
        ARTIFACT,
      ),
    ).toBe('the workspace is a checkout of other/repo, not nanohype/fab');
    expect(
      workspaceMismatch({ remote: 'https://github.com/nanohype/fab', branch: 'main' }, ARTIFACT),
    ).toBe('the workspace is on branch "main", not the branch under gate "feat/thing"');
  });

  it('refuses a directory that is not a checkout, and a non-GitHub one', () => {
    expect(workspaceMismatch(null, ARTIFACT)).toMatch(/not a git checkout/);
    expect(
      workspaceMismatch(
        { remote: 'https://gitlab.com/nanohype/fab', branch: 'feat/thing' },
        ARTIFACT,
      ),
    ).toMatch(/not a GitHub remote/);
  });
});

describe('identifyWorkspace', () => {
  it('reports the remote and branch', async () => {
    const r = checkoutOf('git@github.com:nanohype/fab.git', 'feat/thing');
    expect(await identifyWorkspace('/w', r.run)).toEqual({
      remote: 'git@github.com:nanohype/fab.git',
      branch: 'feat/thing',
    });
  });

  it('is null when the directory has no origin, or no resolvable HEAD', async () => {
    expect(await identifyWorkspace('/w', runner({ 'remote get-url': fail() }).run)).toBeNull();
    expect(
      await identifyWorkspace('/w', runner({ 'rev-parse --abbrev-ref': fail() }).run),
    ).toBeNull();
  });
});

describe('resolveGateWorkspace', () => {
  it('has nothing to run against when there is no artifact', async () => {
    const r = runner({});
    const got = await resolveGateWorkspace({ artifact: null, declared: '/anywhere', run: r.run });
    expect(got).toMatchObject({ kind: 'unavailable' });
    expect((got as { reason: string }).reason).toMatch(/no artifact under gate/);
    // Nothing was inspected, because there was nothing to compare against.
    expect(r.commands).toEqual([]);
  });

  it('uses a declared workspace that is the artifact, and clones nothing', async () => {
    const r = checkoutOf('https://github.com/nanohype/fab.git', 'feat/thing');
    const got = await resolveGateWorkspace({
      artifact: ARTIFACT,
      declared: '/checkout',
      run: r.run,
    });
    expect(got).toMatchObject({ kind: 'ready', cwd: '/checkout' });
    expect(r.commands.some((c) => c.includes('git clone'))).toBe(false);
  });

  it('refuses a declared workspace that is a different tree', async () => {
    const r = checkoutOf('https://github.com/someone/else.git', 'feat/thing');
    const got = await resolveGateWorkspace({
      artifact: ARTIFACT,
      declared: '/checkout',
      run: r.run,
    });
    expect(got.kind).toBe('unavailable');
    expect((got as { reason: string }).reason).toContain('/checkout');
    expect((got as { reason: string }).reason).toContain('someone/else');
    expect(r.commands.some((c) => c.includes('git clone'))).toBe(false);
  });

  it('fetches the branch when no workspace is declared', async () => {
    const r = runner({});
    const written: [string, string][] = [];
    const got = await resolveGateWorkspace({
      artifact: ARTIFACT,
      declared: null,
      run: r.run,
      makeTempDir: async () => '/tmp/gate',
      writeSecret: async (path, body) => {
        written.push([path, body]);
      },
      removeDir: async () => {},
    });
    expect(got).toMatchObject({ kind: 'ready', cwd: '/tmp/gate/checkout' });

    const clone = r.commands.find((c) => c.includes('git clone'))!;
    expect(clone).toContain('--depth 1');
    expect(clone).toContain('--single-branch');
    expect(clone).toContain('--branch feat/thing');
    expect(clone).toContain('https://github.com/nanohype/fab.git');
    // The token is readable by anything that can list processes if it rides on
    // the command line, so it travels in a 0700 file instead.
    expect(clone).not.toContain(ARTIFACT.token);
    expect(written).toHaveLength(1);
    expect(written[0]![1]).toContain(ARTIFACT.token);
  });

  it('reports a failed fetch without printing the token', async () => {
    const removed: string[] = [];
    const got = await resolveGateWorkspace({
      artifact: ARTIFACT,
      declared: null,
      run: runner({
        'git clone': {
          exit: 128,
          stdout: '',
          stderr: `fatal: ${ARTIFACT.token} is not authorized`,
        },
      }).run,
      makeTempDir: async () => '/tmp/gate',
      writeSecret: async () => {},
      removeDir: async (p) => {
        removed.push(p);
      },
    });
    expect(got.kind).toBe('unavailable');
    const reason = (got as { reason: string }).reason;
    expect(reason).toContain('nanohype/fab@feat/thing');
    expect(reason).not.toContain(ARTIFACT.token);
    expect(reason).toContain('***');
    // A checkout that was never made must not be left behind.
    expect(removed).toEqual(['/tmp/gate']);
  });

  it('releases the fetched tree', async () => {
    const removed: string[] = [];
    const got = await resolveGateWorkspace({
      artifact: ARTIFACT,
      declared: null,
      run: runner({}).run,
      makeTempDir: async () => '/tmp/gate',
      writeSecret: async () => {},
      removeDir: async (p) => {
        removed.push(p);
      },
    });
    expect(got.kind).toBe('ready');
    await (got as { release: () => Promise<void> }).release();
    expect(removed).toEqual(['/tmp/gate']);
  });

  it('does not release a declared workspace it did not create', async () => {
    const removed: string[] = [];
    const r = checkoutOf('https://github.com/nanohype/fab', 'feat/thing');
    const got = await resolveGateWorkspace({
      artifact: ARTIFACT,
      declared: '/checkout',
      run: r.run,
      removeDir: async (p) => {
        removed.push(p);
      },
    });
    await (got as { release: () => Promise<void> }).release();
    expect(removed).toEqual([]);
  });
});

describe('redact', () => {
  it('removes every occurrence and tolerates an empty token', () => {
    expect(redact('a tok b tok', 'tok')).toBe('a *** b ***');
    expect(redact('unchanged', '')).toBe('unchanged');
  });
});
