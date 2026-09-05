import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
const { executeWorkflow, streamSessionWithAdvisor } = await import('../src/workflows.js');
const { parseSelfEval, SELF_EVAL_LINE } = await import('../src/gate.js');
const { buildSystemPrompt } = await import('../src/prompts.js');
const { TEAM } = await import('../src/team.js');
type RoleRunner = import('../src/workflows.js').RoleRunner;
type AgentSession = import('../src/runtime.js').AgentSession;
type AgentEvent = import('../src/types.js').AgentEvent;
type AnthropicAgents = import('../src/api.js').AnthropicAgents;
type FabState = import('../src/types.js').FabState;
type TestWorkflow = Parameters<typeof executeWorkflow>[1];

// ── Signals emitted where they happen ───────────────────────────────
//
// A metric read out of model prose measures the words a model chose. A revision
// is not a word — it is a decision this codebase makes, in a loop it controls —
// so a counter that searched the output for one moved when a model happened to
// use it and sat at zero through a run that revised in other words.
//
// The self-evaluation is the other half and it is not the same case: a role
// really is the producer, under a line its own system prompt demands. What was
// missing there is that the demand and the read were two strings with nothing
// holding them together, and the read matched anywhere in any message.
//
// These cases watch the producers. The revision cases drive the workflow loop
// and read what it passed; the self-eval cases render a real system prompt and
// hold the parser to what it asks for. None of them supplies the signal it then
// matches — a case that feeds the string it is looking for measures the matcher
// and can never see the producer go quiet.

const ROLE = 'product';

/** A session that streams one turn of usage and whatever text a case gives it. */
function sessionSaying(text: string): AgentSession {
  const events: AgentEvent[] = [
    {
      type: 'span.model_request_end',
      id: 'msg_1',
      is_error: false,
      model_usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      processed_at: new Date().toISOString(),
    },
    {
      type: 'agent.message',
      id: 'e2',
      content: [{ type: 'text', text }],
      processed_at: new Date().toISOString(),
    } as unknown as AgentEvent,
    {
      type: 'session.status_idle',
      id: 'e3',
      processed_at: new Date().toISOString(),
    } as unknown as AgentEvent,
  ];
  return {
    id: 'sess-signal',
    events: (async function* () {
      for (const e of events) yield e;
    })(),
    async sendInput() {},
    async interrupt() {},
  };
}

describe('a revision is counted where the workflow decides on one', () => {
  let dir: string;
  let priorState: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    perfFile.content = undefined;
    dir = mkdtempSync(join(tmpdir(), 'fab-signal-'));
    priorState = process.env.FAB_STATE_FILE;
    process.env.FAB_STATE_FILE = join(dir, 'state.json');
    writeFileSync(
      process.env.FAB_STATE_FILE,
      JSON.stringify({ agents: [], repos: [], skills: [] }),
    );
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    logSpy.mockRestore();
    if (priorState === undefined) delete process.env.FAB_STATE_FILE;
    else process.env.FAB_STATE_FILE = priorState;
    rmSync(dir, { recursive: true, force: true });
  });

  it('tells the runner which attempt it is, once per time the gate sent it back', async () => {
    // The producer. Two revisions then an approval, and the loop reports the
    // attempt it is on — the number it cannot advance without incrementing.
    const attempts: number[] = [];
    const runRole: RoleRunner = async (_rt, _role, _msg, _wf, attempt) => {
      attempts.push(attempt);
      return 'output';
    };
    const workflow: TestWorkflow = {
      name: 'test-revisions',
      description: 'one step, sent back twice',
      steps: [{ role: ROLE, instruction: 'do it' }],
    };
    let seen = 0;
    await executeWorkflow({} as AnthropicAgents, workflow, 'brief', {
      runRole,
      onGate: async () =>
        seen++ < 2 ? { decision: 'revise', feedback: 'again' } : { decision: 'approve' },
    });

    expect(attempts).toEqual([0, 1, 2]);
  });

  it('records a revision for a run the gate sent back, and none for a first run', async () => {
    await streamSessionWithAdvisor(sessionSaying('done'), { agentRole: ROLE, attempt: 0 });
    expect((await loadPerf())[ROLE].revisions).toBe(0);

    await streamSessionWithAdvisor(sessionSaying('done'), { agentRole: ROLE, attempt: 2 });
    expect((await loadPerf())[ROLE].revisions).toBe(1);
  });

  it('counts nothing for a first run that happens to use the word', async () => {
    // What the counter used to measure. `Revising` is a word this codebase
    // prints to its own terminal, and a role that writes it in a sentence has
    // not been sent back by anything.
    await streamSessionWithAdvisor(sessionSaying('Revising the plan as I go, then finishing.'), {
      agentRole: ROLE,
      attempt: 0,
    });

    expect((await loadPerf())[ROLE].revisions).toBe(0);
  });
});

describe('the self-evaluation is read in the form the prompt asks for', () => {
  const member = TEAM.find((m) => m.role === ROLE)!;
  const state: FabState = {
    agents: [],
    skillIds: {},
    environmentId: null,
    memory: { enabled: true, storeId: null },
    journal: { enabled: true, basePath: '/workspace/.fab/journal' },
    repos: [],
    modelOverrides: {},
    sprint: null,
    vaultIds: [],
    budgetLimit: null,
    projectLanguage: 'typescript',
    sourceDirs: [],
  };

  it('asks for a line this parser can read, in the prompt a role is given', async () => {
    // The producer here is a role, and what is observable of it is the prompt
    // it runs under. A section deleted or reworded so the parser stops reading
    // it fails here rather than showing up as a factory that stopped
    // self-evaluating.
    const rendered = buildSystemPrompt(member, state);
    const asked = rendered.split('\n').find((l) => l.trimStart().startsWith('SELF-EVAL:'));
    expect(asked, 'the system prompt no longer asks for a self-evaluation').toBeDefined();

    // The answer is derived from what was asked rather than written out here,
    // so the case cannot keep passing against a contract that has moved.
    expect(parseSelfEval(asked!.replace(/PASS \| FAIL.*/, 'PASS'))).toBe('pass');
    expect(parseSelfEval(asked!.replace(/PASS \| FAIL.*/, 'FAIL (failed: [tests])'))).toBe('fail');
  });

  it('reads the instruction itself as no verdict at all', async () => {
    // The line the prompt carries names both outcomes. A role that echoes its
    // instructions is describing the form, not answering in it — and a search
    // for each word separately scores that session both a pass and a fail.
    expect(parseSelfEval(SELF_EVAL_LINE)).toBeNull();
  });

  it('reads a mention inside prose as no verdict', async () => {
    expect(parseSelfEval('I will end with SELF-EVAL: PASS once the checks are done.')).toBeNull();
  });

  it('scores one verdict per message, not one per word present', async () => {
    await streamSessionWithAdvisor(
      sessionSaying('All checks green.\nSELF-EVAL: PASS\nARTIFACTS: [src/a.ts]'),
      { agentRole: ROLE, attempt: 0 },
    );

    const row = (await loadPerf())[ROLE];
    expect(row.selfEvalPass).toBe(1);
    expect(row.selfEvalFail).toBe(0);
  });
});
