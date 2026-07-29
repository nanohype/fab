#!/usr/bin/env node
import { execFile } from 'node:child_process';
/**
 * Keep the vendored standard honest against the repository it came from.
 *
 *   node scripts/standards.mjs check       # pin fidelity — the blocking gate
 *   node scripts/standards.mjs sync <sha>  # re-vendor at <sha> and rewrite the digest
 *   node scripts/standards.mjs freshness   # has the file changed upstream since the pin? (scheduled)
 *
 * fab depends on no nanohype package, so what it reads at runtime has to travel
 * with it, and a travelling copy needs something holding it to its source.
 * `check` is that: it reads the file from upstream AT THE PINNED REF and
 * requires the bytes to be identical, so neither a hand-edited copy nor a
 * hand-moved pin survives.
 *
 * Reading at the pin rather than at upstream's head is deliberate. A verdict
 * about this commit must not depend on a commit that is not — otherwise a push
 * to another repository turns this red. `freshness` asks that separate question
 * on its own schedule.
 *
 * Upstream resolves two ways, both deterministic: $NANOHYPE_DIR when a local
 * checkout is set (its HEAD must equal the pin under `check`), otherwise
 * raw.githubusercontent.com at the pinned ref. Every failure exits non-zero; no
 * path reports success without having compared something.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STANDARDS = resolve(ROOT, 'src', 'standards');
const MANIFEST = resolve(STANDARDS, 'source.json');

const die = (msg) => {
  console.error(`standards: ${msg}`);
  process.exit(1);
};

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

const readManifest = async () => JSON.parse(await readFile(MANIFEST, 'utf-8'));

/** The file's bytes at `ref`, from a local checkout or GitHub. */
async function fetchUpstream(manifest, file, ref) {
  const path = `${manifest.upstream.path}/${file}`;
  const local = process.env.NANOHYPE_DIR;

  if (local) {
    try {
      const { stdout } = await run('git', ['-C', local, 'show', `${ref}:${path}`], {
        encoding: 'buffer',
        maxBuffer: 8 * 1024 * 1024,
      });
      return stdout;
    } catch (err) {
      die(`cannot read ${path} at ${ref} from NANOHYPE_DIR=${local}: ${err.message}`);
    }
  }

  const url = `https://raw.githubusercontent.com/${manifest.upstream.repository}/${ref}/${path}`;
  const response = await fetch(url);
  if (!response.ok) die(`cannot read ${url} — HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());

  // A 404 body or an error page is not a standard. Without this the digest
  // comparison would report a mismatch and hide the real cause.
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf-8'));
  } catch {
    die(`what came back from ${ref} for ${file} is not JSON`);
  }
  if (typeof parsed.kind !== 'string' || !parsed.kind.startsWith('nanohype/standards/')) {
    die(`what came back from ${ref} for ${file} is not a nanohype standard`);
  }
  return bytes;
}

async function check() {
  const manifest = await readManifest();
  const ref = manifest.upstream.ref;
  if (!/^[0-9a-f]{40}$/.test(ref)) die(`upstream.ref is ${ref}, which is not a commit sha`);
  if (!manifest.files?.length) die('source.json declares no files');

  if (process.env.NANOHYPE_DIR) {
    const { stdout } = await run('git', ['-C', process.env.NANOHYPE_DIR, 'rev-parse', 'HEAD']);
    const head = stdout.trim();
    if (head !== ref) {
      die(
        `NANOHYPE_DIR is on ${head} but the pin is ${ref}; check that commit out, or unset NANOHYPE_DIR to read from GitHub`,
      );
    }
  }

  for (const entry of manifest.files) {
    const localBytes = await readFile(resolve(STANDARDS, entry.file));
    const localDigest = digest(localBytes);
    if (localDigest !== entry.sha256) {
      die(
        `${entry.file} digest ${localDigest} != source.json ${entry.sha256} — the vendored copy was edited; re-vendor with \`npm run standards:sync\``,
      );
    }

    const upstreamDigest = digest(await fetchUpstream(manifest, entry.file, ref));
    if (upstreamDigest !== entry.sha256) {
      die(
        `${manifest.upstream.repository}@${ref} has ${entry.file} at ${upstreamDigest}, the pin records ${entry.sha256} — the ref and the bytes disagree; re-vendor with \`npm run standards:sync\``,
      );
    }
  }

  console.log(
    `standards: ${manifest.files.length} file(s) match ${manifest.upstream.repository}@${ref}`,
  );
}

async function sync(ref) {
  const manifest = await readManifest();
  const target = ref || manifest.upstream.ref;
  if (!/^[0-9a-f]{40}$/.test(target)) die(`${target} is not a 40-character commit sha`);

  for (const entry of manifest.files) {
    const bytes = await fetchUpstream(manifest, entry.file, target);
    await writeFile(resolve(STANDARDS, entry.file), bytes);
    entry.sha256 = digest(bytes);
  }
  manifest.upstream.ref = target;
  await writeFile(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(
    `standards: vendored ${manifest.files.length} file(s) from ${manifest.upstream.repository}@${target}`,
  );
  console.log('standards: now run: npm test');
}

async function freshness() {
  const manifest = await readManifest();
  const { repository } = manifest.upstream;

  // Compare bytes, not commit shas. The pin names a commit, and commits move
  // for reasons that have nothing to do with these files — a pin can sit
  // *ahead* of the last commit that touched the path and be perfectly current.
  // What matters is whether the file upstream still says what the copy says.
  const stale = [];
  for (const entry of manifest.files) {
    const head = digest(await fetchUpstream(manifest, entry.file, 'HEAD'));
    if (head !== entry.sha256) stale.push(entry.file);
  }

  if (stale.length === 0) {
    console.log(
      `standards: copies match ${repository} at its default branch (pin ${manifest.upstream.ref})`,
    );
    return;
  }

  // Non-zero so a scheduled run is visibly actionable, and separate from
  // `check` so a push to another repository can never turn a required check red.
  console.error(`standards: ${stale.join(', ')} changed upstream since the pin`);
  console.error('standards: re-vendor with: npm run standards:sync -- <sha of the change>');
  process.exit(1);
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case 'check':
    await check();
    break;
  case 'sync':
    await sync(rest[0]);
    break;
  case 'freshness':
    await freshness();
    break;
  default:
    die('usage: standards.mjs {check|sync [<sha>]|freshness}');
}
