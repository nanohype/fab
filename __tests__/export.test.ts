import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { collectArtifacts, type EventPage, type ExportFs, writeArtifacts } from '../src/export.js';

// ── Where the export writes ─────────────────────────────────────────
//
// The paths here are the ones a role's model chose, so the property is about
// what happens when one of them names somewhere else. Three detectors, and it
// is worth being exact about what each can see, because two of them are blind
// in ways the third is not.
//
//   attempts — the destinations the export reaches for, recorded at the
//     filesystem seam it writes through. This sees a write that is refused in
//     the report and made anyway, and it sees it for every refusal kind,
//     including kinds added later. It is blind to a writer that bypasses the
//     seam.
//
//   the sandbox walk — a listing of a directory chosen in advance, correct only
//     because the export sits fifteen levels inside it and the escapes carry at
//     most twelve parent segments, so the listing is a superset by
//     construction. An absolute path leaves the sandbox and this sees nothing.
//
//   the report — what the export says it wrote. This reads the export's own
//     account, so it cannot see an unreported write at all. It is here to check
//     that the account matches the attempts, which is a different property.
//
// Together they cover the writer, and separately none of them does.

const artifact = (path: string, content = 'x') => ({
  type: 'agent.tool_use',
  name: 'write',
  input: { file_path: path, content },
});

const onePage = (paths: string[]): ((page: string | null) => Promise<EventPage>) => {
  return async () => ({ data: paths.map((p) => artifact(p)), next_page: null });
};

/** A filesystem that does the real thing and records every destination reached for. */
function recordingFs(): { fs: ExportFs; attempts: string[] } {
  const attempts: string[] = [];
  return {
    attempts,
    fs: {
      async mkdir(path) {
        attempts.push(path);
        await mkdir(path, { recursive: true });
      },
      async writeFile(path, data) {
        attempts.push(path);
        await writeFile(path, data, 'utf-8');
      },
      realpath: (path) => realpath(path),
    },
  };
}

