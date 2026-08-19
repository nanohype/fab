import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The in-cluster ServiceAccount token lives at a path fixed by Kubernetes, so
// there is no seam to inject outside a pod. Only `readFileSync` is replaced,
// leaving the rest of `node:fs` real — the same partial style workflows.test.ts
// uses. This is a Node builtin standing in for a mounted file, not an external
// SDK swapped out to avoid exercising the code under test.
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  readFileSync: (path: string, ...rest: unknown[]) => {
    if (String(path).endsWith('/serviceaccount/token')) return 'test-sa-token\n';
    const real = require('node:fs') as typeof import('node:fs');
    return real.readFileSync(path, ...(rest as []));
  },
}));

const { K8sClient } = await import('../src/k8s.js');

// `fetch` is a platform global, stubbed the way api.test.ts and git.test.ts
// already do.
const realFetch = globalThis.fetch;

/** A response whose body streams the given chunks, then ends. */
function streaming(chunks: string[], init: { ok?: boolean; status?: number } = {}) {
  const enc = new TextEncoder();
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    body: (async function* () {
      for (const c of chunks) yield enc.encode(c);
    })(),
    text: async () => chunks.join(''),
  };
}

describe('K8sClient.followPodLog', () => {
  let seen: { url: string; init: RequestInit }[];

  beforeEach(() => {
    process.env.KUBERNETES_SERVICE_HOST = 'kube.test';
    process.env.KUBERNETES_SERVICE_PORT = '6443';
    process.env.KUBERNETES_SERVICE_TOKEN = 'tok';
    seen = [];
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.KUBERNETES_SERVICE_HOST;
  });

  function stub(res: unknown) {
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} });
      return res as Response;
    }) as unknown as typeof fetch;
  }

  it('forwards the abort signal to the request', async () => {
    // A follow connection has no natural timeout: the apiserver holds it open
    // for the life of the container. If the signal did not reach fetch, a hung
    // pod would hold the stream open with nothing able to end it.
    stub(streaming(['a\n']));
    const signal = AbortSignal.timeout(50_000);
    const lines: string[] = [];
    for await (const l of new K8sClient().followPodLog('ns', 'pod', signal)) lines.push(l);

    expect(seen).toHaveLength(1);
    expect(seen[0].init.signal).toBe(signal);
  });

  it('requests a following log stream for the named pod', async () => {
    stub(streaming([]));
    for await (const _ of new K8sClient().followPodLog(
      'tenant-a',
      'sess-1',
      AbortSignal.timeout(1000),
    )) {
      // drain
    }
    expect(seen[0].url).toBe(
      'https://kube.test:6443/api/v1/namespaces/tenant-a/pods/sess-1/log?follow=true&timestamps=false',
    );
  });

  it('yields whole lines, reassembling chunks split mid-line', async () => {
    // The apiserver chunks on network boundaries, not line boundaries, so a
    // JSON event can arrive in two pieces.
    stub(streaming(['{"a":1}\n{"b":', '2}\n{"c":3}']));
    const lines: string[] = [];
    for await (const l of new K8sClient().followPodLog('ns', 'pod', AbortSignal.timeout(1000))) {
      lines.push(l);
    }
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it('yields a trailing line that arrives without a newline', async () => {
    stub(streaming(['no-trailing-newline']));
    const lines: string[] = [];
    for await (const l of new K8sClient().followPodLog('ns', 'pod', AbortSignal.timeout(1000))) {
      lines.push(l);
    }
    expect(lines).toEqual(['no-trailing-newline']);
  });

  it('throws with the status and body when the apiserver rejects the request', async () => {
    stub({ ...streaming(['forbidden'], { ok: false, status: 403 }), body: null });
    const gen = new K8sClient().followPodLog('ns', 'pod', AbortSignal.timeout(1000));
    await expect(gen.next()).rejects.toThrow(/failed \(403\).*forbidden/s);
  });

  it('throws rather than hanging when the response carries no body', async () => {
    stub({ ok: true, status: 200, body: null, text: async () => '' });
    const gen = new K8sClient().followPodLog('ns', 'pod', AbortSignal.timeout(1000));
    await expect(gen.next()).rejects.toThrow(/no body/);
  });
});

describe('K8sClient constructor', () => {
  afterEach(() => {
    delete process.env.KUBERNETES_SERVICE_HOST;
  });

  it('refuses to construct outside a pod', () => {
    delete process.env.KUBERNETES_SERVICE_HOST;
    expect(() => new K8sClient()).toThrow(/must run inside a Kubernetes pod/);
  });

  it('defaults the apiserver port to 443', async () => {
    process.env.KUBERNETES_SERVICE_HOST = 'kube.test';
    delete process.env.KUBERNETES_SERVICE_PORT;
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: unknown) => {
      calls.push(String(url));
      return { ok: true, status: 200, body: null, text: async () => '' } as unknown as Response;
    }) as unknown as typeof fetch;
    await expect(
      new K8sClient().followPodLog('ns', 'pod', AbortSignal.timeout(1000)).next(),
    ).rejects.toThrow();
    globalThis.fetch = realFetch;
    expect(calls[0]).toContain('https://kube.test:443/');
  });
});
