import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * release.yml publishes `ghcr.io/nanohype/fab:<version>` only for a `v<version>`
 * tag equal to package.json `version`, so every image reference the repo hands
 * an operator has to name that version. A reference to any other tag points at
 * an image no release produced. The `<version>` placeholder is prose, not a
 * reference, and is skipped.
 */
const repoFile = (rel: string): string => fileURLToPath(new URL(`../${rel}`, import.meta.url));

const PINNED_FILES = ['deploy/job.yaml', '.env.example', 'docs/runbook.md'] as const;
const IMAGE_REF = /ghcr\.io\/nanohype\/fab[:@][^\s'"`]*/g;

describe('deploy image references', () => {
  it.each(PINNED_FILES)('%s pins the package.json version', async (rel) => {
    const { version } = JSON.parse(await readFile(repoFile('package.json'), 'utf8')) as {
      version: string;
    };
    const refs = ((await readFile(repoFile(rel), 'utf8')).match(IMAGE_REF) ?? []).filter(
      (ref) => ref !== 'ghcr.io/nanohype/fab:<version>',
    );
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref).toBe(`ghcr.io/nanohype/fab:${version}`);
    }
  });
});
