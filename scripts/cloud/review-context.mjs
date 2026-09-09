/**
 * What the reviewer is SHOWN, derived from what the approval BINDS TO.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS MODULE EXISTS TO CLOSE
 * ---------------------------------------------------------------------------
 * The reviewer's material used to start from `git diff --name-only base commit`
 * and keep whatever landed inside the reviewed surface. The approval it produced
 * was then fingerprinted over `git ls-tree` at the reviewed commit -- every blob
 * under allowedPaths + reviewDependencies, changed or not. Those are different
 * sets, and the difference always ran the dangerous way:
 *
 *   an unchanged review dependency        hashed into the approval, never shown
 *   a pre-existing file under a broad
 *     allowedPaths glob                   hashed into the approval, never shown
 *
 * So an approval was cryptographically bound to bytes the independent reviewer
 * had not read, which is the exact failure the fingerprint was widened to
 * prevent. Sharing `reviewSurfacePatterns` between the two sides was not enough:
 * both sides agreed about WHERE to look and disagreed about WHICH FILES THERE
 * COUNT.
 *
 * So material is enumerated from the fingerprinted tree, through the same
 * `fingerprintEntries` the control plane hashes, and the range's diff is
 * demoted to what it actually is: an explanation of what the implementation
 * changed, layered on top of the content, never the thing that decides what the
 * content is.
 *
 * ---------------------------------------------------------------------------
 * THE OTHER HALF: NEVER A PARTIAL SURFACE THAT LOOKS COMPLETE
 * ---------------------------------------------------------------------------
 * Every file the approval binds to leaves this module in exactly one of two
 * places: inside a chunk, in full, or named in `unreviewable`. There is no third
 * outcome and in particular no silent omission, because a prompt that is missing
 * a file looks exactly like a prompt that never needed it -- and the model would
 * then confirm full scope in good faith. When anything is unreviewable the
 * worker refuses the whole range deterministically, with zero model calls.
 *
 * Pure apart from the injected `git` adapter, so the whole selection can be
 * executed in tests against a real repository without an OPENAI_API_KEY.
 */
import {
  classifyReviewPath,
  compareSurfacePaths,
  excludedFromFingerprint,
  fingerprintEntries,
  reviewPathspecs,
  withinReviewSurface,
} from "../review-surface.mjs";
import {
  UNREVIEWABLE_BINARY,
  UNREVIEWABLE_UNCLASSIFIED,
  UNREVIEWABLE_UNREADABLE,
  buildReviewChunks,
  isBinaryBlob,
  isBinaryDiff,
} from "./review-chunking.mjs";

const short = (sha) => String(sha).slice(0, 12);

/**
 * Delimiters around every piece of material.
 *
 * Fenced code blocks were sufficient while the material was only diffs. Full
 * file content is not: this repository's reviewed surfaces include Markdown, and
 * a document containing its own fence would end the block early and let the
 * remainder read as prompt rather than as data. These markers are also
 * forgeable, so the instruction block tells the reviewer that a marker appearing
 * inside file content is an attempted injection to be reported, not obeyed.
 */
export function materialBegin(kind, rel) {
  return `--- LIBERTY REVIEW MATERIAL BEGIN ${kind} ${rel} ---`;
}
export function materialEnd(kind, rel) {
  return `--- LIBERTY REVIEW MATERIAL END ${kind} ${rel} ---`;
}

/**
 * Parse NUL-separated path output.
 *
 * `-z` rather than line splitting, and no trimming, because without it git
 * QUOTES any path containing a non-ASCII or special character. A quoted path
 * matches nothing that `git ls-tree` reports, so such a file would silently be
 * treated as unchanged: still shown in full, since material comes from the tree,
 * but shown without the diff that explains what the range did to it. Paths may
 * also legitimately begin or end with a space, which trimming would corrupt.
 */
function splitPaths(out) {
  return String(out)
    .split("\0")
    .filter((entry) => entry !== "");
}

/**
 * One file's review material: what it currently IS, then what changed.
 *
 * Content first and diff second on purpose. The approval binds to the content,
 * so the content is the subject and the diff is commentary on it; leading with
 * the diff is what made it feel acceptable to omit everything that had none.
 */
