import { describe, expect, it } from 'vitest';
import type { Citation, FileReader, GateVerdict, Grade } from '../src/gate.js';
import {
  aggregateGrades,
  applySelfReviewDowngrade,
  compareGrades,
  mergeGateVerdicts,
  parseCitations,
  parseGateVerdict,
  parseQualityGrades,
  verifyCitations,
} from '../src/gate.js';
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

describe('aggregateGrades', () => {
  const v = (role: TeamRole, grades?: Record<string, Grade>, advisory = false): GateVerdict => ({
    role,
    verdict: 'APPROVE',
    feedback: '',
    advisory,
    grades,
  });

  it('merges disjoint per-role dimensions into one map', () => {
    const merged = aggregateGrades([
      v('pr-reviewer', { architecture: 'B+', code_quality: 'A-' }),
      v('qa-security', { security: 'A' }),
    ]);
    expect(merged).toEqual({ architecture: 'B+', code_quality: 'A-', security: 'A' });
  });

  it('skips advisory verdicts (self-review downgrades carry no weight)', () => {
    const merged = aggregateGrades([
      v('pr-reviewer', { architecture: 'A' }, true),
      v('qa-security', { security: 'B' }),
    ]);
    expect(merged).toEqual({ security: 'B' });
  });

  it('lets a later verdict win on a collision', () => {
    const merged = aggregateGrades([
      v('pr-reviewer', { architecture: 'C' }),
      v('qa-security', { architecture: 'A' }),
    ]);
    expect(merged).toEqual({ architecture: 'A' });
  });

  it('tolerates verdicts without grades', () => {
    expect(aggregateGrades([v('pr-reviewer')])).toEqual({});
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

  it('returns the verdicts untouched when no role is conflicted', () => {
    // The ordinary case — no PR touches a gate role's own definition. Pinned
    // because it is the arm that must not mark anything advisory: a downgrade
    // applied by accident here turns a real REJECT into a note.
    const verdicts: GateVerdict[] = [
      { role: 'pr-reviewer', verdict: 'APPROVE', feedback: '' },
      { role: 'qa-security', verdict: 'REJECT', feedback: 'big issue' },
    ];
    const out = applySelfReviewDowngrade(verdicts, new Set<TeamRole>());
    expect(out).toEqual(verdicts);
    expect(out.every((v) => v.advisory === undefined)).toBe(true);
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

  it('stops at the next header rather than reading into the block after it', () => {
    // The grades block is not always last. Reading past it would pull
    // `line_range: 42-57` and similar `key: value` lines out of CITATIONS, and
    // a stray match there would invent a dimension nobody graded.
    const out = [
      'GATE_VERDICT: APPROVE',
      '',
      'QUALITY_GRADES:',
      '  architecture: B+',
      '',
      'CITATIONS:',
      '  - claim: unrelated',
      '    file: src/x.ts',
      '    security: A',
    ].join('\n');
    expect(parseQualityGrades(out)).toEqual({ architecture: 'B+' });
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

  it('treats a grade outside the known letters as maximum drift, blocking release', () => {
    // `Grade` keeps this out of reach in typed code, so the cast is the point:
    // the letter scale has a defensive arm, and it fails closed. An
    // unrecognized grade scores below F, so it drifts past the one-letter
    // tolerance and blocks the release rather than being quietly skipped.
    // Worth pinning — the opposite reading is just as plausible to a reader,
    // and it would let a garbled calibration block ship silently.
    const i: Record<string, Grade> = { security: 'A' };
    const e: Record<string, Grade> = { security: 'Z+' as Grade };
    const d = compareGrades(i, e);
    expect(d.drifted).toEqual(['security']);
    expect(d.maxDrift).toBe(5);
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

describe('parseCitations', () => {
  it('ignores key/value lines that appear before any list item', () => {
    // A model that emits the fields without the leading `- ` has produced no
    // citation at all. Attaching those values to a phantom entry would
    // manufacture evidence that was never structured as a citation.
    const out = [
      'CITATIONS:',
      '  claim: floating, not in a list item',
      '  file: src/nowhere.ts',
    ].join('\n');
    expect(parseCitations(out)).toEqual([]);
  });

  it('ignores keys outside the citation schema', () => {
    const out = [
      'CITATIONS:',
      '  - claim: real claim',
      '    file: src/a.ts',
      '    line_range: 1-1',
      '    confidence: high',
      '    quoted_fragment: "const a = 1;"',
    ].join('\n');
    const cits = parseCitations(out);
    expect(cits).toHaveLength(1);
    expect(cits[0].claim).toBe('real claim');
    expect(cits[0].quotedFragment).toBe('const a = 1;');
  });

  it('yields an empty fragment when a block scalar holds only blank lines', () => {
    // Reaches the dedent path with nothing to measure an indent from. It must
    // produce an empty fragment, which verifyCitations then rejects as
    // malformed — not throw partway through parsing the verdict.
    const out = [
      'CITATIONS:',
      '  - claim: c',
      '    file: src/a.ts',
      '    quoted_fragment: |',
      '',
      '',
    ].join('\n');
    const cits = parseCitations(out);
    expect(cits).toHaveLength(1);
    expect(cits[0].quotedFragment).toBe('');
  });

  it('parses a quoted_fragment given inline rather than as a block scalar', () => {
    // The prompt asks for a block scalar, but a single-line fragment is the
    // shape a model most often emits instead. Dropping it would silently strip
    // the evidence off an otherwise well-formed citation, and the verdict would
    // then be auto-downgraded for having no evidence it did in fact supply.
    const out = [
      'GATE_VERDICT: APPROVE',
      '',
      'CITATIONS:',
      '  - claim: the timeout is bounded',
      '    file: src/api.ts',
      '    line_range: 12-12',
      '    quoted_fragment: "const TIMEOUT_MS = 20_000;"',
    ].join('\n');
    const cits = parseCitations(out);
    expect(cits).toHaveLength(1);
    expect(cits[0].file).toBe('src/api.ts');
    expect(cits[0].quotedFragment).toBe('const TIMEOUT_MS = 20_000;');
  });

  it('parses a block-scalar citation and stops at the next header', () => {
    const out = [
      'GATE_VERDICT: APPROVE',
      '',
      'CITATIONS:',
      '  - claim: auth resolves identity via Okta',
      '    file: src/auth/middleware.ts',
      '    line_range: 42-57',
      '    quoted_fragment: |',
      '      const { userId } = await oktaClient.users.getByEmail(claim.email);',
      '      if (!userId) throw new AuthError("unknown identity");',
      '',
      'QUALITY_GRADES:',
      '  security: A-',
    ].join('\n');
    const cits = parseCitations(out);
    expect(cits).toHaveLength(1);
    expect(cits[0].file).toBe('src/auth/middleware.ts');
    expect(cits[0].lineRange).toBe('42-57');
    expect(cits[0].claim).toContain('Okta');
    expect(cits[0].quotedFragment).toContain('oktaClient.users.getByEmail');
    expect(cits[0].quotedFragment).toContain('throw new AuthError');
    expect(cits[0].quotedFragment).not.toContain('QUALITY_GRADES');
  });

  it('parses multiple citations in one block', () => {
    const out = [
      'CITATIONS:',
      '  - claim: first',
      '    file: a.ts',
      '    line_range: 1-2',
      '    quoted_fragment: |',
      '      const a = 1;',
      '  - claim: second',
      '    file: b.ts',
      '    line_range: 3-4',
      '    quoted_fragment: |',
      '      const b = 2;',
    ].join('\n');
    const cits = parseCitations(out);
    expect(cits.map((c) => c.file)).toEqual(['a.ts', 'b.ts']);
    expect(cits[1].quotedFragment).toBe('const b = 2;');
  });

  it('returns [] when no CITATIONS header is present', () => {
    expect(parseCitations('GATE_VERDICT: APPROVE')).toEqual([]);
  });
});

describe('verifyCitations', () => {
  const cit: Citation = {
    claim: 'x',
    file: 'a.ts',
    lineRange: '1-2',
    quotedFragment: 'const a = 1;',
  };

  it('passes when the fragment appears in the cited file', () => {
    const reader: FileReader = (f) => (f === 'a.ts' ? 'line0\nconst a = 1;\nline2' : null);
    expect(verifyCitations([cit], reader)[0].ok).toBe(true);
  });

  it('fails as fragment-not-found when the fragment is absent (fabricated)', () => {
    const reader: FileReader = () => 'totally unrelated content';
    const check = verifyCitations([cit], reader)[0];
    expect(check.ok).toBe(false);
    expect(check.status).toBe('fragment-not-found');
    expect(check.reason).toContain('not found verbatim');
  });

  it('reports file-unreadable (not fabrication) when the cited file does not exist', () => {
    const reader: FileReader = () => null;
    const check = verifyCitations([cit], reader)[0];
    expect(check.ok).toBe(false);
    expect(check.status).toBe('file-unreadable');
  });

  it('is whitespace/indentation tolerant (block-scalar dedent vs real indent)', () => {
    const multi: Citation = { ...cit, quotedFragment: 'const a = 1;\nconst b = 2;' };
    const reader: FileReader = () => '    const a = 1;\n    const b = 2;'; // indented in source
    expect(verifyCitations([multi], reader)[0].ok).toBe(true);
  });

  it('fails when the fragment is longer than the whole cited file', () => {
    // Cheap rejection before scanning, and the clearest sign of a fabricated
    // quote: more lines claimed than the file contains.
    const long: Citation = { ...cit, quotedFragment: 'a\nb\nc\nd\ne' };
    const check = verifyCitations([long], () => 'a\nb')[0];
    expect(check.ok).toBe(false);
    expect(check.status).toBe('fragment-not-found');
  });

  it('requires the fragment lines to be contiguous and in order', () => {
    const multi: Citation = { ...cit, quotedFragment: 'const a = 1;\nconst b = 2;' };
    const reader: FileReader = () => 'const a = 1;\nsomething else;\nconst b = 2;';
    expect(verifyCitations([multi], reader)[0].ok).toBe(false);
  });

  it('rejects a citation with no file path as malformed', () => {
    // A citation naming no file cannot be checked against anything. Treating it
    // as passing would make the empty string the cheapest way past the evidence
    // contract.
    const check = verifyCitations([{ ...cit, file: '' }], () => 'whatever')[0];
    expect(check.ok).toBe(false);
    expect(check.status).toBe('malformed');
    expect(check.reason).toContain('no file path');
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   \n\t '],
  ])('rejects a citation whose quoted_fragment is %s', (_label, quotedFragment) => {
    // Same shape of hole as the missing file: an empty fragment trivially
    // "appears" in any file, so it has to be refused before the search rather
    // than matched by it.
    const check = verifyCitations([{ ...cit, quotedFragment }], () => 'anything')[0];
    expect(check.ok).toBe(false);
    expect(check.status).toBe('malformed');
  });

  it('reports file-unreadable when the reader throws rather than returning null', () => {
    // A reader can fail with EACCES or EISDIR instead of reporting absence. The
    // distinction that matters is fabrication versus an unreadable tree — a
    // thrown error is the latter, and must not escape as an unhandled exception
    // that takes down the whole gate run.
    const reader: FileReader = () => {
      throw new Error('EACCES: permission denied');
    };
    const check = verifyCitations([cit], reader)[0];
    expect(check.ok).toBe(false);
    expect(check.status).toBe('file-unreadable');
    expect(check.reason).toContain('EACCES');
  });

  it('reports file-unreadable when the reader throws a non-Error value', () => {
    const reader: FileReader = () => {
      throw 'just a string';
    };
    const check = verifyCitations([cit], reader)[0];
    expect(check.ok).toBe(false);
    expect(check.status).toBe('file-unreadable');
    expect(check.reason).toContain('just a string');
  });
});

describe('parseGateVerdict with citation verification', () => {
  const out = withEvidence('GATE_VERDICT: APPROVE');
  const fragment = 'const { userId } = await oktaClient.users.getByEmail(claim.email);';
  const present: FileReader = (f) =>
    f === 'src/auth/middleware.ts' ? `foo\n${fragment}\nbar` : null;
  const absent: FileReader = () => 'unrelated content with no such line';
  const missing: FileReader = () => null;

  it('keeps APPROVE when the citation verifies against the file', () => {
    expect(parseGateVerdict('pr-reviewer', out, { readFile: present }).verdict).toBe('APPROVE');
  });

  it('downgrades APPROVE to REJECT when the cited fragment is absent', () => {
    const v = parseGateVerdict('pr-reviewer', out, { readFile: absent });
    expect(v.verdict).toBe('REJECT');
    expect(v.feedback).toContain('verbatim');
    expect(v.feedback).toContain('src/auth/middleware.ts');
  });

  it('does NOT block APPROVE when the cited file is unreadable (path-convention/infra safe)', () => {
    // A 404 or transient read failure must not be mistaken for fabrication —
    // only a fragment absent from a file we DID read blocks. See gate.ts.
    expect(parseGateVerdict('pr-reviewer', out, { readFile: missing }).verdict).toBe('APPROVE');
  });

  it('is unchanged (no verification) when no readFile is supplied', () => {
    // Backward-compat: the default call path keeps presence-only behavior.
    expect(parseGateVerdict('pr-reviewer', out).verdict).toBe('APPROVE');
  });

  it('does not verify citations on a REJECT verdict', () => {
    const rej = 'GATE_VERDICT: REJECT\nGATE_FEEDBACK: secrets in plaintext';
    expect(parseGateVerdict('qa-security', rej, { readFile: absent }).verdict).toBe('REJECT');
  });
});

// ── A verdict must rest on an examination ───────────────────────────
//
// The shared merge-gate action refuses a skipped job by construction — "a job
// that did not run has not passed". These hold the rubric to the same line:
// a ballot with no binding voter, and a dimension the cold reviewer graded and
// the internal gate did not, are both absences. Neither is agreement.

describe('a ballot with no binding voter', () => {
  it('rejects rather than approving vacuously', () => {
    // Every voter advisory means nothing counted. `all APPROVE` is vacuously
    // true over an empty set, which would ship a PR that four roles rejected.
    const verdicts: GateVerdict[] = [
      { role: 'pr-reviewer', verdict: 'REJECT', feedback: 'broken', advisory: true },
      { role: 'qa-security', verdict: 'REJECT', feedback: 'secrets', advisory: true },
      { role: 'build-verifier', verdict: 'REJECT', feedback: 'tests fail', advisory: true },
      { role: 'artifact-auditor', verdict: 'REJECT', feedback: 'docs wrong', advisory: true },
    ];
    const result = mergeGateVerdicts(verdicts);
    expect(result.decision).toBe('reject');
    expect(result.feedback).toContain('no binding');
  });
});

describe('compareGrades reports what it could not compare', () => {
  const ten = (g: Grade): Record<string, Grade> => ({
    architecture: g,
    patterns: g,
    systems: g,
    testing: g,
    frontend: g,
    security: g,
    code_quality: g,
    documentation: g,
    consistency: g,
    ai_systems: g,
  });

  it('names a dimension the external reviewer graded and the internal gate did not', () => {
    // build-verifier is the sole owner of `testing`; if its block is missing,
    // an external F on testing must not read as agreement.
    const internal = ten('A');
    delete internal.testing;
    const drift = compareGrades(internal, { ...ten('A'), testing: 'F' });
    expect(drift.uncompared).toEqual(['testing']);
    expect(drift.compared).not.toContain('testing');
  });

  it('treats a one-sided N/A as an absence, not an exemption', () => {
    // N/A is the rubric's only exemption mechanism and the graded side declares
    // it. A dimension the cold reviewer scored is a dimension the internal gate
    // does not get to excuse itself from.
    const drift = compareGrades({ ...ten('A'), security: 'N/A' }, { ...ten('A'), security: 'F' });
    expect(drift.uncompared).toEqual(['security']);
  });

  it('does not flag a dimension both sides agree is inapplicable', () => {
    const drift = compareGrades({ ...ten('A'), frontend: 'N/A' }, { ...ten('A'), frontend: 'N/A' });
    expect(drift.uncompared).toEqual([]);
    expect(drift.compared).toHaveLength(9);
  });

  it('compares every dimension when both sides grade all ten', () => {
    const drift = compareGrades(ten('A'), ten('A'));
    expect(drift.compared).toHaveLength(10);
    expect(drift.uncompared).toEqual([]);
    expect(drift.drifted).toEqual([]);
  });
});
