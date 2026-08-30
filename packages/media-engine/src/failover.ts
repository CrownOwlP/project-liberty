import type {
  FailoverPolicy,
  PlaybackAttemptFailure,
  PlaybackFailureKind
} from "@liberty/contracts/domains/failover";
import type {
  CompatibilityConfidence,
  PlaybackCapabilities,
  StreamCandidate
} from "@liberty/contracts/domains/playback";
import { type PlaybackDecision, type RankedCandidate, rankStreamCandidates } from "./ranking";
import {
  DEFAULT_FAILOVER_POLICY,
  boundedPolicy,
  byCodePoint,
  scheduleAttempts,
  type FailoverReason,
  type FailoverStopReason,
  type ScheduledExclusion
} from "./scheduling";

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
 *
 * TWO LAYERS, BECAUSE TWO CALLERS NEED DIFFERENT AMOUNTS OF IT, AND NOW TWO
 * FILES BECAUSE ONE OF THOSE CALLERS IS A BROWSER.
 * `scheduleAttempts` is the scheduling policy over an ALREADY-ORDERED list of
 * ids: what to attempt next, what is ruled out, what the budget has left.
 * `planFailover` is that plus ranking -- it decides the order, and it adds back
 * the two things only a `PlaybackDecision` knows, namely what the ranking
 * believed about a candidate before an attempt disproved it and why a candidate
 * was refused before any attempt happened.
 *
 * The split exists because `apps/web`'s playback machine has to schedule and
 * must NOT rank: the session already ranked, the client has no
 * `PlaybackCapabilities`, and a client-side re-rank would be a second opinion
 * about preference. Before the split it reimplemented scheduling instead, with
 * comments on both sides claiming the two agreed while the machine spent its
 * budget retrying candidates ahead of candidates nobody had tried yet.
 *
 * THE SCHEDULING LAYER NOW LIVES IN `./scheduling`, and this file re-exports all
 * of it. Wiring the machine to `scheduleAttempts` made this module a browser
 * bundle edge for the first time, and the `rankStreamCandidates` import below --
 * needed by `planFailover` and by nothing else -- dragged `./ranking` and
 * `./scoring` into the client along with it. Moving the scheduler into a file
 * with no path to `./ranking` is the only fix that actually breaks that edge; a
 * deep import into this file would not, because the edge is stated in the source
 * here rather than created by the barrel. See the header of `./scheduling` for
 * the alternatives that were rejected.
 *
 * NOTHING WAS RENAMED AND NOTHING MOVED OUT OF REACH. The re-exports below
 * restate exactly the surface this module published before the split, in the
 * same names, so `./failover`, `@liberty/media-engine` and every test that
 * imports from either resolve to the same bindings they always did.
 * `byCodePoint` and `boundedPolicy` are imported but deliberately NOT
 * re-exported: both were module-private before and stay out of the barrel.
 */

export {
  DEFAULT_FAILOVER_POLICY,
  PLAYBACK_FAILURE_KINDS_BY_PRECEDENCE,
  PLAYBACK_FAILURE_POLICY,
  scheduleAttempts
} from "./scheduling";
export type {
  AttemptSchedule,
  ChargedAttempts,
  FailoverExclusionReason,
  FailoverProceedReason,
  FailoverReason,
  FailoverStopReason,
  ScheduledExclusion
} from "./scheduling";

/**
 * A `ScheduledExclusion` with what the RANKING claimed before the attempt.
 *
 * `compatibilityBeforeAttempt` is carried because paired with
 * `compatibility_disproven` it separates two findings that look identical in a
 * log otherwise:
 *
 *   - `unverified` + disproven: the expected way an unverified candidate
 *     resolves. The provider stated no codec, we attempted anyway, it did not
 *     play. Nothing is broken; a fact was learned, and the fix is provider
 *     metadata.
 *   - `verified` + disproven: our capability model said this WOULD decode and it
 *     did not. That is a defect in the model, the device profile, or the
 *     provider's stated codec, and it is worth an alert. Collapsed into a single
 *     "decode failed" line, this signal is invisible.
 *
 * THIS is the reason the two layers are two types and not one. Everything a
 * `ScheduledExclusion` carries is derivable from ids and failure kinds; this one
 * extra field needs a `RankedCandidate`, so it can only be added by a caller
 * holding a ranking -- which is exactly the caller that lives in this file.
 */