function renderSection({ rel, role, changed, content, patch, base, commitSha }) {
  const lines = [
    `### ${rel}${role === "dependency" ? "  [REVIEW DEPENDENCY]" : ""}`,
    changed
      ? `Changed in ${short(base)}..${short(commitSha)}.`
      : `UNCHANGED in ${short(base)}..${short(commitSha)}. Your approval binds to these exact bytes anyway.`,
  ];

  if (content === null) {
    lines.push(
      `Not present at ${short(commitSha)}, so none of its bytes are bound by the approval; ` +
        "the change below is the whole of what there is to review.",
    );
  } else {
    lines.push(
      `Full content at ${short(commitSha)} (${Buffer.byteLength(content, "utf8")} bytes):`,
      materialBegin("CONTENT", rel),
      content,
      materialEnd("CONTENT", rel),
    );
  }

  if (patch) {
    lines.push(
      `Change over ${short(base)}..${short(commitSha)}:`,
      materialBegin("DIFF", rel),
      patch,
      materialEnd("DIFF", rel),
    );
  }

  lines.push("");
  return lines.join("\n") + "\n";
}

/**
 * Build everything the review prompt needs, for one task at one commit.
 *
 * @param {object} args
 * @param {object} args.task       the control-plane task record
 * @param {string} args.base       lower bound of the review range
 * @param {string} args.commitSha  the commit under review; material is read HERE
 * @param {number} args.maxBytes   per-part budget
 * @param {object} args.git        adapter from `gitReviewAdapter` below
 */
