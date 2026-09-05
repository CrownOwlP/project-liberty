/**
 * The orchestration surface, and path-prefix arithmetic over allowedPaths.
 *
 * Extracted from `select-task.mjs` because a SECOND autonomous entry point now
 * needs the identical rule (`agent-dispatcher.mjs`). Two copies of a guard that
 * decides what an agent may autonomously write is the shape this repository has
 * already been bitten by: the copy that quietly stops matching is the one still
 * wearing the green tick. `select-task.mjs` imports from here and holds no local
 * copy; the comments below moved with the code rather than being rewritten, so
 * the reasoning did not get re-derived on the way.
 *
 * Pure. No I/O, no clock, no ambient state.
 */

/**
 * Paths that ARE the orchestration machinery.
 *
 * A task allowed to edit these could rewrite the reviewer, the workflows or the
 * control plane, push to main, and then have its own modified reviewer judge
 * that change from main. Autonomy over the machinery that supervises autonomy
 * is the one loop this system must not close by itself, so such tasks are
 * refused and left for a privileged review-before-main lane.
 */
export const ORCHESTRATION_PREFIXES = [".github", "scripts", "control", "coordination/agent-bus"];

export function normalizePrefix(pattern) {
  return String(pattern).replace(/\\/g, "/").replace(/\*\*.*$/, "").replace(/\*.*$/, "").replace(/\/$/, "");
}

/*
 * A prefix that IS the repository root, in either spelling that reaches it.
 *
 * This case is checked before the prefix comparison below, because the obvious
 * way to write that comparison was `.filter(Boolean)` first -- and that is a
 * hole, not a tidy-up. `normalizePrefix("**")` is "" and `normalizePrefix(".")`
 * is ".", so a task declaring either OWNS THE WHOLE REPOSITORY: .github,
 * scripts, control and coordination/agent-bus included. Dropping "" as falsy,
 * and letting "." fail a comparison no relative path can satisfy, made the
 * single broadest allowedPath expressible the one thing this guard could not
 * see -- and this guard is what stops an agent rewriting the reviewer that
 * judges its own work.
 *
 * `ai-control-plane.mjs validate` now rejects such a path outright, so this
 * should be unreachable. It is checked anyway: the callers read
 * control/tasks.json directly and never run the validator, so validation is not
 * on the path between a bad declaration and an autonomous claim.
 */
export function isRepositoryRoot(prefix) {
  return prefix === "" || prefix === ".";
}

/*
 * Deliberately allowedPaths, never the reviewed surface.
 *
 * This asks what the task may WRITE. A reviewDependency is read-only, so merely
 * reading the orchestration machinery closes no loop and must not push a task
 * into the privileged lane -- doing so would make declaring a dependency more
 * expensive than reserving the whole package, which is the bottleneck the field
 * was added to remove.
 */
export function touchesOrchestration(task) {
  return (task?.allowedPaths ?? [])
    .map(normalizePrefix)
    .filter(
      (p) =>
        isRepositoryRoot(p) ||
        ORCHESTRATION_PREFIXES.some(
          (o) => p === o || p.startsWith(o + "/") || o.startsWith(p + "/"),
        ),
    )
    .map((p) => (isRepositoryRoot(p) ? "<repository root>" : p));
}

/**
 * Do two allowedPaths declarations reserve any of the same tree?
 *
 * A CONSERVATIVE, ADVISORY check, and it is important that it is read as one.
 * The binding collision rule lives in `ai-control-plane.mjs` and runs at claim
 * time; this exists so a planner does not propose two tasks that the control
 * plane would then refuse one of. A planner that never claims cannot create a
 * collision, so being slightly stricter here costs a deferred task and nothing
 * else -- whereas being stricter in the control plane would cost a false
 * refusal. Do not promote this into an enforcement point.
 */
export function pathsOverlap(a, b) {
  const left = [...new Set((a ?? []).map(normalizePrefix))];
  const right = [...new Set((b ?? []).map(normalizePrefix))];
  for (const x of left) {
    for (const y of right) {
      if (isRepositoryRoot(x) || isRepositoryRoot(y)) return true;
      if (x === y || x.startsWith(y + "/") || y.startsWith(x + "/")) return true;
    }
  }
  return false;
}
