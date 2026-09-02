import { exec } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tryParseGitHubUrl } from '../src/git.js';
import {
  type GateArtifact,
  redact,
  resolveGateWorkspace,
  shellQuote,
  type ShellRunner,
  workspaceMismatch,
} from '../src/workspace.js';

const execAsync = promisify(exec);

const ARTIFACT: GateArtifact = {
  owner: 'nanohype',
  repo: 'fab',
  branch: 'feat/thing',
  token: 'ghp_secret_token_value',
};

const ok = (stdout = '') => ({ exit: 0, stdout, stderr: '' });
const fail = (stderr = '') => ({ exit: 1, stdout: '', stderr });

/** Answers git questions from a lookup, longest pattern first, and records commands. */
function runner(answers: Record<string, { exit: number; stdout: string; stderr: string }>) {
  const commands: string[] = [];
  const keys = Object.keys(answers).sort((a, b) => b.length - a.length);
  const run: ShellRunner = async (command) => {
    commands.push(command);
    for (const needle of keys) {
      if (command.includes(needle)) return answers[needle]!;
    }
    return ok();
  };
  return { commands, run };
}

/** A checkout that answers every question the way the artifact would. */
function matchingCheckout(
  over: Record<string, { exit: number; stdout: string; stderr: string }> = {},
) {
  return runner({
    'git remote get-url origin': ok('https://github.com/nanohype/fab.git\n'),
    'git rev-parse --abbrev-ref HEAD': ok('feat/thing\n'),
    'git status --porcelain': ok(''),
    'git rev-parse HEAD': ok('abc123def456789\n'),
    'git ls-remote origin': ok('abc123def456789\trefs/heads/feat/thing\n'),
    ...over,
  });
}

describe('tryParseGitHubUrl covers the forms git writes', () => {
  it.each([
    ['git@github.com:nanohype/fab.git', 'nanohype/fab'],
    ['git@github.com:nanohype/fab', 'nanohype/fab'],
    ['https://github.com/nanohype/fab.git', 'nanohype/fab'],
    ['https://github.com/nanohype/fab/', 'nanohype/fab'],
    ['https://github.com/nanohype/fab.git/', 'nanohype/fab'],
    ['https://x-access-token:tok@github.com/nanohype/fab.git', 'nanohype/fab'],
    ['ssh://git@github.com/nanohype/fab.git', 'nanohype/fab'],
    ['ssh://git@github.com:22/nanohype/fab', 'nanohype/fab'],
    ['git://github.com/nanohype/fab.git', 'nanohype/fab'],
    ['  https://github.com/nanohype/fab.git\n', 'nanohype/fab'],
    // scp-like with no userinfo, which git accepts and stores verbatim.
    ['github.com:nanohype/fab.git', 'nanohype/fab'],
    ['github.com:nanohype/fab', 'nanohype/fab'],
    // The host is a DNS name, so its case carries no meaning.
    ['https://GitHub.com/nanohype/fab', 'nanohype/fab'],
    ['GIT@GITHUB.COM:nanohype/fab.git', 'nanohype/fab'],
  ])('reads %s', (url, expected) => {
    // A checkout git produced in any of these forms is the same checkout; a
    // comparison that refuses one of them calls a genuine tree a different one.
    const p = tryParseGitHubUrl(url);
    expect(p && `${p.owner}/${p.repo}`).toBe(expected);
  });

  it.each([
    'https://gitlab.com/nanohype/fab.git',
    'git@example.com:nanohype/fab.git',
    '',
    'origin',
  ])('returns null for %s', (url) => {
    expect(tryParseGitHubUrl(url)).toBeNull();
  });
});

describe('shellQuote', () => {
  it('survives spaces and quotes in a path', () => {
    expect(shellQuote('/tmp/a b/c')).toBe("'/tmp/a b/c'");
    expect(shellQuote("/tmp/it's")).toBe(`'/tmp/it'\\''s'`);
  });
});

