/* -------------------------------------------------------------------------
 * Ordering primitives (PL-0801)
 *
 * A LEAF module. Two helpers, both of which exist because the alternative has
 * already shipped a defect in this repository.
 * ---------------------------------------------------------------------- */

/**
 * Compares by UTF-16 code point, never by locale.
 *
 * `localeCompare` without an explicit locale reads the host's collation, so the
 * same slate would order differently on a developer's machine and in CI, and the
 * "identical inputs produce an identical slate" claim would be false in exactly
 * the way nobody tests for. Six order-dependence defects have been found in this
 * repository and two of them were locale-sensitive sorts, so the comparison is
 * spelled out rather than reached for.
 */
export function compareCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Narrows a list to a non-empty tuple, or throws.
 *
 * Used where the type system needs to keep a guarantee the code already
 * maintains — a merged candidate always carries at least the reason that caused
 * it to be merged. Throwing rather than returning a fallback because an empty
 * reason list at this point means the merge lost the trail, and silently
 * substituting an empty tuple would hide precisely the failure PL-0801 exists to
 * prevent.
 */
export function nonEmpty<Item>(items: readonly Item[], what: string): readonly [Item, ...Item[]] {
  const [first, ...rest] = items;
  if (first === undefined) throw new Error(`expected ${what} to be non-empty`);
  return [first, ...rest];
}
