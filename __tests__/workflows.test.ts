import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getWorkflow,
  listWorkflows,
  executeWorkflow,
  runMergeGate,
  type RoleRunner,
} from '../src/workflows.js';
import type { AnthropicAgents } from '../src/api.js';
import type { AgentRuntime } from '../src/runtime.js';

// The merge gate appends to the cross-engagement quality log; stub that write so
// the gate test stays hermetic.
vi.mock('../src/quality.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/quality.js')>()),
  appendQualityRun: vi.fn(async () => {}),
}));

// Workflow is internal to workflows.ts; recover its type from executeWorkflow's
// signature so test workflows are contextually typed (roles checked as TeamRole).
type TestWorkflow = Parameters<typeof executeWorkflow>[2];

describe('workflows', () => {
  it('listWorkflows returns the built-in catalog', () => {
    const wfs = listWorkflows();
    expect(wfs.length).toBeGreaterThanOrEqual(18);
    const names = wfs.map((w) => w.name);
    expect(names).toContain('launch-prep');
    expect(names).toContain('feature-build');
    expect(names).toContain('incident');
    expect(names).toContain('customer-onboard');
    expect(names).toContain('market-push');
  });

  it('getWorkflow returns a workflow by name', () => {
    const wf = getWorkflow('feature-build');
    expect(wf).toBeDefined();
    expect(wf!.name).toBe('feature-build');
    expect(wf!.steps.length).toBeGreaterThanOrEqual(5);
  });

  it('getWorkflow returns undefined for unknown name', () => {
    expect(getWorkflow('nonexistent')).toBeUndefined();
  });

  it('launch-prep references the new specialist roster', () => {
    const wf = getWorkflow('launch-prep')!;
    const roles = wf.steps.map((s) => s.role);
    expect(roles).toContain('product');
    expect(roles).toContain('design-lead');
    expect(roles).toContain('react-engineer');
    expect(roles).toContain('node-engineer');
    expect(roles).toContain('agent-engineer');
    expect(roles).toContain('build-verifier');
    expect(roles).toContain('qa-security');
    expect(roles).toContain('ops-sre');
    expect(roles).toContain('ops-incident');
    expect(roles).toContain('marketing-lead');
    expect(roles).toContain('sales-lead');
    expect(roles).toContain('cs-success');
    expect(roles).toContain('data-analyst');
    expect(roles).toContain('content-engineer');
  });

  it('launch-prep has multiple parallel groups', () => {
    const wf = getWorkflow('launch-prep')!;
    const groups = new Set(wf.steps.filter((s) => s.group != null).map((s) => s.group));
    expect(groups.size).toBeGreaterThanOrEqual(3);
  });

  it('feature-build has parallel engineering and gate groups', () => {
    const wf = getWorkflow('feature-build')!;
    const grouped = wf.steps.filter((s) => s.group != null);
    expect(grouped.length).toBeGreaterThanOrEqual(5);
  });

  it('feature-build includes remediation and verification steps', () => {
    const wf = getWorkflow('feature-build')!;
    const roles = wf.steps.map((s) => s.role);
    // node-engineer appears twice: implementation + remediation
    expect(roles.filter((r) => r === 'node-engineer').length).toBeGreaterThanOrEqual(2);
    // build-verifier appears twice: testing + final verification
    expect(roles.filter((r) => r === 'build-verifier').length).toBeGreaterThanOrEqual(2);
    const lastNode = roles.lastIndexOf('node-engineer');
    const lastVerifier = roles.lastIndexOf('build-verifier');
    expect(lastNode).toBeLessThan(lastVerifier);
  });

  it('UI-producing workflows include a fidelity-engineer pass after build-verifier', () => {
    for (const name of ['feature-build', 'launch-prep', 'mobile-ship']) {
      const wf = getWorkflow(name)!;
      const roles = wf.steps.map((s) => s.role);
      expect(roles, `${name} should include fidelity-engineer`).toContain('fidelity-engineer');
      // Fidelity runs after the last build-verifier on workflows that have one
      const lastVerifier = roles.lastIndexOf('build-verifier');
      const lastFidelity = roles.lastIndexOf('fidelity-engineer');
      if (lastVerifier >= 0) {
        expect(
          lastVerifier,
          `fidelity-engineer must follow build-verifier in ${name}`,
        ).toBeLessThan(lastFidelity);
      }
    }
  });

  it('incident uses ops-incident specialist', () => {
    const wf = getWorkflow('incident')!;
    const opsSteps = wf.steps.filter((s) => s.role === 'ops-incident');
    expect(opsSteps.length).toBeGreaterThanOrEqual(2);
  });

  it('code-producing workflows declare gateProfile "code"', () => {
    const codeWorkflows = [
      'feature-build',
      'launch-prep',
      'mobile-ship',
      'infra-setup',
      'security-audit',
      'perf-review',
      'incident',
      'automate',
    ];
    for (const name of codeWorkflows) {
      const wf = getWorkflow(name)!;
      expect(wf.gateProfile, `${name} should use code gate`).toBe('code');
    }
  });

  it('content-engine declares gateProfile "docs"', () => {
    const wf = getWorkflow('content-engine')!;
    expect(wf.gateProfile).toBe('docs');
  });

  it('non-code-producing workflows have no gateProfile', () => {
    const nonCodeWorkflows = [
      'sprint-plan',
      'lead-gen',
      'deal-close',
      'customer-onboard',
      'market-push',
    ];
    for (const name of nonCodeWorkflows) {
      const wf = getWorkflow(name)!;
      expect(wf.gateProfile, `${name} should not have a merge gate`).toBeUndefined();
    }
  });
});