describe('workspaceMismatch', () => {
  it('accepts a checkout that is the artifact at the branch head, clean', async () => {
    expect(await workspaceMismatch('/w', ARTIFACT, matchingCheckout().run)).toBeNull();
  });

  it('names what it found and what it wanted', async () => {
    expect(
      await workspaceMismatch(
        '/w',
        ARTIFACT,
        matchingCheckout({
          'git remote get-url origin': ok('https://github.com/other/repo\n'),
        }).run,
      ),
    ).toBe('it is a checkout of other/repo, not nanohype/fab');

    expect(
      await workspaceMismatch(
        '/w',
        ARTIFACT,
        matchingCheckout({ 'git rev-parse --abbrev-ref HEAD': ok('main\n') }).run,
      ),
    ).toBe('it is on branch "main", not the branch under gate "feat/thing"');
  });

  it('refuses a tree with uncommitted work, counting it', async () => {
    // The phases would measure work that is not on the branch under gate.
    expect(
      await workspaceMismatch(
        '/w',
        ARTIFACT,
        matchingCheckout({ 'git status --porcelain': ok(' M src/a.ts\n?? src/b.ts\n') }).run,
      ),
    ).toBe(
      'it has 2 uncommitted change(s), so the phases would measure work that is not on the branch under gate',
    );
  });

  it('refuses a branch behind the remote, naming both commits', async () => {
    // The common case on the default transport: roles push through the API and
    // the operator's checkout never moves.
    expect(
      await workspaceMismatch(
        '/w',
        ARTIFACT,
        matchingCheckout({
          'git ls-remote origin': ok('999999999999999\trefs/heads/feat/thing\n'),
        }).run,
      ),
    ).toBe('it is at commit abc123def456, while the branch under gate is at 999999999999');
  });

  it('asks the remote at gate time, not a captured commit', async () => {
    const r = matchingCheckout();
    await workspaceMismatch('/w', ARTIFACT, r.run);
    expect(r.commands.some((c) => c.startsWith('git ls-remote origin '))).toBe(true);
    expect(r.commands.some((c) => c.includes("'refs/heads/feat/thing'"))).toBe(true);
  });

  it('refuses when the remote has no such branch', async () => {
    expect(
      await workspaceMismatch(
        '/w',
        ARTIFACT,
        matchingCheckout({ 'git ls-remote origin': ok('') }).run,
      ),
    ).toMatch(/remote has no branch "feat\/thing"/);
  });

  it('refuses a directory that is not a checkout, and a non-GitHub one', async () => {
    expect(
      await workspaceMismatch('/w', ARTIFACT, runner({ 'git remote get-url origin': fail() }).run),
    ).toMatch(/not a git checkout with an origin remote/);
    expect(
      await workspaceMismatch(
        '/w',
        ARTIFACT,
        matchingCheckout({ 'git remote get-url origin': ok('https://gitlab.com/nanohype/fab\n') })
          .run,
      ),
    ).toMatch(/not a GitHub remote/);
  });
});