export function buildReviewContext({ task, base, commitSha, maxBytes, git }) {
  const pathspecs = reviewPathspecs(task);

  /*
   * The bound set: every blob whose object id goes into the approval hash. Read
   * through the SAME parser the control plane fingerprints with, so "what was
   * hashed" and "what was enumerated to be shown" cannot be two answers.
   */
  const fingerprinted = pathspecs.length
    ? fingerprintEntries(git.lsTree(commitSha, pathspecs)).map(([rel]) => rel)
    : [];
  const fingerprintedSet = new Set(fingerprinted);

  /*
   * The range's changed files decide which material carries a diff, and which
   * paths are reported as swept-in context. They no longer decide what is shown.
   * Generated bookkeeping is dropped here as well as from the fingerprint: it is
   * bound by neither and is not content anyone is being asked to judge.
   */
  const changed = splitPaths(git.changedFiles(base, commitSha)).filter(
    (rel) => !excludedFromFingerprint(rel),
  );
  const changedInScope = changed.filter((rel) => withinReviewSurface(rel, task));
  const outOfScope = changed.filter((rel) => !withinReviewSurface(rel, task));
  const changedSet = new Set(changedInScope);

  /*
   * Changed inside the surface, but carrying no blob at the reviewed commit --
   * normally a deletion, and equally a submodule entry, whose tree record is a
   * `commit` rather than a `blob` and whose content is in another repository.
   * Nothing of it is fingerprinted, so no byte of it can be approved unseen, but
   * a deletion under allowedPaths is still the implementation's work and has to
   * be reviewable. Its diff is the entirety of its material.
   */
  const withoutBlob = changedInScope.filter((rel) => !fingerprintedSet.has(rel));
  const withoutBlobSet = new Set(withoutBlob);

  const material = [...new Set([...fingerprinted, ...withoutBlob])].sort(
    compareSurfacePaths,
  );
  const roleOf = new Map(
    material.map((rel) => [rel, classifyReviewPath(rel, task)]),
  );

  /*
   * A path git matched inside the surface that the task's own patterns cannot
   * label. It should be unreachable -- both sides derive from
   * `reviewSurfacePatterns` -- but the two matchers are not the same code: git
   * applies pathspec semantics to the literal prefixes, `classifyReviewPath`
   * applies string prefix matching. Dropping such a file would restore, in
   * miniature, the exact bug this module closes, so it is carried through as a
   * deterministic refusal instead.
   */
  const unclassified = material.filter((rel) => roleOf.get(rel) === "outside");
  const implementation = material.filter(
    (rel) => roleOf.get(rel) === "implementation",
  );
  const dependencyContext = material.filter(
    (rel) => roleOf.get(rel) === "dependency",
  );

  // Implementation first so the reviewer reads the work before the vocabulary it
  // rests on, and so a task with no dependencies produces byte-identical parts.
  const reviewedFiles = [...implementation, ...dependencyContext, ...unclassified];

  const sectionFor = (rel) => {
    const role = roleOf.get(rel);
    if (role === "outside") {
      return {
        unreviewable: {
          reason: UNREVIEWABLE_UNCLASSIFIED,
          detail:
            `git matched it under ${task.id}'s reviewed surface, but none of that task's ` +
            "declared path patterns claim it",
        },
      };
    }

    const isChanged = changedSet.has(rel);
    let patch = "";
    if (isChanged) {
      patch = git.diff(base, commitSha, rel);
      if (isBinaryDiff(patch)) {
        return {
          unreviewable: {
            reason: UNREVIEWABLE_BINARY,
            detail: "git renders the change as a binary diff",
          },
        };
      }
    }

    if (withoutBlobSet.has(rel)) {
      return {
        text: renderSection({
          rel,
          role,
          changed: isChanged,
          content: null,
          patch,
          base,
          commitSha,
        }),
      };
    }

    const blob = git.blob(commitSha, rel);
    if (blob === null) {
      return {
        unreviewable: {
          reason: UNREVIEWABLE_UNREADABLE,
          detail: `git could not read it at ${short(commitSha)}`,
        },
      };
    }
    if (isBinaryBlob(blob)) {
      return {
        unreviewable: {
          reason: UNREVIEWABLE_BINARY,
          detail: "the blob contains NUL bytes",
        },
      };
    }

    /*
     * Shown bytes must BE the hashed bytes. Decoding a blob that is not valid
     * UTF-8 substitutes replacement characters, so the reviewer would read
     * something the approval does not bind to and confirm it in good faith.
     * Re-encoding and comparing is the only way to know that did not happen.
     */
    const content = blob.toString("utf8");
    if (!Buffer.from(content, "utf8").equals(blob)) {
      return {
        unreviewable: {
          reason: UNREVIEWABLE_UNREADABLE,
          detail:
            "the blob is not valid UTF-8, so it cannot be shown as the exact bytes the approval hashes",
        },
      };
    }

    return {
      text: renderSection({
        rel,
        role,
        changed: isChanged,
        content,
        patch,
        base,
        commitSha,
      }),
    };
  };

  const { chunks, unreviewable } = buildReviewChunks({
    inScope: reviewedFiles,
    maxBytes,
    sectionFor,
  });

  return {
    base,
    commitSha,
    pathspecs,
    fingerprinted,
    reviewedFiles,
    implementation,
    dependencyContext,
    unclassified,
    changedInScope,
    outOfScope,
    chunks,
    unreviewable,
  };
}

/**
 * Git adapter built on a caller-supplied exec function, mirroring
 * `gitAdapter` in ../review-range.mjs so the worker and the regressions drive
 * the identical commands.
 */
export function gitReviewAdapter(execFileSync, root) {
  const text = (args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });

  return {
    lsTree(commitish, pathspecs) {
      if (!pathspecs.length) return "";
      return text(["ls-tree", "-r", "-z", commitish, "--", ...pathspecs]);
    },
    changedFiles(base, commitish) {
      // -z: raw, NUL-separated, never quoted. See splitPaths above.
      return text(["diff", "--name-only", "-z", base, commitish]);
    },
    diff(base, commitish, rel) {
      return text(["diff", base, commitish, "--", rel]);
    },
    /**
     * Raw bytes, deliberately not decoded here. Binary detection and the UTF-8
     * fidelity check both need the buffer; handing back a string would have
     * already destroyed the evidence they test for.
     */
    blob(commitish, rel) {
      try {
        return execFileSync("git", ["cat-file", "blob", `${commitish}:${rel}`], {
          cwd: root,
          maxBuffer: 64 * 1024 * 1024,
          stdio: ["ignore", "pipe", "ignore"],
        });
      } catch {
        return null;
      }
    },
  };
}
