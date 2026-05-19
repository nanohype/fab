#!/usr/bin/env node
/**
 * Copy the vendored standards JSON from `src/standards/` into
 * `dist/standards/` so the built package is self-contained — the
 * compiled standards.js loads its public bar from alongside itself.
 *
 * Runs as part of `build`. The canonical source of these files is the
 * nanohype repo; `src/standards/` is the committed vendored copy.
 */

import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC = resolve(ROOT, 'src', 'standards');
const DEST = resolve(ROOT, 'dist', 'standards');

async function main() {
  let entries;
  try {
    entries = await readdir(SRC);
  } catch (err) {
    throw new Error(`Cannot read vendored standards directory at ${SRC}. Underlying error: ${err.message}`);
  }

  const jsonFiles = entries.filter((e) => e.endsWith('.json'));
  if (jsonFiles.length === 0) {
    throw new Error(`No JSON files found in ${SRC} — refusing to build a package with no bundled standards.`);
  }

  await mkdir(DEST, { recursive: true });
  for (const file of jsonFiles) {
    await copyFile(resolve(SRC, file), resolve(DEST, file));
  }
  console.log(`copy-standards: bundled ${jsonFiles.length} standards from ${SRC} → ${DEST}`);
}

main().catch((err) => {
  console.error(`copy-standards: ${err.message}`);
  process.exit(1);
});
