import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── The tree the gate's mechanical step runs against ────────────────
//
// The four-phase pre-hook is the one step in the merge gate that observes
// rather than asks a role to report, and its transcripts reach every gate role
// under an instruction to treat them as observed. That instruction is only
// true if the transcripts came from the artifact under gate.
//
// A workspace resolved from the operator's shell is not that artifact. It is
// whatever directory `fab` happened to be launched from — frequently a
// different repository, and on the default transport never the branch the
// roles are pushing to, since the roles commit through the GitHub API and the
// operator's checkout is untouched. Running `npm ci` there and forwarding the
// result as observed evidence is the failure the pre-hook exists to prevent,
// arriving through the pre-hook itself.
//
// So the artifact names the tree, and there are exactly two ways to get one:
// fetch it, or be handed a checkout that proves it is the same thing. There is
// no third branch that falls back to the current directory.

/** The artifact under gate: a branch on a GitHub repository. */
export interface GateArtifact {
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
  readonly token: string;
}

/** What a checkout reports itself to be. */
export interface WorkspaceIdentity {
  readonly remote: string;
  readonly branch: string;
}

/** Runs one shell command and reports its exit code and output. */
export type ShellRunner = (
  command: string,
  cwd: string,
) => Promise<{ exit: number; stdout: string; stderr: string }>;

export type WorkspaceResolution =
  | { readonly kind: 'ready'; readonly cwd: string; readonly release: () => Promise<void> }
  | { readonly kind: 'unavailable'; readonly reason: string };

/**
 * `owner/repo` for a GitHub remote, or null for anything else.
 *
 * Both URL forms git writes are accepted, with and without the `.git` suffix,
 * because a checkout made by `gh` and one made by `git clone` disagree on the
 * form and neither is wrong.
 */
export function parseGitHubRemote(url: string): string | null {
  const trimmed = url.trim().replace(/\.git$/, '');
  const ssh = /^git@github\.com:([^/]+)\/(.+)$/.exec(trimmed);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  const https = /^https?:\/\/(?:[^@/]*@)?github\.com\/([^/]+)\/(.+)$/.exec(trimmed);
  if (https) return `${https[1]}/${https[2]}`;
  return null;
}

/**
 * The reason a checkout is not the artifact, or null when it is.
 *
 * Both halves are checked because either alone admits the wrong tree: the same
 * repository on a different branch is a different artifact, and the same branch
 * name in a different repository is a coincidence.
 */
export function workspaceMismatch(
  identity: WorkspaceIdentity | null,
  artifact: GateArtifact,
): string | null {
  const want = `${artifact.owner}/${artifact.repo}`;
  if (!identity) {
    return `the workspace is not a git checkout, so it cannot be shown to be ${want}@${artifact.branch}`;
  }
  const have = parseGitHubRemote(identity.remote);
  if (have === null) {
    return `the workspace remote "${identity.remote}" is not a GitHub remote, so it cannot be shown to be ${want}`;
  }
  if (have.toLowerCase() !== want.toLowerCase()) {
    return `the workspace is a checkout of ${have}, not ${want}`;
  }
  if (identity.branch !== artifact.branch) {
    return `the workspace is on branch "${identity.branch}", not the branch under gate "${artifact.branch}"`;
  }
  return null;
}

/** What a checkout says it is, or null when the directory is not one. */
export async function identifyWorkspace(
  cwd: string,
  run: ShellRunner,
): Promise<WorkspaceIdentity | null> {
  const remote = await run('git remote get-url origin', cwd);
  if (remote.exit !== 0) return null;
  const branch = await run('git rev-parse --abbrev-ref HEAD', cwd);
  if (branch.exit !== 0) return null;
  return { remote: remote.stdout.trim(), branch: branch.stdout.trim() };
}

export interface ResolveWorkspaceOptions {
  /** The artifact under gate. Null means the caller has none to name. */
  readonly artifact: GateArtifact | null;
  /** An operator-supplied checkout, which is used only if it is the artifact. */
  readonly declared: string | null;
  readonly run: ShellRunner;
  readonly makeTempDir?: () => Promise<string>;
  readonly writeSecret?: (path: string, body: string) => Promise<void>;
  readonly removeDir?: (path: string) => Promise<void>;
}

const defaultTempDir = (): Promise<string> => mkdtemp(join(tmpdir(), 'fab-gate-'));
const defaultWriteSecret = (path: string, body: string): Promise<void> =>
  writeFile(path, body, { encoding: 'utf-8', mode: 0o700 });
const defaultRemoveDir = (path: string): Promise<void> =>
  rm(path, { recursive: true, force: true });

/**
 * A tree that is the artifact under gate, or the reason there is not one.
 *
 * A declared workspace is checked rather than trusted; being handed a path is
 * not evidence about what is in it. A clone is shallow and single-branch
 * because the phases need the tree at that commit and nothing else, and it is a
 * fresh checkout, which is the condition FOUR_PHASE_CONTRACT states the phases
 * must exit 0 from.
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
    const mismatch = workspaceMismatch(await identifyWorkspace(declared, run), artifact);
    if (mismatch) {
      return {
        kind: 'unavailable',
        reason: `FAB_WORKSPACE=${declared} is not the artifact under gate: ${mismatch}`,
      };
    }
    return { kind: 'ready', cwd: declared, release: async () => {} };
  }

  const makeTempDir = opts.makeTempDir ?? defaultTempDir;
  const writeSecret = opts.writeSecret ?? defaultWriteSecret;
  const removeDir = opts.removeDir ?? defaultRemoveDir;

  const dir = await makeTempDir();
  const release = () => removeDir(dir);
  try {
    // The token reaches git through a helper script rather than the command
    // line, because a process argument is readable by anything on the host that
    // can list processes and a 0700 file is not.
    const askpass = join(dir, 'askpass.sh');
    await writeSecret(
      askpass,
      `#!/bin/sh\nexec printf '%s' '${artifact.token.replace(/'/g, "'\\''")}'\n`,
    );

    const checkout = join(dir, 'checkout');
    const url = `https://github.com/${artifact.owner}/${artifact.repo}.git`;
    const clone = await run(
      `GIT_ASKPASS=${askpass} GIT_TERMINAL_PROMPT=0 git clone --depth 1 --single-branch --branch ${artifact.branch} ${url} ${checkout}`,
      dir,
    );
    if (clone.exit !== 0) {
      await release();
      return {
        kind: 'unavailable',
        reason: `could not fetch ${artifact.owner}/${artifact.repo}@${artifact.branch}: ${redact(clone.stderr || clone.stdout, artifact.token).trim() || `git clone exited ${clone.exit}`}`,
      };
    }
    return { kind: 'ready', cwd: checkout, release };
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
