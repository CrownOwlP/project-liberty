import type {
  CompatibilityConfidence,
  FailoverPolicy,
  PlaybackAttemptFailure,
  PlaybackCapabilities,
  PlaybackFailureKind,
  StreamCandidate
} from "@liberty/contracts";
import { PLAYBACK_FAILURE_KINDS } from "@liberty/contracts";
import { type PlaybackDecision, type RankedCandidate, rankStreamCandidates } from "./ranking";

/**
 * Candidate failover (PL-0204).
 *
 * Ranking answers "which stream should we try first". This answers "what do we
 * do when that did not work", and it is the point at which the three-way
 * distinction PL-0205 established stops being bookkeeping and starts deciding
 * things: authorized != known-compatible != attemptable.
 *
 * An `unverified` candidate is one nothing disqualified rather than one
 * something qualified. Nowhere in ranking can that be resolved, because the
 * facts that would resolve it were never stated. An ATTEMPT resolves it. So this
 * policy is where an unproven candidate becomes proven or is discarded, and the
 * trail must say which -- "we suspected this might not decode" and "this does
 * not decode" are different findings and only the second one is knowledge.
 *
 * PURE AND DETERMINISTIC, on the same terms as the rest of the package: no
 * clocks, no randomness, no I/O, no ambient state, and no dependence on the
 * order of either input array. The engine plans the next attempt; the caller
 * performs it and reports the outcome back as data. Making the caller drive the
 * loop is what keeps the policy testable -- a version that took a "try this"
 * callback would be untestable without stubbing the network, and
 * `@liberty/media-engine` is forbidden from fetching anything itself.
 */

/**
 * Why a candidate may no longer be attempted.
 *
 * Every value is a claim about the CANDIDATE, established by an attempt, and
 * distinct from `RejectionReason` in ranking.ts, which is a claim established
 * before any attempt was made. Keeping the two vocabularies separate is
 * deliberate: `unsupported_video_codec` means we knew in advance, and
 * `compatibility_disproven` means we found out, and a support engineer reading
 * "this candidate was incompatible" needs to know which of those happened before
 * deciding whether the bug is in the provider's metadata or in our capability
 * model.
 */
export type FailoverExclusionReason =
  /**
   * Rights could not be established at attempt time. Terminal, always. Not a
   * transient failure, not a retry budget that happened to reach zero -- a
   * candidate we are not entitled to play is not a candidate.
   */
  | "rights_not_established"
  /**
   * The device did not decode this stream. Compatibility is now settled
   * NEGATIVELY, so a retry would re-run a decode already shown to fail.
   */
  | "compatibility_disproven"
  /** The stream is not there. Nothing about our rights or the device is implied. */
  | "source_unavailable"
  /** Transient failures used up this candidate's per-candidate retry budget. */
  | "transient_retries_exhausted";

/**
 * A candidate ruled out of the pool, and what it cost to find out.
 *
 * `priorCompatibility` is what the RANKING claimed before the attempt, carried
 * here because paired with `compatibility_disproven` it separates two findings
 * that look identical in a log otherwise:
 *
 *   - `unverified` + disproven: the expected way an unverified candidate
 *     resolves. The provider stated no codec, we attempted anyway, it did not
 *     play. Nothing is broken; a fact was learned, and the fix is provider
 *     metadata.
 *   - `verified` + disproven: our capability model said this WOULD decode and it
 *     did not. That is a defect in the model, the device profile, or the
 *     provider's stated codec, and it is worth an alert. Collapsed into a single
 *     "decode failed" line, this signal is invisible.
 */
export interface ExcludedCandidate {
  candidateId: string;
  reason: FailoverExclusionReason;
  /** Attempts this candidate consumed before being ruled out. */
  attempts: number;
  compatibilityBeforeAttempt: CompatibilityConfidence;
}

/** Why the plan is handing back a candidate to try. */
export type FailoverProceedReason =
  | "first_attempt"
  | "retry_after_transient_failure"
  | "failover_to_next_candidate";

