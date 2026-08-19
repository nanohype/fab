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

describe('published role counts agree with TEAM', () => {
  // Several docs publish role headcounts and names. Nothing at runtime reads
  // them, so prose is free to disagree with the roster it describes. These
  // tests treat each document as an artifact, extract every claim it makes,
  // and hold it to TEAM — so a roster change fails here until the docs follow.
  const docs = (name: string) =>
    readFileSync(join(import.meta.dirname, '..', 'docs', name), 'utf-8');
  const roster = docs('roster.md');
  const intake = docs('INTAKE_GUIDE.md');

  /** The one bullet line matching a pattern, so assertions can't hit stray prose. */
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

  const actual = (model: string) => TEAM.filter((x) => x.model === model).length;

  /**
   * The Hierarchy tree, as {node, count, roles} — each node publishes a count
   * and then names the roles it contains, so both halves are checkable.
   */
  function hierarchy(): { node: string; count: number; roles: string[] }[] {
    const tree = roster.split('## Hierarchy')[1]?.split('```')[1];
    if (!tree) throw new Error('docs/roster.md has no Hierarchy code block');
    const nodes: { node: string; count: number; roles: string[] }[] = [];
    for (const raw of tree.split('\n')) {
      const line = raw.replace(/^[\s│├└─]+/, '').trim();
      const head = line.match(/^([A-Za-z ]+?) \((\d+)\)/);
      if (head) {
        nodes.push({ node: head[1], count: Number(head[2]), roles: [] });
        continue;
      }
      // A roles line is only role names joined by '·' (optionally wrapping
      // with a trailing separator). Anything else in the tree — a parent node
      // like 'Build — 8 parallel sub-area sessions' — is not a role list.
      if (!nodes.length || !/^[a-z0-9-]+(\s*·\s*[a-z0-9-]+)*\s*·?$/.test(line)) continue;
      for (const name of line.split('·')) {
        const role = name.trim();
        if (role) nodes[nodes.length - 1].roles.push(role);
      }
    }
    return nodes;
  }

  it('roster.md states the real total', () => {
    const total = Number(roster.match(/roster is (\d+) specialists/)?.[1]);
    expect(total).toBe(TEAM.length);
  });

  it('INTAKE_GUIDE.md states the real total', () => {
    const total = Number(intake.match(/\((\d+) roles total/)?.[1]);
    expect(total).toBe(TEAM.length);
  });

  it('every hierarchy node counts the roles it lists', () => {
    for (const { node, count, roles } of hierarchy()) {
      expect(`${node}=${roles.length}`).toBe(`${node}=${count}`);
    }
  });

  it('the hierarchy names every role in TEAM, and no others', () => {
    const listed = hierarchy().flatMap((n) => n.roles);
    expect([...new Set(listed)].sort()).toEqual(TEAM.map((m) => m.role).sort());
    expect(listed).toHaveLength(TEAM.length);
  });

  it('states the real claude-sonnet-5 headcount', () => {
    expect(claimed('claude-sonnet-5')).toBe(actual('claude-sonnet-5'));
  });

  it('states the real claude-haiku-4-5 headcount', () => {
    expect(claimed('claude-haiku-4-5')).toBe(actual('claude-haiku-4-5'));
  });

  it('states the real Opus headcount and names exactly those roles', () => {
    // Scoped to the Opus bullet: role names appear elsewhere in the doc, so a
    // whole-file search would still pass with this bullet deleted. Exact, not
    // a subset — the bullet cannot name a role that is not on Opus.
    const line = bullet(/lab roles? on Opus/);
    const opus = TEAM.filter((x) => x.model === 'claude-opus-5').map((m) => m.role);
    expect(Number(line.match(/\*\*(\d+) lab roles? on Opus\*\*/)?.[1])).toBe(opus.length);
    expect([...line.matchAll(/`([a-z-]+)`/g)].map((m) => m[1]).sort()).toEqual([...opus].sort());
  });

  it('the published model counts account for every role', () => {
    const opus = Number(bullet(/lab roles? on Opus/).match(/\*\*(\d+) lab/)?.[1]);
    expect(claimed('claude-sonnet-5') + opus + claimed('claude-haiku-4-5')).toBe(TEAM.length);
  });
});
