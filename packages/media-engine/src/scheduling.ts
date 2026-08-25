import {
  PLAYBACK_FAILURE_KINDS,
  type FailoverPolicy,
  type PlaybackAttemptFailure,
  type PlaybackFailureKind
} from "@liberty/contracts/domains/failover";

/**
 * The SCHEDULING half of candidate failover (PL-0204), in a file of its own.
 *
 * Everything here was `failover.ts` and still behaves identically; the split is
 * about what a CONSUMER is forced to load, not about what the policy does. Not
 * one export was renamed, no signature changed, and `failover.ts` re-exports the
 * whole of this file, so every existing import path — the barrel, `./failover`,
 * the tests — resolves to the same bindings it did before.
 *
 * WHY THE FILE EXISTS: `apps/web`'s playback machine calls `scheduleAttempts` at
 * runtime, and it is reached from `player-surface.tsx`, which is `"use client"`.
 * That is a BROWSER BUNDLE edge. Before the split it was an edge into
 * `failover.ts`, which value-imports `rankStreamCandidates` from `./ranking` for
 * `planFailover` alone — a function no client ever calls — and `./ranking`
 * value-imports `./scoring`. So a viewer downloaded the whole ranking and
 * scoring engine in order to answer "which id do I try next", a question
 * decided entirely from ids, failure kinds and a budget.
 *
 * The dependency was real rather than incidental, which is why moving the code
 * was the fix and configuration was not:
 *
 *   - A DEEP IMPORT ALONE WOULD NOT HAVE HELPED. `@liberty/media-engine/failover`
 *     still pulls `./ranking` through that value import; the barrel is not the
 *     only path to it, merely the widest.
 *   - `"sideEffects": false` ALONE WOULD NOT HAVE HELPED EITHER. It lets a
 *     bundler drop modules nothing references, and `failover.ts` genuinely
 *     references `./ranking`. It is added (see `package.json`) because it is
 *     independently true and lets the rest of the barrel fall away, but it
 *     cannot break an edge the source states.
 *   - A `planFailover` THAT TOOK A PRE-BUILT `PlaybackDecision` was rejected: it
 *     would remove the import by letting a plan be built on a decision that came
 *     from different capabilities than the one it reports, which the note on
 *     `planFailover` explains is the exact thing that function refuses to allow.
 *
 * THE SPLIT LINE IS THE ONE THE MODULE ALREADY DOCUMENTED. `failover.ts` has
 * described two layers since PL-0204 — "`scheduleAttempts` is the scheduling
 * policy over an ALREADY-ORDERED list of ids" and "`planFailover` is that plus
 * ranking" — and named the client as the caller that must schedule and must NOT
 * rank. Nothing here takes a `StreamCandidate`, a `PlaybackCapabilities` or a
 * rank, so the boundary is a fact about the code rather than a line drawn to
 * make a bundle smaller.
 *
 * WHAT IS STILL PULLED IN, STATED PLAINLY: `PLAYBACK_FAILURE_KINDS` is a VALUE
 * import from `@liberty/contracts/domains/failover`, whose first line is
 * `import { z } from "zod"` and which evaluates `z.enum(...)` at module scope.
 * So zod's runtime still reaches the browser through this file. Removing that
 * would mean a zod-free constant module inside `packages/contracts`, and that
 * package is out of scope for this change — see the note on
 * `PLAYBACK_FAILURE_KINDS_BY_PRECEDENCE`.
 *
 * PURE AND DETERMINISTIC, on the same terms as the rest of the package: no
 * clocks, no randomness, no I/O, no ambient state, and no dependence on the
 * order of the failures array.
 */