/**
 * Why the plan is handing back nothing.
 *
 * Six values, and the separation between them is the requirement rather than a
 * nicety (product invariant 4). "We ran out of candidates", "we ran out of
 * budget", "everything was rights-blocked" and "everything we tried failed to
 * decode" send whoever reads them to four different systems -- the provider, the
 * policy, the licensing pipeline, and the device capability model -- and a
 * single `failover_failed` sends them nowhere.
 *
 * SCOPE differs between the two homogeneous reasons, and the difference is
 * principled rather than sloppy:
 *
 *   - rights blocking is judged over EVERY supplied candidate, because it can be
 *     established at two separate stages (ranking refuses an unplayable rights
 *     value; an attempt fails to establish authorization) and any narrower scope
 *     would report "all rights-blocked" while some candidate had been discarded
 *     for a different reason entirely.
 *   - incompatibility is judged over the ELIGIBLE pool only, because a decode
 *     failure can only be observed on something that was actually attempted.
 *     Candidates ranking never admitted were never in the decode question.
 *
 * Either claim is refused unless it is true of its whole scope. A homogeneous
 * reason asserts something about a SET; when the set is mixed the honest answer
 * is `candidates_exhausted` plus the itemised `excluded` trail, not the nearest
 * plausible headline.
 */
export type FailoverStopReason =
  /** Nothing was supplied. There was never anything to fail over between. */
  | "no_candidates"
  /** Candidates existed; none passed eligibility, so none was ever attemptable. */
  | "no_eligible_candidates"
  /** Every supplied candidate was refused or failed on RIGHTS. None may be retried. */
  | "all_candidates_rights_blocked"
  /** Every candidate that was ever attemptable has now failed to decode. */
  | "all_eligible_candidates_incompatible"
  /** The pool is empty for mixed reasons; `excluded` itemises them. */
  | "candidates_exhausted"
  /** The budget ran out while attemptable candidates REMAINED. Not exhaustion. */
  | "attempt_limit_reached";

export type FailoverReason = FailoverProceedReason | FailoverStopReason;

export interface FailoverPlan {
  /** The candidate to attempt next, or null when the plan is terminal. */
  next: RankedCandidate | null;
  reason: FailoverReason;
  /**
   * Every reported failure, including ones that could not be attributed. A
   * failure we cannot place still cost the viewer an attempt, and excluding it
   * from the count would let a mis-reporting caller loop forever against a bound
   * that never advances.
   */
  attemptsUsed: number;
  attemptsRemaining: number;
  /**
   * Ids still worth attempting, in RANK order -- here the order IS the meaning,
   * and it is the ranking's own already-deterministic order rather than a second
   * one derived here. Re-sorting would create a second opinion about preference
   * that could disagree with `PlaybackDecision.ranked`.
   */
  attemptable: readonly string[];
  /** Ruled-out candidates, id-sorted by code point. */
  excluded: readonly ExcludedCandidate[];
  /**
   * Ids reported as failed that are not in the eligible pool, deduped and
   * id-sorted. Either no such candidate was supplied, or eligibility rejected it
   * and it should never have been attempted -- `decision.rejected` says which,
   * so the distinction is recoverable rather than lost. Surfaced instead of
   * silently dropped because a caller reporting the wrong id would otherwise see
   * its failures have no effect at all.
   */
  unattributedFailures: readonly string[];
  /**
   * The same ids, WITH the kinds that were reported against them.
   *
   * `unattributedFailures` reduces each of these to a bare string, which throws
   * away the one fact that decides how urgently anybody should look: "the caller
   * attempted a stream whose rights we could not establish" and "the caller
   * mistyped an id while reporting a timeout" arrive as the identical entry.
   * That is an observability hole (invariant 4) on exactly the invariant this
   * module exists to protect -- and it is a reachable state rather than a
   * hypothetical, because ranking rejecting a candidate for
   * `rights_not_playable` and the caller attempting it anyway lands here.
   *
   * Kinds are a SET, not a tally: they are produced by filtering
   * `PLAYBACK_FAILURE_KINDS_BY_PRECEDENCE`, so each appears at most once and the
   * order is the stated precedence order -- the same one `exclusionFor` resolves
   * with, so there is exactly one answer in this module to "what order do
   * failure kinds come in" -- rather than the caller's reporting order.
   * Multiplicity would buy nothing that `attemptsUsed` does not already charge
   * for, and would reintroduce the dependence on report sequence that the rest
   * of this module is built to exclude.
   */
  unattributedDetail: readonly { candidateId: string; kinds: readonly PlaybackFailureKind[] }[];
  /** The ranking this plan sits on, so one object carries the whole trail. */
  decision: PlaybackDecision;
  explanation: string;
}

