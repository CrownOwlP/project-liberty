/**
 * Single shared implementation of review-range validation.
 *
 * Previously the control plane and the GPT worker each had their own version,
 * and they disagreed in ways that could strand a task: the worker accepted a
 * WIDER base than expected, reviewed it, published a decision, and the control
 * plane then permanently rejected that decision for not matching exactly. The
 * model call, the acknowledgement and the task were all wasted.
 *
 * Both callers now use this. It returns a classification rather than throwing,
 * so each side maps it onto its own error type:
 *
 *   ok         the range is exactly what this task expects
 *   permanent  a defect in the immutable message; quarantine it
 *   transient  this checkout cannot verify (shallow clone, missing fetch);
 *              retry later, never quarantine
 *
 * The permanent/transient split is the important part. Treating "I cannot see
 * that commit" as a defect would let an environment problem permanently destroy
 * a valid review decision.
 */

export const RANGE_OK = "ok";
export const RANGE_PERMANENT = "permanent";
export const RANGE_TRANSIENT = "transient";

const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * The base this task's next review must start from.
 *   re-review  -> the commit it was last reviewed at
 *   first      -> the commit implementation started from
 */
export function expectedReviewBase(task, commitSha) {
  const priorReviewed = [...(task?.reviewHistory ?? [])]
    .reverse()
    .map((entry) => entry.reviewedCommitSha)
    .find((sha) => FULL_SHA.test(String(sha)) && sha !== commitSha);
  return priorReviewed ?? task?.implementationBaseSha ?? null;
}

/**
 * @param {object}   args
 * @param {string}   args.baseSha
 * @param {string}   args.commitSha
 * @param {object}   args.task
 * @param {string}   args.label        identifier used in messages
 * @param {object}   args.git          { available(), resolves(sha), isAncestor(a, b) }
 */
export function validateReviewRange({ baseSha, commitSha, task, label, git }) {
  const id = label ?? task?.id ?? "message";

  if (!baseSha) {
    return {
      status: RANGE_PERMANENT,
      reason: `${id} carries no baseSha; a review must state the exact range it covers`,
    };
  }
  if (!FULL_SHA.test(baseSha)) {
    return {
      status: RANGE_PERMANENT,
      reason: `${id} baseSha is not a full 40-character hex sha: ${baseSha}`,
    };
  }
  if (!FULL_SHA.test(String(commitSha))) {
    return {
      status: RANGE_PERMANENT,
      reason: `${id} commitSha is not a full 40-character hex sha: ${commitSha}`,
    };
  }
  if (baseSha === commitSha) {
    return {
      status: RANGE_PERMANENT,
      reason: `${id} baseSha equals commitSha; an empty range reviews nothing`,
    };
  }

  // EXACT match, in both directions. A narrower base hides corrective commits
  // from the reviewer; a wider one is reviewed here but rejected by the control
  // plane later, stranding the task after the model has already run.
  const expected = expectedReviewBase(task, commitSha);
  if (expected && expected !== baseSha) {
    return {
      status: RANGE_PERMANENT,
      reason:
        `${id} claims range ${baseSha.slice(0, 12)}..${String(commitSha).slice(0, 12)}, ` +
        `but ${task?.id} expects a review starting at exactly ${expected.slice(0, 12)}. ` +
        "The decision does not cover the work actually under review.",
    };
  }

  // Ancestry requires history. Absence of history is an environment fault.
  if (!git.available()) return { status: RANGE_OK, reason: null, verified: false };

  if (!git.resolves(commitSha)) {
    return {
      status: RANGE_TRANSIENT,
      reason:
        `${id}: reviewed commit ${String(commitSha).slice(0, 12)} is not present in this checkout ` +
        "(shallow clone or missing fetch); cannot verify the review range",
    };
  }
  if (!git.resolves(baseSha)) {
    return {
      status: RANGE_TRANSIENT,
      reason:
        `${id}: base commit ${baseSha.slice(0, 12)} is not present in this checkout ` +
        "(shallow clone or missing fetch); cannot verify the review range",
    };
  }
  if (!git.isAncestor(baseSha, commitSha)) {
    return {
      status: RANGE_PERMANENT,
      reason:
        `${id} baseSha ${baseSha.slice(0, 12)} is not an ancestor of ` +
        `${String(commitSha).slice(0, 12)}; that range is not a real line of history`,
    };
  }

  return { status: RANGE_OK, reason: null, verified: true };
}

/** Git adapter built on a caller-supplied exec function. */
export function gitAdapter(execFileSync, root) {
  const quiet = { cwd: root, stdio: "ignore" };
  return {
    available() {
      try {
        execFileSync("git", ["rev-parse", "--git-dir"], quiet);
        return true;
      } catch {
        return false;
      }
    },
    resolves(sha) {
      if (!FULL_SHA.test(String(sha))) return false;
      try {
        execFileSync("git", ["rev-parse", "--verify", `${sha}^{commit}`], quiet);
        return true;
      } catch {
        return false;
      }
    },
    isAncestor(a, b) {
      try {
        execFileSync("git", ["merge-base", "--is-ancestor", a, b], quiet);
        return true;
      } catch {
        return false;
      }
    },
  };
}
