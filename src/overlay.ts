/**
 * Skill overlay resolution.
 *
 * Jaunty ships baseline skills (skill files in `jaunty/skills/`) but lets
 * users layer their own versions on top without forking. Two override styles:
 *
 *   - Replace: drop `<skill>.md` at a higher-priority path. Wins outright.
 *   - Append: drop `<skill>.append.md` at any path. Concatenates onto the
 *     resolved base, low-priority first so higher-priority appends end up last.
 *
 * Priority order, highest first:
 *
 *   1. $JAUNTY_SKILLS_DIR        (per-invocation override)
 *   2. ~/.jaunty/skills/         (per-user — the personal recipe)
 *   3. <cwd>/.jaunty/skills/     (per-project)
 *   4. <jaunty-package>/skills/  (bundled baseline)
 *
 * The bundled baseline is always the last resort. If a skill has no base in
 * any layer, the resolver returns `base: null` and the caller decides what
 * to do (typically: fall through to the existing nanohype-template loader).
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type LayerSource = 'env' | 'user' | 'project' | 'bundled';

export interface SkillOverlayResolution {
  /** Path to the resolved base skill file, or null if no base anywhere. */
  base: string | null;
  /** Which layer the base came from, if any. */
  baseSource: LayerSource | null;
  /** Every `<skill>.append.md` found across layers, low-to-high priority. */
  appends: { path: string; source: LayerSource }[];
}

interface Layer {
  source: LayerSource;
  dir: string | null;
}

/**
 * Bundled-baseline directory. From `dist/overlay.js` (compiled), the
 * relative path is `../skills/`. From `src/overlay.ts` (dev / tests),
 * it's also `../skills/`. Same path either way.
 */
function bundledDir(): string {
  const thisDir = fileURLToPath(new URL('.', import.meta.url));
  return resolve(thisDir, '..', 'skills');
}

/**
 * Compute the priority-ordered list of layers. Exposed for tests and
 * for `jaunty skills layers` style CLI introspection.
 */
export function overlayLayers(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): Layer[] {
  // `env.HOME` is honored when passed (lets tests inject a sandbox).
  // Falls through to `os.homedir()` when the caller doesn't override it.
  const home = env.HOME ?? homedir();
  return [
    { source: 'env', dir: env.JAUNTY_SKILLS_DIR ? resolve(env.JAUNTY_SKILLS_DIR) : null },
    { source: 'user', dir: join(home, '.jaunty', 'skills') },
    { source: 'project', dir: join(cwd, '.jaunty', 'skills') },
    { source: 'bundled', dir: bundledDir() },
  ];
}

/**
 * Resolve a skill name against the overlay chain. Pure path-resolution —
 * returns the matched paths without reading their content. Higher-priority
 * `.md` files win as the base; `.append.md` files from every layer are
 * collected.
 */
export function resolveSkillPath(
  skillName: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): SkillOverlayResolution {
  const layers = overlayLayers(env, cwd);

  let base: string | null = null;
  let baseSource: LayerSource | null = null;
  // Walk highest → lowest. First .md hit wins as the base.
  for (const layer of layers) {
    if (!layer.dir) continue;
    const candidate = join(layer.dir, `${skillName}.md`);
    if (existsSync(candidate)) {
      base = candidate;
      baseSource = layer.source;
      break;
    }
  }

  // Collect every .append.md from every layer, low-priority first so
  // high-priority appends end up last in the concatenated output.
  const appends: { path: string; source: LayerSource }[] = [];
  for (const layer of [...layers].reverse()) {
    if (!layer.dir) continue;
    const candidate = join(layer.dir, `${skillName}.append.md`);
    if (existsSync(candidate)) {
      appends.push({ path: candidate, source: layer.source });
    }
  }

  return { base, baseSource, appends };
}

/**
 * Load the resolved skill from the overlay chain. Returns the concatenated
 * content (base + appends) or null if no base exists in any layer. The
 * caller (e.g., `loadSkillContent`) falls through to a different loader
 * when this returns null — that's how nanohype-template-backed briefs
 * resolve: no `skills/brief-*.md` baseline ships, so the overlay returns
 * null and `skills.ts` falls through to the nanohype template.
 */
export async function loadSkillWithOverlay(
  skillName: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Promise<string | null> {
  const { base, appends } = resolveSkillPath(skillName, env, cwd);
  if (!base) return null;

  const parts = [await readFile(base, 'utf-8')];
  for (const entry of appends) {
    parts.push(await readFile(entry.path, 'utf-8'));
  }
  return parts.join('\n\n');
}

/**
 * Append-only helper. Given an already-loaded skill body (from any source —
 * e.g., a nanohype-template-loaded brief), concatenate every `<skill>.append.md`
 * from the overlay chain onto it. Used by skills.ts to support
 * append-mode overlays on nanohype-template-backed briefs.
 */
export async function appendOverlays(
  body: string,
  skillName: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Promise<string> {
  const { appends } = resolveSkillPath(skillName, env, cwd);
  if (appends.length === 0) return body;
  const parts = [body];
  for (const entry of appends) {
    parts.push(await readFile(entry.path, 'utf-8'));
  }
  return parts.join('\n\n');
}

// `dirname` is imported for potential future use (e.g., resolving relative
// includes inside overlay skills). Suppress the unused-import lint that
// strict ESLint configs may otherwise raise.
void dirname;
