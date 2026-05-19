import { describe, it, expect } from 'vitest';
import { getWorkflow, listWorkflows } from '../src/workflows.js';

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
        expect(lastVerifier, `fidelity-engineer must follow build-verifier in ${name}`).toBeLessThan(lastFidelity);
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
    const nonCodeWorkflows = ['sprint-plan', 'lead-gen', 'deal-close', 'customer-onboard', 'market-push'];
    for (const name of nonCodeWorkflows) {
      const wf = getWorkflow(name)!;
      expect(wf.gateProfile, `${name} should not have a merge gate`).toBeUndefined();
    }
  });
});
