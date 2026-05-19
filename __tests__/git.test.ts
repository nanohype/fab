import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parseGitHubUrl, slugForBranch, createBranchIfMissing } from '../src/git.js';

describe('parseGitHubUrl', () => {
  it('parses canonical https URL', () => {
    expect(parseGitHubUrl('https://github.com/nanohype/protohype')).toEqual({
      owner: 'nanohype',
      repo: 'protohype',
    });
  });

  it('strips trailing .git', () => {
    expect(parseGitHubUrl('https://github.com/nanohype/protohype.git')).toEqual({
      owner: 'nanohype',
      repo: 'protohype',
    });
  });

  it('strips trailing slash', () => {
    expect(parseGitHubUrl('https://github.com/nanohype/protohype/')).toEqual({
      owner: 'nanohype',
      repo: 'protohype',
    });
  });

  it('parses SSH form', () => {
    expect(parseGitHubUrl('git@github.com:nanohype/protohype.git')).toEqual({
      owner: 'nanohype',
      repo: 'protohype',
    });
  });

  it('throws on malformed URL', () => {
    expect(() => parseGitHubUrl('not a url')).toThrow(/Unrecognized GitHub URL/);
    expect(() => parseGitHubUrl('https://gitlab.com/foo/bar')).toThrow(/Unrecognized GitHub URL/);
  });
});

describe('slugForBranch', () => {
  it('lowercases single word', () => {
    expect(slugForBranch('Almanac')).toBe('almanac');
  });

  it('replaces spaces with hyphens', () => {
    expect(slugForBranch('Doc Search v2')).toBe('doc-search-v2');
  });

  it('collapses non-alphanumeric runs', () => {
    expect(slugForBranch('Over_Under 3.14')).toBe('over-under-3-14');
  });

  it('trims leading and trailing hyphens', () => {
    expect(slugForBranch('  !!Hello!!  ')).toBe('hello');
  });

  it('handles unicode gracefully by stripping', () => {
    expect(slugForBranch('Café – Société')).toBe('caf-soci-t');
  });
});

describe('createBranchIfMissing', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns created:false when branch already exists', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ref: 'refs/heads/feat/almanac', object: { sha: 'abc123', type: 'commit' } }), {
        status: 200,
      }),
    );
    const result = await createBranchIfMissing('tok', 'nanohype', 'protohype', 'feat/almanac');
    expect(result).toEqual({ created: false, sha: 'abc123' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('creates branch when missing (404 → base lookup → POST)', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ref: 'refs/heads/main', object: { sha: 'mainsha', type: 'commit' } }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ref: 'refs/heads/feat/almanac', object: { sha: 'newsha', type: 'commit' } }), {
          status: 201,
        }),
      );

    const result = await createBranchIfMissing('tok', 'nanohype', 'protohype', 'feat/almanac');
    expect(result).toEqual({ created: true, sha: 'newsha' });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const postCall = fetchMock.mock.calls[2];
    expect(postCall[0]).toContain('/repos/nanohype/protohype/git/refs');
    expect(postCall[1].method).toBe('POST');
    expect(JSON.parse(postCall[1].body)).toEqual({ ref: 'refs/heads/feat/almanac', sha: 'mainsha' });
  });

  it('throws on non-404 error during existence check', async () => {
    fetchMock.mockResolvedValueOnce(new Response('forbidden', { status: 403 }));
    await expect(createBranchIfMissing('tok', 'nanohype', 'protohype', 'feat/almanac')).rejects.toThrow(
      /GET branch ref failed \(403\)/,
    );
  });

  it('throws when base branch lookup fails', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(new Response('base gone', { status: 404 }));
    await expect(createBranchIfMissing('tok', 'nanohype', 'protohype', 'feat/almanac', 'main')).rejects.toThrow(
      /GET base branch main failed \(404\)/,
    );
  });

  it('includes auth header on all calls', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ref: 'x', object: { sha: 'x', type: 'commit' } }), { status: 200 }),
    );
    await createBranchIfMissing('my-token', 'nanohype', 'protohype', 'feat/x');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer my-token');
  });
});
