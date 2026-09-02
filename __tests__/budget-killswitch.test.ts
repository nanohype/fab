import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCliRuntime } from '../src/runtimes/claude-cli.js';
import { SdkAgentSession, SdkRuntime } from '../src/runtimes/sdk.js';
import { streamSessionWithAdvisor } from '../src/workflows.js';
import { streamEventsToJsonl } from '../src/runtimes/role-session.js';
import { parseLogLine } from '../src/runtimes/sdk-k8s.js';
import { formatEvent } from '../src/stream.js';
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
    saved = {
      state: process.env.FAB_STATE_FILE,
      claude: process.env.FAB_CLAUDE_PATH,
      mcp: process.env.FAB_CLAUDE_MCP_DIR,
      idle: process.env.FAB_SESSION_IDLE_MS,
    };
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
    for (const [k, v] of [
      ['FAB_STATE_FILE', saved.state],
      ['FAB_CLAUDE_PATH', saved.claude],
      ['FAB_CLAUDE_MCP_DIR', saved.mcp],
      ['FAB_SESSION_IDLE_MS', saved.idle],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
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
    const pidFile = join(dir, 'pid');
    const fake = join(dir, 'claude');
    const line = (o: unknown) =>
      `process.stdout.write(${JSON.stringify(`${JSON.stringify(o)}\n`)});`;
    writeFileSync(
      fake,
      [
        '#!/usr/bin/env node',
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
        line({ type: 'system', subtype: 'init', session_id: 'sess-budget' }),
        line(assistantMessage('burning tokens', EXPENSIVE)),
        line(assistantMessage('spent past the ceiling', EXPENSIVE)),
        // Never reached if the ceiling acts; the process would otherwise sit
        // here forever, which is what a run past its budget looks like.
        'setInterval(() => {}, 1e9);',
      ].join('\n'),
      { mode: 0o755 },
    );
    // writeFileSync's mode is masked by the umask; the bit has to be set again.
    chmodSync(fake, 0o755);
    process.env.FAB_CLAUDE_PATH = fake;
    process.env.FAB_CLAUDE_MCP_DIR = dir;
    // Far enough above this case's own duration that the wall clock cannot be
    // what ends the session, and low enough that a subprocess which never
    // speaks fails the case by name instead of hanging it.
    process.env.FAB_SESSION_IDLE_MS = '20000';

    const session = await new ClaudeCliRuntime().runRoleSession('pr-reviewer', 'go');
    // The child writes its pid before it writes an event, so waiting for the
    // file is waiting for it to exist. Without that wait the wall clock races
    // process startup, and under a loaded suite the clock wins — which would
    // end the session for a reason this case is not about.
    await waitForFile(pidFile);
    const pid = Number(readFileSync(pidFile, 'utf-8'));

    const output = await streamSessionWithAdvisor(session, { model: MODEL });

    expect(written).toContain('BUDGET EXCEEDED');
    expect(output).toContain('burning tokens');
    expect(output).not.toContain('spent past the ceiling');

    await waitForExit(pid);
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  }, 60_000);

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
    const dir = mkdtempSync(join(tmpdir(), 'fab-cli-turn-'));
    const pidFile = join(dir, 'pid');
    const fake = join(dir, 'claude');
    const line = (o: unknown) =>
      `process.stdout.write(${JSON.stringify(`${JSON.stringify(o)}\n`)});`;
    const msg = (id: string, text: string) => ({
      type: 'assistant',
      uuid: `u-${id}-${text}`,
      session_id: 'sess-cli',
      message: {
        id,
        usage: { input_tokens: 0, output_tokens: 20_000 },
        content: [{ type: 'text', text }],
      },
    });
    writeFileSync(
      fake,
      [
        '#!/usr/bin/env node',
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
        line({ type: 'system', subtype: 'init', session_id: 'sess-cli' }),
        line(msg('msg_A', 'a1')),
        line(msg('msg_A', 'a2')),
        line(msg('msg_A', 'a3')),
        line(msg('msg_B', 'b1')),
        line({ type: 'result', subtype: 'success', uuid: 'r', session_id: 'sess-cli' }),
      ].join('\n'),
      { mode: 0o755 },
    );
    chmodSync(fake, 0o755);

    const saved = {
      path: process.env.FAB_CLAUDE_PATH,
      mcp: process.env.FAB_CLAUDE_MCP_DIR,
      idle: process.env.FAB_SESSION_IDLE_MS,
    };
    process.env.FAB_CLAUDE_PATH = fake;
    process.env.FAB_CLAUDE_MCP_DIR = dir;
    // Far above this case's own duration, and low enough that a subprocess
    // which never speaks ends the stream by name instead of hanging it.
    process.env.FAB_SESSION_IDLE_MS = '20000';
    try {
      const session = await new ClaudeCliRuntime().runRoleSession('pr-reviewer', 'go');
      await waitForFile(pidFile);
      const output = await streamSessionWithAdvisor(session, { model: MODEL });

      // One turn is $0.30 against a $0.50 limit; the second takes it to $0.60.
      // Charged per message the first turn alone would have been $0.90.
      expect(written).toContain('BUDGET EXCEEDED');
      expect(written).toMatch(/\$0\.60 \/ \$0\.50/);
      expect(output).toContain('a1');
      expect(output).toContain('b1');
    } finally {
      if (saved.path === undefined) delete process.env.FAB_CLAUDE_PATH;
      else process.env.FAB_CLAUDE_PATH = saved.path;
      if (saved.mcp === undefined) delete process.env.FAB_CLAUDE_MCP_DIR;
      else process.env.FAB_CLAUDE_MCP_DIR = saved.mcp;
      if (saved.idle === undefined) delete process.env.FAB_SESSION_IDLE_MS;
      else process.env.FAB_SESSION_IDLE_MS = saved.idle;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

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