describe('executeWorkflow resilience', () => {
  const api = {} as AnthropicAgents;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it('one failing role in a parallel batch degrades to a gap, not an abort', async () => {
    const calls: string[] = [];
    const runRole: RoleRunner = async (_rt, role) => {
      calls.push(role);
      if (role === 'qa-security') throw new Error('transient blip');
      return `output from ${role}`;
    };
    let gateOutput = '';
    const workflow: TestWorkflow = {
      name: 'test-parallel',
      description: 'parallel batch with one failing role',
      steps: [
        { role: 'pr-reviewer', instruction: 'review', group: 1 },
        { role: 'qa-security', instruction: 'scan', group: 1 },
      ],
    };

    await expect(
      executeWorkflow(api, 'sid', workflow, 'brief', {
        runRole,
        onGate: async (_s, _i, output) => {
          gateOutput = output;
          return { decision: 'approve' };
        },
      }),
    ).resolves.toBeUndefined();

    // Both roles were attempted; the run continued past the one that failed.
    expect(calls).toContain('pr-reviewer');
    expect(calls).toContain('qa-security');
    // The survivor's output and the failed role's gap both reach the gate.
    expect(gateOutput).toContain('output from pr-reviewer');
    expect(gateOutput).toContain('ROLE SESSION FAILED: qa-security');
  });

  it('a single failing role degrades to a gap instead of throwing', async () => {
    const runRole: RoleRunner = async () => {
      throw new Error('session died');
    };
    let gateOutput = '';
    const workflow: TestWorkflow = {
      name: 'test-single-fail',
      description: 'single failing step',
      steps: [{ role: 'product', instruction: 'plan' }],
    };

    await expect(
      executeWorkflow(api, 'sid', workflow, 'brief', {
        runRole,
        onGate: async (_s, _i, output) => {
          gateOutput = output;
          return { decision: 'approve' };
        },
      }),
    ).resolves.toBeUndefined();

    expect(gateOutput).toContain('ROLE SESSION FAILED: product');
  });

  it('a gate revise then approve re-runs the step (revision loop)', async () => {
    const calls: string[] = [];
    const runRole: RoleRunner = async (_rt, role) => {
      calls.push(role);
      return `out ${calls.length}`;
    };
    let gateCalls = 0;
    const workflow: TestWorkflow = {
      name: 'test-revise',
      description: 'single gated step',
      steps: [{ role: 'product', instruction: 'plan' }],
    };

    await executeWorkflow(api, 'sid', workflow, 'brief', {
      runRole,
      onGate: async () => {
        gateCalls += 1;
        return gateCalls === 1
          ? { decision: 'revise', feedback: 'tighten it' }
          : { decision: 'approve' };
      },
    });

    expect(calls.filter((r) => r === 'product')).toHaveLength(2);
    expect(gateCalls).toBe(2);
  });

  it('a gate reject stops the workflow without throwing', async () => {
    const runRole: RoleRunner = async () => 'out';
    const workflow: TestWorkflow = {
      name: 'test-reject',
      description: 'single gated step',
      steps: [{ role: 'product', instruction: 'plan' }],
    };

    await expect(
      executeWorkflow(api, 'sid', workflow, 'brief', {
        runRole,
        onGate: async () => ({ decision: 'reject' }),
      }),
    ).resolves.toBeUndefined();
  });
});

