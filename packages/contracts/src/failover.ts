import { z } from "zod";

/* -------------------------------------------------------------------------
 * Playback failover (PL-0204)
 * ---------------------------------------------------------------------- */

/**
 * WHY a failure is a closed vocabulary and not an error object.
 *
 * The one thing a failover policy must never do is retry a candidate whose
 * RIGHTS could not be established. If the policy decided retryability by
 * inspecting an error message -- matching "timeout", "403", "not entitled" --
 * then the rights boundary would be enforced by a regular expression over
 * provider-authored, provider-versioned, locale-dependent free text. A provider
 * rewording "entitlement expired" to "access denied" would silently reclassify a
 * rights failure as something retryable, and nothing in the type system, the
 * tests or the reason trail would notice. Classification is therefore data the
 * reporter must assert, and the media engine reads nothing else.
 *
 * The four kinds are the four DIFFERENT REMEDIES, not four flavours of "it
 * broke":
 *
 *   - `rights_unverifiable` -- authorization could not be established or
 *     refreshed for this candidate. Never retryable, at any budget: retrying is
 *     not robustness, it is a second attempt to play something we are not
 *     entitled to play, and product invariants 1 and 2 forbid it. Kept as its
 *     own kind rather than folded into a generic "provider refused" precisely so
 *     that the retry branch is unreachable with it.
 *   - `decode_failed` -- the device could not decode what arrived. This is
 *     INFORMATION, not noise: it settles a compatibility question the ranking
 *     could only leave open, and it settles it negatively. Retrying re-runs a
 *     decode that has already been shown to fail.
 *   - `source_unavailable` -- the stream is gone (missing manifest, removed
 *     asset, permanently dead segment). Nothing about the device or our rights
 *     is disproven; the candidate simply is not there. Separate from
 *     `decode_failed` because the remedy is the provider's, not the player's.
 *   - `network_transient` -- a timeout, reset, or upstream 5xx. The only kind
 *     for which the same candidate is worth attempting again, and the reason
 *     failover exists at all.
 *
 * A reporter that genuinely cannot tell which of these it saw must report
 * nothing rather than guess: an invented `network_transient` buys retries for a
 * failure that will never succeed, and an invented `decode_failed` permanently
 * discards a stream that was only briefly unreachable.
 */
export const playbackFailureKindSchema = z.enum([
  "rights_unverifiable",
  "decode_failed",
  "source_unavailable",
  "network_transient"
]);
export type PlaybackFailureKind = z.infer<typeof playbackFailureKindSchema>;

/**
 * Every kind the contract can report. A MEMBERSHIP list, and nothing more.
 *
 * ITS ORDER CARRIES NO MEANING. Consumers must iterate it only to enumerate the
 * kinds, never to rank them: a candidate that accumulated several failures is
 * resolved against `PLAYBACK_FAILURE_POLICY` in `@liberty/media-engine`, which
 * states a `precedence` per kind as data. That separation is the point --
 * membership is a schema fact and belongs here, precedence is a product decision
 * about which failure may speak for a candidate and belongs where it can be read
 * as a decision. Rearranging the enum above for readability is therefore a
 * no-op, which is the property that was missing when this array's order WAS the
 * rule.
 *
 * DERIVED from the schema rather than restated, and that is a rights guard
 * rather than tidiness. The media engine builds its precedence-sorted scan from
 * THIS array, never from the schema, so a kind the schema can report but this
 * array omits would never be consulted: a candidate carrying only that kind
 * returns "still attemptable" and is retried until the attempt budget runs out.
 * For a rights kind that is precisely the outcome invariants 1 and 2 forbid. A
 * hand-written literal cannot fail loudly here either, because `readonly
 * PlaybackFailureKind[]` accepts a SHORT array without complaint and rejects
 * only a FOREIGN member -- so drift in the direction that matters was caught by
 * one runtime assertion in a test and by nothing else. Reading `.options` makes
 * the compiler the guard instead, and the engine's policy table is declared
 * `satisfies Record<PlaybackFailureKind, ...>` so a new kind cannot exist
 * without a precedence and a retryability either.
 *
 * Copied rather than aliased: `.options` hands back the schema's own values
 * array, and a consumer casting away `readonly` would then be mutating what
 * `.parse()` validates against.
 */
export const PLAYBACK_FAILURE_KINDS: readonly PlaybackFailureKind[] = [
  ...playbackFailureKindSchema.options
];

/**
 * One attempt that did not result in playback.
 *
 * Deliberately carries no timestamp, no attempt index and no error payload.
 * The policy is a pure function of the MULTISET of failures: it counts kinds per
 * candidate and never reads the array's order, so a plan is reproducible from a
 * bug report by pasting the list back in any order. A clock in this record would
 * invite a comparator that reads it, and playback policy that depends on a clock
 * cannot be regression-tested at all.
 *
 * There is no `succeeded` variant. A successful attempt ends failover, so
 * representing one here would create a state -- "what do we fail over to after
 * something worked" -- that has no correct answer and would inevitably be given
 * a wrong one.
 */
export const playbackAttemptFailureSchema = z.object({
  candidateId: z.string().min(1),
  kind: playbackFailureKindSchema
});
export type PlaybackAttemptFailure = z.infer<typeof playbackAttemptFailureSchema>;

/**
 * The two bounds, both required and neither derivable from the other.
 *
 * `maxAttempts` caps the WHOLE resolution. Without it a large candidate list is
 * a long stall: every attempt costs the viewer wall-clock time before anything
 * appears, and a policy that walks fifty candidates has converted "no playback"
 * into "no playback, eventually, after a minute of spinning". Bounding by
 * candidate count would make the bound emergent -- it would change whenever a
 * provider returned more mirrors -- so the ceiling is stated instead.
 *
 * `maxTransientRetriesPerCandidate` caps how often the SAME candidate may be
 * re-attempted after a transient failure. Without it the total budget could be
 * spent entirely on the top-ranked stream while three working alternatives were
 * never tried, which is the failure mode failover exists to prevent.
 *
 * Both are inputs rather than constants so a living-room client on a flaky link
 * and a server-side probe can differ without either forking the policy.
 */
export const failoverPolicySchema = z.object({
  maxAttempts: z.number().int().positive(),
  maxTransientRetriesPerCandidate: z.number().int().nonnegative()
});
export type FailoverPolicy = z.infer<typeof failoverPolicySchema>;