/**
 * The whole per-kind policy, as an exhaustive table rather than a condition:
 * what a kind means for retrying, what it becomes when it is terminal, and how
 * loudly it speaks when a candidate collected several kinds.
 *
 * Named `PLAYBACK_FAILURE_POLICY` rather than the bare `FAILURE_POLICY` only to
 * keep it distinguishable from `FailoverPolicy` and `DEFAULT_FAILOVER_POLICY` in
 * this same module, which are the attempt BUDGET and answer a different question
 * entirely.
 *
 * `satisfies Record<PlaybackFailureKind, ...>` rather than a type annotation.
 * Either form makes adding a kind to the contract without deciding its policy a
 * TYPE ERROR, rather than a value that quietly falls into whichever branch an
 * `if` happened to leave last -- that is the property actually wanted here, and
 * it is why the shape is stated as a total record at all. What `satisfies` adds
 * is that the object also keeps its OWN types: `exclusion` stays the specific
 * literal each kind was given instead of widening to all four, so a lookup
 * cannot silently return an exclusion reason this table never assigned.
 *
 * `precedence` is the field that used to be missing, and its absence was a
 * defect rather than a simplification. A candidate can accumulate more than one
 * kind across its attempts -- a timeout, then a decode error -- and exactly one
 * of them has to speak for it in the trail. That used to be decided by scanning
 * `PLAYBACK_FAILURE_KINDS` and taking the first hit, which made the ZOD ENUM'S
 * DECLARATION ORDER the rule: a contributor alphabetising that enum would have
 * moved `decode_failed` ahead of `rights_unverifiable` and let a decode failure
 * report for a candidate whose rights could not be established, with no test
 * naming the change. Precedence is a product decision, so it is stated as one.
 * LOWER IS MORE FUNDAMENTAL, and `rights_unverifiable` is 0 under every budget,
 * ordering and combination because invariants 1 and 2 depend on it. Values are
 * spaced by 1 and asserted UNIQUE in a test: two kinds sharing a number would
 * put the tie back in the hands of iteration order, which is the entire defect.
 *
 * `exclusion` for a retryable kind is what that kind becomes once its budget is
 * spent, so the same table answers both questions and they cannot drift apart.
 *
 * Exactly one kind is retryable, and that is a product decision, not an
 * oversight: rights failures must never be retried (invariants 1 and 2), a
 * decode failure has already answered its own question, and a removed asset does
 * not come back within a playback session. A test asserts the count, so widening
 * it is a deliberate edit to an assertion rather than a one-word change here.
 */
export const PLAYBACK_FAILURE_POLICY = {
  rights_unverifiable: { retryable: false, precedence: 0, exclusion: "rights_not_established" },
  decode_failed: { retryable: false, precedence: 1, exclusion: "compatibility_disproven" },
  source_unavailable: { retryable: false, precedence: 2, exclusion: "source_unavailable" },
  network_transient: { retryable: true, precedence: 3, exclusion: "transient_retries_exhausted" }
} satisfies Record<
  PlaybackFailureKind,
  { retryable: boolean; precedence: number; exclusion: FailoverExclusionReason }
