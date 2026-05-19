import type { GateResult, TeamRole } from './types.js';

// ── Merge-gate verdict contract ─────────────────────────────────────
//
// Gate roles end their response with:
//
//   GATE_VERDICT: APPROVE | REJECT | REQUEST_CHANGES
//   GATE_FEEDBACK: <rationale — required for REJECT/REQUEST_CHANGES>
//
//   TRANSCRIPTS:
//     - command: <...>
//       exit: <n>
//       stdout: |
//         <captured>
//       stderr: |
//         <captured>
//
//   CITATIONS:
//     - claim: <...>
//       file: <...>
//       line_range: <n-n>
//       quoted_fragment: |
//         <verbatim from file>
//
//   QUALITY_GRADES:
//     <dimension>: <letter>
//
// APPROVE and REQUEST_CHANGES verdicts without both TRANSCRIPTS and
// CITATIONS blocks are auto-downgraded to REJECT per EVIDENCE_CONTRACT —
// the whole point is that claims without evidence have no weight.
//
// Verdicts merge into a single GateResult via mergeGateVerdicts:
//   any REJECT           → 'reject'  (workflow fails)
//   any REQUEST_CHANGES  → 'revise'  (loops back through existing retry)
//   all APPROVE          → 'approve' (workflow advances)

export type Verdict = 'APPROVE' | 'REJECT' | 'REQUEST_CHANGES';

export type Grade = 'A+' | 'A' | 'A-' | 'B+' | 'B' | 'B-' | 'C+' | 'C' | 'C-' | 'D+' | 'D' | 'D-' | 'F' | 'N/A';

export interface GateVerdict {
  role: TeamRole;
  verdict: Verdict;
  feedback: string;
  advisory?: boolean; // true when self-review downgrade applied
  grades?: Record<string, Grade>; // parsed QUALITY_GRADES block
}

const VERDICT_RE = /^\s*GATE_VERDICT:\s*(APPROVE|REJECT|REQUEST_CHANGES)\s*$/im;
const FEEDBACK_RE =
  /^\s*GATE_FEEDBACK:\s*([\s\S]+?)(?=\n\s*(?:GATE_|TRANSCRIPTS:|CITATIONS:|QUALITY_GRADES:)|\n\s*$|$)/im;

// Presence of the header plus at least one indented or dash-prefixed
// child line. An empty `TRANSCRIPTS:` header with nothing under it does
// not count as evidence.
function hasEvidenceBlock(output: string, header: 'TRANSCRIPTS' | 'CITATIONS'): boolean {
  const re = new RegExp(`^\\s*${header}:\\s*\\n(?:\\s{2,}|\\s*-\\s)`, 'im');
  return re.test(output);
}

/**
 * Extract a verdict + feedback + grades from a single gate role's output.
 *
 * - Malformed or missing GATE_VERDICT → REQUEST_CHANGES with parse-error feedback.
 * - APPROVE/REQUEST_CHANGES without TRANSCRIPTS+CITATIONS evidence blocks →
 *   auto-downgrade to REJECT (EVIDENCE_CONTRACT enforcement at the pipeline layer).
 * - REJECT may ship without TRANSCRIPTS/CITATIONS — the point there is to fail fast.
 */
export function parseGateVerdict(role: TeamRole, output: string): GateVerdict {
  const verdictMatch = output.match(VERDICT_RE);
  const feedbackMatch = output.match(FEEDBACK_RE);
  const feedback = feedbackMatch ? feedbackMatch[1].trim() : '';
  const grades = parseQualityGrades(output);

  if (!verdictMatch) {
    return {
      role,
      verdict: 'REQUEST_CHANGES',
      feedback: `Could not parse GATE_VERDICT from ${role} output. Re-emit with the required block.`,
      grades,
    };
  }

  const verdict = verdictMatch[1].toUpperCase() as Verdict;

  if (verdict !== 'APPROVE' && feedback.length === 0) {
    return {
      role,
      verdict,
      feedback: `${role} emitted ${verdict} without GATE_FEEDBACK. Re-emit with a rationale.`,
      grades,
    };
  }

  if (verdict !== 'REJECT') {
    const hasTranscripts = hasEvidenceBlock(output, 'TRANSCRIPTS');
    const hasCitations = hasEvidenceBlock(output, 'CITATIONS');
    if (!hasTranscripts || !hasCitations) {
      const missing = [!hasTranscripts && 'TRANSCRIPTS', !hasCitations && 'CITATIONS'].filter(Boolean).join(' and ');
      return {
        role,
        verdict: 'REJECT',
        feedback: `${role} emitted ${verdict} without required ${missing} evidence block(s) per EVIDENCE_CONTRACT. Re-run with captured stdout/stderr per command (TRANSCRIPTS) and file:line citations per claim (CITATIONS). Original feedback: ${feedback || '(none)'}`,
        grades,
      };
    }
  }

  return { role, verdict, feedback, grades };
}

/**
 * Merge N gate verdicts into the single GateResult the workflow engine expects.
 *
 * - Any REJECT → 'reject' (aborts workflow; concatenates REJECT feedback).
 * - Any REQUEST_CHANGES without a REJECT → 'revise' (triggers retry loop;
 *   concatenates REQUEST_CHANGES feedback).
 * - All APPROVE → 'approve' (workflow advances; optional APPROVE notes kept).
 *
 * Advisory verdicts (self-review downgrade) are excluded from the decision
 * but their feedback is appended for visibility.
 */
