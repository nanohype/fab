import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterAll, describe, it, expect, vi } from 'vitest';
import { TEAM } from '../src/team.js';
import { OFF_SCALE_GRADES, parseGateVerdict, parseQualityGrades } from '../src/gate.js';
import { buildSystemPrompt } from '../src/prompts.js';
import { RUBRIC_DEPTH_END } from '../src/rubric.js';
import {
  QUALITY_DIMENSIONS,
  QUALITY_DIMENSION_OWNERS,
  QUALITY_GRADE_TOKENS,
  QUALITY_RUBRIC,
  MERGE_GATE_CONTRACT,
} from '../src/standards.js';
import type { FabState, TeamRole } from '../src/types.js';

// The grading loop only closes if three independent things agree: the block a
// gate role declares in its own prompt, the parser that reads it, and the
// dimension contract both are supposed to obey. Nothing at runtime notices
// when they don't — parseQualityGrades returns {} for an unreadable block, and
// an empty grade map is indistinguishable from a workflow that never reached
// the gate, so the external-reviewer calibration compares nothing against
// nothing and passes.
//
// These tests read each role's prompt as the artifact it is — the system prompt
// buildSystemPrompt assembles, rubric depth included — extract the block it
// tells the model to emit, and run it through the real parser.

const GRADE = 'B+';

// The built prompt carries the quality-check rubric resolved through the
// overlay chain, whose user layer is $HOME/.fab/skills. An empty HOME keeps a
// developer's own overlay out of these assertions. Stubbed at module load, not
// in a hook: the describe blocks below build their prompts while the suite is
// collected, before any hook runs.
const home = mkdtempSync(join(tmpdir(), 'fab-quality-contract-'));
vi.stubEnv('HOME', home);
vi.stubEnv('FAB_SKILLS_DIR', undefined);
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const STATE: FabState = {
  agents: [],
  skillIds: {},
  environmentId: null,
  memory: { enabled: false, storeId: null },
  journal: { enabled: false, basePath: '/workspace/.fab/journal' },
  repos: [],
  modelOverrides: {},
  sprint: null,
  vaultIds: [],
  budgetLimit: null,
  projectLanguage: 'typescript',
  sourceDirs: [],
};

const BASELINE = readFileSync(
  fileURLToPath(new URL('../skills/quality-check.md', import.meta.url)),
  'utf-8',
);

/** The baseline from its Output format heading on. */
const BASELINE_OUTPUT_FORMAT = BASELINE.slice(BASELINE.indexOf(RUBRIC_DEPTH_END));

/** The cells of each row of the first markdown table after `anchor`, header and rule excluded. */
function tableRows(text: string, anchor: string): string[][] {
  const from = text.indexOf(anchor);
  if (from === -1) throw new Error(`no "${anchor}" in the text`);
  const rows: string[][] = [];
  for (const line of text.slice(from).split('\n')) {
    if (!line.startsWith('|')) {
      if (rows.length > 0) break;
      continue;
    }
    rows.push(
      line
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((cell) => cell.trim()),
    );
  }
  return rows.slice(2);
}

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
  return buildSystemPrompt(member, STATE);
}

