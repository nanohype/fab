import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The vendored standard, held to the copy it claims to be.
//
// fab depends on no nanohype package — the reference client has to run on its
// own — so the standards it reads at runtime travel with it. A travelling copy
// drifts, and this one had: four files vendored here were read by nothing, and
// one of those had gone on describing tenant identity as IRSA long after the
// canonical file said EKS Pod Identity. Nobody noticed, because nothing loaded
// it and nothing compared it.
//
// The four are gone. The one that remains is loaded by standards.ts to dispatch
// the four-phase contract, and is pinned: the digest below fails if the file is
// edited, and `npm run standards:check` fails if the pin and upstream disagree.

const STANDARDS = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'standards');

interface Manifest {
  upstream: { repository: string; path: string; ref: string };
  files: { file: string; sha256: string }[];
}

const manifest = JSON.parse(readFileSync(resolve(STANDARDS, 'source.json'), 'utf-8')) as Manifest;

describe('vendored standards', () => {
  it('records an upstream commit to have been vendored from', () => {
    expect(manifest.upstream.repository).toBe('nanohype/nanohype');
    // A 40-character sha, not a branch. A pin that says "main" describes
    // whatever main happened to be, which is not a pin.
    expect(manifest.upstream.ref).toMatch(/^[0-9a-f]{40}$/);
  });

  it('declares at least one file', () => {
    // Every check below iterates the manifest; an empty list would satisfy all
    // of them without comparing anything.
    expect(manifest.files.length).toBeGreaterThan(0);
  });

  it('matches the digest recorded for each file', () => {
    for (const entry of manifest.files) {
      const bytes = readFileSync(resolve(STANDARDS, entry.file));
      const digest = createHash('sha256').update(bytes).digest('hex');
      expect(digest, `${entry.file} was edited — re-vendor with \`npm run standards:sync\``).toBe(
        entry.sha256,
      );
    }
  });

  it('vendors nothing it does not declare', () => {
    // The direction that rots: a file dropped in here ships with the package
    // and is never compared to anything upstream.
    const present = readdirSync(STANDARDS)
      .filter((f) => f.endsWith('.json') && f !== 'source.json')
      .sort();

    expect(present).toEqual(manifest.files.map((f) => f.file).sort());
  });

  it('vendors only what the runtime loads', () => {
    // The rule the four deleted copies broke. Anything vendored must appear in
    // a loadPublicStandard call; the rest of the production bar reaches agents
    // as prose, which needs no file here.
    const source = readFileSync(resolve(STANDARDS, '..', 'standards.ts'), 'utf-8');

    for (const entry of manifest.files) {
      const name = entry.file.replace(/\.json$/, '');
      expect(source, `${entry.file} is vendored but never loaded — delete it or load it`).toContain(
        `loadPublicStandard<`,
      );
      expect(source, `${entry.file} is vendored but standards.ts never names it`).toContain(
        `'${name}'`,
      );
    }
  });
});
