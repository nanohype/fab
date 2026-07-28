/**
 * Managed Agents REST client tests.
 *
 * `api.ts` is fab's entire boundary to Anthropic and the default transport's
 * only client, and none of it was exercised. `fetch` is stubbed here rather
 * than an SDK mocked: fetch *is* the process edge, so everything above it —
 * header assembly, the retry policy, pagination, and the SSE reader — runs for
 * real.
 *
 * The three behaviors worth the most are the ones a caller never sees until
 * they fail in production: a dropped beta header turns every call into a 404,
 * a retry on a 4xx sends the same bad request four times, and an SSE
 * reconnection that forgets `Last-Event-ID` silently replays or drops events
 * mid-run.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicAgents } from '../src/api.js';
import type { Paginated } from '../src/types.js';

const realFetch = globalThis.fetch;
let calls: Array<{ url: string; init?: RequestInit }>;

function stubFetch(responder: (url: string, init?: RequestInit) => unknown) {
  calls = [];
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return responder(String(input), init) as Response;
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function errorResponse(status: number, body = 'upstream said no') {
  return { ok: false, status, json: async () => ({}), text: async () => body };
}

/** An SSE response whose body yields the given raw wire text in one chunk. */
function sseResponse(wire: string) {
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    body: (async function* () {
      yield encoder.encode(wire);
    })(),
  };
}

const api = () => new AnthropicAgents('sk-ant-test');

