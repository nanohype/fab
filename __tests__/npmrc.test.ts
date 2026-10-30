import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The project .npmrc holds every npm resolution in this repository to a
 * release-age floor. These tests reject the edits that break it:
 *
 * - npm warns about a key it does not define and then ignores it.
 * - A key under a `[section]` header is not top-level config, so npm does not
 *   apply it.
 * - From npm 11.15.0, a `before` in the same file takes precedence over
 *   `min-release-age`, replacing the rolling window with a fixed date. npm
 *   11.10.0 to 11.14.1 refuse to run with both keys set.
 * - `min-release-age-exclude` (npm 11.17.0 and later) exempts every release of
 *   each package it matches.
 */
const npmrcPath = fileURLToPath(new URL('../.npmrc', import.meta.url));

/**
 * Reads the top-level keys of the project .npmrc, the part npm applies as
 * config. Reading stops at the first `[section]` header, since every key
 * after it belongs to a section. A key written as `name[]` is the array form
 * of `name`, so it is recorded as `name`.
 */
async function readTopLevelKeys(): Promise<Map<string, string>> {
  const keys = new Map<string, string>();
  for (const raw of (await readFile(npmrcPath, 'utf8')).split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[') && line.endsWith(']')) break;
    const eq = line.indexOf('=');
    const key = (eq === -1 ? line : line.slice(0, eq)).trim().replace(/\[\]$/, '');
    keys.set(key, eq === -1 ? 'true' : line.slice(eq + 1).trim());
  }
  return keys;
}

describe('.npmrc release-age floor', () => {
  it('sets min-release-age to a positive whole number of days', async () => {
    expect((await readTopLevelKeys()).get('min-release-age')).toMatch(/^[1-9]\d*$/);
  });

  it('sets no before', async () => {
    expect((await readTopLevelKeys()).has('before')).toBe(false);
  });

  it('sets no min-release-age-exclude', async () => {
    expect((await readTopLevelKeys()).has('min-release-age-exclude')).toBe(false);
  });
});
