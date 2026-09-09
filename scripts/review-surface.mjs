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

/**
 * Does this glob name the repository ROOT rather than a place inside it?
 *
 * Two spellings get there, and they fail in OPPOSITE directions, which is why a
 * single predicate has to answer for both:
 *
 *   "**", "*", "/", "/**"  normalizePrefix -> ""  and every downstream
 *       `.filter(Boolean)` drops it. The declaration vanishes, the fingerprint
 *       covers LESS than the task declared, and the approval is silently
 *       narrower than it claims to be.
 *   ".", "./"  normalizePrefix -> "."  which survives the filter and hashes the
 *       entire tree -- while `withinPatterns` below answers "outside" for every
 *       real path, since no repository-relative path starts with "./". The
 *       approval would bind, cryptographically, to bytes the reviewer was never
 *       shown: the exact inversion this module exists to prevent.
 *
 * So one spelling under-covers and the other over-covers, and neither is a
 * declaration anyone can act on. Both are refused rather than assigned a
 * meaning; whole-repository review semantics, if they are ever wanted, have to
 * be designed rather than fall out of a regex that happened to return "".
 *
 * This asks about the root, NOT about breadth. "packages/**" normalizes to
 * "packages" and is an ordinary, wide, entirely legal dependency.
 */
export function normalizesToRepositoryRoot(pattern) {
  const prefix = normalizePrefix(pattern);
  return prefix === "" || prefix === ".";
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
  const rooted = declared.filter(normalizesToRepositoryRoot);
  if (rooted.length) {
    /*
     * The same fail-closed rule, one step further out, and the one this function
     * previously got wrong.
     *
     * A well-formed non-empty string was accepted here and then discarded by
     * `reviewPathspecs`'s `.filter(Boolean)` a few lines below, so a task could
     * declare `reviewDependencies: ["**"]` and be fingerprinted as though it had
     * declared nothing at all. `validate` said only that the entry "protects
     * nothing" -- a warning, on the one field whose entire purpose is to make an
     * approval WIDER than the task's own files.
     *
     * The invariant is not negotiable and is stated as narrowly as it can be: a
     * declared review dependency may never make the approved surface narrower
     * than what was declared. Dropping a declaration breaks it, so a declaration
     * that cannot be turned into a usable prefix is refused instead. See
     * `normalizesToRepositoryRoot` for why "." is refused alongside "**" even
     * though it does not vanish.
     */
    throw new Error(
      `${task.id}: reviewDependencies ${rooted.map((p) => JSON.stringify(p)).join(", ")} ` +
        "normalize to the repository root, which is not a reviewable surface; " +
        "declare the directories the review actually depends on. Refusing to " +
        "fingerprint an approval narrower than the task declares",
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

/* ---------------------------------------------------------------------------
 * What the fingerprint actually hashes
 *
 * The patterns above say WHERE the reviewed surface is. The two definitions
 * below say which files inside it contribute an object id to the approval, and
 * they live here for the same reason the patterns do: the reviewer's material
 * builder and the control plane's fingerprint have to enumerate the identical
 * set. A file the fingerprint hashes but the material builder skips is a byte
 * bound to an approval nobody was shown -- the failure this module exists to
 * make impossible -- and a file the material builder shows but the fingerprint
 * skips is merely noise, so the two errors are not symmetric and only a shared
 * enumeration rules the dangerous one out.
 * ------------------------------------------------------------------------- */

/**
 * Generated control-plane bookkeeping, never implementation.
 *
 * Excluded from the fingerprint because recording an approval would otherwise
 * immediately invalidate that approval, and excluded from reviewer material for
 * the same reason: it is not content anyone is being asked to judge.
 */
export const fingerprintExclusions = [
  "control/tasks.json",
  "control/events.jsonl",
  "control/queues",
  "coordination/PROJECT_STATUS.md",
  "coordination/TASKS.md",
  // Handoff traffic is coordination metadata, not implementation. Without this
  // exclusion, publishing a review request would change the fingerprint of the
  // very task being reviewed and invalidate the approval that came back.
  "coordination/agent-bus",
];

export function excludedFromFingerprint(rel) {
  // Write-then-rename temporaries are transient artefacts, never implementation.
  if (rel.endsWith(".tmp")) return true;
  return fingerprintExclusions.some(
    (ex) => rel === ex || rel.startsWith(ex + "/"),
  );
}

/** Path order the fingerprint hashes in: plain code-unit comparison. */
export function compareSurfacePaths(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Parse `git ls-tree -r -z <commitish> -- <pathspecs>` into the exact
 * `[relativePath, objectId]` pairs, in the exact order, that the approval hash
 * is computed over.
 *
 * Only entries of type `blob` count. A tree entry that is not a blob -- a
 * submodule, recorded as a `commit` -- has no content in this repository to hash
 * or to show, so including it would put a path in front of the reviewer whose
 * bytes live in another repository entirely.
 */
export function fingerprintEntries(lsTreeOutput) {
  const entries = [];
  for (const record of String(lsTreeOutput).split("\0")) {
    if (!record.trim()) continue;
    // "<mode> <type> <objectid>\t<path>"
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const meta = record.slice(0, tab).split(/\s+/);
    const rel = record.slice(tab + 1);
    const objectId = meta[2];
    if (!objectId || meta[1] !== "blob") continue;
    if (excludedFromFingerprint(rel)) continue;
    entries.push([rel, objectId]);
  }
  entries.sort((a, b) => compareSurfacePaths(a[0], b[0]));
  return entries;
}