describe('resolveGateWorkspace', () => {
  const fetchDeps = () => {
    const written: [string, string, number][] = [];
    const removed: string[] = [];
    return {
      written,
      removed,
      makeTempDir: async () => '/tmp/gate dir',
      writeSecret: async (path: string, body: string, mode: number) => {
        written.push([path, body, mode]);
      },
      removeDir: async (p: string) => {
        removed.push(p);
      },
    };
  };

  it('has nothing to run against when there is no artifact', async () => {
    const r = runner({});
    const got = await resolveGateWorkspace({ artifact: null, declared: '/anywhere', run: r.run });
    expect(got).toMatchObject({ kind: 'unavailable' });
    expect((got as { reason: string }).reason).toMatch(/no artifact under gate/);
    expect(r.commands).toEqual([]);
  });

  it('uses a declared workspace that is the artifact, and fetches nothing', async () => {
    const r = matchingCheckout();
    const got = await resolveGateWorkspace({
      artifact: ARTIFACT,
      declared: '/checkout',
      run: r.run,
    });
    expect(got).toMatchObject({ kind: 'ready', cwd: '/checkout', source: 'declared' });
    expect(r.commands.some((c) => c.includes('clone --depth 1'))).toBe(false);
  });

  it('fetches when the declared workspace is not the artifact, and says why', async () => {
    // The artifact still exists on the remote, so a local tree that does not
    // match is a reason to fetch rather than a reason to give up.
    const notes: string[] = [];
    const deps = fetchDeps();
    const r = matchingCheckout({ 'git rev-parse --abbrev-ref HEAD': ok('main\n') });
    const got = await resolveGateWorkspace({
      artifact: ARTIFACT,
      declared: '/checkout',
      run: r.run,
      note: (m) => notes.push(m),
      ...deps,
    });
    expect(got).toMatchObject({ kind: 'ready', source: 'fetched' });
    expect(notes.join()).toContain('not the artifact under gate');
    expect(notes.join()).toContain('not the branch under gate');
    expect(r.commands.some((c) => c.includes('clone --depth 1'))).toBe(true);
  });

  it('keeps the token out of every argument vector', async () => {
    const deps = fetchDeps();
    const r = runner({});
    await resolveGateWorkspace({
      artifact: ARTIFACT,
      declared: null,
      run: r.run,
      ...deps,
    });
    // Not in the clone, and not in what the helper itself runs: an argument is
    // readable by anything on the host that can list processes.
    for (const command of r.commands) expect(command).not.toContain(ARTIFACT.token);
    const helper = deps.written.find(([p]) => p.endsWith('askpass.sh'))!;
    expect(helper[1]).not.toContain(ARTIFACT.token);
    expect(helper[1]).toContain('cat ');
    expect(helper[2]).toBe(0o700);

    const tokenFile = deps.written.find(([p]) => p.endsWith('token'))!;
    expect(tokenFile[1]).toBe(ARTIFACT.token);
    expect(tokenFile[2]).toBe(0o600);
  });

  it('fetches with the operator git configuration excluded', async () => {
    const deps = fetchDeps();
    const r = runner({});
    await resolveGateWorkspace({ artifact: ARTIFACT, declared: null, run: r.run, ...deps });
    const clone = r.commands.find((c) => c.includes('clone --depth 1'))!;
    // A configured credential helper would outlive the checkout by storing the
    // artifact token, and credentials the operator holds for github.com would
    // be offered ahead of it.
    expect(clone).toContain('git -c credential.helper= clone');
    expect(clone).toContain('GIT_CONFIG_GLOBAL=/dev/null');
    expect(clone).toContain('GIT_CONFIG_NOSYSTEM=1');
    expect(clone).toContain('GIT_TERMINAL_PROMPT=0');
    expect(clone).toContain('--depth 1');
    expect(clone).toContain('--single-branch');
  });

  it('quotes every path it interpolates', async () => {
    const deps = fetchDeps();
    const r = runner({});
    await resolveGateWorkspace({ artifact: ARTIFACT, declared: null, run: r.run, ...deps });
    const clone = r.commands.find((c) => c.includes('clone --depth 1'))!;
    // The temp directory is chosen by the operating system and can contain a
    // space; unquoted it becomes two arguments and the fetch fails.
    expect(clone).toContain(shellQuote('/tmp/gate dir/checkout'));
    expect(clone).toContain(shellQuote('/tmp/gate dir/askpass.sh'));
    expect(clone).toContain(shellQuote('feat/thing'));
  });

  it('reports a failed fetch without printing the token, and leaves nothing behind', async () => {
    const deps = fetchDeps();
    const got = await resolveGateWorkspace({
      artifact: ARTIFACT,
      declared: null,
      run: runner({
        'clone --depth 1': {
          exit: 128,
          stdout: '',
          stderr: `fatal: ${ARTIFACT.token} is not authorized`,
        },
      }).run,
      ...deps,
    });
    expect(got.kind).toBe('unavailable');
    const reason = (got as { reason: string }).reason;
    expect(reason).toContain('nanohype/fab@feat/thing');
    expect(reason).not.toContain(ARTIFACT.token);
    expect(reason).toContain('***');
    expect(deps.removed).toEqual(['/tmp/gate dir']);
  });

  it('releases a fetched tree and does not release a declared one', async () => {
    const deps = fetchDeps();
    const fetched = await resolveGateWorkspace({
      artifact: ARTIFACT,
      declared: null,
      run: runner({}).run,
      ...deps,
    });
    await (fetched as { release: () => Promise<void> }).release();
    expect(deps.removed).toEqual(['/tmp/gate dir']);

    const deps2 = fetchDeps();
    const declared = await resolveGateWorkspace({
      artifact: ARTIFACT,
      declared: '/checkout',
      run: matchingCheckout().run,
      ...deps2,
    });
    await (declared as { release: () => Promise<void> }).release();
    expect(deps2.removed).toEqual([]);
  });
});

