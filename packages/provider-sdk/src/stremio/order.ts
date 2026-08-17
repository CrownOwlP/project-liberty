/**
 * The one string comparator this package sorts with (PL-0301).
 *
 * `localeCompare()` with no explicit locale collates using the HOST's settings,
 * so the same two ids order differently on a developer's machine and in
 * production -- and neither candidate ids, source ids nor addon-authored labels
 * are restricted to ASCII. The playback path is required to be deterministic
 * given identical inputs (docs/ARCHITECTURE.md), and four separate
 * order-dependence defects have already been found in this repository, so the
 * comparator lives in ONE place and every sort in the package terminates in it.
 *
 * `<` and `>` on strings compare UTF-16 code units. That is total, stable and
 * host-independent, which is the entire requirement. It is deliberately NOT
 * alphabetical in any human language: nothing sorted with this is ever shown to
 * a viewer as an ordered list, and the moment something is, it needs a real
 * collation with a stated locale rather than this.
 */
export function compareCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
