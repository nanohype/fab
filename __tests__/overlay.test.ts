import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendOverlays,
  bundledDir,
  loadSkillWithOverlay,
  overlayLayers,
  resolveSkillPath,
} from '../src/overlay.js';

// The package's own skills/ directory. Tests read it and never write to it:
// other suites list it in parallel, so a file placed there for one case would
// be seen by them. Each workspace below has a bundled layer of its own.
const PACKAGE_SKILLS_DIR = resolve(
  fileURLToPath(new URL('../src', import.meta.url)),
  '..',
  'skills',
);

interface Workspace {
  envDir: string;
  userHome: string;
  projectCwd: string;
  bundledDir: string;
  cleanup: () => void;
  env: NodeJS.ProcessEnv;
  bundledFile: (name: string, content: string) => string;
}

function makeWorkspace(): Workspace {
  const root = mkdtempSync(join(tmpdir(), 'fab-overlay-'));
  const envDir = join(root, 'env');
  const userHome = join(root, 'home');
  const projectCwd = join(root, 'project');
  const bundled = join(root, 'bundled');
  mkdirSync(envDir, { recursive: true });
  mkdirSync(join(userHome, '.fab', 'skills'), { recursive: true });
  mkdirSync(join(projectCwd, '.fab', 'skills'), { recursive: true });
  mkdirSync(bundled, { recursive: true });

  const bundledFile = (name: string, content: string): string => {
    const path = join(bundled, name);
    writeFileSync(path, content, 'utf-8');
    return path;
  };

  const env: NodeJS.ProcessEnv = {
    FAB_SKILLS_DIR: envDir,
    HOME: userHome,
  };

  return {
    envDir,
    userHome,
    projectCwd,
    bundledDir: bundled,
    env,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    bundledFile,
  };
}

describe('overlayLayers', () => {
  it('returns the four layers in highest-to-lowest priority order', () => {
    const layers = overlayLayers({ FAB_SKILLS_DIR: '/tmp/env' }, '/tmp/cwd');
    expect(layers.map((l) => l.source)).toEqual(['env', 'user', 'project', 'bundled']);
    expect(layers[0].dir).toBe('/tmp/env');
    expect(layers[2].dir).toBe('/tmp/cwd/.fab/skills');
  });

  it('returns null env layer when FAB_SKILLS_DIR is unset', () => {
    const layers = overlayLayers({}, '/tmp/cwd');
    expect(layers[0].source).toBe('env');
    expect(layers[0].dir).toBeNull();
  });

  it("defaults the bundled layer to the package's skills directory", () => {
    expect(bundledDir()).toBe(PACKAGE_SKILLS_DIR);
    expect(overlayLayers({}, '/tmp/cwd')[3].dir).toBe(PACKAGE_SKILLS_DIR);
    expect(overlayLayers({}, '/tmp/cwd', '/tmp/bundled')[3].dir).toBe('/tmp/bundled');
  });
});

