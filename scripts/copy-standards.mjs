#!/usr/bin/env node
/**
 * Copy the vendored standards JSON from `src/standards/` into
 * `dist/standards/` so the built package is self-contained — the
 * compiled standards.js loads its public bar from alongside itself.
 *
 * Runs as part of `build`. The canonical source of these files is the
 * nanohype repo; `src/standards/` is the committed vendored copy.
 */

import { copyFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC = resolve(ROOT, 'src', 'standards');
const DEST = resolve(ROOT, 'dist', 'standards');

async function main() {
  // Copy exactly what source.json declares. Globbing the directory would
  // bundle this manifest as if it were a standard, and — worse — would keep
  // silently shipping any file someone dropped in here, which is how four
  // copies nothing reads came to travel with the package in the first place.
  let manifest;
  try {
    manifest = JSON.parse(await readFile(resolve(SRC, 'source.json'), 'utf-8'));
  } catch (err) {
    throw new Error(`Cannot read ${resolve(SRC, 'source.json')}. Underlying error: ${err.message}`);
  }

  const declared = (manifest.files ?? []).map((f) => f.file);
  if (declared.length === 0) {
    throw new Error(
      `source.json declares no files — refusing to build a package with no bundled standards.`,
    );
  }

  let entries;
  try {
    entries = await readdir(SRC);
  } catch (err) {
    throw new Error(
      `Cannot read vendored standards directory at ${SRC}. Underlying error: ${err.message}`,
    );
  }

  // Both directions: a declared file that is not there, and a file that is
  // there undeclared. The second is the one that rots.
  const present = entries.filter((e) => e.endsWith('.json') && e !== 'source.json');
  const undeclared = present.filter((e) => !declared.includes(e));
  if (undeclared.length > 0) {
    throw new Error(
      `${undeclared.join(', ')} in ${SRC} but not declared in source.json — vendor what you load, and record what you vendor.`,
    );
  }

  // Clear first. Without this a file deleted from src/standards/ survives in
  // dist/ from an earlier build and ships in the published package — bundled,
  // stale, and read by nothing that would notice.
  await rm(DEST, { recursive: true, force: true });
  await mkdir(DEST, { recursive: true });
  for (const file of declared) {
    if (!present.includes(file)) {
      throw new Error(`source.json declares ${file}, which is not in ${SRC}.`);
    }
    await copyFile(resolve(SRC, file), resolve(DEST, file));
  }
  console.log(`copy-standards: bundled ${declared.length} standards from ${SRC} → ${DEST}`);
}

main().catch((err) => {
  console.error(`copy-standards: ${err.message}`);
  process.exit(1);
});
