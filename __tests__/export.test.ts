import {
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
import { isAbsolute, join, relative, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectArtifacts, type EventPage, writeArtifacts } from '../src/export.js';

// ── What the export puts on disk ────────────────────────────────────
//
// The paths here are the ones a role's model chose, so the property is about
// what happens when one of them names somewhere else — and that is a question
// about the filesystem, not about which expressions appear in the source. These
// cases run the export against a session that recorded an escape and then look
// at the disk. A guard removed, a guard reported and not applied, a carve-out
// for one refusal: all three change what appears, and none of them can be
// spelled around, because nothing here reads the source.
//
// What they look at is where each write landed, not the contents of directories
// chosen in advance. An escape leaves the output directory for somewhere its
// author picks — a listing of any particular place is a guess about where that
// is, and a guess that is wrong reports success. Resolving each written path
// and asking whether it is under the output directory is the same question
// asked where the answer is.
//
// What this does not cover: the command that calls this, which reads flags and
// builds a client. `src/bin/fab.ts` runs `main()` on import, so a function
// there can be read and cannot be driven; what it keeps is the part with no
// filesystem in it.

const artifact = (path: string, content = 'x') => ({
  type: 'agent.tool_use',
  name: 'write',
  input: { file_path: path, content },
});

const onePage = (paths: string[]): ((page: string | null) => Promise<EventPage>) => {
  return async () => ({ data: paths.map((p) => artifact(p)), next_page: null });
};

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
