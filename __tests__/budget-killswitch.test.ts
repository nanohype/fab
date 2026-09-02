import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCliRuntime } from '../src/runtimes/claude-cli.js';
import { SdkAgentSession, SdkRuntime } from '../src/runtimes/sdk.js';
import { streamSessionWithAdvisor } from '../src/workflows.js';
import { streamEventsToJsonl } from '../src/runtimes/role-session.js';
import {
  assistantMessage as fixtureAssistant,
  initLine,
  resultLine,
  startFakeClaudeSession,
} from './helpers/fake-claude.js';
import { parseLogLine } from '../src/runtimes/sdk-k8s.js';
import { formatEvent } from '../src/stream.js';
import type { AgentSession } from '../src/runtime.js';
import type { AgentEvent } from '../src/types.js';

// ── The budget ceiling, and what it is compared against ────────────────
//
// streamSessionWithAdvisor compares its accumulated cost against the limit on
// `span.model_request_end` and on nothing else, so every transport reaches the
// ceiling only through those spans. A run total on the terminal result arrives
// once the spending has stopped: it can report a breach and never prevent one.
//
// These cases drive the real transports rather than a hand-built event list,
// because what a transport emits is what decides whether the ceiling can act.

const MODEL = 'claude-sonnet-5';

/** Output tokens priced above any limit these cases set: 200k at $15/MTok is $3. */
const EXPENSIVE = {
  input_tokens: 1_000,
  output_tokens: 200_000,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

const assistantMessage = (text: string, usage: unknown) => ({
  type: 'assistant',
  uuid: 'uuid-burn',
  session_id: 'sess-budget',
  message: { id: 'msg_burn', usage, content: [{ type: 'text', text }] },
});

describe('the budget ceiling stops a session while it can still be stopped', () => {
  let dir: string;
  let saved: Record<string, string | undefined>;
  let written: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fab-budget-'));
    // Only the ceiling's own variable: everything a claude-cli fixture needs is
    // set and restored by the fixture, and a second owner here would be the
    // per-case remedy this file just stopped keeping.
    saved = { state: process.env.FAB_STATE_FILE };
    // A ceiling is read from state; this file is this case's own.
    process.env.FAB_STATE_FILE = join(dir, 'state.json');
    writeFileSync(
      process.env.FAB_STATE_FILE,
      JSON.stringify({ agents: [], repos: [], skills: [], budgetLimit: 0.5 }),
    );
    written = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (saved.state === undefined) delete process.env.FAB_STATE_FILE;
    else process.env.FAB_STATE_FILE = saved.state;
    rmSync(dir, { recursive: true, force: true });
  });

  it('sdk: interrupts the query mid-run rather than reading to the end', async () => {
    let interrupted = 0;
    let pulled = 0;
    const messages: unknown[] = [
      { type: 'system', subtype: 'init', session_id: 'sess-budget' },
      assistantMessage('burning tokens', EXPENSIVE),
      // Reached only if the ceiling did not act. Its text is the tell.
      assistantMessage('spent past the ceiling', EXPENSIVE),
      { type: 'result', subtype: 'success', uuid: 'r', session_id: 'sess-budget' },
    ];
    const sdk = {
      query() {
        return {
          async *[Symbol.asyncIterator]() {
            for (const m of messages) {
              pulled += 1;
              yield m;
            }
          },
          async interrupt() {
            interrupted += 1;
          },
        };
      },
    };

    const session = new SdkAgentSession(sdk, MODEL, 'prompt');
    await session.start('go');
    const output = await streamSessionWithAdvisor(session, { model: MODEL });

    expect(written).toContain('BUDGET EXCEEDED');
    expect(interrupted).toBe(1);
    // The text before the breach is kept; the text after it was never reached.
    expect(output).toContain('burning tokens');
    expect(output).not.toContain('spent past the ceiling');
    expect(pulled).toBeLessThan(messages.length);
  });

  it('claude-cli: the subprocess is gone, not merely stopped being read', async () => {
    const fake = await startFakeClaudeSession({
      emit: [
        initLine('sess-budget'),
        fixtureAssistant('msg_1', 'burning tokens', EXPENSIVE, 'sess-budget'),
        fixtureAssistant('msg_2', 'spent past the ceiling', EXPENSIVE, 'sess-budget'),
      ],
    });
    try {
      const output = await streamSessionWithAdvisor(fake.session, { model: MODEL });

      expect(written).toContain('BUDGET EXCEEDED');
      expect(output).toContain('burning tokens');
      expect(output).not.toContain('spent past the ceiling');

      await fake.waitForExit();
      expect(fake.isGone()).toBe(true);
    } finally {
      fake.dispose();
    }
  }, 120_000);

  it('lets a session under the ceiling run to its own end', async () => {
    // A ceiling that stops everything is not a ceiling. The same shape of run,
    // priced under the limit, reaches its terminal event untouched.
    let interrupted = 0;
    const cheap = { input_tokens: 10, output_tokens: 20 };
    const sdk = {
      query() {
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'system', subtype: 'init', session_id: 'sess-budget' };
            yield assistantMessage('a small answer', cheap);
            yield { type: 'result', subtype: 'success', uuid: 'r', session_id: 'sess-budget' };
          },
          async interrupt() {
            interrupted += 1;
          },
        };
      },
    };
    const session = new SdkAgentSession(sdk, MODEL, 'prompt');
    await session.start('go');
    const output = await streamSessionWithAdvisor(session, { model: MODEL });

    expect(written).not.toContain('BUDGET EXCEEDED');
    expect(interrupted).toBe(0);
    expect(output).toContain('a small answer');
  });

  it('charges one API turn once, however many messages it arrives in', async () => {
    // The SDK emits one assistant message per content block and every one
    // carries the whole turn's usage. Charging per message multiplies the total
    // by the block count, so the ceiling fires at a fraction of the budget —
    // asserted here by what the session does, not by what the translator looks
    // like: one turn under the limit runs to its end, and the second turn is
    // what trips it.
    const turn = (id: string, text: string) => ({
      type: 'assistant',
      uuid: `u-${id}-${text}`,
      session_id: 'sess-budget',
      // 20k output tokens at the sonnet rate is $0.30; the limit is $0.50.
      message: {
        id,
        usage: { input_tokens: 0, output_tokens: 20_000 },
        content: [{ type: 'text', text }],
      },
    });
    let interrupted = 0;
    const sdk = {
      query() {
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'system', subtype: 'init', session_id: 'sess-budget' };
            // One turn, three content blocks, one message id.
            yield turn('msg_A', 'a1');
            yield turn('msg_A', 'a2');
            yield turn('msg_A', 'a3');
            yield turn('msg_B', 'b1');
            yield { type: 'result', subtype: 'success', uuid: 'r', session_id: 'sess-budget' };
          },
          async interrupt() {
            interrupted += 1;
          },
        };
      },
    };
    const session = new SdkAgentSession(sdk, MODEL, 'prompt');
    await session.start('go');
    const output = await streamSessionWithAdvisor(session, { model: MODEL });

    // $0.30 for the first turn leaves the ceiling untouched; the second turn
    // takes the total to $0.60 and trips it. Charged per message the first turn
    // alone would have been $0.90.
    expect(written).toContain('BUDGET EXCEEDED');
    expect(written).toMatch(/\$0\.60 \/ \$0\.50/);
    expect(interrupted).toBe(1);
    expect(output).toContain('a1');
    expect(output).toContain('b1');
  });

  it('sdk: hands the configured ceiling to the query it starts', async () => {
    // The runbook promises the Agent SDK applies its own spend cap on this
    // transport. That is only true if runRoleSession reads the limit and passes
    // it down, which is observable here and nowhere else.
    let seen: Record<string, unknown> | undefined;
    const sdk = {
      query(params: { options?: Record<string, unknown> }) {
        seen = params.options;
        return {
          async *[Symbol.asyncIterator]() {},
          async interrupt() {},
        };
      },
    };
    await new SdkRuntime(async () => sdk).runRoleSession('pr-reviewer', 'go');
    expect(seen?.maxBudgetUsd).toBe(0.5);
  });

  it('claude-cli: charges an API turn once, across its own session state', async () => {
    // The per-turn property is three pieces of state, not one: this transport
    // keeps its own, and a gate that drives only the in-process session leaves
    // it unheld.
    const usage = { input_tokens: 0, output_tokens: 20_000 };
    const fake = await startFakeClaudeSession({
      emit: [
        initLine('sess-cli'),
        fixtureAssistant('msg_A', 'a1', usage, 'sess-cli'),
        fixtureAssistant('msg_A', 'a2', usage, 'sess-cli'),
        fixtureAssistant('msg_A', 'a3', usage, 'sess-cli'),
        fixtureAssistant('msg_B', 'b1', usage, 'sess-cli'),
        resultLine('sess-cli'),
      ],
    });
    try {
      const output = await streamSessionWithAdvisor(fake.session, { model: MODEL });
      // One turn is $0.30 against a $0.50 limit; the second takes it to $0.60.
      // Charged per message the first turn alone would have been $0.90.
      expect(written).toContain('BUDGET EXCEEDED');
      expect(written).toMatch(/\$0\.60 \/ \$0\.50/);
      expect(output).toContain('a1');
      expect(output).toContain('b1');
    } finally {
      fake.dispose();
    }
  }, 120_000);

  it("prices a turn at the caller's model, and at the default tier without one", async () => {
    // The ceiling compares against an estimate, so what the estimate is priced
    // at is part of the ceiling. Naming a model and omitting one are different
    // numbers for identical tokens, and the difference is the tier ratio — held
    // here so it is a stated property rather than something a reader would have
    // to derive from a fallback three modules away.
    // Under the ceiling this file configures, so the session reaches its idle
    // event and reports the accumulated estimate instead of being stopped.
    const usage = {
      input_tokens: 1_000,
      output_tokens: 2_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    const span = {
      type: 'span.model_request_end',
      id: 't1',
      is_error: false,
      model_usage: usage,
      processed_at: 'x',
    } as unknown as AgentEvent;
    // No total_cost_usd on the terminal event, so the accumulated estimate is
    // what gets reported and can be read back.
    const idle = { type: 'session.status_idle', id: 's', processed_at: 'x' } as AgentEvent;
    const session = (): AgentSession =>
      ({
        id: 'sess',
        sendInput: async () => {},
        interrupt: async () => {},
        events: (async function* () {
          yield span;
          yield idle;
        })(),
      }) as unknown as AgentSession;

    const costOf = async (options?: { model: string }): Promise<number> => {
      written = '';
      await streamSessionWithAdvisor(session(), options);
      return Number(/session cost: \$([0-9.]+)/.exec(written)?.[1] ?? Number.NaN);
    };

    const named = await costOf({ model: 'claude-opus-5' });
    const unnamed = await costOf(undefined);
    expect(named).toBeCloseTo(0.055, 5);
    expect(unnamed).toBeCloseTo(0.033, 5);
    // The revision path takes the second number for every role it resumes.
    expect(named / unnamed).toBeCloseTo(5 / 3, 4);
  });

  it('the pod-log wire carries one span per turn to the dispatcher', async () => {
    // The k8s transport reaches the ceiling only through this wire: the in-pod
    // session serializes its events to stdout and the dispatcher parses them
    // back. A span that does not survive the round trip is not a weaker ceiling
    // on that transport, it is no ceiling at all.
    const assistant = (id: string, text: string) => ({
      type: 'assistant',
      uuid: `u-${id}-${text}`,
      session_id: 'sess-pod',
      message: {
        id,
        usage: { input_tokens: 10, output_tokens: 20 },
        content: [{ type: 'text', text }],
      },
    });
    const sdk = {
      query() {
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'system', subtype: 'init', session_id: 'sess-pod' };
            yield assistant('msg_A', 'a1');
            yield assistant('msg_A', 'a2');
            yield assistant('msg_B', 'b1');
            yield { type: 'result', subtype: 'success', uuid: 'r', session_id: 'sess-pod' };
          },
          async interrupt() {},
        };
      },
    };
    const session = new SdkAgentSession(sdk, MODEL, 'prompt');
    await session.start('go');

    const lines: string[] = [];
    const exitCode = await streamEventsToJsonl(session.events, (l) => lines.push(l));
    expect(exitCode).toBe(0);

    const onTheWire = lines.map(parseLogLine).filter((e): e is AgentEvent => e !== null);
    const spans = onTheWire.filter((e) => e.type === 'span.model_request_end');
    // Two turns in, two spans out — the third message of turn A is free on the
    // far side of the wire because it was free on the near side.
    expect(spans).toHaveLength(2);
    expect(spans.map((sp) => (sp as { id: string }).id)).toEqual(['msg_A', 'msg_B']);
  });

  it('sdk: emits the span the ceiling reads, not only a total on the result', async () => {
    // The seam itself: the consumer in workflows.ts reads this event type and
    // nothing else, so a transport that never emits it has no route to the
    // ceiling however correct the comparison is.
    const sdk = {
      query() {
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'system', subtype: 'init', session_id: 's' };
            yield assistantMessage('hello', { input_tokens: 1, output_tokens: 2 });
            yield { type: 'result', subtype: 'success', uuid: 'r', session_id: 's' };
          },
          async interrupt() {},
        };
      },
    };
    const session = new SdkAgentSession(sdk, MODEL, 'prompt');
    await session.start('go');
    const seen: AgentEvent[] = [];
    for await (const e of session.events) seen.push(e);
    expect(seen.map((e) => e.type)).toContain('span.model_request_end');
  });
});

