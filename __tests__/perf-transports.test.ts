import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Only the perf table is intercepted, and only by path: every transport below
// reads workspace state and writes its own files through this same module, so
// replacing it wholesale would stub the code under test rather than the file it
// keeps.
const PERF_PATH = join(process.cwd(), '.fab-perf.json');
const perfFile = { content: undefined as string | undefined };
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    readFile: async (p: unknown, ...rest: unknown[]) => {
      if (String(p) === PERF_PATH) {
        if (perfFile.content === undefined) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        return perfFile.content;
      }
      return real.readFile(p as string, ...(rest as []));
    },
    writeFile: async (p: unknown, data: unknown, ...rest: unknown[]) => {
      if (String(p) === PERF_PATH) {
        perfFile.content = String(data);
        return;
      }
      return real.writeFile(p as string, data as string, ...(rest as []));
    },
  };
});

const { loadPerf } = await import('../src/perf.js');
const { streamSessionWithAdvisor } = await import('../src/workflows.js');
const { SdkAgentSession } = await import('../src/runtimes/sdk.js');
const { ManagedAgentsRuntime } = await import('../src/runtimes/managed-agents.js');
const { streamEventsToJsonl } = await import('../src/runtimes/role-session.js');
const { parseLogLine } = await import('../src/runtimes/sdk-k8s.js');
const { RUNTIME_NAMES } = await import('../src/runtime.js');
const { assistantMessage, initLine, resultLine, startFakeClaudeSession } = await import(
  './helpers/fake-claude.js'
);
type AgentSession = import('../src/runtime.js').AgentSession;
type RuntimeName = import('../src/runtime.js').RuntimeName;
type AgentEvent = import('../src/types.js').AgentEvent;
type AnthropicAgents = import('../src/api.js').AnthropicAgents;

// ── What a run is recorded as, on every transport ───────────────────
//
// The per-role table is what `fab perf` prints and what any exporter over it
// would publish, so a transport that produces a session and records nothing
// does not show as missing — it shows as a role that did no work. That makes
// the population the transport list rather than the fields: a number that is
// right for one transport and absent for three is a dashboard that is wrong
// without looking wrong.
//
// Each case drives a real session of its transport and reads the table back.
// The fixtures stand in for the substrate — an SDK query, a `claude` binary,
// the pod's log — and for nothing in fab: what turns a session into a row is
// the same consumer on all four.

const ROLE = 'product';
const MODEL = 'claude-sonnet-5';
/** One API turn: the usage a span carries, and the text a self-eval carries. */
const TURN = { input_tokens: 10, output_tokens: 20 };
const TEXT = 'SELF-EVAL: PASS';

/** An `AgentSession` over a fixed event list — the far side of the pod's log. */
function sessionOverEvents(id: string, events: AgentEvent[]): AgentSession {
  return {
    id,
    events: (async function* () {
      for (const e of events) yield e;
    })(),
    async sendInput() {},
    async interrupt() {},
  };
}

/** The sdk loop, with the Agent SDK's own query replaced by one turn. */
async function sdkSession(): Promise<AgentSession> {
  const sdk = {
    query() {
      return {
        async *[Symbol.asyncIterator]() {
          yield initLine('sess-perf');
          yield assistantMessage('msg_1', TEXT, TURN, 'sess-perf');
          yield resultLine('sess-perf');
        },
        async interrupt() {},
      };
    },
  };
  const session = new SdkAgentSession(sdk, MODEL, 'prompt');
  await session.start('go');
  return session;
}

type Driven = { session: AgentSession; dispose: () => void };

/**
 * One real session per transport, carrying one turn and one self-eval line.
 *
 * Keyed by the transport list, so a transport the tree can run and this file
 * cannot drive is a compile error rather than a row nobody checked.
 */