describe('redact', () => {
  it('removes every occurrence and tolerates an empty token', () => {
    expect(redact('a tok b tok', 'tok')).toBe('a *** b ***');
    expect(redact('unchanged', '')).toBe('unchanged');
  });
});

// ── Against real checkouts ──────────────────────────────────────────
//
// The two states a remote-and-branch comparison cannot see are a branch behind
// its remote and a tree with uncommitted work. Both are asserted here against
// git itself rather than a fake, because both are properties of git's own
// bookkeeping — `git status --porcelain`, `git rev-parse HEAD` and
// `git ls-remote` all run for real against a local bare repository.
//
// One question is answered rather than run: `git remote get-url origin`, which
// reports the GitHub form the comparison parses. A local remote cannot be a
// github.com URL, and `insteadOf` rewriting reaches `get-url` as well as the
// transport, so a fixture that tried to disguise the path would be testing the
// disguise. Remote identity is covered by the cases above; what these two prove
// is the freshness and cleanliness checks, which is what they are here for.

describe('workspaceMismatch against real checkouts', () => {
  const GH = `https://github.com/${ARTIFACT.owner}/${ARTIFACT.repo}.git`;
  let root: string;
  let clone: string;
  let realRun: ShellRunner;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'fab-ws-real-'));
    const bare = join(root, 'remote.git');
    const seed = join(root, 'seed');
    clone = join(root, 'clone');
    const git = 'git -c user.email=t@e.invalid -c user.name=t';

    await execAsync(`git init -q --bare ${shellQuote(bare)}`);
    await execAsync(
      [
        `git init -q -b ${ARTIFACT.branch} ${shellQuote(seed)}`,
        `cd ${shellQuote(seed)}`,
        'echo one > file.txt',
        `${git} add -A`,
        `${git} commit -q -m one`,
        `git remote add origin ${shellQuote(bare)}`,
        `git push -q origin ${ARTIFACT.branch}`,
      ].join(' && '),
      { shell: '/bin/sh' },
    );
    await execAsync(
      `git clone -q --branch ${ARTIFACT.branch} ${shellQuote(bare)} ${shellQuote(clone)}`,
      { shell: '/bin/sh' },
    );

    realRun = async (command, cwd) => {
      if (command === 'git remote get-url origin') {
        return { exit: 0, stdout: `${GH}\n`, stderr: '' };
      }
      try {
        const { stdout, stderr } = await execAsync(command, { cwd, encoding: 'utf-8' });
        return { exit: 0, stdout, stderr };
      } catch (err) {
        const e = err as { code?: number; stdout?: string; stderr?: string };
        return { exit: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
      }
    };

    // The fixture is only evidence if it starts out matching.
    expect(await workspaceMismatch(clone, ARTIFACT, realRun)).toBeNull();
  }, 60_000);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('refuses a tree with uncommitted work', async () => {
    writeFileSync(join(clone, 'file.txt'), 'edited\n');
    const reason = await workspaceMismatch(clone, ARTIFACT, realRun);
    expect(reason).toMatch(/uncommitted change/);
    await execAsync('git checkout -- file.txt', { cwd: clone });
    expect(await workspaceMismatch(clone, ARTIFACT, realRun)).toBeNull();
  }, 30_000);

  it('refuses a branch behind the commit the remote carries', async () => {
    // What a role pushing through the API does to an operator's checkout.
    const seed = join(root, 'seed');
    await execAsync(
      [
        `cd ${shellQuote(seed)}`,
        'echo two > file.txt',
        'git -c user.email=t@e.invalid -c user.name=t commit -q -am two',
        `git push -q origin ${ARTIFACT.branch}`,
      ].join(' && '),
      { shell: '/bin/sh' },
    );
    const reason = await workspaceMismatch(clone, ARTIFACT, realRun);
    expect(reason).toMatch(/while the branch under gate is at/);
  }, 30_000);
});