export interface ExcludedCandidate extends ScheduledExclusion {
  compatibilityBeforeAttempt: CompatibilityConfidence;
}

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
   *
   * PREFERENCE, not schedule. `next` is drawn from this pool but is not
   * necessarily `attemptable[0]`: a candidate that has never been attempted is
   * taken ahead of a better-ranked one that is carrying a transient failure (see
   * the selection in `scheduleAttempts`). Publishing the pool in rank order and
   * choosing within it are deliberately two facts rather than one -- collapsing
   * them would mean either re-sorting this list, which is the second opinion the
   * paragraph above refuses, or scheduling by rank alone, which is the defect
   * that let two candidates eat a four-attempt budget while a third was never
   * tried at all.
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

const REASON_TEXT: Record<FailoverReason, string> = {
  first_attempt: "nothing has been attempted yet; starting at the top of the ranking",
  retry_after_transient_failure:
    "every attemptable candidate has now been tried at least once, so the best-ranked transient failure is retried before it is demoted",
  failover_to_next_candidate:
    "spending this attempt on the best-ranked candidate that has not been tried yet, rather than repeating one that just failed",
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
  //
  // Stated as an equality over the WHOLE exclusion list rather than as "no
  // exclusion contradicts it", which is what keeps it honest as
  // `FailoverExclusionReason` grows: a fifth value that this function has never
  // heard of makes the claim false rather than letting it through. It is also
  // why `attempt_failed_unclassified` needed nothing here -- it is unreachable
  // for `planFailover`, and if it ever became reachable the answer below would
  // already be `candidates_exhausted` plus the itemised trail, which is the
  // correct answer for a mixed pool.
  if (excluded.length > 0 && excluded.every((entry) => entry.reason === "compatibility_disproven")) {
    return "all_eligible_candidates_incompatible";
  }

  return "candidates_exhausted";
}

/**
 * The next attempt, or a terminal reason, RANKED.
 *
 * Two jobs, and since PL-0204's scheduler was extracted only one of them is done
 * here: this ranks, and `scheduleAttempts` schedules. What is left is the part
 * that genuinely needs candidates and capabilities -- the ranking itself, the
 * compatibility the ranking believed before an attempt disproved it, and the
 * pre-attempt refusals that turn "the pool is empty" into a finding somebody can
 * act on.
 *
 * Takes raw candidates and ranks them internally rather than accepting a
 * `PlaybackDecision`, so there is exactly one ranking in play and a failover
 * plan can never be built on a decision that came from different capabilities
 * than the one it reports. It also makes the whole result order-invariant in
 * both inputs, which is the property the regression test pins -- the scheduler
 * itself is deliberately NOT order-invariant in its ids, and this is where that
 * guarantee is supplied.
 *
 * That refusal is also why `rankStreamCandidates` is imported as a VALUE here
 * and why the scheduler had to move rather than the import: accepting a
 * pre-built decision would have deleted the import at the cost of the guarantee
 * the paragraph above describes.
 *
 * Nothing here reads or re-derives technical metadata. A decode failure does not
 * write back a codec, an attempt does not infer a height, and an excluded
 * candidate keeps whatever the provider stated -- including nothing. Unknown
 * stays unknown; the attempt establishes decodability, and decodability only.
 *
 * NO PRODUCTION CALLER TODAY, AND THAT IS RECORDED HERE RATHER THAN LEFT TO BE
 * INFERRED. Every caller in the repository is a test. The session route
 * (`apps/web/.../playback/session/issue-session.ts`) ranks and PUBLISHES
 * `failoverPolicy`; the failover decisions that real playback takes are taken in
 * the browser, by `playback-machine.ts`, through `scheduleAttempts` directly.
 * That is the point of the split and it is not a defect -- the client must
 * schedule and must not rank -- but a policy function with no caller enforces
 * nothing, and this repository has already paid for a comment that implied an
 * alignment nobody had wired up. What this function IS, precisely: the
 * server-side plan a future endpoint publishes alongside a session, and the
 * ranking-aware reference the scheduler is tested against -- `next` here and
 * `next` in the client come from one implementation, so a divergence is a test
 * failure rather than a field report. If it acquires a caller, the fact above is
 * the line to delete.
 *
 * Total for every input, including a zero or negative `maxAttempts` (terminal
 * immediately), a `NaN` policy (see `scheduleAttempts`) and failures naming
 * candidates that do not exist (counted, surfaced, attributed to nothing).
 */
