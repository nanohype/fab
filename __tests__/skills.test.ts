/**
 * Skill loading tests.
 *
 * `overlay.ts` is well covered on its own, but nothing exercised the module
 * that *calls* it. That gap matters more here than the coverage number
 * suggests: the overlay chain is the whole public/personal split — fab ships a
 * baseline anyone can run, and a personal recipe at `~/.fab/skills/` replaces
 * or extends it. A resolver that works in isolation while `loadSkillContent`
 * quietly ignores it is a feature that is documented, tested, and absent.
 *
 * So these drive `loadSkillContent` end to end against a real overlay
 * directory and a real (fixture) nanohype checkout, and assert the resolution
 * order the README promises rather than the resolver's own return value.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getAllSkillDefs,
  getSkillDef,
  loadSkillContent,
  previewSkillContent,
  resolveNanohypePath,
} from '../src/skills.js';
import type { TeamRole } from '../src/types.js';

let workspace: string;
let nanohypePath: string;
let skillsDir: string;
const savedEnv: Record<string, string | undefined> = {};

/**
 * A fixture nanohype checkout holding just what a brief reads:
 * `templates/<t>/skeleton/brief.md` and `templates/<t>/template.yaml`.
 */
async function writeTemplate(template: string, brief: string, yaml: string) {
  const dir = join(nanohypePath, 'templates', template);
  await mkdir(join(dir, 'skeleton'), { recursive: true });
  await writeFile(join(dir, 'skeleton', 'brief.md'), brief);
  await writeFile(join(dir, 'template.yaml'), yaml);
}

/** Find a role whose skill is loaded by the given strategy. */
function roleOfType(type: 'brief' | 'generated'): TeamRole {
  const found = getAllSkillDefs().find(([, def]) => def.type === type);
  if (!found) throw new Error(`no skill def of type ${type}`);
  return found[0];
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'fab-skills-'));
  nanohypePath = join(workspace, 'nanohype');
  skillsDir = join(workspace, 'overlay');
  await mkdir(nanohypePath, { recursive: true });
  await mkdir(skillsDir, { recursive: true });

  for (const key of ['FAB_SKILLS_DIR', 'NANOHYPE_PATH', 'HOME']) {
    savedEnv[key] = process.env[key];
  }
  // Point the highest-priority overlay layer at a directory this test owns,
  // and HOME at an empty one so the developer's real ~/.fab/skills cannot
  // change the outcome.
  process.env.FAB_SKILLS_DIR = skillsDir;
  process.env.HOME = workspace;
});

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(workspace, { recursive: true, force: true });
});

describe('the skill catalog', () => {
  it('gives every role a definition with a usable description', () => {
    const defs = getAllSkillDefs();
    expect(defs.length).toBeGreaterThan(0);
    for (const [role, def] of defs) {
      expect(def.name, `${role} has a skill name`).toMatch(/^[a-z0-9-]+$/);
      expect(def.description.length, `${role} has a description`).toBeGreaterThan(10);
    }
  });

  it('gives each loader the inputs it needs', () => {
    // A brief with no template fails at load time, in whichever factory run
    // happens to reach that role first.
    for (const [role, def] of getAllSkillDefs()) {
      if (def.type === 'brief') {
        expect(def.briefTemplate, `${role} names its template`).toBeTruthy();
      }
    }
  });

  it('returns undefined for a role that is not on the roster', () => {
    expect(getSkillDef('not-a-role')).toBeUndefined();
  });
});

describe('loadSkillContent — the default loaders', () => {
  it('builds a generated skill from the definition itself', async () => {
    const role = roleOfType('generated');
    const def = getSkillDef(role)!;
    const content = await loadSkillContent(role, nanohypePath);

    expect(content).toContain(`name: ${def.name}`);
    expect(content).toContain(def.description);
  });

  it('loads a brief from the nanohype template and strips its placeholders', async () => {
    const role = roleOfType('brief');
    const def = getSkillDef(role)!;
    await writeTemplate(
      def.briefTemplate!,
      '# Brief\n\nThe problem: __PROBLEM_STATEMENT__\nThe user: __TARGET_USER__\n',
      [
        'variables:',
        '  - name: ProblemStatement',
        '    placeholder: "__PROBLEM_STATEMENT__"',
        '    description: "The core problem this product addresses"',
        '  - name: TargetUser',
        '    placeholder: "__TARGET_USER__"',
        '    description: "Who this is for"',
        '',
      ].join('\n'),
    );

    const content = await loadSkillContent(role, nanohypePath);

    // Placeholders become readable prompts. A raw __TOKEN__ reaching an agent
    // reads as a variable it is supposed to substitute, not as a question.
    expect(content).toContain('[the core problem this product addresses]');
    expect(content).toContain('[who this is for]');
    expect(content).not.toContain('__PROBLEM_STATEMENT__');
    expect(content).not.toContain('__TARGET_USER__');
    // Wrapped as a SKILL.md with front matter the API can ingest.
    expect(content.startsWith('---\n')).toBe(true);
    expect(content).toContain(`name: ${def.name}`);
  });

  it('fails loudly when the brief template is missing', async () => {
    const role = roleOfType('brief');
    await expect(loadSkillContent(role, nanohypePath)).rejects.toThrow();
  });
});