>;

/**
 * The one canonical order for failure kinds, and the only one anything reads.
 *
 * MEMBERSHIP from the contract, ORDER from the policy above -- the two facts
 * that used to be conflated into a single array literal. Every kind the schema
 * can report appears exactly once (a kind absent here is never tested by
 * `exclusionFor`, so a candidate carrying only that kind would stay attemptable
 * and be retried, which for a rights kind is what invariants 1 and 2 forbid),
 * and its position is the `precedence` somebody wrote down rather than where it
 * happened to land in a Zod enum.
 *
 * Computed once instead of sorted per call, and the comparator is total because
 * precedences are unique, so `Array.prototype.sort`'s stability is not being
 * relied on to make the result deterministic.
 */
export const PLAYBACK_FAILURE_KINDS_BY_PRECEDENCE: readonly PlaybackFailureKind[] = [
  ...PLAYBACK_FAILURE_KINDS
].sort((a, b) => PLAYBACK_FAILURE_POLICY[a].precedence - PLAYBACK_FAILURE_POLICY[b].precedence);

/**
 * The default bound, stated rather than emergent.
 *
 * Four attempts covers the top candidate, one retry of it, and two fallbacks --
 * or four distinct streams when nothing is worth retrying. Beyond that the
 * ranking's own model says the remaining candidates are materially worse, and
 * the viewer has been staring at a spinner for four round trips. One retry per
 * candidate because a second consecutive timeout on the same host is evidence
 * about the host, not about the network.
 */
export const DEFAULT_FAILOVER_POLICY: FailoverPolicy = {
  maxAttempts: 4,
  maxTransientRetriesPerCandidate: 1
};

const REASON_TEXT: Record<FailoverReason, string> = {
  first_attempt: "nothing has been attempted yet; starting at the top of the ranking",
  retry_after_transient_failure:
    "the previous failure was transient, so the same candidate is retried before it is demoted",
  failover_to_next_candidate:
    "the previous candidate was ruled out; falling back to the next-ranked one",
  no_candidates: "no candidates were supplied, so there was never anything to fail over between",
  no_eligible_candidates:
    "candidates were supplied but none passed eligibility, so none was ever attemptable",
  all_candidates_rights_blocked:
    "every candidate was refused or failed on rights; none of them may be retried",
  all_eligible_candidates_incompatible:
    "every candidate that was ever attemptable failed to decode; compatibility is disproven, not merely unverified",
  candidates_exhausted: "every attemptable candidate has been ruled out, for mixed reasons",
  attempt_limit_reached:
    "the attempt budget was spent while attemptable candidates still remained"
};

/** Code-point comparison. Never `localeCompare`: see the note in ranking.ts. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function countOf(kinds: readonly PlaybackFailureKind[], kind: PlaybackFailureKind): number {
  return kinds.reduce((total, recorded) => (recorded === kind ? total + 1 : total), 0);
}

/**
 * The reason this candidate is out, or null while it is still worth attempting.
 *
 * Walks the kinds in PRECEDENCE order rather than in the reported order, so a
 * candidate that failed on rights AND on decode reports rights -- whichever
 * order the caller listed them in. Reading the caller's order here would make
 * the published reason depend on reporting sequence, which is the
 * order-dependence class of defect this package has already had to remove three
 * times.
 *
 * That order is `PLAYBACK_FAILURE_KINDS_BY_PRECEDENCE`, whose positions come
 * from the `precedence` numbers in `PLAYBACK_FAILURE_POLICY` and NOT from the
 * order of the contract's enum. The distinction matters: the enum is a
 * vocabulary somebody may reasonably resort, and it must not be able to change
 * which failure speaks for a candidate. What the contract still supplies is
 * membership -- a kind it can report but the scan omits would never be tested
 * here, so a candidate carrying only that kind would stay attemptable and be
 * retried, which invariants 1 and 2 forbid for a rights kind.
 *
 * A retryable kind under budget does not return: it falls through to the next
 * kind, so a candidate with one timeout and one decode failure is excluded by
 * the decode failure rather than kept alive by the unspent timeout budget.
 */
