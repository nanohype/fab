import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The project .npmrc sets npm's release-age floor. npm 11.10.0 and later apply
 * it unless the command line or the environment sets `min-release-age`, or,
 * from npm 11.15.0, `before`. The file holds that one setting and nothing else,
 * because other keys break or weaken the floor: npm 11.10.0 to 11.14.1 refuse
 * to run with `before` beside `min-release-age`, npm 11.15.0 and later let a
 * `before` in the same file replace the rolling window with a fixed date, and
 * `min-release-age-exclude` (npm 11.17.0 and later) exempts every release of
 * the packages it matches.
 *
 * npm also reads a key from more spellings than the plain one: quoted, cut
 * short by an inline `;` or `#` comment, or named by a `${VAR}` reference. A
 * check for forbidden key names misses those, so these tests admit exactly one
 * `min-release-age=<days>` line and fail on any other setting. Adding a setting
 * to .npmrc means changing this test.
 */
const npmrcPath = fileURLToPath(new URL('../.npmrc', import.meta.url));

/** The one setting .npmrc holds: a floor of a positive whole number of days. */
const FLOOR = /^min-release-age=[1-9]\d*$/;

/**
 * The lines of an .npmrc other than blank and comment lines. npm's ini parser
 * splits on runs of CR and LF and skips a line that is blank or whose first
 * non-blank character is `;` or `#`. The expressions here are the parser's
 * own, so every line this drops is a line npm skips.
 */
function settingLines(npmrc: string): string[] {
  return npmrc.split(/[\r\n]+/).filter((line) => !/^\s*[;#]/.test(line) && !/^\s*$/.test(line));
}

function holdsOnlyTheFloor(npmrc: string): boolean {
  const lines = settingLines(npmrc);
  return lines.length === 1 && FLOOR.test(lines[0]);
}

describe('.npmrc release-age floor', () => {
  it('holds one min-release-age line of a positive whole number of days and no other setting', async () => {
    const npmrc = await readFile(npmrcPath, 'utf8');
    expect(holdsOnlyTheFloor(npmrc), `settings: ${JSON.stringify(settingLines(npmrc))}`).toBe(true);
  });

  // npm 11.17.0 reads each of these with no floor, a zero floor, or the floor
  // beside `before` or `min-release-age-exclude`; the `${KEY}` line names
  // `before` when the environment sets KEY=before.
  it.each([
    ['a zero floor', 'min-release-age=0'],
    ['a misspelled key', 'min-release-ages=3'],
    ['the floor under a [section] header', '[floor]\nmin-release-age=3'],
    ['before', 'min-release-age=3\nbefore=2020-01-01'],
    ['a double-quoted before', 'min-release-age=3\n"before"=2020-01-01'],
    ['a single-quoted before', "min-release-age=3\n'before'=2020-01-01"],
    ['before cut short by an inline comment', 'min-release-age=3\nbefore;note=2020-01-01'],
    ['before after a CR inside a comment line', 'min-release-age=3\n# note\rbefore=2020-01-01'],
    ['before after an indented [section] line', 'min-release-age=3\n [x]\nbefore=2020-01-01'],
    ['a key named by an environment variable', `min-release-age=3\n\${KEY}=2020-01-01`],
    ['min-release-age-exclude', 'min-release-age=3\nmin-release-age-exclude=@x/*'],
    ['a quoted min-release-age-exclude', 'min-release-age=3\n"min-release-age-exclude"=@x/*'],
    ['min-release-age-exclude as an array', 'min-release-age=3\nmin-release-age-exclude[]=@x/*'],
  ])('rejects %s', (_label, npmrc) => {
    expect(holdsOnlyTheFloor(npmrc)).toBe(false);
  });
});
