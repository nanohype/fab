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
export function parseGateVerdict(role: TeamRole, output: string, opts?: { readFile?: FileReader }): GateVerdict {
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

    // Verbatim citation verification — only when the caller can read the
    // cited files (local cwd in sdk/claude-cli, or a GitHub-backed reader).
    // Without a reader this is a no-op and behavior is unchanged.
    //
    // Conservative blocking policy: REJECT only on `fragment-not-found` — the
    // file WAS read and the cited code is not in it, which is unambiguous
    // fabrication (EVIDENCE_CONTRACT's "fragment that appears nowhere"). A
    // `file-unreadable` result (e.g. a 404 from a path-convention mismatch or
    // a transient fetch failure) and a `malformed`/unparseable citation are
    // left non-blocking, so verification can only ever strengthen the gate —
    // it never turns an infra hiccup or parser gap into a false REJECT.
    if (opts?.readFile) {
      const fabricated = verifyCitations(parseCitations(output), opts.readFile).filter(
        (c) => c.status === 'fragment-not-found',
      );
      if (fabricated.length > 0) {
        const detail = fabricated.map((f) => `  - ${f.citation.file}: ${f.reason}`).join('\n');
        return {
          role,
          verdict: 'REJECT',
          feedback: `${role} emitted ${verdict} but citation verification failed per EVIDENCE_CONTRACT — every quoted_fragment must appear verbatim at the cited file:\n${detail}\nOriginal feedback: ${feedback || '(none)'}`,
          grades,
        };
      }
    }
  }

  return { role, verdict, feedback, grades };
}

// ── Citation verification (EVIDENCE_CONTRACT) ──────────────────────
//
// A CITATIONS block carries {claim, file, line_range, quoted_fragment}
// tuples; the contract says each quoted_fragment must appear verbatim at the
// cited file. parseGateVerdict checks block *presence* unconditionally; given
// a FileReader it also confirms each fragment exists in the file and
// downgrades to REJECT on a fabricated citation (the "fragment that appears
// nowhere in the codebase" anti-pattern). The reader is injected so this
// module stays pure and transport-agnostic — the caller supplies local-fs or
// GitHub-backed access. Without a reader, verification is skipped.

export interface Citation {
  claim: string;
  file: string;
  lineRange: string;
  quotedFragment: string;
}

/** Returns the cited file's full text, or null when it cannot be read. */
export type FileReader = (file: string) => string | null;

export type CitationStatus = 'ok' | 'fragment-not-found' | 'file-unreadable' | 'malformed';

export interface CitationCheck {
  citation: Citation;
  ok: boolean; // true only when the fragment was found verbatim
  status: CitationStatus;
  reason?: string;
}

function isBlockScalar(value: string): boolean {
  const t = value.trim();
  return t === '' || t === '|' || t === '|-' || t === '>';
}

function dedent(lines: string[]): string {
  const out = [...lines];
  while (out.length && out[0].trim() === '') out.shift();
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  const indents = out.filter((l) => l.trim() !== '').map((l) => l.length - l.trimStart().length);
  const min = indents.length ? Math.min(...indents) : 0;
  return out.map((l) => l.slice(min)).join('\n');
}

/**
 * Parse the CITATIONS block into structured tuples. Hand-rolled (no YAML
 * dependency, matching fab's zero-dep style) and tolerant: it reads the
 * `- claim/file/line_range` scalars and the `quoted_fragment: |` block scalar,
 * dedenting the fragment body. Returns [] when no parseable entries are found
 * — verification then no-ops rather than risk a false REJECT from a format
 * this parser doesn't recognize.
 */
export function parseCitations(output: string): Citation[] {
  const headerMatch = output.match(/^[ \t]*CITATIONS:[ \t]*$/im);
  if (!headerMatch || headerMatch.index === undefined) return [];
  const rest = output.slice(headerMatch.index + headerMatch[0].length);
  const nextHeader = rest.match(/^\s*(?:GATE_[A-Z]+|TRANSCRIPTS|CITATIONS|QUALITY_GRADES):/m);
  const block = nextHeader && nextHeader.index !== undefined ? rest.slice(0, nextHeader.index) : rest;

  const indentOf = (s: string) => s.length - s.trimStart().length;
  const stripQuotes = (s: string) => s.trim().replace(/^["']|["']$/g, '');

  const citations: Citation[] = [];
  let cur: Citation | null = null;
  let collecting = false;
  let keyIndent = 0;
  let fragment: string[] = [];

  const flush = () => {
    if (cur && cur.file) {
      cur.quotedFragment = dedent(fragment);
      citations.push(cur);
    }
    cur = null;
    collecting = false;
    fragment = [];
  };

  for (const line of block.split('\n')) {
    if (collecting) {
      if (line.trim() === '' || indentOf(line) > keyIndent) {
        fragment.push(line);
        continue;
      }
      collecting = false; // dedented — reparse this line as a key/entry
    }

    const m = line.match(/^(\s*)(?:-\s+)?(claim|file|line_range|quoted_fragment):\s*(.*)$/);
    if (!m) continue;
    const [, indent, key, valueRaw] = m;

    if (/^\s*-\s/.test(line)) {
      flush();
      cur = { claim: '', file: '', lineRange: '', quotedFragment: '' };
    }
    if (!cur) continue;

    if (key === 'claim') cur.claim = stripQuotes(valueRaw);
    else if (key === 'file') cur.file = stripQuotes(valueRaw);
    else if (key === 'line_range') cur.lineRange = stripQuotes(valueRaw);
    else if (key === 'quoted_fragment') {
      if (isBlockScalar(valueRaw)) {
        collecting = true;
        keyIndent = indent.length;
        fragment = [];
      } else {
        fragment = [stripQuotes(valueRaw)];
      }
    }
  }
  flush();
  return citations;
}

function normalizeLines(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function containsRun(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

/**
 * Verify each citation's quoted_fragment appears verbatim in the cited file.
 * Comparison is line-based and whitespace-tolerant (each line trimmed, blank
 * lines dropped) so YAML block-scalar dedenting and indentation differences
 * don't cause false negatives — it requires the actual cited lines to be
 * present, in order, as a contiguous run. Catches fabricated fragments and
 * citations pointing at files that don't exist in the tree.
 */
export function verifyCitations(citations: Citation[], readFile: FileReader): CitationCheck[] {
  return citations.map((citation): CitationCheck => {
    if (!citation.file) return { citation, ok: false, status: 'malformed', reason: 'citation has no file path' };
    if (!citation.quotedFragment.trim())
      return { citation, ok: false, status: 'malformed', reason: 'citation has no quoted_fragment' };
    let content: string | null;
    try {
      content = readFile(citation.file);
    } catch (err) {
      return {
        citation,
        ok: false,
        status: 'file-unreadable',
        reason: `could not read ${citation.file}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (content === null)
      return { citation, ok: false, status: 'file-unreadable', reason: `cited file not found: ${citation.file}` };
    const needle = normalizeLines(citation.quotedFragment);
    if (needle.length === 0)
      return { citation, ok: false, status: 'malformed', reason: 'quoted_fragment is empty after normalization' };
    const ok = containsRun(normalizeLines(content), needle);
    return ok
      ? { citation, ok: true, status: 'ok' }
      : {
          citation,
          ok: false,
          status: 'fragment-not-found',
          reason: `quoted_fragment not found verbatim in ${citation.file}`,
        };
  });
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