export function mergeGateVerdicts(verdicts: GateVerdict[]): GateResult {
  if (verdicts.length === 0) {
    return { decision: 'reject', feedback: 'Merge gate ran with zero verdicts — configuration error.' };
  }

  const binding = verdicts.filter((v) => !v.advisory);
  const advisory = verdicts.filter((v) => v.advisory);

  const rejects = binding.filter((v) => v.verdict === 'REJECT');
  const changes = binding.filter((v) => v.verdict === 'REQUEST_CHANGES');

  const format = (v: GateVerdict) => `[${v.role}${v.advisory ? ' (advisory)' : ''}] ${v.verdict}: ${v.feedback}`;
  const advisoryNotes = advisory.length > 0 ? '\n\nAdvisory:\n' + advisory.map(format).join('\n') : '';

  if (rejects.length > 0) {
    return {
      decision: 'reject',
      feedback: rejects.map(format).join('\n') + advisoryNotes,
    };
  }
  if (changes.length > 0) {
    return {
      decision: 'revise',
      feedback: changes.map(format).join('\n') + advisoryNotes,
    };
  }

  const approveNotes = binding
    .filter((v) => v.feedback.length > 0)
    .map(format)
    .join('\n');
  return {
    decision: 'approve',
    feedback: (approveNotes + advisoryNotes).trim() || undefined,
  };
}

/**
 * If the PR diff touches a gate role's own definition, that role's vote
 * is downgraded to advisory to prevent trivial self-approval loops.
 *
 * The check is path-based: a role is conflicted if any changed file path
 * contains its role name as a path segment or matches the role-definition
 * file pattern (src/team.ts is the shared definition file; prompts touching
 * it affect every role, but only a role whose own block changed should be
 * downgraded — the caller decides by passing the conflicted role set).
 */
export function applySelfReviewDowngrade(verdicts: GateVerdict[], conflictedRoles: Set<TeamRole>): GateVerdict[] {
  if (conflictedRoles.size === 0) return verdicts;
  return verdicts.map((v) => (conflictedRoles.has(v.role) ? { ...v, advisory: true } : v));
}

// ── Quality rubric — parsing + calibration ─────────────────────────
//
// Gate verdicts end with a QUALITY_GRADES: block. external-reviewer
// runs the full 9-dimension rubric cold. compareGrades detects
// letter-level drift between internal and external; >1 letter on any
// dimension blocks release and re-invokes the diverged role.

const VALID_GRADES: ReadonlyArray<Grade> = [
  'A+',
  'A',
  'A-',
  'B+',
  'B',
  'B-',
  'C+',
  'C',
  'C-',
  'D+',
  'D',
  'D-',
  'F',
  'N/A',
];

const GRADE_VALUES = new Set<string>(VALID_GRADES);

function letterLevel(grade: Grade): number {
  if (grade === 'N/A') return -1;
  const letter = grade.charAt(0);
  switch (letter) {
    case 'A':
      return 4;
    case 'B':
      return 3;
    case 'C':
      return 2;
    case 'D':
      return 1;
    case 'F':
      return 0;
    default:
      return -1;
  }
}

/**
 * Extract the QUALITY_GRADES block from a gate role's output.
 *
 * Expected shape:
 *   QUALITY_GRADES:
 *     architecture: B+
 *     patterns: A-
 *     code_quality: B
 *     frontend: N/A
 *
 * Returns an empty object when the block is absent. Invalid grade values
 * (typos, unknown dimensions with invalid grades) are skipped silently —
 * the caller can check Object.keys for presence.
 */
export function parseQualityGrades(output: string): Record<string, Grade> {
  // Locate the header, slice from immediately after it until the next
  // top-level ALL_CAPS header (or end of input), then scan grade lines.
  const headerRe = /QUALITY_GRADES:\s*$/im;
  const headerMatch = output.match(headerRe);
  if (!headerMatch || headerMatch.index === undefined) return {};

  const headerEnd = headerMatch.index + headerMatch[0].length;
  const rest = output.slice(headerEnd);
  const nextHeaderRe = /^\s*(?:GATE_[A-Z]+|TRANSCRIPTS|CITATIONS|QUALITY_GRADES):/m;
  const nextMatch = rest.match(nextHeaderRe);
  const block = nextMatch && nextMatch.index !== undefined ? rest.slice(0, nextMatch.index) : rest;

  const grades: Record<string, Grade> = {};
  const lineRe = /^\s*([a-z][a-z0-9_]*)\s*:\s*(A\+|A-|A|B\+|B-|B|C\+|C-|C|D\+|D-|D|F|N\/A)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(block)) !== null) {
    const dim = m[1].toLowerCase();
    const grade = m[2] as Grade;
    if (GRADE_VALUES.has(grade)) grades[dim] = grade;
  }
  return grades;
}

export interface GradeDrift {
  drifted: string[]; // dimensions where |internal - external| > 1 letter
  maxDrift: number; // largest letter-level gap observed
}

/**
 * Compare internal gate grades against external-reviewer grades.
 *
 * Drift is measured at the letter level (A/B/C/D/F), ignoring +/-.
 * A difference >1 letter (e.g., internal B, external D) means the
 * internal voter missed something the external reviewer caught; the
 * pipeline blocks release and re-invokes the diverged role.
 *
 * Dimensions graded N/A on either side are excluded — no drift signal
 * from a dimension that doesn't apply.
 */
export function compareGrades(internal: Record<string, Grade>, external: Record<string, Grade>): GradeDrift {
  const dims = new Set([...Object.keys(internal), ...Object.keys(external)]);
  const drifted: string[] = [];
  let maxDrift = 0;
  for (const d of dims) {
    const i = internal[d];
    const e = external[d];
    if (!i || !e) continue;
    if (i === 'N/A' || e === 'N/A') continue;
    const diff = Math.abs(letterLevel(i) - letterLevel(e));
    if (diff > maxDrift) maxDrift = diff;
    if (diff > 1) drifted.push(d);
  }
  return { drifted, maxDrift };
}
