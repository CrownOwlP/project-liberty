/**
 * Single shared implementation of the REVIEW surface.
 *
 * Two surfaces exist and must never be collapsed into one:
 *
 *   write / collision / staging   allowedPaths
 *   reviewed / fingerprinted      allowedPaths + reviewDependencies
 *
 * This module owns the second one, and nothing else may derive it. It was
 * extracted the moment the two ideas stopped agreeing by accident: the
 * fingerprint bound an approval to allowedPaths + reviewDependencies while the
 * reviewer was shown only allowedPaths, so an approval could cryptographically
 * cover bytes the independent reviewer never saw. The stronger fingerprint would
 * have made the evidence look better while its epistemic basis got worse.
 *
 * The rule for callers is a question about intent, not about convenience:
 *
 *   deciding what a REVIEWER IS SHOWN            -> call in here
 *   deciding what an IMPLEMENTER MAY WRITE       -> stay on allowedPaths
 *
 * The second half is not a stylistic preference. A declared dependency is
 * read-only by construction: no collision check reserved it, so another active
 * task may be editing it at this moment, and treating it as writable anywhere --
 * staging, patch export, ownership, autonomy checks -- would hand out a claim the
 * scheduler never granted.
 *
 * Absent or empty reviewDependencies reduces every function here to allowedPaths,
 * so the tasks authored before the field existed classify exactly as they always
 * did.
 */

/**
 * Longest literal prefix of a path glob.
 *
 * Shared rather than re-typed because the fingerprint walks the tree with it and
 * the reviewer-facing filters test membership with it. If the two normalized a
 * glob even slightly differently, a file could be hashed into an approval while
 * being filtered out of the diff -- the exact divergence this module exists to
 * make impossible.
 */
export function normalizePrefix(pattern) {
  return pattern
    .replace(/\\/g, "/")
    .replace(/\*\*.*$/, "")
    .replace(/\*.*$/, "")
    .replace(/\/$/, "");
}

function withinPatterns(rel, patterns) {
  return patterns.some((raw) => {
    const prefix = normalizePrefix(raw);
    return prefix && (rel === prefix || rel.startsWith(prefix + "/"));
  });
}

/**
 * The REVIEWED surface: everything an approval binds to.
 *
 * allowedPaths is in the union by construction rather than by convention. If a
 * task could write a file that its own fingerprint did not cover, it could
 * change its approved content without invalidating the approval -- which is the
 * exact failure the fingerprint exists to prevent.
 */
export function reviewSurfacePatterns(task) {
  const declared = task.reviewDependencies ?? [];
  if (
    !Array.isArray(declared) ||
    declared.some((p) => typeof p !== "string" || !p.trim())
  ) {
    // Fail closed rather than skipping the unusable entries. `validate` reports
    // this properly, so anything reaching here bypassed it -- and silently
    // fingerprinting a NARROWER surface than the task declares would record an
    // approval that claims to cover a shared vocabulary it never hashed, which
    // is the precise failure this field exists to prevent.
    throw new Error(
      `${task.id}: reviewDependencies must be an array of non-empty path globs; ` +
        "refusing to fingerprint a review surface that cannot be determined",
    );
  }
  return [...(task.allowedPaths ?? []), ...declared];
}

/** The reviewed surface as git pathspecs: deduplicated literal prefixes. */
export function reviewPathspecs(task) {
  return [
    ...new Set(reviewSurfacePatterns(task).map(normalizePrefix).filter(Boolean)),
  ];
}

/**
 * What one path IS to this task. The distinction is the whole point of showing
 * dependencies at all: a reviewer that cannot tell implementation from context
 * will either raise findings against code the task may not touch, or -- far
 * worse -- read a dependency's change as the task's work and approve it.
 *
 * allowedPaths wins ties, so redundantly declaring an owned path as a dependency
 * stays the no-op the fingerprint already treats it as.
 */
export function classifyReviewPath(rel, task) {
  if (withinPatterns(rel, task.allowedPaths ?? [])) return "implementation";
  if (withinPatterns(rel, reviewSurfacePatterns(task))) return "dependency";
  return "outside";
}

/** Is this path inside anything the approval will bind to? */
export function withinReviewSurface(rel, task) {
  return classifyReviewPath(rel, task) !== "outside";
}

/**
 * How to NAME the reviewed surface in operator-facing text.
 *
 * Centralised so the stale-review error, the reviewer's refusal message and any
 * future report say the same thing. An owner who has touched nothing in their
 * own allowedPaths would otherwise read a stale-review failure as a control-plane
 * fault rather than as the shared-vocabulary change it is.
 */
export function reviewSurfaceLabel(task) {
  return (task.reviewDependencies ?? []).length
    ? "allowedPaths + reviewDependencies"
    : "allowedPaths";
}