describe('runMergeGate resilience', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it('a thrown gate role fails safe (never approves) instead of crashing', async () => {
    const seen: string[] = [];
    const runRole: RoleRunner = async (_rt, role) => {
      seen.push(role);
      throw new Error('gate role offline');
    };

    const result = await runMergeGate({} as AgentRuntime, 'wf', 'docs', 'context', null, runRole);

    // A role that can't run yields no verdict, which can never merge to approve.
    expect(result.decision).not.toBe('approve');
    // The gate kept iterating roles rather than crashing on the first throw.
    expect(seen.length).toBeGreaterThan(0);
  });
});

// ── Merge gate + calibration behavior ───────────────────────────────

// Verdict fixture carrying the TRANSCRIPTS + CITATIONS blocks
// EVIDENCE_CONTRACT requires, plus a QUALITY_GRADES block.
function verdictWith(
  decision: 'APPROVE' | 'REJECT' | 'REQUEST_CHANGES',
  grades: Record<string, string>,
): string {
  const gradeLines = Object.entries(grades)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join('\n');
  return `GATE_VERDICT: ${decision}
GATE_FEEDBACK: fixture feedback

TRANSCRIPTS:
  - command: npm test
    exit: 0
    stdout: |
      Tests  12 passed (12)
    stderr: ""

CITATIONS:
  - claim: fixture claim
    file: src/index.ts
    line_range: 1-2
    quoted_fragment: |
      export {};

QUALITY_GRADES:
${gradeLines}`;
}

// All nine dimensions graded the same letter — the shape a clean run produces.
const NINE = (letter: string): Record<string, string> => ({
  architecture: letter,
  patterns: letter,
  systems: letter,
  testing: letter,
  frontend: letter,
  security: letter,
  code_quality: letter,
  documentation: letter,
  consistency: letter,
});