/** Drive the retry loop's `setTimeout` backoff without waiting on it. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  const result = promise.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );
  await vi.advanceTimersByTimeAsync(60_000);
  const outcome = await result;
  if (outcome.ok) return outcome.value;
  throw outcome.error;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('request headers', () => {
  it('sends the api key, the api version and the beta opt-ins on every call', async () => {
    stubFetch(() => jsonResponse({ id: 'agent_1' }));
    await api().getAgent('agent_1');

    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers['X-Api-Key']).toBe('sk-ant-test');
    expect(headers['anthropic-version']).toBeTruthy();
    // Managed agents and skills are both behind betas. Dropping either turns
    // every call in the client into a 404 that reads like a wrong path.
    expect(headers['anthropic-beta']).toContain('managed-agents');
    expect(headers['anthropic-beta']).toContain('skills');
  });

  it('posts a JSON body and reads the created resource back', async () => {
    stubFetch(() => jsonResponse({ id: 'sess_1', type: 'session' }));
    const session = await api().createSession({ agent_id: 'agent_1' } as never);

    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ agent_id: 'agent_1' });
    expect(session).toMatchObject({ id: 'sess_1' });
  });

  it('tolerates an empty body on a POST that returns nothing', async () => {
    // `sendMessage` and `interrupt` return 204 with no body. JSON.parse('')
    // would throw on a call that in fact succeeded.
    stubFetch(() => ({ ok: true, status: 204, text: async () => '' }));
    await expect(api().sendMessage('sess_1', 'hello')).resolves.toBeUndefined();
  });

  it('issues a DELETE without expecting a body back', async () => {
    stubFetch(() => ({ ok: true, status: 204, text: async () => '' }));
    await api().deleteSession('sess_1');

    expect(calls[0].init?.method).toBe('DELETE');
    expect(calls[0].url).toContain('/v1/sessions/sess_1');
  });
});

describe('the retry policy', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('does not retry a client error', async () => {
    // A 400 is deterministic. Retrying it sends the same malformed request
    // four times and reports the last failure four requests later.
    stubFetch(() => errorResponse(400, 'invalid agent id'));

    await expect(settle(api().getAgent('bad'))).rejects.toThrow(/400/);
    expect(calls).toHaveLength(1);
  });

  it.each([429, 500, 503])('retries a %d and returns the eventual success', async (status) => {
    let n = 0;
    stubFetch(() => (++n === 1 ? errorResponse(status) : jsonResponse({ id: 'agent_1' })));

    await expect(settle(api().getAgent('agent_1'))).resolves.toMatchObject({ id: 'agent_1' });
    expect(calls).toHaveLength(2);
  });

  it('gives up after the retry budget and surfaces the last failure', async () => {
    stubFetch(() => errorResponse(503, 'still down'));

    await expect(settle(api().getAgent('agent_1'))).rejects.toThrow(/503.*still down/s);
    // One original attempt plus three retries.
    expect(calls).toHaveLength(4);
  });

  it('retries a POST as well as a GET', async () => {
    let n = 0;
    stubFetch(() => (++n === 1 ? errorResponse(500) : jsonResponse({ id: 'sess_1' })));

    await expect(
      settle(api().createSession({ agent_id: 'agent_1' } as never)),
    ).resolves.toMatchObject({ id: 'sess_1' });
    expect(calls).toHaveLength(2);
  });
});

describe('listAll', () => {
  it('walks every page and concatenates the results', async () => {
    const pages: Record<string, Paginated<{ id: string }>> = {
      first: { data: [{ id: 'a' }, { id: 'b' }], next_page: 'p2' } as Paginated<{ id: string }>,
      p2: { data: [{ id: 'c' }], next_page: 'p3' } as Paginated<{ id: string }>,
      p3: { data: [{ id: 'd' }], next_page: null } as unknown as Paginated<{ id: string }>,
    };

    const seen: Array<string | undefined> = [];
    const all = await api().listAll<{ id: string }>(async (page) => {
      seen.push(page);
      return pages[page ?? 'first'];
    });

    expect(all.map((x) => x.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(seen).toEqual([undefined, 'p2', 'p3']);
  });

  it('stops after one page when there is no next cursor', async () => {
    const all = await api().listAll<{ id: string }>(
      async () =>
        ({ data: [{ id: 'only' }], next_page: null }) as unknown as Paginated<{ id: string }>,
    );
    expect(all).toHaveLength(1);
  });

  it('returns an empty list rather than throwing on an empty first page', async () => {
    const all = await api().listAll<{ id: string }>(
      async () => ({ data: [], next_page: null }) as unknown as Paginated<{ id: string }>,
    );
    expect(all).toEqual([]);
  });
});

describe('the SSE reader', () => {
  async function collect(gen: AsyncGenerator<unknown>) {
    const out: unknown[] = [];
    for await (const event of gen) out.push(event);
    return out;
  }

  it('yields one event per data line and ignores the terminator', async () => {
    stubFetch(() =>
      sseResponse(
        'data: {"type":"text","text":"one"}\n' +
          'data: {"type":"text","text":"two"}\n' +
          'data: [DONE]\n',
      ),
    );

    const events = await collect(api().stream('sess_1'));
    expect(events).toEqual([
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
    ]);
  });

  it('skips a malformed event instead of ending the stream', async () => {
    // A single bad frame mid-run would otherwise abort a workflow that is
    // most of the way done.
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stubFetch(() =>
      sseResponse('data: {"type":"text","text":"good"}\ndata: {not json\ndata: {"type":"done"}\n'),
    );

    const events = await collect(api().stream('sess_1'));
    expect(events).toEqual([{ type: 'text', text: 'good' }, { type: 'done' }]);
    expect(String(warn.mock.calls[0]?.[0])).toContain('malformed');
  });

  it('ignores comment and blank lines', async () => {
    stubFetch(() => sseResponse(': keep-alive\n\ndata: {"type":"done"}\n'));
    expect(await collect(api().stream('sess_1'))).toEqual([{ type: 'done' }]);
  });

  it('resumes from the last event id after a dropped connection', async () => {
    // This is the whole point of tracking ids. Reconnecting without the header
    // restarts the event stream, so a long session either replays work already
    // consumed or loses the tail — and neither shows up as an error.
    vi.useFakeTimers();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    let attempt = 0;
    stubFetch(() => {
      attempt++;
      if (attempt === 1) {
        return {
          ok: true,
          status: 200,
          body: (async function* () {
            yield new TextEncoder().encode('id: evt_7\ndata: {"type":"text","text":"before"}\n');
            throw new Error('socket hang up');
          })(),
        };
      }
      return sseResponse('data: {"type":"text","text":"after"}\n');
    });

    const gen = api().stream('sess_1');
    const events = await settle(collect(gen) as Promise<unknown[]>);

    expect(events).toEqual([
      { type: 'text', text: 'before' },
      { type: 'text', text: 'after' },
    ]);
    const resumeHeaders = calls[1].init?.headers as Record<string, string>;
    expect(resumeHeaders['Last-Event-ID']).toBe('evt_7');
  });

  it('does not send a resume header on the first connection', async () => {
    stubFetch(() => sseResponse('data: {"type":"done"}\n'));
    await collect(api().stream('sess_1'));

    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers['Last-Event-ID']).toBeUndefined();
  });

  it('retries a 503 on the stream endpoint', async () => {
    vi.useFakeTimers();
    let attempt = 0;
    stubFetch(() =>
      ++attempt === 1 ? errorResponse(503, 'overloaded') : sseResponse('data: {"type":"done"}\n'),
    );

    const events = await settle(collect(api().stream('sess_1')) as Promise<unknown[]>);
    expect(events).toEqual([{ type: 'done' }]);
  });

  it('does not retry a 401 on the stream endpoint', async () => {
    vi.useFakeTimers();
    stubFetch(() => errorResponse(401, 'bad key'));

    await expect(settle(collect(api().stream('sess_1')))).rejects.toThrow(/401/);
    expect(calls).toHaveLength(1);
  });

  it('streams a single thread of a multiagent session', async () => {
    stubFetch(() => sseResponse('data: {"type":"done"}\n'));
    await collect(api().streamThread('sess_1', 'thread_2'));

    expect(calls[0].url).toContain('/v1/sessions/sess_1/threads/thread_2/events/stream');
  });
});
