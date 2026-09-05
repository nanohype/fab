import { describe, it, expect } from 'vitest';
import { initLine, startFakeClaudeSession } from './helpers/fake-claude.js';
import {
  boundEvents,
  deadlineError,
  resolveSessionDeadlines,
  MIN_BOUND_MS,
  SESSION_IDLE_MS,
  SESSION_TOTAL_MS,
  type SessionDeadlines,
  type Stoppable,
} from '../src/runtimes/deadline.js';
import { isTerminal } from '../src/runtimes/sdk-events.js';
import { SdkAgentSession } from '../src/runtimes/sdk.js';
import type { AgentEvent } from '../src/types.js';

// A wall clock is only testable if the clock is an argument. `boundEvents`
// takes its bounds as a parameter and its victim as a two-method interface, so
// every timing case below runs on a real clock at millisecond scale — no fake
// timers, no waiting out a production bound.

const EVENT: AgentEvent = {
  type: 'session.status_running',
  id: 'sess-1',
  processed_at: '2026-01-01T00:00:00Z',
} as AgentEvent;

/** Turns a bound that never fires into a named failure instead of a suite timeout. */
function within<T>(p: Promise<T>, ms: number, why: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(why)), ms).unref();
    }),
  ]);
}

function recorder() {
  const order: string[] = [];
  return {
    order,
    target: (fail = false): Stoppable => ({
      id: 'sess-1',
      async stop() {
        order.push('stop');
        if (fail) throw new Error('the session refused to stop');
      },
    }),
  };
}

/** A source that yields what it is given and then never settles again. */
function hangs(order: string[], ...first: AgentEvent[]): AsyncIterable<AgentEvent> {
  let sent = 0;
  return {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        if (sent < first.length) return { value: first[sent++]!, done: false };
        return new Promise<IteratorResult<AgentEvent>>(() => {});
      },
      return: async () => {
        order.push('return');
        return { value: undefined, done: true } as IteratorResult<AgentEvent>;
      },
    }),
  };
}

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

describe('resolveSessionDeadlines', () => {
  it('defaults to the two bounds the tree already declares elsewhere', () => {
    expect(resolveSessionDeadlines({})).toEqual({
      idleMs: SESSION_IDLE_MS,
      totalMs: SESSION_TOTAL_MS,
    });
    // Pinned, so widening a bound is a reviewed change rather than a quiet one.
    expect(SESSION_IDLE_MS).toBe(900_000);
    expect(SESSION_TOTAL_MS).toBe(1_800_000);
  });

  it('reads both knobs from the environment', () => {
    expect(
      resolveSessionDeadlines({ FAB_SESSION_IDLE_MS: '5000', FAB_SESSION_TOTAL_MS: '9000' }),
    ).toEqual({ idleMs: 5000, totalMs: 9000 });
  });

  it('treats an empty value as unset', () => {
    expect(resolveSessionDeadlines({ FAB_SESSION_IDLE_MS: '' }).idleMs).toBe(SESSION_IDLE_MS);
  });

  it.each(['0x384', '1e3', ' 12 ', '900000ms', '-1', '12.5'])(
    'rejects %s rather than reading it as a duration',
    (raw) => {
      // `Number` accepts most of these; an operator cannot predict the bound
      // they get from the string they set, so a silent reading is worse than a
      // refusal.
      expect(() => resolveSessionDeadlines({ FAB_SESSION_IDLE_MS: raw })).toThrow(
        /whole milliseconds/,
      );
    },
  );

  it('rejects a bound below the floor', () => {
    expect(() => resolveSessionDeadlines({ FAB_SESSION_TOTAL_MS: '10' })).toThrow(
      new RegExp(`at least ${MIN_BOUND_MS}ms`),
    );
  });
});

describe('deadlineError', () => {
  const bounds: SessionDeadlines = { idleMs: 111, totalMs: 222 };

  it('is terminal to both definitions of terminal in the tree', () => {
    // sdk-events' isTerminal decides whether a transport appends a second
    // synthetic ending; streamSessionWithAdvisor breaks on the same type.
    expect(isTerminal(deadlineError('s', 'idle', bounds, true))).toBe(true);
  });

  it('names the clock, its value and the knob that sets it', () => {
    const e = deadlineError('s', 'idle', bounds, true);
    expect(e.error.type).toBe('idle_timeout');
    expect(e.error.message).toContain('111ms');
    expect(e.error.message).toContain('FAB_SESSION_IDLE_MS');
    expect(deadlineError('s', 'total', bounds, true).error.message).toContain('222ms');
  });

  it('says the session may still be running when the stop was refused', () => {
    expect(deadlineError('s', 'total', bounds, false).error.message).toMatch(
      /may still be running/,
    );
    expect(deadlineError('s', 'total', bounds, true).error.message).not.toMatch(/may still be/);
  });
});