describe('runMergeGate behavior', () => {
  const runtime = {} as AgentRuntime;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it('docs profile runs only the docs gate roles and skips calibration', async () => {
    const calls: string[] = [];
    const runRole: RoleRunner = async (_rt, role) => {
      calls.push(role);
      return verdictWith('APPROVE', NINE('B'));
    };

    const result = await runMergeGate(runtime, 'wf', 'docs', 'ctx', null, runRole);
    expect(result.decision).toBe('approve');
    expect(calls).toEqual(['artifact-auditor', 'qa-security']);
    expect(calls).not.toContain('external-reviewer');
  });

  it('code profile approve triggers external calibration after all four gate roles', async () => {
    const calls: string[] = [];
    const runRole: RoleRunner = async (_rt, role) => {
      calls.push(role);
      if (role === 'external-reviewer') return `QUALITY_GRADES:\n${gradeBlock(NINE('B'))}`;
      return verdictWith('APPROVE', NINE('B'));
    };

    const result = await runMergeGate(runtime, 'wf', 'code', 'ctx', null, runRole);
    expect(result.decision).toBe('approve');
    expect(calls.slice(0, 4)).toEqual([
      'pr-reviewer',
      'qa-security',
      'build-verifier',
      'artifact-auditor',
    ]);
    expect(calls[4]).toBe('external-reviewer');
  });

  it('blocks release when the cold external grades drift >1 letter', async () => {
    const runRole: RoleRunner = async (_rt, role) => {
      if (role === 'external-reviewer') {
        // Internal says A across the board; external says C on code_quality —
        // a two-letter drift that must block.
        return `QUALITY_GRADES:\n${gradeBlock({ ...NINE('A'), code_quality: 'C' })}`;
      }
      return verdictWith('APPROVE', NINE('A'));
    };

    const result = await runMergeGate(runtime, 'wf', 'code', 'ctx', null, runRole);
    expect(result.decision).toBe('reject');
    expect(result.feedback).toContain('code_quality');
    expect(result.feedback).toContain('drift');
  });

  it('fails open when the external reviewer returns no parseable grades', async () => {
    const runRole: RoleRunner = async (_rt, role) => {
      if (role === 'external-reviewer') return 'I could not complete the review.';
      return verdictWith('APPROVE', NINE('B'));
    };

    const result = await runMergeGate(runtime, 'wf', 'code', 'ctx', null, runRole);
    expect(result.decision).toBe('approve');
  });

  it('fails open when the external reviewer session throws', async () => {
    const runRole: RoleRunner = async (_rt, role) => {
      if (role === 'external-reviewer') throw new Error('session died');
      return verdictWith('APPROVE', NINE('B'));
    };

    const result = await runMergeGate(runtime, 'wf', 'code', 'ctx', null, runRole);
    expect(result.decision).toBe('approve');
  });

  it('an evidence-less APPROVE from one role downgrades and the gate rejects', async () => {
    const runRole: RoleRunner = async (_rt, role) => {
      if (role === 'qa-security') return 'GATE_VERDICT: APPROVE\nGATE_FEEDBACK: trust me';
      return verdictWith('APPROVE', NINE('B'));
    };

    const result = await runMergeGate(runtime, 'wf', 'code', 'ctx', null, runRole);
    expect(result.decision).toBe('reject');
  });

  it('request_changes appends feedback to the context and exhausts after three attempts', async () => {
    const contexts: string[] = [];
    let attempts = 0;
    const runRole: RoleRunner = async (_rt, role, message) => {
      if (role === 'pr-reviewer') {
        attempts++;
        contexts.push(message);
      }
      return verdictWith('REQUEST_CHANGES', NINE('B'));
    };

    const result = await runMergeGate(runtime, 'wf', 'code', 'initial ctx', null, runRole);
    expect(result.decision).toBe('revise');
    expect(attempts).toBe(3);
    expect(contexts[0]).not.toContain('MERGE GATE REVISION REQUESTED');
    expect(contexts[1]).toContain('MERGE GATE REVISION REQUESTED');
    expect(contexts[2]).toContain('MERGE GATE REVISION REQUESTED');
  });

  it('a hard REJECT returns immediately without revision attempts', async () => {
    let calls = 0;
    const runRole: RoleRunner = async (_rt, role) => {
      calls++;
      if (role === 'qa-security') return 'GATE_VERDICT: REJECT\nGATE_FEEDBACK: secrets in diff';
      return verdictWith('APPROVE', NINE('B'));
    };

    const result = await runMergeGate(runtime, 'wf', 'code', 'ctx', null, runRole);
    expect(result.decision).toBe('reject');
    expect(calls).toBe(4); // one pass over the code gate roles, no revision loop
  });
});

function gradeBlock(grades: Record<string, string>): string {
  return Object.entries(grades)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join('\n');
}

describe('executeWorkflow code-profile fail-fast', () => {
  const api = {} as AnthropicAgents;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it('halts a code workflow before any role runs when no feature branch can be pre-created', async () => {
    const runRole = vi.fn(async () => 'should never run');
    const workflow: TestWorkflow = {
      name: 'test-code-failfast',
      description: 'code workflow without repo prerequisites',
      gateProfile: 'code',
      steps: [{ role: 'node-engineer', instruction: 'build it' }],
    };

    // No intake JSON and no primary repo configured (FAB_STATE_FILE points at
    // a throwaway temp path) — branch pre-creation cannot succeed.
    await executeWorkflow(api, 'sid', workflow, 'a plain prose brief', { runRole });

    expect(runRole).not.toHaveBeenCalled();
    const logged = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('Halted');
  });
});

// ── streamSessionWithAdvisor behavior ───────────────────────────────

import { streamSessionWithAdvisor } from '../src/workflows.js';
import type { AgentSession } from '../src/runtime.js';
import type { AgentEvent } from '../src/types.js';
import { setBudgetLimit } from '../src/state.js';

function fakeSession(events: unknown[]): AgentSession & {
  sendInput: ReturnType<typeof vi.fn>;
  interrupt: ReturnType<typeof vi.fn>;
} {
  return {
    id: 'sess-test',
    events: (async function* () {
      for (const e of events) yield e as AgentEvent;
    })(),
    sendInput: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
  } as AgentSession & { sendInput: ReturnType<typeof vi.fn>; interrupt: ReturnType<typeof vi.fn> };
}

