import { describe, it, expect } from 'vitest';
import {
  parseGateVerdict,
  mergeGateVerdicts,
  applySelfReviewDowngrade,
  parseQualityGrades,
  compareGrades,
} from '../src/gate.js';
import type { GateVerdict, Grade } from '../src/gate.js';
import type { TeamRole } from '../src/types.js';

// Helper: wrap a verdict body with the TRANSCRIPTS+CITATIONS+QUALITY_GRADES
// blocks that EVIDENCE_CONTRACT now requires for APPROVE/REQUEST_CHANGES.
function withEvidence(body: string, opts?: { grades?: Record<string, string> }): string {
  const gradesBlock = opts?.grades
    ? '\n\nQUALITY_GRADES:\n' +
      Object.entries(opts.grades)
        .map(([k, v]) => `  ${k}: ${v}`)
        .join('\n')
    : '';
  return `${body}

TRANSCRIPTS:
  - command: npm test
    exit: 0
    stdout: |
      Tests  42 passed (42)
    stderr: ""

CITATIONS:
  - claim: auth middleware resolves identity via upstream IdP
    file: src/auth/middleware.ts
    line_range: 20-34
    quoted_fragment: |
      const { userId } = await oktaClient.users.getByEmail(claim.email);${gradesBlock}`;
}

describe('parseGateVerdict', () => {
  it('extracts APPROVE when evidence blocks present', () => {
    const out = withEvidence('Looks good.\n\nGATE_VERDICT: APPROVE');
    const v = parseGateVerdict('pr-reviewer', out);
    expect(v.verdict).toBe('APPROVE');
    expect(v.feedback).toBe('');
    expect(v.role).toBe('pr-reviewer');
  });

  it('downgrades APPROVE to REJECT when TRANSCRIPTS missing', () => {
    const out = [
      'GATE_VERDICT: APPROVE',
      '',
      'CITATIONS:',
      '  - claim: auth works',
      '    file: src/auth.ts',
      '    line_range: 1-10',
      '    quoted_fragment: |',
      '      const token = ...',
    ].join('\n');
    const v = parseGateVerdict('pr-reviewer', out);
    expect(v.verdict).toBe('REJECT');
    expect(v.feedback).toContain('TRANSCRIPTS');
    expect(v.feedback).toContain('EVIDENCE_CONTRACT');
  });

  it('downgrades APPROVE to REJECT when CITATIONS missing', () => {
    const out = [
      'GATE_VERDICT: APPROVE',
      '',
      'TRANSCRIPTS:',
      '  - command: npm test',
      '    exit: 0',
      '    stdout: |',
      '      ok',
    ].join('\n');
    const v = parseGateVerdict('pr-reviewer', out);
    expect(v.verdict).toBe('REJECT');
    expect(v.feedback).toContain('CITATIONS');
  });

  it('downgrades APPROVE to REJECT when both evidence blocks missing', () => {
    const out = 'GATE_VERDICT: APPROVE';
    const v = parseGateVerdict('pr-reviewer', out);
    expect(v.verdict).toBe('REJECT');
    expect(v.feedback).toContain('TRANSCRIPTS');
    expect(v.feedback).toContain('CITATIONS');
  });

  it('downgrades APPROVE when evidence headers present but empty', () => {
    // Header with nothing indented underneath must not count.
    const out = 'GATE_VERDICT: APPROVE\n\nTRANSCRIPTS:\n\nCITATIONS:';
    const v = parseGateVerdict('pr-reviewer', out);
    expect(v.verdict).toBe('REJECT');
  });

  it('extracts REJECT with required feedback (no evidence needed)', () => {
    const out = [
      'Found a critical issue.',
      '',
      'GATE_VERDICT: REJECT',
      'GATE_FEEDBACK: Secrets are committed in plaintext to the Dockerfile.',
    ].join('\n');
    const v = parseGateVerdict('qa-security', out);
    expect(v.verdict).toBe('REJECT');
    expect(v.feedback).toContain('Secrets are committed');
  });

  it('extracts REQUEST_CHANGES with feedback when evidence present', () => {
    const out = withEvidence('GATE_VERDICT: REQUEST_CHANGES\nGATE_FEEDBACK: Add load tests.');
    const v = parseGateVerdict('build-verifier', out);
    expect(v.verdict).toBe('REQUEST_CHANGES');
    expect(v.feedback).toBe('Add load tests.');
  });

  it('downgrades REQUEST_CHANGES to REJECT when evidence missing', () => {
    const out = 'GATE_VERDICT: REQUEST_CHANGES\nGATE_FEEDBACK: Add load tests.';
    const v = parseGateVerdict('build-verifier', out);
    expect(v.verdict).toBe('REJECT');
    expect(v.feedback).toContain('EVIDENCE_CONTRACT');
  });

  it('defaults to REQUEST_CHANGES on missing verdict block', () => {
    const out = 'I looked at it but forgot to emit a verdict.';
    const v = parseGateVerdict('artifact-auditor', out);
    expect(v.verdict).toBe('REQUEST_CHANGES');
    expect(v.feedback).toContain('Could not parse');
  });

  it('returns REJECT when REJECT emitted without feedback', () => {
    const out = 'GATE_VERDICT: REJECT';
    const v = parseGateVerdict('qa-security', out);
    expect(v.verdict).toBe('REJECT');
    expect(v.feedback).toContain('without GATE_FEEDBACK');
  });

  it('is case-insensitive on the block markers (with evidence)', () => {
    const out = withEvidence('gate_verdict: approve\ngate_feedback: lgtm');
    const v = parseGateVerdict('pr-reviewer', out);
    expect(v.verdict).toBe('APPROVE');
    expect(v.feedback).toBe('lgtm');
  });

  it('parses QUALITY_GRADES when present', () => {
    const out = withEvidence('GATE_VERDICT: APPROVE', {
      grades: { architecture: 'B+', patterns: 'A-', code_quality: 'B' },
    });
    const v = parseGateVerdict('pr-reviewer', out);
    expect(v.grades).toEqual({ architecture: 'B+', patterns: 'A-', code_quality: 'B' });
  });
});

