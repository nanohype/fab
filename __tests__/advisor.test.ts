import { describe, it, expect } from 'vitest';
import { ADVISOR_ROLES, hasAdvisorAccess, ADVISOR_TOOL } from '../src/advisor.js';
import { TEAM } from '../src/team.js';
import type { TeamRole } from '../src/types.js';

describe('advisor access control', () => {
  it('limits advisor access to phase leads + key gate roles', () => {
    expect(ADVISOR_ROLES.size).toBe(12);
    expect(ADVISOR_ROLES.has('intake-analyst')).toBe(true);
    expect(ADVISOR_ROLES.has('product')).toBe(true);
    expect(ADVISOR_ROLES.has('design-lead')).toBe(true);
    expect(ADVISOR_ROLES.has('agent-engineer')).toBe(true);
    expect(ADVISOR_ROLES.has('pr-reviewer')).toBe(true);
    expect(ADVISOR_ROLES.has('release-manager')).toBe(true);
    expect(ADVISOR_ROLES.has('ops-sre')).toBe(true);
    expect(ADVISOR_ROLES.has('cs-success')).toBe(true);
    expect(ADVISOR_ROLES.has('sales-lead')).toBe(true);
    expect(ADVISOR_ROLES.has('marketing-lead')).toBe(true);
    expect(ADVISOR_ROLES.has('chief-of-staff')).toBe(true);
    expect(ADVISOR_ROLES.has('external-reviewer')).toBe(true);
  });

  it('excludes specialist roles from advisor access', () => {
    const specialists: TeamRole[] = [
      'react-engineer',
      'next-engineer',
      'mobile-engineer',
      'node-engineer',
      'python-engineer',
      'go-engineer',
      'rag-engineer',
      'eval-engineer',
      'bedrock-curator',
      'claude-curator',
      'postgres-engineer',
      'opensearch-engineer',
      'dynamodb-curator',
      'aws-curator',
      'opentofu-engineer',
      'terragrunt-engineer',
      'landing-zone-curator',
      'kubernetes-engineer',
      'helm-engineer',
      'eks-agent-platform-curator',
      'qa-security',
      'build-verifier',
      'artifact-auditor',
      'compliance-curator',
      'sales-solutions',
      'sales-ops',
      'content-engineer',
      'seo-engineer',
      'brand-strategist',
      'ops-incident',
      'ops-finops',
      'ops-automation',
      'cs-support',
      'cs-renewals',
      'ux-engineer',
      'ux-writer',
      'accessibility-engineer',
      'product-research-curator',
      'lead-research-curator',
      'lead-outbound',
      'lead-events',
      'github-curator',
      'notion-curator',
      'data-analyst',
      'legal-curator',
      'prompt-optimizer',
      'learner',
    ];
    for (const role of specialists) {
      expect(hasAdvisorAccess(role)).toBe(false);
    }
  });

  it('every role with advisor access exists in TEAM', () => {
    const teamRoles = new Set(TEAM.map((m) => m.role));
    for (const role of ADVISOR_ROLES) {
      expect(teamRoles.has(role)).toBe(true);
    }
  });

  it('advisor tool definition matches contract', () => {
    expect(ADVISOR_TOOL.type).toBe('custom');
    expect(ADVISOR_TOOL.name).toBe('consult_advisor');
    expect(ADVISOR_TOOL.input_schema.required).toContain('question');
    expect(ADVISOR_TOOL.input_schema.required).toContain('context');
    expect(ADVISOR_TOOL.description.toLowerCase()).toMatch(/last resort|irreversible|expensive/);
  });
});
