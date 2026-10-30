import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The project .npmrc holds every npm resolution in this repository to a
 * release-age floor. Two edits remove that floor while installs keep
 * succeeding: npm warns about a key it does not define and then ignores it,
 * and a `before` in the same file takes precedence over `min-release-age`,
 * replacing the rolling window with a fixed date.
 */
const npmrcPath = fileURLToPath(new URL('../.npmrc', import.meta.url));

async function readSettings(): Promise<Map<string, string>> {
  const settings = new Map<string, string>();
  for (const raw of (await readFile(npmrcPath, 'utf8')).split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) {
      settings.set(line, 'true');
    } else {
      settings.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
    }
  }
  return settings;
}

describe('.npmrc release-age floor', () => {
  it('sets min-release-age to a whole number of days', async () => {
    expect((await readSettings()).get('min-release-age')).toMatch(/^[1-9]\d*$/);
  });

  it('sets no before', async () => {
    expect((await readSettings()).has('before')).toBe(false);
  });
});
