import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCliRuntime } from '../src/runtimes/claude-cli.js';
import { SdkAgentSession } from '../src/runtimes/sdk.js';
import { streamSessionWithAdvisor } from '../src/workflows.js';
import { formatEvent } from '../src/stream.js';
import type { AgentEvent } from '../src/types.js';

// ── The budget ceiling, reached from the transports that had no route to it ──
//
// streamSessionWithAdvisor compares its accumulated cost against the limit on
// `span.model_request_end` and on nothing else. The transports that speak the
// Claude Code message shape produced no such span: their only cost signal was
// `total_cost_usd` on the terminal result, which arrives once the session is
// over. A ceiling that is only consulted after the spending has stopped can
// report a breach and can never prevent one, so the kill-switch was declared,
// consumed, and unreachable.
//
// These cases drive the real transports rather than a hand-built event list,
// because the defect was in what the transports emitted, not in the comparison.

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
    // Streaming is the barrier: the first event cannot arrive before the
    // subprocess has run, so there is no separate wait to race against it.
    const output = await streamSessionWithAdvisor(session, { model: MODEL });

    expect(written).toContain('BUDGET EXCEEDED');
    expect(output).toContain('burning tokens');
    expect(output).not.toContain('spent past the ceiling');

    await waitForFile(pidFile);
    const pid = Number(readFileSync(pidFile, 'utf-8'));
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
// an event as its own type name. One span arrives per model request, so a span
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
  for (let i = 0; i < 200; i++) {
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