describe('boundEvents', () => {
  it('ends a hung stream with an idle-timeout error', async () => {
    const r = recorder();
    const out = await within(
      collect(boundEvents(hangs(r.order, EVENT), r.target(), { idleMs: 20, totalMs: 60_000 })),
      2000,
      'the idle bound never fired',
    );
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ type: 'session.error', error: { type: 'idle_timeout' } });
  });

  it('kills the session before releasing the source', async () => {
    // Ordering is the whole point: `return()` on a generator suspended at an
    // await does not run its `finally` until the generator resumes, so the
    // thing it waits on has to die first.
    const r = recorder();
    await within(
      collect(boundEvents(hangs(r.order), r.target(), { idleMs: 20, totalMs: 60_000 })),
      2000,
      'the idle bound never fired',
    );
    expect(r.order).toEqual(['stop', 'return']);
  });

  it('stops a session that keeps emitting events', async () => {
    // The case a total-only bound gets wrong in the other direction: a stream
    // that never goes idle still has to end.
    const r = recorder();
    async function* chatty(): AsyncIterable<AgentEvent> {
      for (;;) {
        await new Promise((res) => setTimeout(res, 5));
        yield EVENT;
      }
    }
    const out = await within(
      collect(boundEvents(chatty(), r.target(), { idleMs: 10_000, totalMs: 60 })),
      2000,
      'the total bound never fired while events were flowing',
    );
    expect(out.at(-1)).toMatchObject({ error: { type: 'total_timeout' } });
    expect(out.length).toBeGreaterThan(1);
    expect(r.order).toContain('stop');
  });

  it('reports a refused stop rather than claiming the session ended', async () => {
    const r = recorder();
    const out = await within(
      collect(boundEvents(hangs(r.order), r.target(true), { idleMs: 20, totalMs: 60_000 })),
      2000,
      'the idle bound never fired',
    );
    expect(out.at(-1)!).toMatchObject({ error: { type: 'idle_timeout' } });
    expect((out.at(-1) as { error: { message: string } }).error.message).toMatch(
      /may still be running/,
    );
  });

  it('passes a healthy stream through untouched and never stops it', async () => {
    const r = recorder();
    async function* healthy(): AsyncIterable<AgentEvent> {
      yield EVENT;
      yield { ...EVENT, type: 'session.status_idle' } as AgentEvent;
    }
    const out = await collect(boundEvents(healthy(), r.target(), { idleMs: 5000, totalMs: 5000 }));
    expect(out).toHaveLength(2);
    // A bound that interrupts every completed session would add a spurious
    // stop to every role the factory runs.
    expect(r.order).toEqual([]);
  });

  it('runs the source cleanup when the consumer walks away', async () => {
    const closed: string[] = [];
    async function* withCleanup(): AsyncIterable<AgentEvent> {
      try {
        for (;;) {
          yield EVENT;
          await new Promise((res) => setTimeout(res, 1));
        }
      } finally {
        closed.push('finally');
      }
    }
    for await (const _e of boundEvents(withCleanup(), recorder().target(), {
      idleMs: 5000,
      totalMs: 5000,
    })) {
      break;
    }
    expect(closed).toEqual(['finally']);
  });

  it('propagates a source failure instead of dressing it as a timeout', async () => {
    async function* boom(): AsyncIterable<AgentEvent> {
      yield EVENT;
      throw new Error('transport died');
    }
    await expect(
      collect(boundEvents(boom(), recorder().target(), { idleMs: 5000, totalMs: 5000 })),
    ).rejects.toThrow('transport died');
  });
});

describe('the bound is wired into the transports that had none', () => {
  it('sdk: a query that stops producing ends the session and interrupts it', async () => {
    let interrupted = 0;
    const sdk = {
      query() {
        return {
          [Symbol.asyncIterator]: () => ({
            next: async () => new Promise<IteratorResult<unknown>>(() => {}),
          }),
          async interrupt() {
            interrupted += 1;
          },
        };
      },
    };
    const session = new SdkAgentSession(sdk, 'claude-sonnet-5', 'prompt');
    await session.start('go');
    const prev = process.env.FAB_SESSION_IDLE_MS;
    process.env.FAB_SESSION_IDLE_MS = String(MIN_BOUND_MS);
    try {
      const out = await within(
        collect(session.events),
        10_000,
        'the sdk session was never bounded',
      );
      expect(out.at(-1)).toMatchObject({ error: { type: 'idle_timeout' } });
      expect(interrupted).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.FAB_SESSION_IDLE_MS;
      else process.env.FAB_SESSION_IDLE_MS = prev;
    }
  }, 20_000);

  it('claude-cli: a hung subprocess is stopped, not merely stopped reading', async () => {
    // The hazard this closes: an unkilled child with piped stdio holds the
    // parent alive, so a bound that only stops iterating turns a hung LLM call
    // into a hung CLI. The assertion is that the operating system no longer has
    // the process, not that the loop returned.
    const fake = await startFakeClaudeSession({
      emit: [initLine('hung')],
      hang: true,
      idleMs: MIN_BOUND_MS,
    });
    try {
      const out = await within(
        collect(fake.session.events),
        30_000,
        'the claude-cli session was never bounded',
      );
      expect(out.at(-1)).toMatchObject({ error: { type: 'idle_timeout' } });

      await fake.waitForExit();
      expect(fake.isGone()).toBe(true);
    } finally {
      fake.dispose();
    }
  }, 120_000);
});
