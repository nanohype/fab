#!/usr/bin/env node
// Lets typedoc 0.28.x run on minimatch 11.
//
// GHSA-g3hv-75wg-m249 (minimatch globparts amplification DoS) is fixed only in
// minimatch 11, and minimatch reaches this tree only through typedoc. typedoc
// 0.28.x calls Minimatch#matchOne once, in glob()'s shouldRecurse, and
// minimatch 11 made matchOne private, so package.json overrides typedoc's
// minimatch to ^11 and this script moves that one call onto the public
// match(path, partial = true). `npm run docs` runs it before typedoc.
//
// It edits node_modules only, and only that one call:
//   - already patched, or typedoc still on minimatch 10: nothing to do, exit 0;
//   - the call is found: rewrite it, exit 0;
//   - typedoc is on minimatch 11 and the call is not where it was: exit 1,
//     because typedoc moved and this patch no longer describes it.
// Delete the script, the docs prefix and the override once a typedoc release
// declares minimatch 11.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(process.cwd(), 'node_modules');
const target = join(root, 'typedoc', 'dist', 'node-utils.js');
const MARKER = 'minimatch 11 made matchOne private';

const OLD = `      return mini.set.some((row) => mini.matchOne(
        childPath,
        row,
        /* partial */
        true
      ));`;

const NEW = `      // ${MARKER} (GHSA-g3hv-75wg-m249 is fixed only
      // there). match(path, partial) runs the same partial row match;
      // un-flip negation so a "!" pattern recurses exactly as before.
      const hit = mini.match(childPath.join("/"), true);
      return mini.negate ? !hit : hit;`;

if (!existsSync(target)) {
  process.stderr.write(`patch-typedoc-minimatch: ${target} not found; is typedoc installed?\n`);
  process.exit(1);
}

const minimatchPkg = [
  join(root, 'typedoc', 'node_modules', 'minimatch', 'package.json'),
  join(root, 'minimatch', 'package.json'),
].find(existsSync);
const minimatchMajor = minimatchPkg
  ? Number(JSON.parse(readFileSync(minimatchPkg, 'utf8')).version.split('.')[0])
  : NaN;

const src = readFileSync(target, 'utf8');
if (src.includes(MARKER)) process.exit(0);
if (src.includes(OLD)) {
  writeFileSync(target, src.replace(OLD, NEW));
  process.stdout.write(
    "patch-typedoc-minimatch: typedoc's matchOne call moved to match(path, true)\n",
  );
  process.exit(0);
}
if (minimatchMajor < 11) process.exit(0);
process.stderr.write(
  `patch-typedoc-minimatch: typedoc resolves minimatch ${minimatchMajor} but its matchOne call is not ` +
    'where this patch expects it. typedoc has changed: check whether it now supports minimatch 11 ' +
    'and, if so, delete this script and the docs prefix.\n',
);
process.exit(1);