// ── The fetch, executed ─────────────────────────────────────────────
//
// Every case above short-circuits before git runs, so what they prove is the
// shape of the command line. These two run it: the composed flag set against a
// real repository, and the credential helper the flags point at.

describe('the composed fetch runs', () => {
  let root: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'fab-fetch-'));
    const bare = join(root, ARTIFACT.owner, `${ARTIFACT.repo}.git`);
    const seed = join(root, 'seed');
    await execAsync(`git init -q --bare ${shellQuote(bare)}`, { shell: '/bin/sh' });
    await execAsync(
      [
        `git init -q -b ${ARTIFACT.branch} ${shellQuote(seed)}`,
        `cd ${shellQuote(seed)}`,
        'echo one > file.txt',
        'git add file.txt',
        'git -c user.email=t@e.invalid -c user.name=t commit -q -m one',
        `git remote add origin ${shellQuote(bare)}`,
        `git push -q origin ${ARTIFACT.branch}`,
      ].join(' && '),
      { shell: '/bin/sh' },
    );
  }, 60_000);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('fetches the branch with the flags it composes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fab-gate-real-'));
    try {
      const got = await resolveGateWorkspace({
        artifact: ARTIFACT,
        declared: null,
        // The real runner: git is what decides whether the command is valid.
        run: async (command, cwd) => {
          try {
            const { stdout, stderr } = await execAsync(command, { cwd, encoding: 'utf-8' });
            return { exit: 0, stdout, stderr };
          } catch (err) {
            const e = err as { code?: number; stdout?: string; stderr?: string };
            return { exit: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
          }
        },
        originBase: `file://${root}`,
        makeTempDir: async () => dir,
        removeDir: async () => {},
      });
      expect(got.kind).toBe('ready');
      if (got.kind !== 'ready') return;
      expect(got.source).toBe('fetched');
      // A shallow single-branch checkout of the branch under gate, on disk.
      expect(readFileSync(join(got.cwd, 'file.txt'), 'utf-8').trim()).toBe('one');
      const branch = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: got.cwd });
      expect(branch.stdout.trim()).toBe(ARTIFACT.branch);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('writes a credential helper that prints the token when git runs it', async () => {
    // What GIT_ASKPASS points at has to work as a program, not merely exist.
    const dir = mkdtempSync(join(tmpdir(), 'fab-gate-askpass-'));
    try {
      await resolveGateWorkspace({
        artifact: ARTIFACT,
        declared: null,
        run: async () => ({ exit: 1, stdout: '', stderr: 'not run here' }),
        makeTempDir: async () => dir,
        removeDir: async () => {},
      });
      const { stdout } = await execAsync(`sh ${shellQuote(join(dir, 'askpass.sh'))}`, {
        shell: '/bin/sh',
      });
      expect(stdout).toBe(ARTIFACT.token);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