/** The Quality rubric depth section of a built prompt. */
function rubricDepth(prompt: string): string {
  const start = prompt.indexOf('# Quality rubric depth');
  if (start === -1) throw new Error('the prompt has no Quality rubric depth section');
  // The section runs to the next section buildSystemPrompt appends, each of
  // which opens with a level-two heading naming it.
  const next = prompt
    .slice(start)
    .search(/\n## (?:Personal Journal|Repository Access|Source Directory Scope|Self-Evaluation)\b/);
  return next === -1 ? prompt.slice(start) : prompt.slice(start, start + next);
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

      it('receives a rubric depth that declares no grades block of its own', () => {
        // The role's block is the only one addressed to it. A QUALITY_GRADES
        // block inside the rubric text would be a second instruction naming
        // dimensions this role does not own.
        expect(rubricDepth(prompt)).not.toMatch(/^\s*QUALITY_GRADES:/m);
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

    it('offers only the grade tokens the scale declares', () => {
      const line = prompt.match(/^Grades are one of ([^,]+), or N\/A/m);
      expect(line, 'the external reviewer names its grade scale').not.toBeNull();
      expect((line as RegExpMatchArray)[1].split(' ')).toEqual(
        QUALITY_GRADE_TOKENS.filter((t) => t !== 'N/A'),
      );
    });
  });

  describe('the quality-check baseline', () => {
    const block = declaredBlock(BASELINE_OUTPUT_FORMAT);

    it('declares every dimension, in QUALITY_DIMENSIONS order', () => {
      expect(block, 'the baseline Output format declares no QUALITY_GRADES block').not.toBeNull();
      // The baseline shows the scale on its first line and <grade> on the rest;
      // a grader copying either form has to produce something the parser reads.
      const filled = (block as string).replace(/<A\|[^>]*>/g, GRADE);
      expect(Object.keys(parseQualityGrades(filled))).toEqual([...QUALITY_DIMENSIONS]);
    });

    it('shows the grade scale QUALITY_GRADE_TOKENS declares', () => {
      const scale = (block as string).match(/<(A\|[^>]*)>/);
      expect(scale, 'the baseline block shows no grade scale').not.toBeNull();
      expect((scale as RegExpMatchArray)[1].split('|')).toEqual([...QUALITY_GRADE_TOKENS]);
    });

    it('marks N/A under the same condition QUALITY_RUBRIC does, per dimension', () => {
      // QUALITY_RUBRIC reaches the gate roles; the baseline table reaches an
      // interactive grader. A condition that differs between them is a
      // dimension one grader scores and the other excuses.
      const rubric = new Map(
        tableRows(QUALITY_RUBRIC, '| #  | Dimension').map((cells) => [
          QUALITY_DIMENSIONS[Number(cells[0]) - 1],
          cells[3],
        ]),
      );
      const baseline = new Map(
        tableRows(BASELINE_OUTPUT_FORMAT, '| Key').map((cells) => [cells[0], cells[1]]),
      );
      expect([...rubric.keys()]).toEqual([...QUALITY_DIMENSIONS]);
      expect([...baseline.keys()]).toEqual([...QUALITY_DIMENSIONS]);
      for (const dimension of QUALITY_DIMENSIONS) {
        expect(baseline.get(dimension), dimension).toBe(rubric.get(dimension));
      }
    });
  });

  describe('the grade scale', () => {
    it('is the scale the merge-gate contract shows every gate role', () => {
      expect(MERGE_GATE_CONTRACT).toContain(`<${QUALITY_GRADE_TOKENS.join('|')}>`);
    });

    it('parses every declared token to itself', () => {
      const block = ['QUALITY_GRADES:', ...QUALITY_GRADE_TOKENS.map((t, i) => `  d${i}: ${t}`)];
      expect(Object.values(parseQualityGrades(block.join('\n')))).toEqual([
        ...QUALITY_GRADE_TOKENS,
      ]);
    });

    it('maps each off-scale token onto a declared one', () => {
      for (const [token, mapped] of Object.entries(OFF_SCALE_GRADES)) {
        expect(QUALITY_GRADE_TOKENS as readonly string[], token).not.toContain(token);
        expect(QUALITY_GRADE_TOKENS as readonly string[], token).toContain(mapped);
      }
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
      const wrong = [
        /all nine (?:QUALITY_RUBRIC )?dimensions/i,
        /\b9 (?:QUALITY_RUBRIC |quality )?dimensions/i,
      ];
      for (const text of [QUALITY_RUBRIC, MERGE_GATE_CONTRACT]) {
        for (const re of wrong) {
          expect(text, `stale dimension count (there are ${count})`).not.toMatch(re);
        }
      }
    });
  });

  // ── Every count in src/ answers to QUALITY_DIMENSIONS.length ──────
  //
  // The two constants above are the strings the roles are graded against, and
  // holding those alone leaves the count free to rot anywhere else: a doc
  // comment on the calibration function, a prompt that tells the cold reviewer
  // how many dimensions to emit, a header over the rubric. Each of those is a
  // claim about the size of the set, and none of them is derived from it.
  //
  // The denominator is therefore the source tree, not a list of known sites: a
  // new comment written with the wrong number fails here without this file
  // being edited. The scan covers comments and prompt strings alike, since a
  // count reaches a model through either.

  describe('dimension counts in src/', () => {
    const NUMBER_WORDS: Record<string, number> = {
      one: 1,
      two: 2,
      three: 3,
      four: 4,
      five: 5,
      six: 6,
      seven: 7,
      eight: 8,
      nine: 9,
      ten: 10,
      eleven: 11,
      twelve: 12,
    };
    const COUNT = `\\d{1,3}|${Object.keys(NUMBER_WORDS).join('|')}`;
    // A word between the count and the noun, so long as it is neither another
    // count ("4 of the 10 quality dimensions" is a claim about the 10) nor
    // `per`, which marks the distributive idiom rather than a size.
    const FILLER = `(?:(?!(?:${COUNT})\\b)(?!per\\b)[A-Za-z_][\\w./'-]*[ ]+){0,3}`;
    // Plural: "all ten dimensions". Hyphenated attributive: "10-dimension
    // rubric". Bare singular is excluded on purpose — "one dimension per
    // indented line" and "±1 letter per dimension" are shapes, not counts.
    const CLAIMS = [
      new RegExp(`\\b(${COUNT})[ ]+${FILLER}dimensions\\b`, 'gi'),
      new RegExp(`\\b(${COUNT})-dimensions?\\b`, 'gi'),
    ];

    /** Line breaks and comment continuation markers, flattened to spaces. */
    function flatten(source: string): string {
      return source.replace(/^[ \t]*(?:\/\*\*?|\*\/|\/\/|\*)[ \t]?/gm, ' ').replace(/\s+/g, ' ');
    }

    function countOf(token: string): number {
      return NUMBER_WORDS[token.toLowerCase()] ?? Number(token);
    }

    async function sources(dir: string): Promise<string[]> {
      const out: string[] = [];
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...(await sources(path)));
        else if (entry.name.endsWith('.ts')) out.push(path);
      }
      return out.sort();
    }

    const srcDir = fileURLToPath(new URL('../src', import.meta.url));

    it('finds the claims it is meant to check', async () => {
      // A scan that matched nothing would pass the assertion below on an empty
      // set, which is the failure mode this whole file exists to catch.
      const files = await sources(srcDir);
      expect(files.length).toBeGreaterThan(10);
      let claims = 0;
      for (const file of files) {
        const text = flatten(await readFile(file, 'utf-8'));
        for (const re of CLAIMS) claims += [...text.matchAll(re)].length;
      }
      expect(claims).toBeGreaterThan(5);
    });

    it('states the count QUALITY_DIMENSIONS has, everywhere it states one', async () => {
      const stale: string[] = [];
      for (const file of await sources(srcDir)) {
        const text = flatten(await readFile(file, 'utf-8'));
        for (const re of CLAIMS) {
          for (const m of text.matchAll(re)) {
            if (countOf(m[1]) === QUALITY_DIMENSIONS.length) continue;
            const at = m.index ?? 0;
            stale.push(
              `${file.slice(srcDir.length + 1)}: "...${text.slice(Math.max(0, at - 40), at + m[0].length + 40)}..."`,
            );
          }
        }
      }
      expect(
        stale,
        `dimension counts disagreeing with QUALITY_DIMENSIONS.length (${QUALITY_DIMENSIONS.length})`,
      ).toEqual([]);
    });
  });
});