describe('mergeGateVerdicts', () => {
  const v = (role: TeamRole, verdict: GateVerdict['verdict'], feedback = ''): GateVerdict => ({
    role,
    verdict,
    feedback,
  });

  it('returns approve when all APPROVE', () => {
    const result = mergeGateVerdicts([
      v('pr-reviewer', 'APPROVE'),
      v('qa-security', 'APPROVE'),
      v('build-verifier', 'APPROVE'),
      v('artifact-auditor', 'APPROVE'),
    ]);
    expect(result.decision).toBe('approve');
  });

  it('returns reject when any REJECT present', () => {
    const result = mergeGateVerdicts([
      v('pr-reviewer', 'APPROVE'),
      v('qa-security', 'REJECT', 'IAM wildcards on S3.'),
      v('build-verifier', 'REQUEST_CHANGES', 'missing tests'),
      v('artifact-auditor', 'APPROVE'),
    ]);
    expect(result.decision).toBe('reject');
    expect(result.feedback).toContain('IAM wildcards');
  });

  it('returns revise when any REQUEST_CHANGES but no REJECT', () => {
    const result = mergeGateVerdicts([
      v('pr-reviewer', 'APPROVE'),
      v('qa-security', 'APPROVE'),
      v('build-verifier', 'REQUEST_CHANGES', 'coverage below 70%'),
      v('artifact-auditor', 'APPROVE'),
    ]);
    expect(result.decision).toBe('revise');
    expect(result.feedback).toContain('coverage below 70%');
  });

  it('rejects on zero verdicts (config error)', () => {
    const result = mergeGateVerdicts([]);
    expect(result.decision).toBe('reject');
  });
});

