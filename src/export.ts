import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { describeRefusal, exportDestination } from './paths.js';

// ── Writing a session's artifacts to disk ───────────────────────────
//
// Every path here is the `file_path` argument of a `write` tool call a role's
// model made, so what it names is the model's choice and nothing has been near
// a filesystem yet. `join` resolves a parent segment rather than refusing it,
// and a recursive `mkdir` builds whatever tree the resolved path implies, so an
// unchecked value writes wherever it points.
//
// This lives here rather than in the command because a guard is only held by
// what can be run against it: the entrypoint executes on import, so a function
// there can be read and cannot be driven. What the command keeps is the part a
// test does not need — reading flags, building a client, printing.

/** One artifact recorded in a session: the path the model chose and what it wrote. */
export interface RecordedArtifact {
  readonly path: string;
  readonly content: string;
}

/** One page of session events, as the API returns them. */
export interface EventPage {
  readonly data: ReadonlyArray<{
    type: string;
    name?: string;
    input?: Record<string, unknown>;
  }>;
  readonly next_page: string | null;
}

export interface ExportOutcome {
  /** Absolute, symlink-resolved locations of the files this export created. */
  readonly written: string[];
  /** Paths the session named that this export could not place, with the reason. */
  readonly refused: string[];
}

/**
 * The location `target` would occupy with every symlink on the way resolved.
 *
 * The deepest ancestor that exists is resolved and the rest appended, because a
 * file that has not been written yet has no realpath of its own. A lexical rule
 * cannot see a symlink already sitting in the output directory, and a write
 * through one lands wherever the link points while every string involved still
 * looks contained.
 */
async function resolvedTarget(target: string): Promise<string> {
  const parts: string[] = [];
  let probe = resolve(target);
  for (;;) {
    try {
      return join(await realpath(probe), ...parts.reverse());
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return resolve(target);
      parts.push(probe.slice(parent.length + 1));
      probe = parent;
    }
  }
}

/** True when `p` names a place strictly inside `base`, both already resolved. */
function isInside(base: string, p: string): boolean {
  const rel = relative(base, p);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Collect the artifacts a session recorded, in the order it wrote them. */
export async function collectArtifacts(
  fetchPage: (page: string | null) => Promise<EventPage>,
): Promise<RecordedArtifact[]> {
  const files: RecordedArtifact[] = [];
  let page: string | null = null;
  do {
    const result = await fetchPage(page);
    for (const event of result.data) {
      if (event.type === 'agent.tool_use' && event.name === 'write' && event.input) {
        const path = String(event.input.file_path ?? event.input.path ?? '');
        const content = String(event.input.content ?? '');
        if (path && content) files.push({ path, content });
      }
    }
    page = result.next_page;
  } while (page);
  return files;
}

/**
 * Write the artifacts that name a place inside `outputDir`, and report the rest.
 *
 * A refused path is named rather than counted: which path the session asked for
 * is the part an operator needs, and a silent skip is how a truncated export
 * reads as a complete one.
 */
export async function writeArtifacts(
  files: readonly RecordedArtifact[],
  outputDir: string,
): Promise<ExportOutcome> {
  const written: string[] = [];
  const refused: string[] = [];
  await mkdir(outputDir, { recursive: true });
  const base = await realpath(outputDir);

  for (const file of files) {
    const dest = exportDestination(file.path);
    if ('refusal' in dest) {
      refused.push(`${file.path} — ${describeRefusal(dest.refusal)}`);
      continue;
    }
    // Where the write would actually land, not where the string says. The rule
    // above is lexical and cannot see a symlink already in the directory.
    const target = await resolvedTarget(join(outputDir, dest.path));
    if (!isInside(base, target)) {
      refused.push(`${file.path} — resolves to ${target}, outside the export directory`);
      continue;
    }
    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content, 'utf-8');
      written.push(target);
    } catch (err) {
      // One artifact that cannot be placed — a path that names a file another
      // artifact already occupies, a permission — must not take the rest of the
      // export with it, silently.
      refused.push(`${file.path} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { written, refused };
}
