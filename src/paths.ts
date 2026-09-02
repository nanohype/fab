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

  // Only the parent segment can leave the tree. A `.` or an empty segment
  // resolves to the directory it sits in, so refusing them would buy no
  // containment and would cost a caller a path the published contract accepts —
  // and on the read side a refusal is a skipped check, which fails open. They
  // are removed by {@link canonicalRepoPath} instead, so the path that was
  // checked is the path that gets used.
  if (value.split('/').includes('..')) return 'parent-segment';
  return null;
}

/**
 * The contained path in the one spelling every consumer uses, or null when the
 * value is not contained.
 *
 * Segments that resolve to nothing are dropped here rather than refused above,
 * so `./src`, `src/` and `a//b` reach a consumer as `src`, `src` and `a/b`. A
 * check that passes a string and a use that resolves a different one is the
 * defect this module exists to prevent, and normalising once at the boundary is
 * what keeps them the same string.
 */
export function canonicalRepoPath(value: string): string | null {
  if (repoPathRefusal(value) !== null) return null;
  return value
    .split('/')
    .filter((seg) => seg !== '' && seg !== '.')
    .join('/');
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
    case 'backslash':
      return 'contains a backslash';
  }
}

/** Where an artifact recorded in a session lands, or why it lands nowhere. */
export type ExportDestination = { readonly path: string } | { readonly refusal: PathRefusal };

/**
 * The repo-relative destination for an artifact path a role's model chose.
 *
 * The sandbox roots are stripped first because that is where a session's own
 * writes are rooted, and what remains is held to the same containment rule the
 * read side uses. Exported rather than inlined at the call site so the rule can
 * be exercised on this side too: a guard reachable only from a command's
 * private function is a guard no test can run, and the two sides of one rule
 * are one rule only while both are checked.
 */
export function exportDestination(filePath: string): ExportDestination {
  const stripped = filePath.replace(/^\/workspace\/artifacts\//, '').replace(/^\/workspace\//, '');
  const refusal = repoPathRefusal(stripped);
  if (refusal) return { refusal };
  return { path: canonicalRepoPath(stripped)! };
}
