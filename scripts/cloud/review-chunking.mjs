/**
 * Review chunking, binary detection and decision aggregation.
 *
 * Extracted from the worker so the paths that prevent approving unseen code can
 * be executed in tests WITHOUT an OPENAI_API_KEY. These are the highest-risk
 * mechanisms in the reviewer, and they previously had zero execution evidence.
 *
 * Pure: the caller injects `diffFor(file)`. No git, no network, no env.
 */

/** Git renders binary changes as a notice, never as reviewable content. */
const BINARY_MARKERS = [/^Binary files .* differ$/m, /^GIT binary patch$/m];

export function isBinaryDiff(patch) {
  return BINARY_MARKERS.some((re) => re.test(patch));
}

/**
 * Split in-scope files into chunks that each fit the byte budget.
 *
 * Never truncates. A file that cannot be shown in full is recorded as
 * unreviewable rather than silently cut, because approving a truncated diff
 * means approving code the reviewer was never shown.
 */
export function buildReviewChunks({ inScope, maxBytes, diffFor }) {
  const chunks = [];
  const oversizedFiles = [];
  const binaryFiles = [];
  let current = { files: [], patch: "" };

  for (const rel of inScope) {
    const patch = diffFor(rel);

    if (isBinaryDiff(patch)) {
      // "Binary files differ" is a notice ABOUT a change, not the change. It
      // must never be treated as though the contents had been reviewed.
      binaryFiles.push(rel);
      continue;
    }
    if (patch.length > maxBytes) {
      oversizedFiles.push({ rel, bytes: patch.length });
      continue;
    }
    if (current.patch.length + patch.length > maxBytes && current.files.length) {
      chunks.push(current);
      current = { files: [], patch: "" };
    }
    current.files.push(rel);
    current.patch += patch;
  }
  if (current.files.length) chunks.push(current);

  return { chunks, oversizedFiles, binaryFiles };
}

/**
 * A deterministic changes_requested for content that cannot be shown in full.
 * Returned WITHOUT calling the model: there is nothing a model could add, and
 * asking it would risk an approval of unseen code.
 */
export function unreviewableDecision({ oversizedFiles, binaryFiles, maxBytes }) {
  const blockingFindings = [
    ...oversizedFiles.map((f) => ({
      severity: "high",
      file: f.rel,
      finding: `diff is ${f.bytes} bytes, above the ${maxBytes}-byte review budget, so it cannot be shown in full`,
      requestedChange: "split this change into smaller, individually reviewable commits",
    })),
    ...binaryFiles.map((rel) => ({
      severity: "high",
      file: rel,
      finding: "binary change; git reports only that the files differ, so the content cannot be reviewed",
      requestedChange:
        "justify the binary artefact explicitly, or replace it with reviewable source",
    })),
  ];

  return {
    decision: "changes_requested",
    summary:
      `Cannot review this range: ${blockingFindings.length} file(s) cannot be shown in full ` +
      "(oversized or binary). Approving would mean approving unseen content.",
    reviewedScopeConfirmed: false,
    blockingFindings,
    nonBlockingFindings: [],
  };
}

/** Structural validation of one model-returned part. Throws on incoherence. */
export function assertPartCoherent(part, index, total) {
  const where = total > 1 ? `part ${index + 1}/${total}` : "review";
  if (part.decision === "review_approved" && part.blockingFindings.length > 0) {
    throw new Error(`${where} returned review_approved with blocking findings; refusing an inconsistent verdict`);
  }
  if (part.decision === "changes_requested" && part.blockingFindings.length === 0) {
    throw new Error(`${where} returned changes_requested with no blocking findings; refusing an unactionable verdict`);
  }
  // An approval only means something if the reviewer confirms it saw the
  // material. Without this the schema field is decorative.
  if (part.decision === "review_approved" && part.reviewedScopeConfirmed !== true) {
    throw new Error(
      `${where} returned review_approved without reviewedScopeConfirmed; ` +
      "refusing an approval the reviewer will not confirm it fully reviewed",
    );
  }
  return part;
}

/**
 * Combine part decisions. The range is approved only if EVERY part approved and
 * every part confirmed full scope.
 */
export function aggregateDecision(parts, { inScopeCount }) {
  if (!parts.length) throw new Error("no review parts to aggregate");

  const blockingFindings = parts.flatMap((p) => p.blockingFindings);
  const scopeConfirmed = parts.every((p) => p.reviewedScopeConfirmed === true);
  const total = parts.length;

  const decision = {
    decision: blockingFindings.length ? "changes_requested" : "review_approved",
    summary:
      total > 1
        ? `Reviewed in ${total} parts covering all ${inScopeCount} in-scope files. ` +
          parts.map((p, i) => `[${i + 1}] ${p.summary}`).join(" ")
        : parts[0].summary,
    reviewedScopeConfirmed: scopeConfirmed,
    blockingFindings,
    nonBlockingFindings: parts.flatMap((p) => p.nonBlockingFindings),
  };

  if (decision.decision === "review_approved" && decision.reviewedScopeConfirmed !== true) {
    throw new Error("aggregate approval lacks full scope confirmation; refusing to approve unseen code");
  }
  return decision;
}
