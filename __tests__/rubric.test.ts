import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RUBRIC_DEPTH_END,
  RUBRIC_DEPTH_START,
  extractRubricDepth,
  qualityRubricDepth,
} from '../src/rubric.js';

const BASELINE = readFileSync(
  fileURLToPath(new URL('../skills/quality-check.md', import.meta.url)),
  'utf-8',
);

describe('extractRubricDepth', () => {
  it('keeps the bundled baseline from §0 up to its Output format', () => {
    const depth = extractRubricDepth(BASELINE, 'quality-check.md');
    expect(depth.startsWith(RUBRIC_DEPTH_START)).toBe(true);
    expect(depth).toContain('## 10. AI & Agent Systems');
    expect(depth).not.toContain(RUBRIC_DEPTH_END);
    expect(depth).not.toContain('## Bibliography');
  });

  it('drops the frontmatter and the interactive run instructions above §0', () => {
    const depth = extractRubricDepth(BASELINE, 'quality-check.md');
    expect(depth).not.toContain('name: quality-check');
    expect(depth).not.toContain('Launch up to 4 parallel agents');
  });

  it('drops the rule and blank lines that separate the last section from the report format', () => {
    const depth = extractRubricDepth(BASELINE, 'quality-check.md');
    expect(depth).not.toMatch(/\n-{3,}\s*$/);
    expect(depth).toBe(depth.trimEnd());
  });

  it('runs to the end of a base that has no report format', () => {
    const base = ['intro', RUBRIC_DEPTH_START, 'standards', '## 1. One', 'body', ''].join('\n');
    expect(extractRubricDepth(base, 'x.md')).toBe(
      [RUBRIC_DEPTH_START, 'standards', '## 1. One', 'body'].join('\n'),
    );
  });

  it('refuses a base without the §0 heading, naming the file', () => {
    // An empty section, or one that still carries the run instructions, would
    // reach the graders with nothing to say it was wrong.
    expect(() => extractRubricDepth('# My own rubric\n\n## Architecture\n', '/o/q.md')).toThrow(
      /\/o\/q\.md has no "## 0\. Apply the published standards" heading/,
    );
  });
});

describe('qualityRubricDepth', () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  let cwd: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'fab-rubric-'));
    cwd = join(root, 'project');
    mkdirSync(join(root, 'home', '.fab', 'skills'), { recursive: true });
    mkdirSync(join(root, 'env'), { recursive: true });
    mkdirSync(join(cwd, '.fab', 'skills'), { recursive: true });
    env = { HOME: join(root, 'home'), FAB_SKILLS_DIR: join(root, 'env') };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const write = (dir: string, name: string, body: string) => writeFileSync(join(dir, name), body);

  it('is the bundled dimension sections when no layer adds anything', () => {
    const section = qualityRubricDepth(env, cwd);
    expect(section).toContain('# Quality rubric depth');
    expect(section).toContain(extractRubricDepth(BASELINE, 'quality-check.md'));
  });

  it('appends every layer, lowest priority first, after the dimension sections', () => {
    write(join(cwd, '.fab', 'skills'), 'quality-check.append.md', 'PROJECT-APPEND\n');
    write(join(root, 'home', '.fab', 'skills'), 'quality-check.append.md', 'USER-APPEND\n');
    write(join(root, 'env'), 'quality-check.append.md', 'ENV-APPEND\n');

    const section = qualityRubricDepth(env, cwd);
    const at = (marker: string) => section.indexOf(marker);
    expect(at('## 10. AI & Agent Systems')).toBeLessThan(at('PROJECT-APPEND'));
    expect(at('PROJECT-APPEND')).toBeLessThan(at('USER-APPEND'));
    expect(at('USER-APPEND')).toBeLessThan(at('ENV-APPEND'));
  });

  it('skips an append that is empty', () => {
    write(join(root, 'home', '.fab', 'skills'), 'quality-check.append.md', '\n\n');
    expect(qualityRubricDepth(env, cwd).endsWith('\n')).toBe(false);
  });

  it('takes a replacement base in place of the bundled one', () => {
    write(
      join(root, 'env'),
      'quality-check.md',
      `---\nname: quality-check\n---\n\nRun it my way.\n\n${RUBRIC_DEPTH_START}\n\nMY-STANDARDS\n\n${RUBRIC_DEPTH_END}\n\nMY-FORMAT\n`,
    );
    const section = qualityRubricDepth(env, cwd);
    expect(section).toContain('MY-STANDARDS');
    expect(section).not.toContain('Run it my way.');
    expect(section).not.toContain('MY-FORMAT');
    expect(section).not.toContain('## 10. AI & Agent Systems');
  });

  it('refuses a replacement base without the §0 heading', () => {
    write(join(root, 'home', '.fab', 'skills'), 'quality-check.md', '# Mine\n');
    expect(() => qualityRubricDepth(env, cwd)).toThrow(/has no "## 0\. Apply/);
  });
});