describe('loadSkillContent — the overlay chain', () => {
  it('lets an overlay replace a generated skill entirely', async () => {
    const role = roleOfType('generated');
    const def = getSkillDef(role)!;
    await writeFile(join(skillsDir, `${def.name}.md`), '# Replaced\n\nmy own version\n');

    const content = await loadSkillContent(role, nanohypePath);

    expect(content).toBe('# Replaced\n\nmy own version\n');
    expect(content).not.toContain(def.description);
  });

  it('lets an overlay replace a template-backed brief without the template existing', async () => {
    // The replace layer wins before the default loader runs, so a personal
    // brief does not need the nanohype checkout the baseline would have read.
    const role = roleOfType('brief');
    const def = getSkillDef(role)!;
    await writeFile(join(skillsDir, `${def.name}.md`), '# Mine\n\nsharper reject criteria\n');

    const content = await loadSkillContent(role, nanohypePath);

    expect(content).toContain('sharper reject criteria');
  });

  it('appends onto a template-backed brief, keeping the brief', async () => {
    // The documented case: deepen a nanohype-backed brief with personal voice
    // rules without replacing it. Appends have to survive the fall-through to
    // the default loader, which is the part a resolver test cannot see.
    const role = roleOfType('brief');
    const def = getSkillDef(role)!;
    await writeTemplate(def.briefTemplate!, '# Brief\n\nbaseline body\n', 'variables: []\n');
    await writeFile(
      join(skillsDir, `${def.name}.append.md`),
      '## My voice rules\n\nno buzzwords\n',
    );

    const content = await loadSkillContent(role, nanohypePath);

    expect(content).toContain('baseline body');
    expect(content).toContain('no buzzwords');
    expect(content.indexOf('baseline body')).toBeLessThan(content.indexOf('no buzzwords'));
  });

  it('appends onto a replaced base too', async () => {
    const role = roleOfType('generated');
    const def = getSkillDef(role)!;
    await writeFile(join(skillsDir, `${def.name}.md`), 'replaced base\n');
    await writeFile(join(skillsDir, `${def.name}.append.md`), 'appended tail\n');

    const content = await loadSkillContent(role, nanohypePath);

    expect(content).toContain('replaced base');
    expect(content).toContain('appended tail');
  });

  it('prefers $FAB_SKILLS_DIR over ~/.fab/skills', async () => {
    // Precedence is the whole contract of the chain, and it is only observable
    // through the loader — both layers resolve, and the question is which one
    // the caller ends up with.
    const role = roleOfType('generated');
    const def = getSkillDef(role)!;
    const home = join(workspace, '.fab', 'skills');
    await mkdir(home, { recursive: true });
    await writeFile(join(home, `${def.name}.md`), 'from home\n');
    await writeFile(join(skillsDir, `${def.name}.md`), 'from env\n');

    const content = await loadSkillContent(role, nanohypePath);

    expect(content).toContain('from env');
    expect(content).not.toContain('from home');
  });
});

describe('previewSkillContent', () => {
  it('returns the same body the loader would upload', async () => {
    const role = roleOfType('brief');
    const def = getSkillDef(role)!;
    await writeTemplate(def.briefTemplate!, '# Brief\n\nbaseline body\n', 'variables: []\n');

    const [preview, loaded] = await Promise.all([
      previewSkillContent(role, nanohypePath),
      loadSkillContent(role, nanohypePath),
    ]);
    expect(preview).toBe(loaded);
  });
});

describe('resolveNanohypePath', () => {
  it('prefers an explicit flag over the environment', () => {
    process.env.NANOHYPE_PATH = '/from/env';
    expect(resolveNanohypePath('/from/flag')).toBe('/from/flag');
  });

  it('falls back to NANOHYPE_PATH when no flag is given', () => {
    process.env.NANOHYPE_PATH = '/from/env';
    expect(resolveNanohypePath()).toBe('/from/env');
  });

  it('resolves a relative path to an absolute one', () => {
    delete process.env.NANOHYPE_PATH;
    expect(resolveNanohypePath('./somewhere')).toMatch(/^\//);
  });

  it('falls back to the sibling checkout when nothing is configured', () => {
    delete process.env.NANOHYPE_PATH;
    expect(resolveNanohypePath().endsWith('nanohype')).toBe(true);
  });
});
