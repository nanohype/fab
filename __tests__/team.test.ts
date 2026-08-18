import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TEAM } from '../src/team.js';

describe('TEAM structure', () => {
  it('has 78 agents organized by phase', () => {
    expect(TEAM).toHaveLength(78);
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

describe('roster doc agrees with the roster', () => {
  // docs/roster.md publishes a per-model headcount. Nothing at runtime reads
  // it, so when a role's model changes the prose silently goes stale — it had
  // drifted to claiming 78 sonnet-5 roles alongside "2 lab roles on Opus",
  // summing to 80 against a 78-role roster. Read the doc as the artifact it is
  // and hold every number it publishes to TEAM.
  const roster = readFileSync(join(import.meta.dirname, '..', 'docs', 'roster.md'), 'utf-8');

  /** The one bullet line naming a model, so assertions can't match stray prose. */
  function bullet(pattern: RegExp): string {
    const line = roster.split('\n').find((l) => l.trimStart().startsWith('-') && pattern.test(l));
    if (!line) throw new Error(`docs/roster.md has no bullet matching ${pattern}`);
    return line;
  }

  /** Headcount the doc claims for a model id, from "- **<n> roles on `<model>`**". */
  function claimed(model: string): number {
    const re = new RegExp(`\\*\\*(\\d+) roles? on \\\`${model}\\\``);
    return Number(bullet(re).match(re)?.[1]);
  }

  function actual(model: string): number {
    return TEAM.filter((x) => x.model === model).length;
  }

  it('states the real claude-sonnet-5 headcount', () => {
    expect(claimed('claude-sonnet-5')).toBe(actual('claude-sonnet-5'));
  });

  it('states the real claude-haiku-4-5 headcount', () => {
    expect(claimed('claude-haiku-4-5')).toBe(actual('claude-haiku-4-5'));
  });

  it('states the real Opus headcount and names those roles in that same bullet', () => {
    // Scoped to the Opus bullet on purpose: `external-reviewer` is backticked
    // elsewhere in the doc, so a whole-file search would still pass if this
    // bullet were deleted outright.
    const opusBullet = bullet(/lab roles? on Opus/);
    const opus = TEAM.filter((x) => x.model === 'claude-opus-5');
    expect(Number(opusBullet.match(/\*\*(\d+) lab roles? on Opus\*\*/)?.[1])).toBe(opus.length);
    for (const m of opus) expect(opusBullet).toContain(`\`${m.role}\``);
  });

  it('the published counts account for every role', () => {
    const opusClaimed = Number(bullet(/lab roles? on Opus/).match(/\*\*(\d+) lab/)?.[1]);
    expect(claimed('claude-sonnet-5') + opusClaimed + claimed('claude-haiku-4-5')).toBe(
      TEAM.length,
    );
  });
});