/**
 * Why a candidate may no longer be attempted.
 *
 * Every value is established by an ATTEMPT, which is what makes the vocabulary
 * distinct from `RejectionReason` in ranking.ts, whose values are established
 * before any attempt was made. Four of them are claims about the candidate and
 * the fifth is a claim about the report -- see `attempt_failed_unclassified`,
 * which is the honest thing to say when an attempt ended and nothing came back
 * that could be named. Keeping the two vocabularies separate is
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
  | "transient_retries_exhausted"
  /**
   * An attempt on this candidate ended in a failure the reporter COULD NOT
   * CLASSIFY. Nothing was learned, so it is not attempted again.
   *
   * The only value here that is a claim about the REPORT rather than about the
   * stream, and it is stated as one on purpose. The other four name what is
   * wrong with the candidate; this one says the attempt ended and we cannot say
   * why -- which is exactly the honest content of an unclassified failure, and
   * exactly why it is not one of the other four.
   *
   * IT EXISTS BECAUSE THE ALTERNATIVE IS TO GUESS A KIND.
   * `apps/web/.../playback-failure.ts` rule 1 is explicit that a reporter which
   * cannot place an error must report NOTHING rather than invent a
   * `PlaybackFailureKind`: an invented `network_transient` buys retries for
   * something that will never succeed, and an invented `decode_failed`
   * permanently discards a stream that was briefly unreachable. So an
   * unclassified failure never enters `failures` and `exclusionFor` -- which
   * reads kinds and only kinds -- can never see it.
   *
   * That left the candidate merely TRIED rather than ruled out: breadth-first
   * scheduling de-prioritised it, and then handed it straight back the moment
   * nothing was untried, so a single fatally-broken stream could eat the whole
   * budget and the plan would still report it as one that "remained". The
   * exclusion is the missing half of rule 1 -- the attempt ended, it earned no
   * retry -- said without asserting anything the reporter refused to assert.
   *
   * ONE ATTEMPT IS THE WHOLE BUDGET, unlike `transient_retries_exhausted`. A
   * retry is only ever worth an attempt when something is known about what
   * failed; here nothing is, so a second attempt is a bet at unknown odds
   * against a candidate that has already cost the viewer a load. It is reached
   * only through `ChargedAttempts.attemptsByCandidate` -- the caller asserting
   * "this was attempted" for an attempt that produced no failure kind -- so it
   * is unreachable for `planFailover`, whose attempt count IS its failure count.
   */
  | "attempt_failed_unclassified";

/**
 * A candidate ruled out of the pool, and what it cost to find out — stated with
 * nothing but the candidate's own attempt history.
 *
 * This is everything `scheduleAttempts` can honestly say. It knows ids and the
 * failures reported against them; it was never shown the candidate, so it cannot
 * report what the ranking believed about the candidate BEFORE the attempt. That
 * fact is real and load-bearing (see `ExcludedCandidate` in failover.ts, which
 * is where it is added), so it is supplied by the caller that holds it rather
 * than defaulted to something plausible here.
 */
