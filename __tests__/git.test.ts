import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parseGitHubUrl, slugForBranch, createBranchIfMissing, fetchRepoFile } from '../src/git.js';

describe('parseGitHubUrl', () => {
  it('parses canonical https URL', () => {
    expect(parseGitHubUrl('https://github.com/nanohype/digest-pipeline')).toEqual({
      owner: 'nanohype',
      repo: 'digest-pipeline',
    });
  });

  it('strips trailing .git', () => {
    expect(parseGitHubUrl('https://github.com/nanohype/digest-pipeline.git')).toEqual({
      owner: 'nanohype',
      repo: 'digest-pipeline',
    });
  });

  it('strips trailing slash', () => {
    expect(parseGitHubUrl('https://github.com/nanohype/digest-pipeline/')).toEqual({
      owner: 'nanohype',
      repo: 'digest-pipeline',
    });
  });

  it('parses SSH form', () => {
    expect(parseGitHubUrl('git@github.com:nanohype/digest-pipeline.git')).toEqual({
      owner: 'nanohype',
      repo: 'digest-pipeline',
    });
  });

  it('throws on malformed URL', () => {
    expect(() => parseGitHubUrl('not a url')).toThrow(/Unrecognized GitHub URL/);
    expect(() => parseGitHubUrl('https://gitlab.com/foo/bar')).toThrow(/Unrecognized GitHub URL/);
  });
});

describe('slugForBranch', () => {
  it('lowercases single word', () => {
    expect(slugForBranch('Portal')).toBe('portal');
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
      new Response(
        JSON.stringify({
          ref: 'refs/heads/feat/digest-pipeline',
          object: { sha: 'abc123', type: 'commit' },
        }),
        {
          status: 200,
        },
      ),
    );
    const result = await createBranchIfMissing(
      'tok',
      'nanohype',
      'digest-pipeline',
      'feat/digest-pipeline',
    );
    expect(result).toEqual({ created: false, sha: 'abc123' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('creates branch when missing (404 → base lookup → POST)', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ref: 'refs/heads/main', object: { sha: 'mainsha', type: 'commit' } }),
          {
            status: 200,
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ref: 'refs/heads/feat/digest-pipeline',
            object: { sha: 'newsha', type: 'commit' },
          }),
          {
            status: 201,
          },
        ),
      );

    const result = await createBranchIfMissing(
      'tok',
      'nanohype',
      'digest-pipeline',
      'feat/digest-pipeline',
    );
    expect(result).toEqual({ created: true, sha: 'newsha' });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const postCall = fetchMock.mock.calls[2];
    expect(postCall[0]).toContain('/repos/nanohype/digest-pipeline/git/refs');
    expect(postCall[1].method).toBe('POST');
    expect(JSON.parse(postCall[1].body)).toEqual({
      ref: 'refs/heads/feat/digest-pipeline',
      sha: 'mainsha',
    });
  });

  it('throws on non-404 error during existence check', async () => {
    fetchMock.mockResolvedValueOnce(new Response('forbidden', { status: 403 }));
    await expect(
      createBranchIfMissing('tok', 'nanohype', 'digest-pipeline', 'feat/digest-pipeline'),
    ).rejects.toThrow(/GET branch ref failed \(403\)/);
  });

  it('throws when base branch lookup fails', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(new Response('base gone', { status: 404 }));
    await expect(
      createBranchIfMissing('tok', 'nanohype', 'digest-pipeline', 'feat/digest-pipeline', 'main'),
    ).rejects.toThrow(/GET base branch main failed \(404\)/);
  });

  it('includes auth header on all calls', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ref: 'x', object: { sha: 'x', type: 'commit' } }), {
        status: 200,
      }),
    );
    await createBranchIfMissing('my-token', 'nanohype', 'digest-pipeline', 'feat/x');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer my-token');
  });
});

describe('fetchRepoFile', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('decodes base64 file content on 200', async () => {
    const body = 'const x = 1;\nconst y = 2;\n';
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          type: 'file',
          encoding: 'base64',
          content: Buffer.from(body).toString('base64'),
        }),
        { status: 200 },
      ),
    );
    expect(
      await fetchRepoFile('tok', 'nanohype', 'digest-pipeline', 'src/x.ts', 'feat/digest-pipeline'),
    ).toBe(body);
  });

  it('returns null on 404 (file does not exist — a clean signal, not an error)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not found', { status: 404 }));
    expect(await fetchRepoFile('tok', 'o', 'r', 'missing.ts', 'feat/x')).toBeNull();
  });

  it('throws on a non-404 error (auth / rate-limit)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('forbidden', { status: 403 }));
    await expect(fetchRepoFile('tok', 'o', 'r', 'a.ts', 'feat/x')).rejects.toThrow(
      /GET contents a.ts failed \(403\)/,
    );
  });

  it('throws on unsupported encoding (>1MB file returns encoding "none")', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ type: 'file', encoding: 'none', content: '' }), {
        status: 200,
      }),
    );
    await expect(fetchRepoFile('tok', 'o', 'r', 'big.bin', 'feat/x')).rejects.toThrow(
      /unsupported encoding/,
    );
  });

  it('returns null when the path is a directory (array response, no type:"file")', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify([{ type: 'file', name: 'a.ts' }]), { status: 200 }),
    );
    expect(await fetchRepoFile('tok', 'o', 'r', 'src', 'feat/x')).toBeNull();
  });

  it('url-encodes path segments + ref and sends the auth header', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          type: 'file',
          encoding: 'base64',
          content: Buffer.from('x').toString('base64'),
        }),
        {
          status: 200,
        },
      ),
    );
    await fetchRepoFile(
      'my-token',
      'nanohype',
      'digest-pipeline',
      'src/a b.ts',
      'feat/digest-pipeline',
    );
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/repos/nanohype/digest-pipeline/contents/src/a%20b.ts');
    expect(url).toContain('?ref=feat%2Fdigest-pipeline');
    expect(init.headers.Authorization).toBe('Bearer my-token');
  });
});