const DRIVE: Record<RuntimeName, () => Promise<Driven>> = {
  'managed-agents': async () => {
    const api = {
      stream: async function* () {
        yield {
          type: 'span.model_request_end',
          id: 'msg_1',
          is_error: false,
          model_usage: { ...TURN, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          processed_at: new Date().toISOString(),
        } as AgentEvent;
        yield {
          type: 'agent.message',
          id: 'e2',
          content: [{ type: 'text', text: TEXT }],
          processed_at: new Date().toISOString(),
        } as unknown as AgentEvent;
        yield {
          type: 'session.status_idle',
          id: 'e3',
          processed_at: new Date().toISOString(),
        } as unknown as AgentEvent;
      },
    } as unknown as AnthropicAgents;
    return { session: new ManagedAgentsRuntime(api).resumeSession('sess-perf'), dispose: () => {} };
  },

  sdk: async () => ({ session: await sdkSession(), dispose: () => {} }),

  'sdk-k8s': async () => {
    // The dispatcher sees this transport only through the pod's log: the in-pod
    // sdk loop serializes its events to stdout and the dispatcher parses them
    // back. A session recorded here is one recorded from what survives that
    // round trip.
    const lines: string[] = [];
    await streamEventsToJsonl((await sdkSession()).events, (l) => lines.push(l));
    const events = lines.map(parseLogLine).filter((e): e is AgentEvent => e !== null);
    return { session: sessionOverEvents('sess-perf', events), dispose: () => {} };
  },

  'claude-cli': async () => {
    const fake = await startFakeClaudeSession({
      emit: [initLine(), assistantMessage('msg_1', TEXT, TURN), resultLine()],
    });
    return { session: fake.session, dispose: () => fake.dispose() };
  },
};

describe('a session is recorded whatever transport ran it', () => {
  let dir: string;
  let priorState: string | undefined;

  beforeEach(() => {
    perfFile.content = undefined;
    dir = mkdtempSync(join(tmpdir(), 'fab-perf-'));
    priorState = process.env.FAB_STATE_FILE;
    process.env.FAB_STATE_FILE = join(dir, 'state.json');
    writeFileSync(
      process.env.FAB_STATE_FILE,
      JSON.stringify({ agents: [], repos: [], skills: [] }),
    );
  });

  afterEach(() => {
    if (priorState === undefined) delete process.env.FAB_STATE_FILE;
    else process.env.FAB_STATE_FILE = priorState;
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(RUNTIME_NAMES)(
    '%s records the run it produced',
    async (name) => {
      const driven = await DRIVE[name]();
      try {
        await streamSessionWithAdvisor(driven.session, { agentRole: ROLE, model: MODEL });
      } finally {
        driven.dispose();
      }

      const perf = await loadPerf();
      const row = perf[ROLE];
      expect(row, `${name} recorded no row for the role that ran`).toBeDefined();
      expect(row.sessions, `${name} counted no session`).toBe(1);
      expect(row.totalInputTokens, `${name} recorded no input tokens`).toBe(TURN.input_tokens);
      expect(row.totalOutputTokens, `${name} recorded no output tokens`).toBe(TURN.output_tokens);
      expect(row.totalCostUsd, `${name} priced the run at nothing`).toBeGreaterThan(0);
      expect(row.selfEvalPass, `${name} saw no self-eval`).toBe(1);
    },
    30_000,
  );

  it('records the cost the ceiling arrived at, not a second pass over the tokens', async () => {
    // Two numbers describe one run: the estimate accumulated per request, and
    // the run total the transport reports at the end. The table carries what
    // the ceiling arrived at, so a reader of the table and a reader of the
    // ceiling are looking at one number. Re-pricing the stored token counts
    // afterwards answers a different question and cannot see either one — it
    // has no cache split, no per-request model, and no billed total.
    const BILLED = 1.23;
    const api = {
      stream: async function* () {
        yield {
          type: 'span.model_request_end',
          id: 'msg_1',
          is_error: false,
          model_usage: { ...TURN, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          processed_at: new Date().toISOString(),
        } as AgentEvent;
        yield {
          type: 'session.status_idle',
          id: 'e2',
          total_cost_usd: BILLED,
          processed_at: new Date().toISOString(),
        } as unknown as AgentEvent;
      },
    } as unknown as AnthropicAgents;

    await streamSessionWithAdvisor(new ManagedAgentsRuntime(api).resumeSession('sess-billed'), {
      agentRole: ROLE,
      model: MODEL,
    });

    const row = (await loadPerf())[ROLE];
    expect(row.totalCostUsd).toBeCloseTo(BILLED, 6);
    // What a second pass over the stored tokens would have produced.
    expect(row.totalCostUsd).not.toBeCloseTo(0.0003, 4);
  });

  it('records against the role that ran, and nothing when none is named', async () => {
    // The revision path resumes a session by id and names no role. A row under
    // some other role would be worse than the absent one: it attributes spend
    // to work that did not happen.
    const { session } = await DRIVE.sdk();
    await streamSessionWithAdvisor(session, { model: MODEL });
    expect(await loadPerf()).toEqual({});
  });
});
