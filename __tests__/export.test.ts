import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

    expect(tree(outputDir)).toEqual(['notes.md', 'product/prd.md']);
    expect(written).toEqual(['product/prd.md', 'notes.md']);
    expect(refused).toHaveLength(3);
    // The assertion the whole change exists for, made of the filesystem.
    expect(readFileSync(join(root, 'VICTIM.txt'), 'utf-8')).toBe('original\n');
    expect(readdirSync(root).sort()).toEqual(['VICTIM.txt', 'out']);
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
    expect(tree(outputDir)).toEqual(['keep.md']);
    expect(written).toEqual(['keep.md']);
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
    expect(written).toEqual(['a.md']);
    expect(readFileSync(join(root, 'VICTIM.txt'), 'utf-8')).toBe('original\n');
  });

  it('places nothing above the directory however deep the escape goes', async () => {
    const deep = `/workspace/${'../'.repeat(12)}OWNED.txt`;
    const files = await collectArtifacts(onePage([deep]));
    await writeArtifacts(files, outputDir);
    // Refused before anything is created, so the directory is never made — and
    // nothing appears beside it or above it, which is what a deep escape would
    // otherwise reach.
    expect(readdirSync(root)).toEqual(['VICTIM.txt']);
    expect(readdirSync(resolve(root, '..')).includes('OWNED.txt')).toBe(false);
  });
});
