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