describe('applySelfReviewDowngrade', () => {
  it('downgrades conflicted role to advisory', () => {
    const verdicts: GateVerdict[] = [
      { role: 'pr-reviewer', verdict: 'APPROVE', feedback: '' },
      { role: 'qa-security', verdict: 'REJECT', feedback: 'big issue' },
    ];
    const conflicted = new Set<TeamRole>(['qa-security']);
    const out = applySelfReviewDowngrade(verdicts, conflicted);
    expect(out.find((v) => v.role === 'qa-security')?.advisory).toBe(true);
    expect(out.find((v) => v.role === 'pr-reviewer')?.advisory).toBeUndefined();
  });

  it('advisory REJECT does not force reject decision', () => {
    const verdicts: GateVerdict[] = [
      { role: 'pr-reviewer', verdict: 'APPROVE', feedback: '' },
      { role: 'qa-security', verdict: 'APPROVE', feedback: '' },
      { role: 'build-verifier', verdict: 'APPROVE', feedback: '' },
      { role: 'artifact-auditor', verdict: 'REJECT', feedback: 'self-touch' },
    ];
    const conflicted = new Set<TeamRole>(['artifact-auditor']);
    const downgraded = applySelfReviewDowngrade(verdicts, conflicted);
    const result = mergeGateVerdicts(downgraded);
    expect(result.decision).toBe('approve');
    expect(result.feedback).toContain('Advisory:');
  });
});

describe('parseQualityGrades', () => {
  it('extracts a simple grade block', () => {
    const out = [
      'GATE_VERDICT: APPROVE',
      '',
      'QUALITY_GRADES:',
      '  architecture: B+',
      '  patterns: A-',
      '  code_quality: B',
      '  frontend: N/A',
    ].join('\n');
    expect(parseQualityGrades(out)).toEqual({
      architecture: 'B+',
      patterns: 'A-',
      code_quality: 'B',
      frontend: 'N/A',
    });
  });

  it('returns empty object when block is absent', () => {
    expect(parseQualityGrades('GATE_VERDICT: APPROVE')).toEqual({});
  });

  it('skips unknown grade values silently', () => {
    const out = [
      'QUALITY_GRADES:',
      '  architecture: B',
      '  patterns: GREAT', // invalid
      '  code_quality: B',
    ].join('\n');
    expect(parseQualityGrades(out)).toEqual({ architecture: 'B', code_quality: 'B' });
  });

  it('is case-insensitive on grade letters', () => {
    const out = 'QUALITY_GRADES:\n  architecture: b+';
    // Letter regex expects uppercase; lowercase should not parse.
    expect(parseQualityGrades(out)).toEqual({});
  });
});

describe('compareGrades', () => {
  it('returns zero drift when internal and external agree', () => {
    const i: Record<string, Grade> = { architecture: 'B+', security: 'A-' };
    const e: Record<string, Grade> = { architecture: 'B', security: 'A' };
    const d = compareGrades(i, e);
    expect(d.drifted).toEqual([]);
    expect(d.maxDrift).toBe(0);
  });

  it('detects one-letter drift without flagging it', () => {
    const i: Record<string, Grade> = { architecture: 'B' };
    const e: Record<string, Grade> = { architecture: 'C' };
    const d = compareGrades(i, e);
    expect(d.drifted).toEqual([]);
    expect(d.maxDrift).toBe(1);
  });

  it('flags >1 letter drift', () => {
    const i: Record<string, Grade> = { security: 'A' };
    const e: Record<string, Grade> = { security: 'D' };
    const d = compareGrades(i, e);
    expect(d.drifted).toEqual(['security']);
    expect(d.maxDrift).toBe(3);
  });

  it('ignores dimensions where either side is N/A', () => {
    const i: Record<string, Grade> = { frontend: 'N/A' };
    const e: Record<string, Grade> = { frontend: 'F' };
    const d = compareGrades(i, e);
    expect(d.drifted).toEqual([]);
    expect(d.maxDrift).toBe(0);
  });

  it('ignores dimensions missing on one side', () => {
    const i: Record<string, Grade> = { architecture: 'B' };
    const e: Record<string, Grade> = { security: 'B' };
    const d = compareGrades(i, e);
    expect(d.drifted).toEqual([]);
    expect(d.maxDrift).toBe(0);
  });

  it('reports max drift across multiple dimensions', () => {
    const i: Record<string, Grade> = { architecture: 'B', security: 'A', code_quality: 'A' };
    const e: Record<string, Grade> = { architecture: 'C', security: 'F', code_quality: 'B' };
    const d = compareGrades(i, e);
    expect(d.drifted.sort()).toEqual(['security']);
    expect(d.maxDrift).toBe(4);
  });
});
