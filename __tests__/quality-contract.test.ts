import { describe, it, expect } from 'vitest';
import { TEAM } from '../src/team.js';
import { parseGateVerdict, parseQualityGrades } from '../src/gate.js';
import {
  QUALITY_DIMENSIONS,
  QUALITY_DIMENSION_OWNERS,
  QUALITY_RUBRIC,
  MERGE_GATE_CONTRACT,
} from '../src/standards.js';
import type { TeamRole } from '../src/types.js';

// The grading loop only closes if three independent things agree: the block a
// gate role declares in its own prompt, the parser that reads it, and the
// dimension contract both are supposed to obey. Nothing at runtime notices
// when they don't — parseQualityGrades returns {} for an unreadable block, and
// an empty grade map is indistinguishable from a workflow that never reached
// the gate, so the external-reviewer calibration compares nothing against
// nothing and passes.
//
// These tests read each role's prompt as the artifact it is, extract the block
// it tells the model to emit, and run it through the real parser.

const GRADE = 'B+';

/** Pull the QUALITY_GRADES block out of a prompt and fill in the placeholders. */
function declaredBlock(prompt: string): string | null {
  const header = prompt.match(/^QUALITY_GRADES:[^\n]*$/m);
  if (!header || header.index === undefined) return null;
  const rest = prompt.slice(header.index + header[0].length);
  // The block runs to the next unindented line — the role prompts follow it
  // with TRANSCRIPTS: or prose.
  const end = rest.search(/\n(?=\S)/);
  const body = end === -1 ? rest : rest.slice(0, end);
  return (header[0] + body).replace(/<grade>/g, GRADE);
}

function roleprompt(role: TeamRole): string {
  const member = TEAM.find((m) => m.role === role);
  if (!member) throw new Error(`no such role: ${role}`);
  return member.system;
}

describe('quality-grade contract', () => {
  it('the owners map partitions the dimension list', () => {
    const owned = Object.values(QUALITY_DIMENSION_OWNERS).flat();
    // Every dimension graded exactly once. A duplicate means two roles fight
    // over one grade (aggregateGrades keeps the later verdict, so the winner
    // depends on gate ordering); a gap means a dimension the external reviewer
    // grades cold and the internal gate never produces a counterpart for.
    expect([...owned].sort()).toEqual([...QUALITY_DIMENSIONS].sort());
    expect(new Set(owned).size).toBe(owned.length);
  });

  for (const [role, dimensions] of Object.entries(QUALITY_DIMENSION_OWNERS)) {
    describe(role, () => {
      const prompt = roleprompt(role as TeamRole);

      it('declares a block the parser can read', () => {
        const block = declaredBlock(prompt);
        expect(block, `${role} declares no QUALITY_GRADES block`).not.toBeNull();

        const parsed = parseQualityGrades(block as string);
        // The original bug: the block was one inline line, the parser wants a
        // bare header plus indented lines, and the mismatch produced {}.
        expect(
          Object.keys(parsed).length,
          `${role}'s declared block parses to no grades`,
        ).toBeGreaterThan(0);
      });

      it('declares exactly the dimensions it owns', () => {
        const parsed = parseQualityGrades(declaredBlock(prompt) as string);
        expect(Object.keys(parsed).sort()).toEqual([...dimensions].sort());
      });

      it('declares no dimension outside the contract', () => {
        const parsed = parseQualityGrades(declaredBlock(prompt) as string);
        for (const key of Object.keys(parsed)) {
          expect(QUALITY_DIMENSIONS as readonly string[]).toContain(key);
        }
      });

      it('survives a whole verdict, not just the block', () => {
        // parseGateVerdict slices the output into blocks before grading, so a
        // block that parses alone can still be lost in context.
        const verdict = parseGateVerdict(
          role as TeamRole,
          [
            'GATE_VERDICT: APPROVE',
            'GATE_FEEDBACK: reads fine.',
            '',
            'TRANSCRIPTS:',
            '  - command: npm test',
            '    exit: 0',
            '',
            'CITATIONS:',
            '  - claim: it builds',
            '    file: src/index.ts',
            '    line_range: 1-2',
            '',
            declaredBlock(prompt),
          ].join('\n'),
        );
        expect(Object.keys(verdict.grades ?? {}).sort()).toEqual([...dimensions].sort());
      });
    });
  }

  describe('external-reviewer', () => {
    const prompt = roleprompt('external-reviewer');

    it('grades every dimension, since it is the calibration signal', () => {
      const block = declaredBlock(prompt);
      expect(block).not.toBeNull();
      const parsed = parseQualityGrades(block as string);
      // A dimension the cold reviewer omits is one the internal gate is never
      // checked against — the calibration silently covers less than it claims.
      expect(Object.keys(parsed).sort()).toEqual([...QUALITY_DIMENSIONS].sort());
    });
  });

  describe('the preamble the roles are graded against', () => {
    it('names every dimension', () => {
      for (const dimension of QUALITY_DIMENSIONS) {
        expect(QUALITY_RUBRIC).toContain(dimension);
      }
    });

    it('shows a block shape the parser accepts', () => {
      // The rubric carries a worked example. If that example is unreadable,
      // every role copying it is unreadable too.
      const parsed = parseQualityGrades(QUALITY_RUBRIC);
      expect(Object.keys(parsed).length).toBeGreaterThan(0);
    });

    it('does not promise a dimension count it does not have', () => {
      const count = QUALITY_DIMENSIONS.length;
      const wrong = [/all nine (?:QUALITY_RUBRIC )?dimensions/i, /\b9 (?:quality )?dimensions/i];
      for (const text of [QUALITY_RUBRIC, MERGE_GATE_CONTRACT]) {
        for (const re of wrong) {
          expect(text, `stale dimension count (there are ${count})`).not.toMatch(re);
        }
      }
    });
  });
});
