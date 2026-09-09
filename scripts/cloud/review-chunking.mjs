/**
 * Review packing, binary detection and decision aggregation.
 *
 * Extracted from the worker so the paths that prevent approving unseen code can
 * be executed in tests WITHOUT an OPENAI_API_KEY. These are the highest-risk
 * mechanisms in the reviewer, and they previously had zero execution evidence.
 *
 * Pure: the caller injects `sectionFor(file)`. No git, no network, no env.
 *
 * WHAT A SECTION IS
 *
 * `sectionFor(rel)` returns either `{ text }` -- everything about that file the
 * reviewer needs to see -- or `{ unreviewable: { reason, ... } }`. It used to be
 * `diffFor(rel)`, returning a patch, and that was the shape of a real defect:
 * the approval binds to a file's whole current blob, so a patch is only ever
 * part of what is being bound, and an unchanged blob produced no patch and
 * therefore no material at all. Deciding what one file's material IS belongs to
 * the builder in ./review-context.mjs; this module only packs it and refuses
 * what will not fit.
 */

/** Git renders binary changes as a notice, never as reviewable content. */
const BINARY_MARKERS = [/^Binary files .* differ$/m, /^GIT binary patch$/m];

export function isBinaryDiff(patch) {
  return BINARY_MARKERS.some((re) => re.test(patch));
}

/**
 * A NUL byte anywhere in the blob -- the same signal git uses to call a file
 * binary, applied to the whole buffer rather than to git's leading sample, which
 * can only classify more content as unreviewable and never less.
 *
 * Needed as well as `isBinaryDiff` and not instead of it. The two answer
 * different questions -- "did git decline to render this change" versus "is this
 * file content readable at all" -- and only the second one can be asked about a
 * file that did not change in the range but is still bound by the approval.
 * Decoding such a blob as text would put mojibake in front of the reviewer and
 * count it as seen.
 */
export function isBinaryBlob(content) {
  if (content == null) return false;
  const buffer = Buffer.isBuffer(content)
    ? content
    : Buffer.from(String(content), "utf8");
  return buffer.includes(0);
}

/** Why a file the approval binds to could not be put in front of the reviewer. */
export const UNREVIEWABLE_OVERSIZED = "oversized";
export const UNREVIEWABLE_BINARY = "binary";
export const UNREVIEWABLE_UNREADABLE = "unreadable";
export const UNREVIEWABLE_UNCLASSIFIED = "unclassified";

/**
 * The budget is stated in BYTES, so it is measured in bytes.
 *
 * `String.prototype.length` counts UTF-16 code units, which is the same number
 * only for ASCII. Every refusal message quotes this figure to the party under
 * review, so measuring anything else would make those messages false for any
 * file containing non-ASCII text.
 */
function sizeOf(text) {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Split review material into parts that each fit the byte budget.
 *
 * Never truncates and never drops. A file whose material does not fit is
 * recorded as unreviewable rather than silently cut or quietly skipped, because
 * both of those mean approving content the reviewer was never shown -- and the
 * quiet skip is the worse of the two, since the prompt still looks complete.
 *
 * Every input path leaves in exactly one of `chunks` or `unreviewable`; callers
 * rely on that partition to prove nothing went missing.
 */
export function buildReviewChunks({ inScope, maxBytes, sectionFor }) {
  const chunks = [];
  const unreviewable = [];
  let current = { files: [], body: "", bytes: 0 };

  for (const rel of inScope) {
    const section = sectionFor(rel);

    if (section.unreviewable) {
      unreviewable.push({ rel, ...section.unreviewable });
      continue;
    }
    const text = section.text;
    const bytes = sizeOf(text);
    if (bytes > maxBytes) {
      unreviewable.push({ rel, reason: UNREVIEWABLE_OVERSIZED, bytes });
      continue;
    }
    if (current.bytes + bytes > maxBytes && current.files.length) {
      chunks.push(current);
      current = { files: [], body: "", bytes: 0 };
    }
    current.files.push(rel);
    current.body += text;
    current.bytes += bytes;
  }
  if (current.files.length) chunks.push(current);

  return { chunks, unreviewable };
}

/** How each refusal reason reads to the party under review. */
function findingFor(item, maxBytes) {
  const where = item.detail ? ` (${item.detail})` : "";
  switch (item.reason) {
    case UNREVIEWABLE_OVERSIZED:
      return {
        finding:
          `review material is ${item.bytes} bytes, above the ${maxBytes}-byte review budget, ` +
          "so it cannot be shown in full",
        requestedChange:
          "split this change into smaller, individually reviewable commits",
      };
    case UNREVIEWABLE_BINARY:
      return {
        finding: `binary content${where}, so there is nothing readable to review`,
        requestedChange:
          "justify the binary artefact explicitly, or replace it with reviewable source",
      };
    case UNREVIEWABLE_UNREADABLE:
      return {
        finding:
          `content could not be read at the reviewed commit${where}, so it cannot be shown ` +
          "even though the approval would bind to it",
        requestedChange:
          "republish the review request against a commit whose content this checkout can read in full",
      };
    case UNREVIEWABLE_UNCLASSIFIED:
      return {
        finding:
          `the approval would bind to this file${where}, but it cannot be labelled as ` +
          "implementation or as review dependency, so it cannot be put in front of the reviewer " +
          "with an honest account of whose work it is",
        requestedChange:
          "declare the path this file is under in allowedPaths or reviewDependencies",
      };
    default:
      return {
        finding: `cannot be shown to the reviewer: ${item.reason}${where}`,
        requestedChange:
          "make this file reviewable, or remove it from the reviewed surface",
      };
  }
}

/**
 * A deterministic changes_requested for content that cannot be shown in full.
 * Returned WITHOUT calling the model: there is nothing a model could add, and
 * asking it would risk an approval of unseen code.
 */
export function unreviewableDecision({ unreviewable, maxBytes }) {
  if (!unreviewable?.length) {
    // Every finding here is derived from the list, so an empty list would
    // produce a changes_requested with nothing to act on -- which
    // `assertPartCoherent` calls incoherent for good reason. Refuse at the
    // source rather than emit a verdict nobody can satisfy.
    throw new Error(
      "unreviewableDecision called with nothing unreviewable; that is not a refusal, it is a bug",
    );
  }

  const blockingFindings = unreviewable.map((item) => ({
    severity: "high",
    file: item.rel,
    ...findingFor(item, maxBytes),
  }));

  return {
    decision: "changes_requested",
    summary:
      `Cannot review this range: ${blockingFindings.length} file(s) in the reviewed surface ` +
      "cannot be shown in full (oversized, binary, unreadable or unclassifiable). " +
      "Approving would mean approving unseen content.",
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
