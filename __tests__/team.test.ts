import { describe, it, expect } from 'vitest';
import { TEAM } from '../src/team.js';

describe('TEAM structure', () => {
  it('has 80 agents organized by phase', () => {
    expect(TEAM).toHaveLength(80);
  });

  it('every agent has a group field set to factory, firm, or lab', () => {
    for (const m of TEAM) {
      expect(m.group).toBeDefined();
      expect(['factory', 'firm', 'lab']).toContain(m.group);
    }
  });

  it('group distribution matches phase shape: factory > firm > lab', () => {
    const counts = { factory: 0, firm: 0, lab: 0 };
    for (const m of TEAM) {
      if (m.group) counts[m.group]++;
    }
    expect(counts.factory).toBeGreaterThan(counts.firm);
    expect(counts.firm).toBeGreaterThan(counts.lab);
    expect(counts.factory + counts.firm + counts.lab).toBe(TEAM.length);
  });

  it('all roles are unique', () => {
    const roles = TEAM.map((m) => m.role);
    expect(new Set(roles).size).toBe(roles.length);
  });

  it('every agent has a non-empty system prompt', () => {
    for (const m of TEAM) {
      expect(m.system.length).toBeGreaterThan(100);
    }
  });

  it('curator/engineer convention: -curator and -engineer suffix the specialists', () => {
    const suffixed = TEAM.filter(
      (m) => m.role.endsWith('-curator') || m.role.endsWith('-engineer'),
    );
    // The bulk of the roster follows the convention; process names
    // (pr-reviewer, build-verifier, artifact-auditor, release-manager,
    // external-reviewer, etc.) are intentional exceptions.
    expect(suffixed.length).toBeGreaterThan(TEAM.length / 2);
  });

  it('no agent claims the reserved "coordinator" role name', () => {
    // The roster relies on workflow-level multi-session orchestration
    // (Managed Agents caps a multiagent roster at 20 agents and does not
    // nest coordinators). A coordinator role would imply a delegation
    // path the runtime cannot honor.
    const coord = TEAM.filter((m) => (m.role as string) === 'coordinator');
    expect(coord).toHaveLength(0);
  });
});