function exclusionFor(
  kinds: readonly PlaybackFailureKind[],
  policy: FailoverPolicy
): FailoverExclusionReason | null {
  for (const kind of PLAYBACK_FAILURE_KINDS_BY_PRECEDENCE) {
    if (!kinds.includes(kind)) continue;
    const disposition = PLAYBACK_FAILURE_POLICY[kind];
    if (!disposition.retryable) return disposition.exclusion;
    if (countOf(kinds, kind) > policy.maxTransientRetriesPerCandidate) return disposition.exclusion;
  }
  return null;
}

/**
 * Which flavour of "nothing left" this is.
 *
 * Ordered most specific first, and every homogeneous claim is checked against
 * its whole scope before it is made. `no_candidates` is tested first because
 * with an empty input every "all candidates were X" claim is vacuously true, and
 * a vacuous claim about rights is exactly the kind of confident nonsense a
 * reason trail must not print.
 */
function exhaustionReason(
  candidateIds: ReadonlySet<string>,
  decision: PlaybackDecision,
  excluded: readonly ExcludedCandidate[]
): FailoverStopReason {
  if (candidateIds.size === 0) return "no_candidates";

  const rightsBlocked = new Set<string>();
  for (const entry of decision.rejected) {
    if (entry.reason === "rights_not_playable") rightsBlocked.add(entry.candidateId);
  }
  for (const entry of excluded) {
    if (entry.reason === "rights_not_established") rightsBlocked.add(entry.candidateId);
  }
  if (rightsBlocked.size === candidateIds.size) return "all_candidates_rights_blocked";

  if (decision.ranked.length === 0) return "no_eligible_candidates";

  // `every` is vacuously true on an empty list, and "all of them failed to
  // decode" about nothing at all is a fabricated finding.
  if (excluded.length > 0 && excluded.every((entry) => entry.reason === "compatibility_disproven")) {
    return "all_eligible_candidates_incompatible";
  }

  return "candidates_exhausted";
}

/**
 * The next attempt, or a terminal reason.
 *
 * Takes raw candidates and ranks them internally rather than accepting a
 * `PlaybackDecision`, so there is exactly one ranking in play and a failover
 * plan can never be built on a decision that came from different capabilities
 * than the one it reports. It also makes the whole result order-invariant in
 * both inputs, which is the property the regression test pins.
 *
 * Nothing here reads or re-derives technical metadata. A decode failure does not
 * write back a codec, an attempt does not infer a height, and an excluded
 * candidate keeps whatever the provider stated -- including nothing. Unknown
 * stays unknown; the attempt establishes decodability, and decodability only.
 *
 * Total for every input, including a zero or negative `maxAttempts` (terminal
 * immediately) and failures naming candidates that do not exist (counted,
 * surfaced, attributed to nothing).
 */
