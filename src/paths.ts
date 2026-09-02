// ── Containment for paths fab did not author ────────────────────────
//
// fab composes paths from values written elsewhere: a directory from an intake
// brief, a `file:` from a role's CITATIONS block, a `file_path` from a tool call
// a model made. Each is a repo-relative path by contract and arbitrary text in
// fact, and the difference is only ever what checks it before use.
//
// One definition, used by the read side and the write side alike. A guard that
// exists on only one of them protects only one of them, and the two sides of a
// system that disagree about what is inside it are a system with no inside.
//
// A parent-directory segment is refused wherever it appears, including where it
// would normalize back within the tree. `a/../b` is `b` to every resolver, so
// admitting it means the path that was checked and the path that is used are
// different strings — and the checking of one while the other is used is the
// whole of this defect class. Refusing the segment outright is what makes the
// checked string and the used string the same one.

/** Why a value is not a contained repo-relative path. */
export type PathRefusal =
  | 'empty'
  | 'too-long'
  | 'not-one-line'
  | 'absolute'
  | 'parent-segment'
  | 'empty-segment'
  | 'current-segment'
  | 'backslash';

/**
 * Long enough for any real repository path, short enough that a value built to
 * overflow something downstream is refused here.
 */
export const REPO_PATH_MAX = 200;

/**
 * Why `value` is not a contained repo-relative path, or null when it is.
 *
 * Returns the reason rather than a boolean so a caller can say what was wrong
 * with the value it was given instead of reporting that something was.
 */
export function repoPathRefusal(value: string): PathRefusal | null {
  if (value.length === 0) return 'empty';
  if (value.length > REPO_PATH_MAX) return 'too-long';
  // Control characters cover NUL and the newline that would let one entry
  // become two lines wherever the value is rendered.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
  if (/[\u0000-\u001f\u007f]/.test(value)) return 'not-one-line';
  // A separator on one platform and an ordinary character on another. Splitting
  // on '/' alone would not see the segments it divides.
  if (value.includes('\\')) return 'backslash';
  if (value.startsWith('/')) return 'absolute';

  for (const segment of value.split('/')) {
    if (segment === '..') return 'parent-segment';
    if (segment === '.') return 'current-segment';
    if (segment === '') return 'empty-segment';
  }
  return null;
}

/** True when `value` names a location inside the repository and nowhere else. */
export function isContainedRepoPath(value: string): boolean {
  return repoPathRefusal(value) === null;
}

/** The refusal as a phrase that reads inside a sentence about the offending value. */
export function describeRefusal(refusal: PathRefusal): string {
  switch (refusal) {
    case 'empty':
      return 'is empty';
    case 'too-long':
      return `is longer than ${REPO_PATH_MAX} characters`;
    case 'not-one-line':
      return 'carries a control character or a line break';
    case 'absolute':
      return 'is an absolute path';
    case 'parent-segment':
      return 'contains a parent-directory segment';
    case 'empty-segment':
      return 'contains an empty path segment';
    case 'current-segment':
      return 'contains a bare current-directory segment';
    case 'backslash':
      return 'contains a backslash';
  }
}