describe('resolveSkillPath', () => {
  let ws: Workspace;

  beforeEach(() => {
    ws = makeWorkspace();
  });

  afterEach(() => {
    ws.cleanup();
  });

  it('returns null base when no layer has the skill', () => {
    const result = resolveSkillPath('does-not-exist', ws.env, ws.projectCwd, ws.bundledDir);
    expect(result.base).toBeNull();
    expect(result.baseSource).toBeNull();
    expect(result.appends).toEqual([]);
  });

  it('returns bundled base when only bundled has the skill', () => {
    ws.bundledFile('only-bundled.md', '# Bundled\n');
    const result = resolveSkillPath('only-bundled', ws.env, ws.projectCwd, ws.bundledDir);
    expect(result.base).toBe(join(ws.bundledDir, 'only-bundled.md'));
    expect(result.baseSource).toBe('bundled');
  });

  it('env > user > project > bundled — env wins when all four have the same skill', () => {
    writeFileSync(join(ws.envDir, 'priority.md'), '# Env\n');
    writeFileSync(join(ws.userHome, '.fab', 'skills', 'priority.md'), '# User\n');
    writeFileSync(join(ws.projectCwd, '.fab', 'skills', 'priority.md'), '# Project\n');
    ws.bundledFile('priority.md', '# Bundled\n');

    const result = resolveSkillPath('priority', ws.env, ws.projectCwd, ws.bundledDir);
    expect(result.baseSource).toBe('env');
    expect(result.base).toBe(join(ws.envDir, 'priority.md'));
  });

  it('user wins when env is empty but user has the skill', () => {
    writeFileSync(join(ws.userHome, '.fab', 'skills', 'pick-user.md'), '# User\n');
    writeFileSync(join(ws.projectCwd, '.fab', 'skills', 'pick-user.md'), '# Project\n');
    ws.bundledFile('pick-user.md', '# Bundled\n');

    const result = resolveSkillPath('pick-user', ws.env, ws.projectCwd, ws.bundledDir);
    expect(result.baseSource).toBe('user');
  });

  it('project wins when env and user are empty but project has the skill', () => {
    writeFileSync(join(ws.projectCwd, '.fab', 'skills', 'pick-project.md'), '# Project\n');
    ws.bundledFile('pick-project.md', '# Bundled\n');

    const result = resolveSkillPath('pick-project', ws.env, ws.projectCwd, ws.bundledDir);
    expect(result.baseSource).toBe('project');
  });

  it('collects .append.md from every layer in low-to-high priority order', () => {
    ws.bundledFile('skill-with-appends.md', '# Base\n');
    writeFileSync(join(ws.envDir, 'skill-with-appends.append.md'), '# env-append\n');
    writeFileSync(
      join(ws.userHome, '.fab', 'skills', 'skill-with-appends.append.md'),
      '# user-append\n',
    );
    writeFileSync(
      join(ws.projectCwd, '.fab', 'skills', 'skill-with-appends.append.md'),
      '# project-append\n',
    );

    const result = resolveSkillPath('skill-with-appends', ws.env, ws.projectCwd, ws.bundledDir);
    expect(result.appends.map((a) => a.source)).toEqual(['project', 'user', 'env']);
  });

  it('does not require a base to collect appends (caller decides what to do)', () => {
    writeFileSync(join(ws.userHome, '.fab', 'skills', 'no-base.append.md'), '# user-append\n');
    const result = resolveSkillPath('no-base', ws.env, ws.projectCwd, ws.bundledDir);
    expect(result.base).toBeNull();
    expect(result.appends).toHaveLength(1);
  });
});

describe('loadSkillWithOverlay', () => {
  let ws: Workspace;

  beforeEach(() => {
    ws = makeWorkspace();
  });

  afterEach(() => {
    ws.cleanup();
  });

  it('returns null when no base exists in any layer', async () => {
    const result = await loadSkillWithOverlay('nothing-here', ws.env, ws.projectCwd, ws.bundledDir);
    expect(result).toBeNull();
  });

  it('returns the bundled base when only bundled has the skill', async () => {
    ws.bundledFile('bundled-only.md', 'base body');
    const result = await loadSkillWithOverlay('bundled-only', ws.env, ws.projectCwd, ws.bundledDir);
    expect(result).toBe('base body');
  });

  it('user override wins over bundled base', async () => {
    ws.bundledFile('overridden.md', 'baseline body');
    writeFileSync(join(ws.userHome, '.fab', 'skills', 'overridden.md'), 'user body');
    const result = await loadSkillWithOverlay('overridden', ws.env, ws.projectCwd, ws.bundledDir);
    expect(result).toBe('user body');
  });

  it('concatenates base + appends with low-priority appends first', async () => {
    ws.bundledFile('layered.md', 'BASE');
    writeFileSync(join(ws.projectCwd, '.fab', 'skills', 'layered.append.md'), 'PROJECT');
    writeFileSync(join(ws.userHome, '.fab', 'skills', 'layered.append.md'), 'USER');
    writeFileSync(join(ws.envDir, 'layered.append.md'), 'ENV');

    const result = await loadSkillWithOverlay('layered', ws.env, ws.projectCwd, ws.bundledDir);
    // BASE first, then project, user, env (low-to-high priority).
    expect(result).toBe('BASE\n\nPROJECT\n\nUSER\n\nENV');
  });
});

describe('appendOverlays', () => {
  let ws: Workspace;

  beforeEach(() => {
    ws = makeWorkspace();
  });

  afterEach(() => {
    ws.cleanup();
  });

  it('returns the body unchanged when no appends exist', async () => {
    const result = await appendOverlays(
      'untouched body',
      'no-appends',
      ws.env,
      ws.projectCwd,
      ws.bundledDir,
    );
    expect(result).toBe('untouched body');
  });

  it('concatenates appends onto an externally-loaded body', async () => {
    writeFileSync(join(ws.userHome, '.fab', 'skills', 'brief-prd.append.md'), 'extra user notes');
    const result = await appendOverlays(
      'baseline brief text',
      'brief-prd',
      ws.env,
      ws.projectCwd,
      ws.bundledDir,
    );
    expect(result).toBe('baseline brief text\n\nextra user notes');
  });
});