export function planFailover(
  candidates: readonly StreamCandidate[],
  capabilities: PlaybackCapabilities,
  failures: readonly PlaybackAttemptFailure[] = [],
  policy: FailoverPolicy = DEFAULT_FAILOVER_POLICY
): FailoverPlan {
  const decision = rankStreamCandidates([...candidates], capabilities);

  /*
   * Grouped, then only ever COUNTED or membership-tested. The per-candidate
   * array's own order is never read, which is what makes the plan a function of
   * the multiset of failures rather than of the sequence the caller recorded
   * them in.
   */
  const kindsById = new Map<string, PlaybackFailureKind[]>();
  for (const failure of failures) {
    const recorded = kindsById.get(failure.candidateId);
    if (recorded) recorded.push(failure.kind);
    else kindsById.set(failure.candidateId, [failure.kind]);
  }

  const attemptable: RankedCandidate[] = [];
  const excluded: ExcludedCandidate[] = [];

  for (const entry of decision.ranked) {
    const kinds = kindsById.get(entry.candidate.id) ?? [];
    const exclusion = exclusionFor(kinds, policy);
    if (exclusion === null) {
      attemptable.push(entry);
      continue;
    }
    excluded.push({
      candidateId: entry.candidate.id,
      reason: exclusion,
      attempts: kinds.length,
      compatibilityBeforeAttempt: entry.compatibility
    });
  }

  // Id-sorted, like `PlaybackDecision.rejected`. `excluded` is a set of findings,
  // not a preference order, so publishing it in rank order would tie a list with
  // no ordering semantics to one that has them.
  excluded.sort((a, b) => byCodePoint(a.candidateId, b.candidateId));

  const pooled = new Set(decision.ranked.map((entry) => entry.candidate.id));
  const unattributedFailures = [
    ...new Set(
      failures
        .filter((failure) => !pooled.has(failure.candidateId))
        .map((failure) => failure.candidateId)
    )
  ].sort(byCodePoint);

  // Built from the already-sorted id list and by filtering the canonical
  // precedence order, so neither coordinate of this list can inherit the
  // caller's ordering -- nor the enum's.
  const unattributedDetail = unattributedFailures.map((candidateId) => ({
    candidateId,
    kinds: PLAYBACK_FAILURE_KINDS_BY_PRECEDENCE.filter((kind) =>
      failures.some((failure) => failure.candidateId === candidateId && failure.kind === kind)
    )
  }));

  const attemptsUsed = failures.length;
  const attemptsRemaining = Math.max(policy.maxAttempts - attemptsUsed, 0);

  const head = attemptable[0] ?? null;
  let next: RankedCandidate | null = null;
  let reason: FailoverReason;

  if (head === null) {
    /*
     * Exhaustion outranks the budget. When nothing is attemptable the budget is
     * irrelevant, and reporting `attempt_limit_reached` there would tell an
     * operator to raise a limit that would change nothing -- the two states are
     * mutually exclusive by construction, and this is which way round they go.
     */
    reason = exhaustionReason(new Set(candidates.map((c) => c.id)), decision, excluded);
  } else if (attemptsUsed >= policy.maxAttempts) {
    reason = "attempt_limit_reached";
  } else {
    next = head;
    /*
     * Derived from what actually happened to THIS candidate. Any failure it
     * carries while still attemptable can only be a transient one -- every other
     * kind is terminal on the first occurrence -- so a non-empty history here is
     * exactly a retry.
     */
    const priorKinds = kindsById.get(head.candidate.id) ?? [];
    reason = priorKinds.length > 0
      ? "retry_after_transient_failure"
      : attemptsUsed === 0
        ? "first_attempt"
        : "failover_to_next_candidate";
  }

  const trail = [
    next === null ? REASON_TEXT[reason] : `${next.candidate.id}: ${REASON_TEXT[reason]}`,
    `${attemptsUsed}/${policy.maxAttempts} attempts used`,
    excluded.length > 0
      ? `ruled out: ${excluded.map((entry) => `${entry.candidateId}=${entry.reason}`).join(", ")}`
      : "nothing ruled out",
    // Rendered from the detail rather than from the bare ids: a rights failure
    // reported against an id nobody ranked is the single most alarming thing
    // this plan can carry, and a trail that prints it as `ghost` alone reads
    // like a caller typo.
    unattributedDetail.length > 0
      ? `unattributed failures: ${unattributedDetail
          .map((entry) => `${entry.candidateId}=${entry.kinds.join("/")}`)
          .join(", ")}`
      : null
  ];

  return {
    next,
    reason,
    attemptsUsed,
    attemptsRemaining,
    attemptable: attemptable.map((entry) => entry.candidate.id),
    excluded,
    unattributedFailures,
    unattributedDetail,
    decision,
    explanation: trail.filter((part): part is string => part !== null).join(" | ")
  };
}
