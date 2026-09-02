import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tryParseGitHubUrl } from './git.js';

// ── The tree the gate's mechanical step runs against ────────────────
//
// The four-phase pre-hook is the one step in the merge gate that observes
// rather than asks a role to report, and its transcripts reach every gate role
// under an instruction to treat them as observed. That instruction is only
// true if the transcripts came from the artifact under gate.
//
// A workspace resolved from the operator's shell is not that artifact. It is
// whatever directory `fab` happened to be launched from — frequently a
// different repository, and on the default transport never in step with the
// branch the roles are pushing to, since the roles commit through the GitHub
// API and the operator's checkout is untouched. Running `npm ci` there and
// forwarding the result as observed evidence is the failure the pre-hook exists
// to prevent, arriving through the pre-hook itself.
//
// So the artifact names the tree. A local checkout is used only when it is
// provably the same commit with nothing uncommitted on top; anything else is
// fetched.

/** The artifact under gate: a branch on a GitHub repository. */
export interface GateArtifact {
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
  readonly token: string;
}

/** Runs one shell command and reports its exit code and output. */
export type ShellRunner = (
  command: string,
  cwd: string,
) => Promise<{ exit: number; stdout: string; stderr: string }>;

export type WorkspaceResolution =
  | {
      readonly kind: 'ready';
      readonly cwd: string;
      readonly source: 'declared' | 'fetched';
      readonly release: () => Promise<void>;
    }
  | { readonly kind: 'unavailable'; readonly reason: string };

/** Single-quote a path for a shell command line, so a space in it is not two words. */
export function shellQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

/**
 * The reason a checkout is not the artifact, or null when it is.
 *
 * Four questions, because passing three of them still admits a tree the roles
 * are not reviewing: a different repository, the same repository on another
 * branch, the right branch behind the commit the roles pushed, and the right
 * commit with uncommitted work on top. The third is the common one — on the
 * default transport the local branch is behind by construction once a role has
 * pushed — and it is the one a remote-and-branch comparison cannot see.
 */
export async function workspaceMismatch(
  cwd: string,
  artifact: GateArtifact,
  run: ShellRunner,
): Promise<string | null> {
  const want = `${artifact.owner}/${artifact.repo}`;

  const remote = await run('git remote get-url origin', cwd);
  if (remote.exit !== 0) {
    return `it is not a git checkout with an origin remote, so it cannot be shown to be ${want}@${artifact.branch}`;
  }
  const have = tryParseGitHubUrl(remote.stdout.trim());
  if (!have) {
    return `its origin remote "${remote.stdout.trim()}" is not a GitHub remote, so it cannot be shown to be ${want}`;
  }
  if (`${have.owner}/${have.repo}`.toLowerCase() !== want.toLowerCase()) {
    return `it is a checkout of ${have.owner}/${have.repo}, not ${want}`;
  }

  const branch = await run('git rev-parse --abbrev-ref HEAD', cwd);
  if (branch.exit !== 0 || branch.stdout.trim() !== artifact.branch) {
    return `it is on branch "${branch.stdout.trim() || '(none)'}", not the branch under gate "${artifact.branch}"`;
  }

  const dirty = await run('git status --porcelain', cwd);
  if (dirty.exit !== 0) {
    return `its working tree state could not be read: ${dirty.stderr.trim() || `git status exited ${dirty.exit}`}`;
  }
  if (dirty.stdout.trim() !== '') {
    const count = dirty.stdout.trim().split('\n').length;
    return `it has ${count} uncommitted change(s), so the phases would measure work that is not on the branch under gate`;
  }

  // Asked of the remote at gate time rather than compared against a commit
  // captured when the branch was created: the roles push between those two
  // moments, which is exactly the drift this catches.
  const head = await run('git rev-parse HEAD', cwd);
  const remoteHead = await run(
    `git ls-remote origin ${shellQuote(`refs/heads/${artifact.branch}`)}`,
    cwd,
  );
  if (head.exit !== 0 || remoteHead.exit !== 0) {
    return `its commit could not be compared with the remote branch: ${
      (remoteHead.stderr || head.stderr).trim() || 'git exited non-zero'
    }`;
  }
  const remoteSha = remoteHead.stdout.trim().split(/\s+/)[0] ?? '';
  if (remoteSha === '') {
    return `the remote has no branch "${artifact.branch}" to compare its commit against`;
  }
  if (head.stdout.trim() !== remoteSha) {
    return `it is at commit ${short(head.stdout)}, while the branch under gate is at ${short(remoteSha)}`;
  }
  return null;
}

const short = (sha: string): string => sha.trim().slice(0, 12);

