import { readFileSync } from 'node:fs';
import { resolveSkillPath } from './overlay.js';

// ── Quality rubric depth — the rubric body fab's graders receive ─────
//
// `skills/quality-check.md` is written for an interactive run: run
// instructions, the ten dimension sections, a report format and a
// bibliography. Gate roles and the external reviewer grade from the same
// dimension sections, resolved through the same overlay chain, so a
// `quality-check.append.md` deepens a factory grade the way it deepens an
// interactive one.
//
// They take only the dimension sections. The run instructions above §0 (a
// read-only session, parallel collection agents) describe an interactive
// session, and the report format asks for every dimension in one block. A gate
// role owns a subset of the dimensions and declares its own block; a gate role
// that emitted the full block would grade dimensions another role owns, and
// aggregateGrades keeps whichever verdict comes later. So the section is the
// base from RUBRIC_DEPTH_START up to RUBRIC_DEPTH_END, then every append body
// in the overlay chain's order.

/** The skill name the overlay chain resolves for the rubric. */
export const RUBRIC_SKILL = 'quality-check';

/** The heading the dimension sections start at, in the base. */
export const RUBRIC_DEPTH_START = '## 0. Apply the published standards';

/** The heading the dimension sections end before, in the base. */
export const RUBRIC_DEPTH_END = '## Output format';

/**
 * The dimension sections of a quality-check base: from the RUBRIC_DEPTH_START
 * line up to, not including, the RUBRIC_DEPTH_END line, or to the end of the
 * file when the base has no report format. Trailing blank lines and horizontal
 * rules are dropped.
 *
 * Throws when the base has no RUBRIC_DEPTH_START heading. A replacement
 * `quality-check.md` that drops it would otherwise hand the graders an empty
 * rubric, or one that still carries the interactive run instructions.
 */
export function extractRubricDepth(base: string, source: string): string {
  const lines = base.split('\n');
  const start = lines.findIndex((line) => line.trimEnd() === RUBRIC_DEPTH_START);
  if (start === -1) {
    throw new Error(
      `${source} has no "${RUBRIC_DEPTH_START}" heading. fab's gate roles and external reviewer grade from the quality-check dimension sections, which start at that heading; a replacement quality-check.md keeps it.`,
    );
  }
  const end = lines.findIndex((line, i) => i > start && line.trimEnd() === RUBRIC_DEPTH_END);
  const body = lines.slice(start, end === -1 ? undefined : end);
  while (body.length > 0 && /^\s*(?:-{3,})?\s*$/.test(body[body.length - 1])) body.pop();
  return body.join('\n');
}

/**
 * The Quality rubric depth prompt section: the resolved base's dimension
 * sections, then every `quality-check.append.md` in the overlay chain, lowest
 * priority first.
 *
 * Resolved each call, against the same layers `loadSkillContent` uses, so an
 * edited overlay reaches the next role session without a restart. The chain
 * resolves where the prompt is built: fab's own process for `sdk` and
 * `claude-cli`, the deploying machine at `fab deploy` for `managed-agents`,
 * and the session pod for `sdk-k8s`.
 */
export function qualityRubricDepth(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const { base, appends } = resolveSkillPath(RUBRIC_SKILL, env, cwd);
  if (!base) {
    throw new Error(
      `No ${RUBRIC_SKILL}.md resolved in any skill layer. The package ships skills/${RUBRIC_SKILL}.md; a build that drops it leaves the gate roles with no rubric.`,
    );
  }

  const parts = [extractRubricDepth(readFileSync(base, 'utf-8'), base)];
  for (const entry of appends) {
    const body = readFileSync(entry.path, 'utf-8').trim();
    if (body) parts.push(body);
  }

  return `# Quality rubric depth

What each grade means: the quality-check rubric's dimension sections, resolved through the skill overlay chain, followed by every \`${RUBRIC_SKILL}.append.md\` in that chain. Your role prompt decides which dimensions you grade and the exact \`QUALITY_GRADES:\` block you emit. Where anything below describes a report layout or a grades block, your role prompt's block replaces it.

${parts.join('\n\n')}`;
}