const idle = (extra: Record<string, unknown> = {}) => ({ type: 'session.status_idle', ...extra });
const message = (text: string) => ({
  type: 'agent.message',
  content: [{ type: 'text', text }],
});

describe('streamSessionWithAdvisor', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(async () => {
    stdoutSpy.mockRestore();
    await setBudgetLimit(null);
  });

  it('accumulates agent message text and stops at idle', async () => {
    const session = fakeSession([message('hello '), message('world'), idle()]);
    const output = await streamSessionWithAdvisor(session);
    expect(output).toBe('hello world');
  });

  it('continues through a rescheduled session and stops at terminated', async () => {
    const session = fakeSession([
      message('before '),
      { type: 'session.status_rescheduled' },
      message('after'),
      { type: 'session.status_terminated' },
      message('never seen'),
    ]);
    const output = await streamSessionWithAdvisor(session);
    expect(output).toBe('before after');
  });

  it('stops on session.error without consuming further events', async () => {
    const session = fakeSession([
      message('partial'),
      { type: 'session.error', error: { message: 'boom' } },
      message('nope'),
    ]);
    const output = await streamSessionWithAdvisor(session);
    expect(output).toBe('partial');
  });

  it('routes always_ask tool confirmations through onToolConfirm', async () => {
    const session = fakeSession([
      { type: 'agent.tool_use', id: 'tu-1', name: 'Bash', input: { command: 'rm -rf /' } },
      idle({ stop_reason: { type: 'requires_action', event_ids: ['tu-1'] } }),
      idle(),
    ]);
    const onToolConfirm = vi.fn(async () => 'deny' as const);

    await streamSessionWithAdvisor(session, { onToolConfirm });

    expect(onToolConfirm).toHaveBeenCalledWith('Bash', { command: 'rm -rf /' });
    expect(session.sendInput).toHaveBeenCalledWith({
      type: 'user.tool_confirmation',
      tool_use_id: 'tu-1',
      result: 'deny',
    });
  });

  it('auto-allows tool confirmations when no handler is supplied', async () => {
    const session = fakeSession([
      { type: 'agent.tool_use', id: 'tu-2', name: 'Read', input: { file: 'a.ts' } },
      idle({ stop_reason: { type: 'requires_action', event_ids: ['tu-2'] } }),
      idle(),
    ]);

    await streamSessionWithAdvisor(session);

    expect(session.sendInput).toHaveBeenCalledWith({
      type: 'user.tool_confirmation',
      tool_use_id: 'tu-2',
      result: 'allow',
    });
  });

  it('denies advisor consults once the per-session budget is exhausted', async () => {
    const session = fakeSession([
      {
        type: 'agent.custom_tool_use',
        id: 'ct-1',
        name: 'consult_advisor',
        input: { question: 'should we?', context: 'ctx' },
      },
      idle({ stop_reason: { type: 'requires_action', event_ids: ['ct-1'] } }),
      idle(),
    ]);

    await streamSessionWithAdvisor(session, { maxAdvisorCalls: 0 });

    expect(session.sendInput).toHaveBeenCalledTimes(1);
    const input = session.sendInput.mock.calls[0][0] as {
      type: string;
      is_error?: boolean;
      content: { text: string }[];
    };
    expect(input.type).toBe('user.custom_tool_result');
    expect(input.is_error).toBe(true);
    expect(input.content[0].text).toContain('budget exhausted');
  });

  it('interrupts the session when accumulated cost breaches the budget', async () => {
    await setBudgetLimit(0.000001);
    const session = fakeSession([
      {
        type: 'span.model_request_end',
        is_error: false,
        model_usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      },
      message('never reached'),
    ]);

    const output = await streamSessionWithAdvisor(session, { model: 'claude-sonnet-4-6' });

    expect(session.interrupt).toHaveBeenCalled();
    expect(output).toBe('');
  });

  it('adopts the transport-reported total cost from the idle event', async () => {
    const session = fakeSession([message('done'), idle({ total_cost_usd: 1.23 })]);
    const output = await streamSessionWithAdvisor(session);
    expect(output).toBe('done');
    const written = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(written).toContain('1.2300');
  });
});