describe('the export writes inside its directory and nowhere else', () => {
  let root: string;
  let outputDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'fab-export-'));
    outputDir = join(root, 'out');
    // A sibling an escaping path would reach, and a file in it that must
    // survive the run untouched.
    writeFileSync(join(root, 'VICTIM.txt'), 'original\n');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * `p` with every symlink on the way resolved, whether or not it exists yet.
   *
   * An attempt is recorded before the call that would create it, and on this
   * platform the temp root is itself a link, so comparing the raw strings would
   * report a contained write as an escape.
   */
  function resolveAttempt(p: string): string {
    const parts: string[] = [];
    let probe = resolve(p);
    for (;;) {
      if (existsSync(probe)) return join(realpathSync(probe), ...parts.reverse());
      const parent = dirname(probe);
      if (parent === probe) return resolve(p);
      parts.push(probe.slice(parent.length + 1));
      probe = parent;
    }
  }

  /** Every destination reached for that is not inside the output directory. */
  function outsideAttempts(attempts: readonly string[]): string[] {
    const base = realpathSync(outputDir);
    return attempts.map(resolveAttempt).filter((a) => a !== base && !isInsideOf(base, a));
  }

  /** True when `p` names a place strictly inside `base`, both resolved. */
  function isInsideOf(base: string, p: string): boolean {
    const rel = relative(base, p);
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  }

  /** Every file under a directory, mapped to its contents. */
  function snapshot(dir: string, prefix = ''): Map<string, string> {
    const out = new Map<string, string>();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        for (const [k, v] of snapshot(join(dir, entry.name), rel)) out.set(k, v);
      } else {
        out.set(rel, readFileSync(join(dir, entry.name), 'utf-8'));
      }
    }
    return out;
  }

  /** Every written path, resolved, that is not under the resolved output directory. */
  function escaped(written: readonly string[]): string[] {
    const base = realpathSync(outputDir);
    return written.filter((p) => {
      const rel = relative(base, realpathSync(p));
      return rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
    });
  }

  /** Every regular file under a directory, as paths relative to it. */
  function tree(dir: string, prefix = ''): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) out.push(...tree(join(dir, entry.name), rel));
      else out.push(rel);
    }
    return out.sort();
  }

  it('places a contained artifact and leaves an escaping one on the floor', async () => {
    const files = await collectArtifacts(
      onePage([
        '/workspace/artifacts/product/prd.md',
        '/workspace/notes.md',
        '/workspace/../../VICTIM.txt',
        '../../VICTIM.txt',
        '/etc/cron.d/pwn',
      ]),
    );
    const { written, refused } = await writeArtifacts(files, outputDir);

    // Every write landed inside the export, wherever the paths pointed.
    expect(escaped(written)).toEqual([]);
    expect(tree(outputDir)).toEqual(['notes.md', 'product/prd.md']);
    expect(refused).toHaveLength(3);
    expect(readFileSync(join(root, 'VICTIM.txt'), 'utf-8')).toBe('original\n');
  });

  it('leaves the output directory a directory when a path reduces to nothing', async () => {
    // `.` and its spellings name the directory they are relative to. Joined,
    // they target the export directory itself: the write would replace it with
    // a regular file and the next artifact's mkdir would fail on it.
    const files = await collectArtifacts(
      onePage(['/workspace/.', '/workspace/artifacts/./', '.', '/workspace/keep.md']),
    );
    const { written, refused } = await writeArtifacts(files, outputDir);

    expect(statSync(outputDir).isDirectory()).toBe(true);
    expect(escaped(written)).toEqual([]);
    expect(tree(outputDir)).toEqual(['keep.md']);
    expect(refused).toHaveLength(3);
  });

  it('names each path it could not place, and why', async () => {
    const files = await collectArtifacts(onePage(['../../VICTIM.txt', '/workspace/.']));
    const { refused } = await writeArtifacts(files, outputDir);
    expect(refused[0]).toContain('../../VICTIM.txt');
    expect(refused[0]).toContain('parent-directory segment');
    expect(refused[1]).toContain('names no location inside the tree');
  });

  it('writes nothing outside the directory across a paged session', async () => {
    // Paging is where a session's artifacts actually arrive, so the escape is
    // placed on the second page rather than the first.
    let served = 0;
    const fetchPage = async (): Promise<EventPage> => {
      served += 1;
      return served === 1
        ? { data: [artifact('/workspace/a.md')], next_page: 'p2' }
        : { data: [artifact('/workspace/../../VICTIM.txt')], next_page: null };
    };
    const files = await collectArtifacts(fetchPage);
    expect(files).toHaveLength(2);

    const { written } = await writeArtifacts(files, outputDir);
    expect(escaped(written)).toEqual([]);
    expect(tree(outputDir)).toEqual(['a.md']);
    expect(readFileSync(join(root, 'VICTIM.txt'), 'utf-8')).toBe('original\n');
  });

  it('reaches for nothing outside the directory, for any refusal kind', async () => {
    // Aimed at the writer rather than at geography: every destination the
    // export reaches for is recorded where it is made, so a refusal that is
    // reported and written anyway is visible whatever kind it is — including
    // kinds nobody has added yet, since nothing here enumerates them.
    const { fs, attempts } = recordingFs();
    const files = await collectArtifacts(
      onePage([
        // One value per refusal kind that can name somewhere outside the tree,
        // plus the contained case so the run is not vacuous.
        '/workspace/../../PARENT.txt',
        '../../PARENT2.txt',
        '/etc/cron.d/ABSOLUTE.txt',
        '/workspace/artifacts/../../../ABOVE.txt',
        '/workspace/.',
        '/workspace/kept.md',
      ]),
    );
    const { written } = await writeArtifacts(files, outputDir, fs);

    expect(outsideAttempts(attempts)).toEqual([]);
    expect(escaped(written)).toEqual([]);
    expect(tree(outputDir)).toEqual(['kept.md']);
  });

  it('reports every write it attempted, and attempts every write it reports', async () => {
    // The report is the export's own account. Held against the attempts rather
    // than trusted, because an account that omits a write is exactly the shape
    // the detector above exists to catch.
    const { fs, attempts } = recordingFs();
    const files = await collectArtifacts(
      onePage(['/workspace/a.md', '/workspace/deep/b.md', '/workspace/../../ESCAPE.txt']),
    );
    const { written } = await writeArtifacts(files, outputDir, fs);
    for (const w of written) expect(attempts).toContain(w);
    expect(written).toHaveLength(2);
  });

  it('keeps a sibling whose name extends the output directory outside it', async () => {
    // `out` and `out-side` share a prefix and are different directories; a
    // containment check comparing strings without a separator admits the second.
    mkdirSync(`${outputDir}-side`, { recursive: true });
    const { fs, attempts } = recordingFs();
    const files = await collectArtifacts(onePage(['/workspace/../out-side/SNEAK.txt']));
    const { written, refused } = await writeArtifacts(files, outputDir, fs);

    expect(written).toEqual([]);
    expect(refused).toHaveLength(1);
    expect(outsideAttempts(attempts)).toEqual([]);
    expect(readdirSync(`${outputDir}-side`)).toEqual([]);
  });

  it('changes nothing outside the directory, whether or not it says so', async () => {
    // The assertions above read what the export reports it wrote. A write that
    // happens without being reported is invisible to them, so this one does not
    // ask the export anything: it takes the whole region an escape could reach
    // and compares it before and after.
    //
    // The region is bounded by construction rather than chosen. The export sits
    // fifteen directories inside a sandbox, so a path of up to twelve parent
    // segments cannot climb out of it — which makes the sandbox a superset of
    // where these escapes land, not a guess at it.
    const sandbox = mkdtempSync(join(tmpdir(), 'fab-sandbox-'));
    try {
      const deepOut = join(sandbox, ...Array.from({ length: 15 }, (_, i) => `d${i}`), 'out');
      mkdirSync(deepOut, { recursive: true });
      writeFileSync(join(sandbox, 'SENTINEL.txt'), 'untouched\n');
      const before = snapshot(sandbox);

      const files = await collectArtifacts(
        onePage([
          `/workspace/${'../'.repeat(12)}OWNED.txt`,
          `/workspace/${'../'.repeat(3)}NEARBY.txt`,
          '../../SIBLING.txt',
          '/workspace/kept.md',
        ]),
      );
      await writeArtifacts(files, deepOut);

      const after = snapshot(sandbox);
      const changed = [...after.keys()]
        .filter((k) => after.get(k) !== before.get(k))
        .concat([...before.keys()].filter((k) => !after.has(k)));
      const outPrefix = `${relative(sandbox, deepOut)}/`;
      expect(changed.filter((c) => !c.startsWith(outPrefix))).toEqual([]);
      expect(changed).toContain(`${outPrefix}kept.md`);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('places nothing outside the directory however deep the escape goes', async () => {
    // Twelve segments from a temp directory reaches somewhere near the
    // filesystem root. Where that is depends on the machine, so the case asks
    // whether each write is contained rather than looking in a place chosen
    // here — the question is the same and the answer does not move.
    const deep = `/workspace/${'../'.repeat(12)}OWNED.txt`;
    const files = await collectArtifacts(onePage([deep, '/workspace/kept.md']));
    const { written, refused } = await writeArtifacts(files, outputDir);
    expect(escaped(written)).toEqual([]);
    expect(tree(outputDir)).toEqual(['kept.md']);
    expect(refused).toHaveLength(1);
  });

  it('refuses a write that a symlink would carry out of the directory', async () => {
    // The rule on the path is lexical and cannot see a link already sitting in
    // the export. Resolving the target is what makes the check about where the
    // bytes land rather than about how the string reads.
    mkdirSync(outputDir, { recursive: true });
    mkdirSync(join(root, 'elsewhere'));
    symlinkSync(join(root, 'elsewhere'), join(outputDir, 'link'));

    const files = await collectArtifacts(onePage(['/workspace/link/deep/OWNED.txt']));
    const { written, refused } = await writeArtifacts(files, outputDir);

    expect(written).toEqual([]);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain('outside the export directory');
    expect(readdirSync(join(root, 'elsewhere'))).toEqual([]);
  });

  it('reports an artifact it could not place and keeps going', async () => {
    // One path naming a file another artifact already occupies used to abort
    // the run, dropping every later artifact with no line about it — the
    // failure this reporting exists to prevent.
    const files = await collectArtifacts(
      onePage(['/workspace/a', '/workspace/a/b.md', '/workspace/z.md']),
    );
    const { written, refused } = await writeArtifacts(files, outputDir);

    expect(escaped(written)).toEqual([]);
    expect(tree(outputDir)).toEqual(['a', 'z.md']);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain('/workspace/a/b.md');
  });
});
