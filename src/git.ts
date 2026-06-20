// ── GitHub helpers ──────────────────────────────────────────────────
//
// CLI-side utilities for parsing GitHub URLs, slugging strings into
// branch-safe identifiers, and creating branches via the GitHub REST
// API directly (bypassing the github MCP, which is an agent-side tool).
//
// Used by the workflow engine to pre-create the feature branch at
// workflow start so agents never have to create, search for, or verify
// the repo themselves.

const GITHUB_API = 'https://api.github.com';

/**
 * Parse a GitHub repo URL into {owner, repo}. Handles:
 *   - https://github.com/owner/repo
 *   - https://github.com/owner/repo.git
 *   - https://github.com/owner/repo/
 *   - git@github.com:owner/repo.git
 *
 * Throws on malformed input — callers should have verified state.repos[0]
 * exists and is a github_repository.
 */
export function parseGitHubUrl(url: string): { owner: string; repo: string } {
  const cleaned = url
    .trim()
    .replace(/\.git$/, '')
    .replace(/\/$/, '');
  const httpsMatch = cleaned.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)$/);
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };
  const sshMatch = cleaned.match(/^git@github\.com:([^/]+)\/([^/]+)$/);
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };
  throw new Error(`Unrecognized GitHub URL: ${url}`);
}

/**
 * Convert an arbitrary string (e.g., context.product) into a
 * branch-safe slug. Lowercases, replaces non-alphanumerics with `-`,
 * collapses runs, trims leading/trailing hyphens.
 *
 *   "Almanac"         → "almanac"
 *   "Doc Search v2"   → "doc-search-v2"
 *   "Over_Under 3.14" → "over-under-3-14"
 */
export function slugForBranch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-') // runs of non-alphanumerics collapse to a single '-'
    .replace(/^-|-$/g, ''); // strip the lone leading/trailing '-' that can leave
}

interface GitHubRef {
  ref: string;
  object: { sha: string; type: string };
}

/**
 * Create `branch` on `owner/repo` from `fromBranch` if it doesn't already
 * exist. Idempotent: returns `{created: false}` if the branch is already
 * present (SHA returned in both cases).
 *
 * Uses the GitHub REST API directly (not the github MCP — the MCP is for
 * agents, and we want deterministic, pre-workflow execution here).
 */
export async function createBranchIfMissing(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  fromBranch = 'main',
): Promise<{ created: boolean; sha: string }> {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  // 1. Does the branch already exist?
  const existing = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/ref/heads/${branch}`, {
    headers,
    signal: AbortSignal.timeout(10000),
  });
  if (existing.ok) {
    const data = (await existing.json()) as GitHubRef;
    return { created: false, sha: data.object.sha };
  }
  if (existing.status !== 404) {
    const body = await existing.text();
    throw new Error(`GET branch ref failed (${existing.status}): ${body.slice(0, 200)}`);
  }

  // 2. Look up the SHA of `fromBranch`.
  const base = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/ref/heads/${fromBranch}`, {
    headers,
    signal: AbortSignal.timeout(10000),
  });
  if (!base.ok) {
    const body = await base.text();
    throw new Error(`GET base branch ${fromBranch} failed (${base.status}): ${body.slice(0, 200)}`);
  }
  const baseData = (await base.json()) as GitHubRef;

  // 3. Create the branch.
  const create = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/refs`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseData.object.sha }),
    signal: AbortSignal.timeout(10000),
  });
  if (!create.ok) {
    const body = await create.text();
    throw new Error(`POST branch ${branch} failed (${create.status}): ${body.slice(0, 200)}`);
  }
  const createdData = (await create.json()) as GitHubRef;
  return { created: true, sha: createdData.object.sha };
}

interface GitHubContentFile {
  type?: string;
  encoding?: string;
  content?: string;
}

/**
 * Fetch a single file's UTF-8 text from `owner/repo` at `ref` via the GitHub
 * Contents API. Used by the merge gate to verify CITATIONS fragments against
 * the feature branch in the default managed-agents transport, where the work
 * tree lives in the cloud sandbox rather than on fab's disk.
 *
 * Returns null when the file does not exist (404) — a clean signal, not an
 * error. Throws on auth / rate-limit / network failures and on the >1MB
 * "encoding: none" response (which would decode to empty and read as a false
 * mismatch) so callers can fail open — skip verification — rather than mistake
 * an infra problem for a fabricated citation.
 */
export async function fetchRepoFile(
  token: string,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string | null> {
  const encodedPath = path
    .split('/')
    .filter((seg) => seg.length > 0)
    .map(encodeURIComponent)
    .join('/');
  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(10000),
    },
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GET contents ${path} failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as GitHubContentFile;
  if (data.type !== 'file') return null; // a directory or symlink — not a citable file
  if (data.encoding !== 'base64' || typeof data.content !== 'string') {
    throw new Error(`contents ${path}: unsupported encoding "${data.encoding}" (file too large?)`);
  }
  return Buffer.from(data.content, 'base64').toString('utf-8');
}