export function planFailover(
  candidates: readonly StreamCandidate[],
  capabilities: PlaybackCapabilities,
  failures: readonly PlaybackAttemptFailure[] = [],
  policy: FailoverPolicy = DEFAULT_FAILOVER_POLICY
): FailoverPlan {
  const decision = rankStreamCandidates([...candidates], capabilities);

  /*
   * The ranking's own order, handed over as ids. No `ChargedAttempts`: for this
   * caller `failures.length` IS the attempt count and a candidate with no
   * reported failure genuinely has never been attempted, which is the identity
   * the published plan and its property tests are written against.
   */
  const schedule = scheduleAttempts(
    decision.ranked.map((entry) => entry.candidate.id),
    failures,
    policy
  );

  /*
   * ENRICHMENT, walked over `decision.ranked` rather than looked up per
   * exclusion, so the join is total by construction and needs no assertion for a
   * miss that cannot happen: every scheduled exclusion came from the very list
   * being walked. Re-sorted afterwards because this pass produces rank order and
   * `excluded` is published id-sorted -- see the note in `scheduleAttempts`.
   */
  const ruledOutById = new Map<string, ScheduledExclusion>(
    schedule.excluded.map((entry) => [entry.candidateId, entry])
  );
  const excluded: ExcludedCandidate[] = [];
  for (const entry of decision.ranked) {
    const ruledOut = ruledOutById.get(entry.candidate.id);
    if (ruledOut === undefined) continue;
    excluded.push({ ...ruledOut, compatibilityBeforeAttempt: entry.compatibility });
  }
  excluded.sort((a, b) => byCodePoint(a.candidateId, b.candidateId));

  const next =
    schedule.next === null
      ? null
      : (decision.ranked.find((entry) => entry.candidate.id === schedule.next) ?? null);

  /*
   * The refinement `AttemptSchedule.reason` describes, and the only place the
   * schedule's answer is ever second-guessed. It is not a second opinion: it
   * applies to exhaustion ONLY, it uses the same vocabulary, and it fires
   * exactly where the scheduler said it lacked the evidence -- pre-attempt
   * refusals, which live in `decision.rejected` and reach no id list.
   *
   * `attempt_limit_reached` is deliberately excluded from the refinement even
   * though it is also terminal: it is a fact about the budget, the scheduler had
   * every input needed to decide it, and exhaustion has already been ruled out
   * by the time it is reported.
   */
  const reason: FailoverReason =
    schedule.next === null && schedule.reason !== "attempt_limit_reached"
      ? exhaustionReason(new Set(candidates.map((c) => c.id)), decision, excluded)
      : schedule.reason;

  const attemptsUsed = schedule.attemptsUsed;
  const unattributedDetail = schedule.unattributedDetail;

  const trail = [
    next === null ? REASON_TEXT[reason] : `${next.candidate.id}: ${REASON_TEXT[reason]}`,
    /* The ENFORCED budget, not the stated one. They differ only for a `NaN`
     * nobody meant to pass (see `boundedPolicy`), and that is exactly the case
     * where a trail reading `0/NaN attempts used` would send its reader looking
     * for a bound the scheduler never applied. */
    `${attemptsUsed}/${boundedPolicy(policy).maxAttempts} attempts used`,
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
    attemptsRemaining: schedule.attemptsRemaining,
    attemptable: schedule.attemptable,
    excluded,
    unattributedFailures: schedule.unattributedFailures,
    unattributedDetail,
    decision,
    explanation: trail.filter((part): part is string => part !== null).join(" | ")
  };
}