export interface ScheduledExclusion {
  candidateId: string;
  reason: FailoverExclusionReason;
  /** Attempts this candidate consumed before being ruled out. */
  attempts: number;
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

/**
 * Attempts already charged, when the caller counts them differently to the way
 * this module counts them by default.
 *
 * OPTIONAL, AND THE DEFAULT IS THE WHOLE POINT FOR MOST CALLERS. `planFailover`
 * passes nothing, so `attemptsUsed` is `failures.length` and "never attempted"
 * is "has no reported failure" — the identity that the published plan, its
 * property tests and every bug report replay depend on.
 *
 * It exists because ONE caller legitimately knows more than its own failure list
 * says. `@liberty/contracts/domains/failover` is explicit that a reporter which
 * cannot classify a failure must report NOTHING rather than guess a kind, so the
 * player's `PlaybackAttemptFailure[]` omits attempts whose error it could not
 * place. Those attempts still happened: they cost the viewer a load, they must
 * count against the budget, and the candidate they were spent on must not look
 * untried to a breadth-first scheduler. Deriving both facts from `failures`
 * alone would let an unclassifiable error reload the same candidate for ever
 * against a bound that never advances — the machine's previous guards avoided
 * that only because they advanced an index instead of consulting a policy.
 *
 * `attemptsByCandidate` REPLACES the derived per-candidate count rather than
 * adding to it: a caller that supplies the map is asserting it is complete, so a
 * missing key means zero attempts and not "fall back to counting failures". A
 * merge of the two would double-count every classified failure.
 *
 * WHAT IT CAN AND CANNOT DO, and the asymmetry is the safety property. Neither
 * field can make a candidate ATTEMPTABLE that `exclusionFor` ruled out: the
 * rights and compatibility invariants are decided from the failure kinds alone
 * and stay out of reach of this. It can rule one OUT — a charged attempt that
 * produced no failure kind is an attempt that taught us nothing, and
 * `attempt_failed_unclassified` is what the scheduler says about it. That
 * direction is safe in a way the other is not: the worst an over-count can do is
 * discard a candidate we might have played, while an under-count of an exclusion
 * is a second attempt to play something already ruled out.
 */
export interface ChargedAttempts {
  /** Total attempts spent, including ones no failure kind could be attributed to. */
  readonly attemptsUsed?: number;
  /** Attempts per candidate, on the same terms. A missing key means none. */
  readonly attemptsByCandidate?: Readonly<Record<string, number>>;
}

/**
 * The scheduling half of a failover plan: what to attempt next, out of a list
 * somebody else has already put in preference order.
 *
 * Everything here is derivable from ids, failure kinds and a budget. Nothing
 * here needed a `StreamCandidate`, a `PlaybackCapabilities` or a rank — which is
 * exactly why it is separable, and why it is the piece a client can share with
 * the server without shipping the ranking engine or acquiring a second opinion
 * about preference. `FailoverPlan` in failover.ts is this plus the facts only
 * ranking holds.
 */
export interface AttemptSchedule {
  /** The candidate ID to attempt next, or null when the schedule is terminal. */
  next: string | null;
  /**
   * Why. Drawn from the SAME vocabulary `FailoverPlan` publishes, so a client
   * trail and a server plan cannot describe one decision in two dialects.
   *
   * Three of the six terminal reasons are unreachable from here and that is a
   * statement about evidence rather than a gap: `no_eligible_candidates`,
   * `all_candidates_rights_blocked` and `all_eligible_candidates_incompatible`
   * are claims about candidates that were refused BEFORE any attempt, and an
   * ordered list of ids that survived ranking cannot see them. A caller holding
   * a `PlaybackDecision` refines `candidates_exhausted` into whichever of them
   * is true; see `planFailover`. That is a refinement within one vocabulary, not
   * a second opinion — the refinement can only ever replace an exhaustion-family
   * reason, never `attempt_limit_reached` and never a proceed reason.
   */
  reason: FailoverReason;
  /** Every reported failure, including ones that could not be attributed. */
  attemptsUsed: number;
  attemptsRemaining: number;
  /** Ids still worth attempting, in the order they were supplied. */
  attemptable: readonly string[];
  /** Ruled-out candidates, id-sorted by code point. */
  excluded: readonly ScheduledExclusion[];
  /** Ids reported as failed that are not in the supplied list, deduped and id-sorted. */
  unattributedFailures: readonly string[];
  /** The same ids, WITH the kinds reported against them, in precedence order. */
  unattributedDetail: readonly { candidateId: string; kinds: readonly PlaybackFailureKind[] }[];
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
 *
 * THIS IS THE ONE VALUE IMPORT THIS FILE STILL MAKES, and it is what keeps zod
 * in the client bundle: `@liberty/contracts/domains/failover` opens with
 * `import { z } from "zod"` and builds `playbackFailureKindSchema` at module
 * scope, so importing the derived `PLAYBACK_FAILURE_KINDS` array evaluates the
 * schema too. Two ways out were considered and neither was taken here:
 *
 *   - DERIVE MEMBERSHIP FROM `PLAYBACK_FAILURE_POLICY` instead, via
 *     `Object.keys`. The keys are provably the kinds -- `satisfies
 *     Record<PlaybackFailureKind, ...>` rejects a missing one and an extra one
 *     -- so it would type-check and the existing membership test would still
 *     pass. REJECTED because it inverts a stated invariant rather than a style:
 *     both this file and the contract document that membership is a SCHEMA fact
 *     and precedence is a PRODUCT decision, precisely so that the engine's scan
 *     cannot silently stop covering a kind the schema can still report. Trading
 *     that for a smaller bundle is not a trade this change is entitled to make.
 *   - A ZOD-FREE CONSTANT MODULE in `packages/contracts` that both the schema
 *     and this file read. That is the correct fix and it keeps the invariant
 *     intact, but it is an edit to `packages/contracts`, which is out of scope
 *     for this change. Left as the stated follow-up.
 */
export const PLAYBACK_FAILURE_KINDS_BY_PRECEDENCE: readonly PlaybackFailureKind[] = [
  ...PLAYBACK_FAILURE_KINDS
].sort((a, b) => PLAYBACK_FAILURE_POLICY[a].precedence - PLAYBACK_FAILURE_POLICY[b].precedence);

/**
 * The default bound, stated rather than emergent.
 *
 * Four attempts buys the FIRST attempt of up to four distinct streams. Only once
 * every attemptable candidate has been tried does a leftover attempt get spent
 * retrying one -- so three candidates means three first attempts plus one retry
 * of the best-ranked survivor, and a single candidate means one attempt plus one
 * retry, where it is the per-candidate ceiling rather than this budget that
 * stops it.
 *
 * The previous wording claimed four attempts covered "the top candidate, one
 * retry of it, and two fallbacks". That was only ever true if the fallbacks were
 * not themselves retried, and the scheduler retried them: two candidates at two
 * attempts each consumed the whole budget while a third candidate sat in
 * `attemptable`, never tried even once, at the moment the plan reported
 * `attempt_limit_reached`. The comment described an intent the code did not
 * implement. `scheduleAttempts` now implements that intent -- for the server
 * through `planFailover` and for the player directly -- and this describes what
 * it does.
 *
 * Beyond four, the ranking's own model says the remaining candidates are
 * materially worse and the viewer has been staring at a spinner for four round
 * trips. One retry per candidate because a second consecutive timeout on the
 * same host is evidence about the host, not about the network.
 */
export const DEFAULT_FAILOVER_POLICY: FailoverPolicy = {
  maxAttempts: 4,
  maxTransientRetriesPerCandidate: 1
};

/**
 * Code-point comparison. Never `localeCompare`: see the note in ranking.ts.
 *
 * Exported only so `failover.ts` can sort its enriched `ExcludedCandidate[]` by
 * the SAME comparator this file sorts `ScheduledExclusion[]` by. It is not
 * re-exported from `failover.ts` and so does not reach the barrel: it is an
 * internal shared by two files, not a public API. Restating it there instead
 * would put one ordering rule -- and the `localeCompare` prohibition attached to
 * it -- in two places, which is the drift this package has already paid for.
 */
export function byCodePoint(a: string, b: string): number {
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
 *
 * KINDS ONLY, WHICH IS WHY IT IS NOT THE WHOLE ANSWER. An attempt the caller
 * could not classify contributes no kind by contract, so it is invisible here
 * and `attempt_failed_unclassified` is decided by the scheduler, from the
 * attempt COUNT, after this returns null. Deciding it here would mean handing
 * this function a count it has no other use for; deciding it BEFORE this would
 * make an unclassified attempt outrank a decode failure on the same candidate,
 * and "we found out this does not decode" is the more informative finding.
 *
 * MODULE-PRIVATE, exactly as it was in failover.ts. `scheduleAttempts` is its
 * only caller and the barrel never published it, so exporting it as part of the
 * split would have widened the public surface for no consumer.
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
 * The next attempt out of an ALREADY-ORDERED list of candidate ids.
 *
 * THE SCHEDULING POLICY, AND NOW THE ONLY COPY OF IT. It was extracted from
 * `planFailover` because there were two: this package planned failover one way
 * and `apps/web`'s playback machine reimplemented it another, each carrying a
 * comment asserting they agreed. They did not. The machine tried a RETRY before
 * a fresh candidate, so with `maxAttempts: 4` and three candidates, two of them
 * ate the budget two attempts apiece while the third was never attempted once --
 * and the breadth-before-depth fix landed here, where real playback never read
 * it. A divergence that comments on both sides swear cannot happen is precisely
 * the divergence that survives review, so there is one implementation and both
 * callers are wired to it.
 *
 * IT DOES NOT RANK, AND MUST NOT. It takes ids in an order somebody else is
 * responsible for and never reorders them. That is what makes it callable from
 * the player at all: the player is handed a candidate list the SESSION already
 * ranked, it holds no `PlaybackCapabilities` to rank with, and a client-side
 * re-rank would be a second opinion about preference that could disagree with
 * the one the session published -- after which the reason trail would explain a
 * choice nobody made. `planFailover` passes `decision.ranked`; the player passes
 * the session's list; neither is re-sorted here.
 *
 * That is also why this function, and not `planFailover`, is what a browser
 * imports -- and why it now lives in a file with no path to `./ranking` at all.
 *
 * Nothing here reads or re-derives technical metadata, because nothing here has
 * any: the input is ids. An attempt establishes attemptability and nothing else.
 *
 * PURE AND DETERMINISTIC, on the same terms as the rest of the package. The
 * failures array is read by COUNT and by membership only, never by its sequence,
 * so a schedule is a function of the MULTISET of failures and a bug report
 * replays whatever order the list is pasted back in. The candidate order is the
 * one input whose sequence DOES reach the output, because there it is the
 * meaning rather than noise -- making the whole result order-invariant is the
 * caller's guarantee to make, and `planFailover` makes it by ranking.
 *
 * Total for every input: an empty list, a zero or negative `maxAttempts`
 * (terminal immediately), and failures naming ids that were never supplied
 * (counted, surfaced, attributed to nothing).
 */
export function scheduleAttempts(
  orderedCandidateIds: readonly string[],
  failures: readonly PlaybackAttemptFailure[] = [],
  policy: FailoverPolicy = DEFAULT_FAILOVER_POLICY,
  charged: ChargedAttempts = {}
): AttemptSchedule {
  /*
   * Grouped, then only ever COUNTED or membership-tested. The per-candidate
   * array's own order is never read, which is what makes the schedule a function
   * of the multiset of failures rather than of the sequence the caller recorded
   * them in.
   */
  const kindsById = new Map<string, PlaybackFailureKind[]>();
  for (const failure of failures) {
    const recorded = kindsById.get(failure.candidateId);
    if (recorded) recorded.push(failure.kind);
    else kindsById.set(failure.candidateId, [failure.kind]);
  }

  /*
   * "How many attempts has this candidate had", which is also "has it had any"
   * and "did any of them produce a failure we can name" everywhere it is used.
   *
   * The failure count is the default and the only thing `planFailover` ever
   * uses. A supplied `attemptsByCandidate` REPLACES it rather than merging with
   * it -- see `ChargedAttempts` for why a caller would hold a better count, and
   * why merging would double-charge every classified failure.
   *
   * COPIED INTO A MAP RATHER THAN INDEXED WHERE IT LIES. The argument is a plain
   * object the caller built, so `record["constructor"]` and `record["toString"]`
   * return functions off `Object.prototype`, `?? 0` never fires, and a candidate
   * whose provider happened to name it `toString` would poison both the
   * arithmetic and the tried/untried partition. `Object.entries` reads OWN
   * enumerable properties only, which is the same immunity `kindsById` above has
   * for free by being a `Map`, and one mechanism in this function beats two.
   */
  const chargedPerCandidate =
    charged.attemptsByCandidate === undefined
      ? null
      : new Map<string, number>(Object.entries(charged.attemptsByCandidate));
  const attemptsOn = (candidateId: string): number =>
    chargedPerCandidate === null
      ? (kindsById.get(candidateId) ?? []).length
      : (chargedPerCandidate.get(candidateId) ?? 0);

  const attemptable: string[] = [];
  const excluded: ScheduledExclusion[] = [];

  for (const candidateId of orderedCandidateIds) {
    const kinds = kindsById.get(candidateId) ?? [];
    const charges = attemptsOn(candidateId);

    /*
     * TWO QUESTIONS, ASKED IN PRECEDENCE ORDER, and the order is the product
     * decision. The kinds get first say, so a candidate that both failed to
     * decode AND was attempted once with an unclassifiable error reports
     * `compatibility_disproven`: that is a fact about the stream and about this
     * device, and it is strictly more informative than "an attempt ended and we
     * cannot say why". Only when nothing nameable ruled the candidate out does
     * the bare arithmetic speak.
     *
     * `charges > kinds.length` is the whole test for the second one: the caller
     * charged this candidate more attempts than it reported failures for it, so
     * at least one attempt ended without a classifiable failure. It cannot fire
     * for a candidate nobody attempted (that needs `charges >= 1`), and it
     * cannot fire at all for `planFailover`, where the two counts are the same
     * number by construction.
     */
    const exclusion: FailoverExclusionReason | null =
      exclusionFor(kinds, policy) ?? (charges > kinds.length ? "attempt_failed_unclassified" : null);

    if (exclusion === null) {
      attemptable.push(candidateId);
      continue;
    }
    /* The larger of the two counts, because either one alone can understate what
     * the candidate cost: a caller with no `ChargedAttempts` has only its
     * failures, and a caller supplying one may have charged attempts that
     * reported nothing. Identical to the old `kinds.length` for `planFailover`. */
    excluded.push({ candidateId, reason: exclusion, attempts: Math.max(charges, kinds.length) });
  }

  // Id-sorted, like `PlaybackDecision.rejected`. `excluded` is a set of findings,
  // not a preference order, so publishing it in the supplied order would tie a
  // list with no ordering semantics to one that has them.
  excluded.sort((a, b) => byCodePoint(a.candidateId, b.candidateId));

  const pooled = new Set(orderedCandidateIds);
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

  const attemptsUsed = charged.attemptsUsed ?? failures.length;
  const attemptsRemaining = Math.max(policy.maxAttempts - attemptsUsed, 0);

  /*
   * BREADTH BEFORE DEPTH.
   *
   * `attemptable` is in the caller's preference order, so its head is the best
   * candidate we know of -- but "which is best" and "what should the next
   * attempt buy" are not the same question, and answering the second with the
   * first is what let two candidates spend a four-attempt budget between them
   * while a third was never tried at all.
   *
   * A retry is a bet that an identical request to an identical URL will behave
   * differently. An untried candidate is a different SOURCE. And the only
   * retryable kind is precisely the ambiguous one: `network_transient` is what a
   * player reports when it cannot tell a CORS rejection from a refused
   * connection from real packet loss -- Shaka collapses all three into
   * HTTP_ERROR -- so a transient failure is evidence that something is wrong,
   * not evidence that waiting will fix it. When the kind cannot say whether the
   * fault is permanent, trying something new is strictly more informative than
   * repeating something that just failed.
   *
   * So retries spend the budget REMAINING after every attemptable candidate has
   * had a chance; they never spend the budget another candidate needs for its
   * first attempt.
   *
   * A PARTITION, NOT A SORT. The pool is read as two groups -- never attempted,
   * then carrying prior attempts -- and each group keeps the caller's own order,
   * because `find` returns the earliest match and the fallback is the pool's own
   * head. No second preference key is introduced that could disagree with the
   * order supplied, and `attemptable` is published untouched. Order-invariance
   * in the FAILURES survives for the same reason it did before: they are
   * consulted here by COUNT only, never by the sequence the caller reported.
   */
  const head = attemptable.find((candidateId) => attemptsOn(candidateId) === 0) ?? attemptable[0] ?? null;
  let next: string | null = null;
  let reason: FailoverReason;

  if (head === null) {
    /*
     * Exhaustion outranks the budget. When nothing is attemptable the budget is
     * irrelevant, and reporting `attempt_limit_reached` there would tell an
     * operator to raise a limit that would change nothing -- the two states are
     * mutually exclusive by construction, and this is which way round they go.
     *
     * `no_candidates` and `candidates_exhausted` are the only two an id list can
     * justify. The three homogeneous reasons are claims about candidates refused
     * BEFORE any attempt, which is evidence this function was never shown; a
     * caller holding a `PlaybackDecision` refines the second value into one of
     * them. Guessing here instead would be exactly the vacuous confidence the
     * `FailoverStopReason` doc refuses -- and with an EMPTY input every "all
     * candidates were X" claim is vacuously true, which is why the empty case is
     * separated first rather than folded into exhaustion.
     */
    reason = orderedCandidateIds.length === 0 ? "no_candidates" : "candidates_exhausted";
  } else if (attemptsUsed >= policy.maxAttempts) {
    reason = "attempt_limit_reached";
  } else {
    next = head;
    /*
     * Derived from what actually happened to THIS candidate, and it has to be
     * checked rather than assumed, because the selection above is what makes
     * each branch mean what it says. `retry_after_transient_failure` is
     * reachable only when NO attemptable candidate is untried, since an untried
     * one would have won the `find`; it therefore asserts something stronger
     * than a bare repeat -- the pool has been covered breadth-first. Conversely
     * `failover_to_next_candidate` and `first_attempt` are reachable only with
     * an empty history, so a candidate picked because it is untried while a
     * better-ranked one sits mid-retry reports the failover, not a retry it is
     * not.
     *
     * "TRANSIENT" IS THE VOCABULARY'S WORD, NOT AN INDEPENDENT CLAIM. For
     * `planFailover` it is literally true: a candidate still in the pool
     * carrying a failure can only be carrying a transient one, because every
     * other kind is terminal on its first occurrence. For a caller supplying
     * `attemptsByCandidate` it means the weaker thing that vocabulary can say --
     * this candidate was attempted and nothing ruled it out. `FailoverReason` is
     * a closed vocabulary shared with the client trail and is deliberately not
     * widened here; the distinction belongs in the caller's own detail line,
     * which is where an unclassifiable error is already recorded.
     *
     * `first_attempt` MEANS THE SESSION HAS NO HISTORY AT ALL, which is a
     * stronger test than "the budget is untouched" and it has to be, because the
     * two came apart the moment a caller started counting attempts for itself. A
     * player whose engine reports a fatal error BEFORE the attempt is charged
     * arrives here with `attemptsUsed === 0` and a candidate already ruled out,
     * and the old test printed `a -> b: first_attempt` for a candidate being
     * failed over TO. All three components are zero together for `planFailover`
     * -- exclusions there are derived from failures, so an empty failure list is
     * an empty exclusion list -- so this is the same predicate it always was for
     * the caller whose behaviour must not change.
     */
    const nothingHasHappenedYet =
      attemptsUsed === 0 && failures.length === 0 && excluded.length === 0;
    reason = attemptsOn(head) > 0
      ? "retry_after_transient_failure"
      : nothingHasHappenedYet
        ? "first_attempt"
        : "failover_to_next_candidate";
  }

  return {
    next,
    reason,
    attemptsUsed,
    attemptsRemaining,
    attemptable,
    excluded,
    unattributedFailures,
    unattributedDetail
  };
}