// ── The span is accounting, not narration ───────────────────────────
//
// `streamSessionWithAdvisor` writes whatever `formatEvent` returns straight to
// the transcript with no separator, and `formatEvent`'s default branch renders
// an event as its own type name. A span arrives for every charged unit of work, so a span
// that formats to anything splices a type name into the middle of the role's
// text on every transport that emits one.

describe('the cost span stays out of the operator transcript', () => {
  const SPAN: AgentEvent = {
    type: 'span.model_request_end',
    id: 'msg_1',
    is_error: false,
    model_usage: {
      input_tokens: 1,
      output_tokens: 2,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    processed_at: '2026-01-01T00:00:00Z',
  };

  it('formats to nothing rather than to its own type name', () => {
    expect(formatEvent(SPAN)).toBe('');
  });

  it('leaves the streamed text contiguous, and still reports the run cost', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fab-span-'));
    const priorState = process.env.FAB_STATE_FILE;
    process.env.FAB_STATE_FILE = join(dir, 'state.json');
    writeFileSync(
      process.env.FAB_STATE_FILE,
      JSON.stringify({ agents: [], repos: [], skills: [] }),
    );
    let out = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      out += String(chunk);
      return true;
    });
    try {
      const sdk = {
        query() {
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: 'system', subtype: 'init', session_id: 's' };
              yield assistantMessage('first half ', { input_tokens: 1, output_tokens: 2 });
              yield assistantMessage('second half', { input_tokens: 1, output_tokens: 2 });
              yield {
                type: 'result',
                subtype: 'success',
                uuid: 'r',
                session_id: 's',
                total_cost_usd: 0.5,
              };
            },
            async interrupt() {},
          };
        },
      };
      const session = new SdkAgentSession(sdk, MODEL, 'prompt');
      await session.start('go');
      const output = await streamSessionWithAdvisor(session, { model: MODEL });

      expect(out).not.toContain('span.model_request_end');
      expect(out).toContain('first half second half');
      expect(output).toBe('first half second half');
      // Suppressing the event must not suppress what it was accounting for.
      expect(out).toContain('session cost: $0.5000');
    } finally {
      spy.mockRestore();
      if (priorState === undefined) delete process.env.FAB_STATE_FILE;
      else process.env.FAB_STATE_FILE = priorState;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

async function waitForFile(path: string): Promise<void> {
  // Generous because process startup is not what this file measures: under a
  // full suite a child can take seconds to boot, and a bound that fired before
  // it had spoken would end the case for the wrong reason.
  for (let i = 0; i < 1200; i++) {
    if (existsSync(path)) return;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`the fake claude never started: ${path} was not written`);
}

async function waitForExit(pid: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((res) => setTimeout(res, 25));
  }
}