export interface ResolveWorkspaceOptions {
  /** The artifact under gate. Null means the caller has none to name. */
  readonly artifact: GateArtifact | null;
  /** An operator-supplied checkout, used when it proves to be the artifact. */
  readonly declared: string | null;
  readonly run: ShellRunner;
  /** Where a rejected declared workspace is reported. */
  readonly note?: (message: string) => void;
  /**
   * Where the repository is fetched from. The default is GitHub; a test points
   * it at a local repository so the composed command is executed rather than
   * only inspected.
   */
  readonly originBase?: string;
  readonly makeTempDir?: () => Promise<string>;
  readonly writeSecret?: (path: string, body: string, mode: number) => Promise<void>;
  readonly removeDir?: (path: string) => Promise<void>;
}

const defaultTempDir = (): Promise<string> => mkdtemp(join(tmpdir(), 'fab-gate-'));
const defaultWriteSecret = (path: string, body: string, mode: number): Promise<void> =>
  writeFile(path, body, { encoding: 'utf-8', mode });
const defaultRemoveDir = (path: string): Promise<void> =>
  rm(path, { recursive: true, force: true });

/**
 * A tree that is the artifact under gate, or the reason there is not one.
 *
 * A declared workspace is checked rather than trusted; being handed a path is
 * not evidence about what is in it. One that fails the check is not fatal — the
 * artifact still exists on the remote — so the branch is fetched instead, and
 * the reason the local tree was passed over is reported rather than swallowed.
 *
 * A fetch is shallow and single-branch because the phases need the tree at that
 * commit and nothing else, and it is a fresh checkout, which is the condition
 * FOUR_PHASE_CONTRACT states the phases must exit 0 from.
 */
export async function resolveGateWorkspace(
  opts: ResolveWorkspaceOptions,
): Promise<WorkspaceResolution> {
  const { artifact, declared, run } = opts;

  if (!artifact) {
    return {
      kind: 'unavailable',
      reason:
        'no artifact under gate — the gate was invoked without a repository and branch, so there is no tree the four phases could be run against and be about',
    };
  }

  if (declared) {
    const mismatch = await workspaceMismatch(declared, artifact, run);
    if (!mismatch) {
      return { kind: 'ready', cwd: declared, source: 'declared', release: async () => {} };
    }
    opts.note?.(
      `FAB_WORKSPACE=${declared} is not the artifact under gate — ${mismatch}. Fetching ${artifact.owner}/${artifact.repo}@${artifact.branch} instead.`,
    );
  }

  return fetchArtifact(opts, artifact);
}

async function fetchArtifact(
  opts: ResolveWorkspaceOptions,
  artifact: GateArtifact,
): Promise<WorkspaceResolution> {
  const makeTempDir = opts.makeTempDir ?? defaultTempDir;
  const writeSecret = opts.writeSecret ?? defaultWriteSecret;
  const removeDir = opts.removeDir ?? defaultRemoveDir;

  const dir = await makeTempDir();
  const release = () => removeDir(dir);
  try {
    // The token is read from a file the helper prints, never passed as an
    // argument to anything: a process argument is readable by any process on
    // the host that can list processes, and that includes the helper's own.
    const tokenFile = join(dir, 'token');
    const askpass = join(dir, 'askpass.sh');
    await writeSecret(tokenFile, artifact.token, 0o600);
    await writeSecret(askpass, `#!/bin/sh\ncat ${shellQuote(tokenFile)}\n`, 0o700);

    const checkout = join(dir, 'checkout');
    const url = `${opts.originBase ?? 'https://github.com'}/${artifact.owner}/${artifact.repo}.git`;
    // The operator's git configuration is excluded rather than inherited. A
    // configured credential helper would store the artifact's token past the
    // life of this checkout, and credentials the operator already has for
    // github.com would be offered ahead of it.
    const clone = [
      `GIT_ASKPASS=${shellQuote(askpass)}`,
      'GIT_TERMINAL_PROMPT=0',
      'GIT_CONFIG_GLOBAL=/dev/null',
      'GIT_CONFIG_NOSYSTEM=1',
      'git -c credential.helper=',
      'clone --depth 1 --single-branch --branch',
      shellQuote(artifact.branch),
      shellQuote(url),
      shellQuote(checkout),
    ].join(' ');

    const result = await opts.run(clone, dir);
    if (result.exit !== 0) {
      await release();
      return {
        kind: 'unavailable',
        reason: `could not fetch ${artifact.owner}/${artifact.repo}@${artifact.branch}: ${
          redact(result.stderr || result.stdout, artifact.token).trim() ||
          `git clone exited ${result.exit}`
        }`,
      };
    }
    return { kind: 'ready', cwd: checkout, source: 'fetched', release };
  } catch (err) {
    await release();
    return {
      kind: 'unavailable',
      reason: `could not prepare a checkout of ${artifact.owner}/${artifact.repo}@${artifact.branch}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Remove a token from text that is about to be shown.
 *
 * git reports the URL it was working with in several of its failure messages,
 * and a reason string reaches the gate roles, the terminal and the PR body.
 */
export function redact(text: string, token: string): string {
  return token.length > 0 ? text.split(token).join('***') : text;
}
