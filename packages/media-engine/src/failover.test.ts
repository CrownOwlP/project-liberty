import { describe, expect, it } from "vitest";
import {
  PLAYBACK_FAILURE_KINDS,
  type FailoverPolicy,
  type PlaybackAttemptFailure,
  type PlaybackFailureKind
} from "@liberty/contracts/domains/failover";
import type { PlaybackCapabilities, StreamCandidate } from "@liberty/contracts/domains/playback";
import {
  DEFAULT_FAILOVER_POLICY,
  PLAYBACK_FAILURE_KINDS_BY_PRECEDENCE,
  PLAYBACK_FAILURE_POLICY,
  planFailover,
  scheduleAttempts
} from "./failover";

/**
 * Candidate failover (PL-0204).
 *
 * Three properties are under test throughout and each has its own way of going
 * quietly wrong:
 *
 *   - BOUNDED. The loop must terminate on a stated ceiling, not on running out
 *     of candidates, and a rights or decode failure must never be retried at
 *     all. `runToCompletion` below drives the real loop rather than asserting a
 *     single plan, because "bounded" is a property of the sequence.
 *   - DETERMINISTIC. Neither input array's order may reach the output. The
 *     failure list is a multiset and the candidate list is order-invariant by
 *     the ranking's own guarantee, so reversing both must produce a byte-equal
 *     plan.
 *   - OBSERVABLE. Exhaustion, the attempt limit, wholesale rights blocking and
 *     wholesale decode failure are four different findings with four different
 *     remedies, and each has an assertion that it did not collapse into another.
 */

const capabilities: PlaybackCapabilities = {
  maxHeight: 2160,
  supportedVideoCodecs: ["h264", "hevc"],
  supportedAudioCodecs: ["aac", "eac3"],
  preferredAudioLanguages: ["en"]
};

/** Fully described and eligible. Override to make it unknown or ineligible. */
const candidate = (over: Partial<StreamCandidate> & { id: string }): StreamCandidate => ({
  providerId: "fixture",
  rights: "licensed",
  protocol: "https",
  height: 1080,
  bitrateKbps: 8100,
  estimatedLatencyMs: 70,
  healthScore: 0.9,
  videoCodec: "h264",
  audioCodec: "aac",
  ...over
});

/*
 * Ids are deliberately NOT in rank order: health decides the ranking here, so
 * "zulu" outranks "alpha" outranks "mike". A policy that fell back on id order
 * instead of the ranking would visibly pick the wrong stream.
 */
const zulu = candidate({ id: "zulu", healthScore: 0.99 });
const alpha = candidate({ id: "alpha", healthScore: 0.9 });
const mike = candidate({ id: "mike", healthScore: 0.8 });

const generous: FailoverPolicy = { maxAttempts: 8, maxTransientRetriesPerCandidate: 1 };

const failed = (candidateId: string, kind: PlaybackFailureKind): PlaybackAttemptFailure => ({
  candidateId,
  kind
});

/**
 * Drives the real loop to a fixed point, reporting the same failure kind every
 * time.
 *
 * The guard is not a safety net, it is the assertion: an unbounded policy would
 * trip it rather than hang the suite, and the returned `attempted` sequence is
 * what proves the ceiling was the thing that stopped it.
 */
function runToCompletion(
  candidates: readonly StreamCandidate[],
  kind: PlaybackFailureKind,
  policy: FailoverPolicy = DEFAULT_FAILOVER_POLICY
) {
  const failures: PlaybackAttemptFailure[] = [];
  const attempted: string[] = [];

  for (let guard = 0; guard <= 1000; guard++) {
    const plan = planFailover(candidates, capabilities, failures, policy);
    if (plan.next === null) return { plan, attempted };
    attempted.push(plan.next.candidate.id);
    failures.push(failed(plan.next.candidate.id, kind));
  }

  throw new Error("failover did not terminate");
}

describe("failure policy", () => {
  it("decides retryability from data, with exactly one retryable kind", () => {
    /*
     * The whole rights guarantee rests on this. Widening the retryable set is a
     * deliberate edit to this assertion, never a one-word change to the table --
     * and it can never be a side effect of a provider rewording an error string,
     * because no string is consulted anywhere in the policy.
     */
    const retryable = PLAYBACK_FAILURE_KINDS.filter(
      (kind) => PLAYBACK_FAILURE_POLICY[kind].retryable
    );
    expect(retryable).toEqual(["network_transient"]);
  });

  it("gives every kind a unique precedence", () => {
    /*
     * The point of moving precedence out of the enum's declaration order was to
     * make ONE thing decide which failure speaks for a candidate. Two kinds
     * sharing a number would hand that decision straight back to whatever order
     * the sort happened to leave them in -- the same defect wearing a number.
     */
    const precedences = PLAYBACK_FAILURE_KINDS.map(
      (kind) => PLAYBACK_FAILURE_POLICY[kind].precedence
    );

    expect(new Set(precedences).size).toBe(precedences.length);
  });

  it("keeps rights at the head of the canonical precedence order", () => {
    /*
     * Precedence is now stated as data, so this pins the STATEMENT rather than
     * an accident of how the contract's enum was typed out. `exclusionFor` walks
     * this order to decide which of a candidate's failures speaks for it, so
     * demoting `rights_unverifiable` would let a decode or transient failure
     * report for a candidate whose rights could not be established -- which is
     * why the head of the list is asserted twice: once as a position, once as
     * the minimum precedence, so neither a reordering nor a renumbering slips
     * past.
     */
    expect([...PLAYBACK_FAILURE_KINDS_BY_PRECEDENCE]).toEqual([
      "rights_unverifiable",
      "decode_failed",
      "source_unavailable",
      "network_transient"
    ]);

    const precedences = PLAYBACK_FAILURE_KINDS.map(
      (kind) => PLAYBACK_FAILURE_POLICY[kind].precedence
    );
    expect(PLAYBACK_FAILURE_POLICY.rights_unverifiable.precedence).toBe(Math.min(...precedences));
    expect(PLAYBACK_FAILURE_POLICY.rights_unverifiable.retryable).toBe(false);
    expect(PLAYBACK_FAILURE_POLICY.rights_unverifiable.exclusion).toBe("rights_not_established");
  });

  it("orders exactly the kinds the contract can report, no more and no fewer", () => {
    /*
     * Membership comes from the contract, order comes from the policy, and this
     * is the seam between them. A kind the scan omits is never tested by
     * `exclusionFor` at all: a candidate carrying only that kind stays
     * attemptable and is retried until the budget runs out, which for a rights
     * kind is precisely what invariants 1 and 2 forbid.
     */
    expect([...PLAYBACK_FAILURE_KINDS_BY_PRECEDENCE].sort()).toEqual(
      [...PLAYBACK_FAILURE_KINDS].sort()
    );
  });

  it("has a policy entry for every kind the contract can report", () => {
    // `satisfies Record<PlaybackFailureKind, ...>` already makes an omission a
    // type error; this catches the reverse -- an entry for a kind the contract
    // dropped, which the compiler is happy to keep.
    expect(Object.keys(PLAYBACK_FAILURE_POLICY).sort()).toEqual([...PLAYBACK_FAILURE_KINDS].sort());
  });

  it("resolves a multi-kind candidate by precedence, whatever the report order", () => {
    /*
     * The mechanism, tested across every pair rather than on the one pair
     * somebody thought of. Expectations are read out of the policy table, so
     * this asserts that `exclusionFor` obeys the stated precedence -- the tests
     * above are what pin the statement itself.
     *
     * Zero per-candidate retries so that every kind, including the retryable
     * one, is terminal on first occurrence and the comparison is purely about
     * precedence rather than about leftover budget.
     */
    const zeroRetries: FailoverPolicy = { maxAttempts: 8, maxTransientRetriesPerCandidate: 0 };

    for (const first of PLAYBACK_FAILURE_KINDS) {
      for (const second of PLAYBACK_FAILURE_KINDS) {
        if (first === second) continue;

        const winner =
          PLAYBACK_FAILURE_POLICY[first].precedence < PLAYBACK_FAILURE_POLICY[second].precedence
            ? first
            : second;

        const forward = planFailover(
          [zulu],
          capabilities,
          [failed("zulu", first), failed("zulu", second)],
          zeroRetries
        );
        const reverse = planFailover(
          [zulu],
          capabilities,
          [failed("zulu", second), failed("zulu", first)],
          zeroRetries
        );

        expect(forward.excluded[0]?.reason).toBe(PLAYBACK_FAILURE_POLICY[winner].exclusion);
        expect(reverse).toEqual(forward);
      }
    }
  });
});

describe("rights failures are terminal", () => {
  it("never re-offers a candidate whose rights could not be established", () => {
    // Budget deliberately left over, so the refusal cannot be mistaken for the
    // bound doing the work. Retrying here would be a rights violation dressed up
    // as robustness.
    const plan = planFailover(
      [zulu],
      capabilities,
      [failed("zulu", "rights_unverifiable")],
      generous
    );

    expect(plan.next).toBeNull();
    expect(plan.attemptsRemaining).toBeGreaterThan(0);
    expect(plan.attemptable).toEqual([]);
    expect(plan.excluded).toEqual([
      {
        candidateId: "zulu",
        reason: "rights_not_established",
        attempts: 1,
        compatibilityBeforeAttempt: "verified"
      }
    ]);
    expect(plan.reason).toBe("all_candidates_rights_blocked");
  });

  it("reports rights ahead of every other failure the same candidate collected", () => {
    // And in whichever order they were reported: precedence comes from the
    // stated policy table, not from the caller's array and not from the order
    // the contract's enum happens to list its values in.
    const forward = planFailover(
      [zulu],
      capabilities,
      [
        failed("zulu", "network_transient"),
        failed("zulu", "decode_failed"),
        failed("zulu", "rights_unverifiable")
      ],
      generous
    );
    const reverse = planFailover(
      [zulu],
      capabilities,
      [
        failed("zulu", "rights_unverifiable"),
        failed("zulu", "decode_failed"),
        failed("zulu", "network_transient")
      ],
      generous
    );

    expect(forward.excluded[0]?.reason).toBe("rights_not_established");
    expect(reverse).toEqual(forward);
  });

  it("counts a ranking-time rights refusal towards the wholesale verdict", () => {
    /*
     * Rights blocking happens at two stages -- eligibility refuses an unplayable
     * rights value, an attempt fails to establish authorization -- so the
     * "everything is rights-blocked" claim is only true if it holds across both.
     */
    const plan = planFailover(
      [
        // Deliberately bypasses the schema to simulate untrusted upstream data.
        candidate({ id: "alpha", rights: "unlicensed" as never }),
        zulu
      ],
      capabilities,
      [failed("zulu", "rights_unverifiable")],
      generous
    );

    expect(plan.reason).toBe("all_candidates_rights_blocked");
    expect(plan.decision.rejected).toEqual([
      { candidateId: "alpha", reason: "rights_not_playable" }
    ]);
  });

  it("does not claim wholesale rights blocking when only some candidates were", () => {
    // A homogeneous reason is a claim about a set. Mixed causes get the generic
    // reason plus the itemised trail, never the nearest plausible headline.
    const plan = planFailover(
      [zulu, alpha],
      capabilities,
      [failed("zulu", "rights_unverifiable"), failed("alpha", "source_unavailable")],
      generous
    );

    expect(plan.reason).toBe("candidates_exhausted");
    expect(plan.excluded.map((entry) => entry.reason)).toEqual([
      "source_unavailable",
      "rights_not_established"
    ]);
  });
});

describe("decode failures settle compatibility", () => {
  it("does not retry a decode failure, and records it as disproven", () => {
    const plan = planFailover(
      [zulu, alpha],
      capabilities,
      [failed("zulu", "decode_failed")],
      generous
    );

    expect(plan.excluded).toEqual([
      {
        candidateId: "zulu",
        reason: "compatibility_disproven",
        attempts: 1,
        compatibilityBeforeAttempt: "verified"
      }
    ]);
    expect(plan.next?.candidate.id).toBe("alpha");
    expect(plan.reason).toBe("failover_to_next_candidate");
  });

  it("distinguishes an unverified candidate proven bad from a verified one that lied", () => {
    /*
     * Both are `compatibility_disproven` and neither is retried, but they are
     * different findings. An unverified candidate failing to decode is the
     * expected way the label resolves -- the remedy is provider metadata. A
     * VERIFIED candidate failing to decode means our capability model asserted
     * something false, which is a defect worth alerting on. One line for both
     * would hide the second inside the noise of the first.
     */
    const unverified = candidate({ id: "alpha", healthScore: 0.9, videoCodec: null });

    const suspected = planFailover(
      [unverified],
      capabilities,
      [failed("alpha", "decode_failed")],
      generous
    );
    const asserted = planFailover(
      [zulu],
      capabilities,
      [failed("zulu", "decode_failed")],
      generous
    );

    expect(suspected.excluded[0]?.compatibilityBeforeAttempt).toBe("unverified");
    expect(asserted.excluded[0]?.compatibilityBeforeAttempt).toBe("verified");
  });

  it("learns nothing about metadata from a failed attempt", () => {
    // An attempt establishes decodability and decodability only. It must not
    // write back a codec, infer a height, or otherwise turn unknown into a value.
    const unverified = candidate({
      id: "alpha",
      healthScore: 0.9,
      videoCodec: null,
      height: null,
      bitrateKbps: null
    });

    const plan = planFailover(
      [unverified, zulu],
      capabilities,
      [failed("zulu", "decode_failed")],
      generous
    );

    expect(plan.next?.candidate).toEqual(unverified);
    expect(plan.next?.unknownFacts).toEqual(["videoCodec", "height", "bitrateKbps"]);
    expect(plan.next?.compatibility).toBe("unverified");
  });
});

describe("transient failures are the retryable case", () => {
  it("tries an untried candidate before retrying a better-ranked one", () => {
    /*
     * This assertion used to be the opposite -- "one blip should not hand
     * playback to a worse stream" -- and the reasoning behind it was wrong in a
     * way that only shows up against a budget. A retry is a bet that an
     * identical request to an identical URL behaves differently; `alpha` is a
     * different source. `network_transient` is the one retryable kind precisely
     * because it is the AMBIGUOUS one -- a player reports it when it cannot tell
     * a CORS rejection from a refused connection from real packet loss -- so
     * repeating `zulu` learns strictly less than trying `alpha`, even though
     * `alpha` ranks lower.
     *
     * `zulu` is not demoted and nothing is ruled out: it stays attemptable, it
     * stays at the head of the published pool, and it still gets its retry --
     * out of the budget left after the pool has been covered, which is the test
     * below.
     */
    const plan = planFailover(
      [zulu, alpha],
      capabilities,
      [failed("zulu", "network_transient")],
      generous
    );

    expect(plan.next?.candidate.id).toBe("alpha");
    // Not `retry_after_transient_failure`: the candidate handed back has never
    // been attempted, so calling this a retry would describe the wrong event.
    expect(plan.reason).toBe("failover_to_next_candidate");
    expect(plan.excluded).toEqual([]);
    // The pool is published in RANK order whatever was scheduled out of it, so
    // `next` is deliberately not its head here.
    expect(plan.attemptable).toEqual(["zulu", "alpha"]);
  });

  it("retries the best-ranked transient failure once every candidate has been tried", () => {
    // Breadth first, then depth. With nothing left untried, the remaining budget
    // goes back to the top of the ranking rather than nowhere -- the retry is
    // deferred, not cancelled.
    const plan = planFailover(
      [zulu, alpha],
      capabilities,
      [failed("zulu", "network_transient"), failed("alpha", "network_transient")],
      generous
    );

    expect(plan.next?.candidate.id).toBe("zulu");
    expect(plan.reason).toBe("retry_after_transient_failure");
    expect(plan.excluded).toEqual([]);
  });

  it("attempts a third candidate rather than spending the budget on two retries", () => {
    /*
     * THE REGRESSION, at the budget where it bites. Three authorized candidates,
     * four attempts, one retry each. The old scheduler picked by rank alone and
     * produced dash, dash, hls, hls -- then stopped with `attempt_limit_reached`
     * while `progressive` sat in `attemptable`, never tried once, despite being
     * a different source that might simply have worked.
     *
     * Driven through the real loop rather than asserted on a single plan,
     * because the defect is a property of the SEQUENCE: every individual plan
     * the old code produced was locally defensible.
     */
    const dash = candidate({ id: "aurora-fall-dash", healthScore: 0.99 });
    const hls = candidate({ id: "aurora-fall-hls", healthScore: 0.9 });
    const progressive = candidate({ id: "aurora-fall-progressive", healthScore: 0.8 });

    const { plan, attempted } = runToCompletion(
      [dash, hls, progressive],
      "network_transient",
      DEFAULT_FAILOVER_POLICY
    );

    expect(attempted).toEqual([
      "aurora-fall-dash",
      "aurora-fall-hls",
      "aurora-fall-progressive",
      // Only now, with the budget that is left over, does anything get repeated.
      "aurora-fall-dash"
    ]);
    // Stated separately from the sequence above, because THIS is the defect: the
    // third candidate was never attempted even once.
    expect(new Set(attempted).size).toBe(3);
    expect(attempted).toContain("aurora-fall-progressive");
    expect(plan.attemptsUsed).toBe(DEFAULT_FAILOVER_POLICY.maxAttempts);
    expect(plan.reason).toBe("attempt_limit_reached");
  });

  it("does not let two candidates consume a budget a third one needs", () => {
    /*
     * The same defect stated as a single plan rather than a sequence, so a
     * failure names the moment rather than the trace. Two candidates one
     * transient failure each, two attempts left: the next attempt must go to the
     * candidate that has never been tried.
     */
    const plan = planFailover(
      [zulu, alpha, mike],
      capabilities,
      [failed("zulu", "network_transient"), failed("alpha", "network_transient")],
      DEFAULT_FAILOVER_POLICY
    );

    expect(plan.next?.candidate.id).toBe("mike");
    expect(plan.reason).toBe("failover_to_next_candidate");
    expect(plan.attemptsRemaining).toBe(2);
    expect(plan.excluded).toEqual([]);
  });

  it("demotes the candidate once its own retry budget is spent", () => {
    const plan = planFailover(
      [zulu, alpha],
      capabilities,
      [failed("zulu", "network_transient"), failed("zulu", "network_transient")],
      generous
    );

    expect(plan.next?.candidate.id).toBe("alpha");
    expect(plan.reason).toBe("failover_to_next_candidate");
    expect(plan.excluded).toEqual([
      {
        candidateId: "zulu",
        reason: "transient_retries_exhausted",
        attempts: 2,
        compatibilityBeforeAttempt: "verified"
      }
    ]);
  });

  it("honours a zero per-candidate retry budget", () => {
    const plan = planFailover([zulu, alpha], capabilities, [failed("zulu", "network_transient")], {
      maxAttempts: 8,
      maxTransientRetriesPerCandidate: 0
    });

    expect(plan.next?.candidate.id).toBe("alpha");
    expect(plan.excluded[0]?.reason).toBe("transient_retries_exhausted");
  });

  it("lets a terminal failure end a candidate that still had retry budget", () => {
    // The unspent transient budget must not keep a decode-failed candidate alive.
    const plan = planFailover(
      [zulu],
      capabilities,
      [failed("zulu", "network_transient"), failed("zulu", "decode_failed")],
      generous
    );

    expect(plan.next).toBeNull();
    expect(plan.excluded[0]?.reason).toBe("compatibility_disproven");
  });
});

describe("the bound is stated, not emergent", () => {
  it("never exceeds the attempt budget however many candidates exist", () => {
    const many = Array.from({ length: 20 }, (_, index) =>
      candidate({ id: `cand-${String(index).padStart(2, "0")}`, healthScore: 0.9 })
    );

    const { plan, attempted } = runToCompletion(many, "network_transient");

    expect(attempted).toHaveLength(DEFAULT_FAILOVER_POLICY.maxAttempts);
    expect(plan.attemptsUsed).toBe(DEFAULT_FAILOVER_POLICY.maxAttempts);
    expect(plan.attemptsRemaining).toBe(0);
    expect(plan.reason).toBe("attempt_limit_reached");
    // The bound stopped it, and candidates were still available -- which is
    // exactly why this must not be reported as exhaustion.
    expect(plan.attemptable.length).toBeGreaterThan(0);
  });

  it("spends the budget across candidates rather than on one of them", () => {
    /*
     * One attempt each on four distinct streams, not two attempts each on two of
     * them, and certainly not four on the first. The per-candidate retry ceiling
     * alone was never enough to guarantee this -- it caps how deep any single
     * candidate can go but says nothing about the ORDER, so with a ceiling of
     * one, two candidates could still take two attempts apiece and close out the
     * budget. Breadth-first selection is what actually spends it across the pool.
     *
     * Every candidate here is identical apart from its id, so the ranking's
     * id-ascending tiebreak fixes the sequence exactly and a regression cannot
     * hide behind an unordered set comparison.
     */
    const many = Array.from({ length: 20 }, (_, index) =>
      candidate({ id: `cand-${String(index).padStart(2, "0")}`, healthScore: 0.9 })
    );

    const { attempted } = runToCompletion(many, "network_transient");

    expect(attempted).toEqual(["cand-00", "cand-01", "cand-02", "cand-03"]);
    expect(new Set(attempted).size).toBe(DEFAULT_FAILOVER_POLICY.maxAttempts);
  });

  it("terminates within the same bound on a large candidate set", () => {
    // The work per plan is linear in the candidate count and the number of plans
    // is capped by the policy, so a provider returning hundreds of mirrors cannot
    // turn failover into a long stall.
    const many = Array.from({ length: 250 }, (_, index) =>
      candidate({ id: `cand-${String(index).padStart(3, "0")}`, healthScore: 0.9 })
    );

    const { plan, attempted } = runToCompletion(many, "network_transient");

    expect(attempted.length).toBeLessThanOrEqual(DEFAULT_FAILOVER_POLICY.maxAttempts);
    /*
     * All 250, not 248. Four distinct candidates were attempted once each and a
     * single transient failure is within the per-candidate ceiling, so nothing
     * was ruled out -- the budget stopped this, and the pool is untouched. Under
     * the old rank-only scheduler two candidates took two attempts each and were
     * therefore excluded, which is what made this number 248.
     */
    expect(plan.attemptable).toHaveLength(250);
    expect(plan.excluded).toEqual([]);
    expect(plan.reason).toBe("attempt_limit_reached");
  });

  it("stops immediately on a budget that permits nothing", () => {
    // Total for every input, including a policy no sane caller would pass.
    const plan = planFailover([zulu], capabilities, [], {
      maxAttempts: 0,
      maxTransientRetriesPerCandidate: 0
    });

    expect(plan.next).toBeNull();
    expect(plan.reason).toBe("attempt_limit_reached");
    expect(plan.attemptsRemaining).toBe(0);
  });

  it("reports exhaustion, not the limit, when nothing is left to attempt", () => {
    // Both conditions can look true at once. Reporting the limit here would tell
    // an operator to raise a ceiling that would change nothing.
    const plan = planFailover(
      [zulu, alpha],
      capabilities,
      [
        failed("zulu", "decode_failed"),
        failed("alpha", "decode_failed"),
        failed("mike", "decode_failed"),
        failed("mike", "decode_failed")
      ],
      { maxAttempts: 4, maxTransientRetriesPerCandidate: 1 }
    );

    expect(plan.attemptsRemaining).toBe(0);
    expect(plan.reason).toBe("all_eligible_candidates_incompatible");
  });
});

describe("terminal reasons stay distinguishable", () => {
  it("says nothing was supplied", () => {
    const plan = planFailover([], capabilities);

    expect(plan.reason).toBe("no_candidates");
    expect(plan.next).toBeNull();
    expect(plan.excluded).toEqual([]);
  });

  it("says candidates existed but none was ever attemptable", () => {
    // Distinct from exhaustion: nothing was attempted, so nothing was learned.
    const plan = planFailover([candidate({ id: "zulu", videoCodec: "vp9" })], capabilities);

    expect(plan.reason).toBe("no_eligible_candidates");
    expect(plan.attemptsUsed).toBe(0);
    expect(plan.decision.rejected).toEqual([
      { candidateId: "zulu", reason: "unsupported_video_codec" }
    ]);
  });

  it("says every attemptable candidate failed to decode", () => {
    const plan = planFailover(
      [zulu, alpha],
      capabilities,
      [failed("zulu", "decode_failed"), failed("alpha", "decode_failed")],
      generous
    );

    expect(plan.reason).toBe("all_eligible_candidates_incompatible");
  });

  it("keeps the four terminal findings apart", () => {
    /*
     * The defect this guards against is a later refactor collapsing any of these
     * into a single failure value. Each sends a reader somewhere different: the
     * provider, the licensing pipeline, the device capability model, the policy
     * itself.
     */
    const exhausted = planFailover(
      [zulu, alpha],
      capabilities,
      [failed("zulu", "decode_failed"), failed("alpha", "source_unavailable")],
      generous
    ).reason;
    const limited = runToCompletion(
      Array.from({ length: 20 }, (_, index) => candidate({ id: `cand-${index}` })),
      "network_transient"
    ).plan.reason;
    const rightsBlocked = planFailover(
      [zulu],
      capabilities,
      [failed("zulu", "rights_unverifiable")],
      generous
    ).reason;
    const incompatible = planFailover(
      [zulu],
      capabilities,
      [failed("zulu", "decode_failed")],
      generous
    ).reason;

    expect([exhausted, limited, rightsBlocked, incompatible]).toEqual([
      "candidates_exhausted",
      "attempt_limit_reached",
      "all_candidates_rights_blocked",
      "all_eligible_candidates_incompatible"
    ]);
    expect(new Set([exhausted, limited, rightsBlocked, incompatible]).size).toBe(4);
  });

  it("names the finding and the budget in the readable trail", () => {
    const plan = planFailover(
      [zulu],
      capabilities,
      [failed("zulu", "rights_unverifiable")],
      generous
    );

    expect(plan.explanation).toContain("rights");
    expect(plan.explanation).toContain("1/8 attempts used");
    expect(plan.explanation).toContain("zulu=rights_not_established");
  });
});

describe("proceeding", () => {
  it("starts at the top of the ranking, not at the first id", () => {
    const plan = planFailover([alpha, mike, zulu], capabilities);

    expect(plan.reason).toBe("first_attempt");
    expect(plan.next?.candidate.id).toBe("zulu");
    expect(plan.attemptable).toEqual(["zulu", "alpha", "mike"]);
    expect(plan.attemptsUsed).toBe(0);
  });
});

describe("failures that cannot be attributed", () => {
  it("surfaces them and still charges them to the budget", () => {
    /*
     * An id that is not in the eligible pool -- no such candidate, or one
     * eligibility rejected and the caller attempted anyway. Silently dropping it
     * would let a mis-reporting caller loop forever against a bound that never
     * advances, and would hide the caller's bug completely.
     *
     * The reason is not `first_attempt`: an attempt WAS made and charged for. It
     * is not attributable to a pool member either, which is what
     * `unattributedFailures` says on the same object.
     */
    const plan = planFailover(
      [zulu],
      capabilities,
      [failed("ghost", "network_transient")],
      generous
    );

    expect(plan.unattributedFailures).toEqual(["ghost"]);
    expect(plan.attemptsUsed).toBe(1);
    expect(plan.next?.candidate.id).toBe("zulu");
    expect(plan.reason).toBe("failover_to_next_candidate");
  });

  it("dedupes and code-point orders them", () => {
    const plan = planFailover(
      [zulu],
      capabilities,
      [
        failed("apparition", "network_transient"),
        failed("Ghost", "decode_failed"),
        failed("apparition", "decode_failed")
      ],
      generous
    );

    expect(plan.unattributedFailures).toEqual(["Ghost", "apparition"]);
  });

  it("keeps the kind, so a stray rights failure is not read as a stray timeout", () => {
    /*
     * A reachable state, not a hypothetical: ranking refuses a candidate for
     * `rights_not_playable` and the caller attempts it anyway. Reduced to a bare
     * id, "someone played a stream we could not establish rights for" is
     * indistinguishable from a mistyped id attached to a timeout -- an
     * observability hole (invariant 4) on the one invariant this module exists
     * to protect.
     */
    const plan = planFailover(
      [zulu],
      capabilities,
      [failed("ghost", "rights_unverifiable")],
      generous
    );

    expect(plan.unattributedDetail).toEqual([
      { candidateId: "ghost", kinds: ["rights_unverifiable"] }
    ]);
    // The bare list is unchanged, so the addition is a sibling rather than a
    // reinterpretation of a field callers already read.
    expect(plan.unattributedFailures).toEqual(["ghost"]);
    expect(plan.explanation).toContain("ghost=rights_unverifiable");
  });

  it("orders the kinds by the contract, not by the order they were reported", () => {
    // Both coordinates are derived: ids from the code-point sort, kinds by
    // filtering `PLAYBACK_FAILURE_KINDS_BY_PRECEDENCE` -- the same order
    // `exclusionFor` resolves with, so the plan has one answer rather than two.
    // Reporting the same facts in a different sequence must not move either.
    const failures = [
      failed("ghost", "network_transient"),
      failed("apparition", "decode_failed"),
      failed("ghost", "rights_unverifiable"),
      // Deliberately repeated: kinds are a set, and the repeat is already
      // charged to `attemptsUsed`.
      failed("ghost", "network_transient")
    ];

    const forward = planFailover([zulu], capabilities, failures, generous);
    const reverse = planFailover([zulu], capabilities, [...failures].reverse(), generous);

    expect(forward.unattributedDetail).toEqual([
      { candidateId: "apparition", kinds: ["decode_failed"] },
      { candidateId: "ghost", kinds: ["rights_unverifiable", "network_transient"] }
    ]);
    expect(reverse.unattributedDetail).toEqual(forward.unattributedDetail);
    expect(forward.attemptsUsed).toBe(4);
  });
});

describe("an attempt that produced no failure kind", () => {
  /*
   * THE OTHER HALF OF "`null` IS A LEGITIMATE ANSWER".
   *
   * A reporter that cannot place an error must report nothing rather than guess
   * a kind (`apps/web/.../playback-failure.ts` rule 1), so an unclassified
   * failure never reaches `failures` and `exclusionFor` — which reads kinds and
   * only kinds — can never see it. Counting the attempt in
   * `attemptsByCandidate` made the candidate merely TRIED, which breadth-first
   * scheduling de-prioritises and then hands straight back once nothing is
   * untried: one fatally-broken stream re-loaded until the budget ran out, and a
   * plan that still called it a candidate which "remained".
   *
   * These drive `scheduleAttempts` directly rather than `planFailover`, because
   * the state under test is one only a caller that counts its own attempts can
   * be in — which is exactly why `planFailover`'s behaviour is unchanged and
   * every test above it still passes untouched.
   */
  const charged = (attemptsByCandidate: Record<string, number>) => ({
    attemptsUsed: Object.values(attemptsByCandidate).reduce((total, n) => total + n, 0),
    attemptsByCandidate
  });

  it("rules the candidate out after ONE attempt, without inventing a failure kind", () => {
    const schedule = scheduleAttempts(["zulu", "alpha"], [], generous, charged({ zulu: 1 }));

    expect(schedule.excluded).toEqual([
      { candidateId: "zulu", reason: "attempt_failed_unclassified", attempts: 1 }
    ]);
    // Not a retry, not a demotion: it is out, and `alpha` gets the next attempt.
    expect(schedule.attemptable).toEqual(["alpha"]);
    expect(schedule.next).toBe("alpha");
    expect(schedule.reason).toBe("failover_to_next_candidate");
  });

  it("stops instead of re-loading the only candidate it has, with budget to spare", () => {
    /*
     * The defect at its sharpest. One candidate, four attempts, an error nobody
     * can classify: the pool empties on the FIRST attempt and the three
     * remaining attempts buy nothing, because there is nothing left to spend
     * them on. Exhaustion outranks the budget, so the reason is about the pool.
     */
    const schedule = scheduleAttempts(["zulu"], [], DEFAULT_FAILOVER_POLICY, charged({ zulu: 1 }));

    expect(schedule.next).toBeNull();
    expect(schedule.reason).toBe("candidates_exhausted");
    expect(schedule.attemptable).toEqual([]);
    expect(schedule.attemptsRemaining).toBe(3);
  });

  it("lets the classified finding speak when a candidate carries both", () => {
    /*
     * PRECEDENCE, and it is the informative one that wins. "This device did not
     * decode this stream" is knowledge about the stream; "an attempt ended and
     * we cannot say why" is knowledge about the report. Collapsing the first
     * into the second would send a support engineer to the reporter instead of
     * to the capability model.
     */
    const schedule = scheduleAttempts(
      ["zulu"],
      [failed("zulu", "decode_failed")],
      generous,
      charged({ zulu: 2 })
    );

    expect(schedule.excluded).toEqual([
      { candidateId: "zulu", reason: "compatibility_disproven", attempts: 2 }
    ]);
  });

  it("charges the exclusion with the attempts it really cost", () => {
    // Two loads, one nameable failure. Reporting `attempts: 1` would understate
    // what the candidate cost the viewer by exactly the attempt nobody could
    // classify -- the one this whole exclusion exists to account for.
    const schedule = scheduleAttempts(
      ["zulu", "alpha"],
      [failed("zulu", "network_transient")],
      generous,
      charged({ zulu: 2 })
    );

    expect(schedule.excluded).toEqual([
      { candidateId: "zulu", reason: "attempt_failed_unclassified", attempts: 2 }
    ]);
  });

  it("never fires for a candidate nobody attempted", () => {
    const schedule = scheduleAttempts(["zulu", "alpha"], [], generous, charged({ zulu: 1 }));

    expect(schedule.excluded.map((entry) => entry.candidateId)).not.toContain("alpha");
    expect(schedule.attemptable).toContain("alpha");
  });

  it("is unreachable for planFailover, whose attempt count IS its failure count", () => {
    /*
     * The identity every published plan, property test and bug-report replay
     * depends on. `planFailover` supplies no `ChargedAttempts`, so "attempted"
     * and "reported a failure" are the same predicate and the fifth exclusion
     * reason cannot be produced by any failure list at all.
     */
    const plan = planFailover(
      [zulu, alpha, mike],
      capabilities,
      [
        failed("zulu", "network_transient"),
        failed("zulu", "network_transient"),
        failed("alpha", "decode_failed"),
        failed("mike", "rights_unverifiable")
      ],
      generous
    );

    // Id-sorted, and every one of them named by a KIND somebody reported.
    expect(plan.excluded.map((entry) => [entry.candidateId, entry.reason])).toEqual([
      ["alpha", "compatibility_disproven"],
      ["mike", "rights_not_established"],
      ["zulu", "transient_retries_exhausted"]
    ]);
  });

  it("reads the charged map by OWN key, so an id off Object.prototype cannot poison it", () => {
    /*
     * `attemptsByCandidate` is a plain object keyed by provider-supplied ids, so
     * `record["toString"]` used to return a FUNCTION rather than `undefined`,
     * `?? 0` never fired, and the value then decided both the tried/untried
     * partition and the exclusion arithmetic. One candidate named `toString`
     * would have made `toString` look retried (`fn > 0`) and reported a repeat
     * of it as `retry_after_transient_failure`.
     */
    const schedule = scheduleAttempts(
      ["constructor", "toString"],
      [],
      generous,
      charged({ constructor: 1 })
    );

    expect(schedule.excluded).toEqual([
      { candidateId: "constructor", reason: "attempt_failed_unclassified", attempts: 1 }
    ]);
    expect(schedule.next).toBe("toString");
    // The tell: `toString` is UNTRIED, so this is a failover and not a retry.
    expect(schedule.reason).toBe("failover_to_next_candidate");
  });

  it("does not call a failover the first attempt just because the budget is untouched", () => {
    /*
     * `attemptsUsed === 0` used to be the whole test for `first_attempt`, and it
     * stopped meaning "nothing has happened" as soon as a caller started
     * counting attempts for itself: a player whose engine reports a fatal error
     * BEFORE the attempt is charged arrives here with an empty budget and a
     * candidate already ruled out, and the plan announced `first_attempt` for a
     * candidate being failed over TO.
     */
    const schedule = scheduleAttempts(
      ["zulu", "alpha"],
      [failed("zulu", "decode_failed")],
      generous,
      { attemptsUsed: 0, attemptsByCandidate: {} }
    );

    expect(schedule.attemptsUsed).toBe(0);
    expect(schedule.next).toBe("alpha");
    expect(schedule.reason).toBe("failover_to_next_candidate");
  });

  it("still says first_attempt when genuinely nothing has happened", () => {
    const schedule = scheduleAttempts(["zulu", "alpha"], [], generous, {
      attemptsUsed: 0,
      attemptsByCandidate: {}
    });

    expect(schedule.reason).toBe("first_attempt");
    expect(schedule.next).toBe("zulu");
  });
});

describe("determinism", () => {
  it("produces an identical plan for the same inputs in reverse order", () => {
    /*
     * BOTH inputs reversed, and the WHOLE plan compared. The candidate list is
     * order-invariant by the ranking's guarantee; the failure list is a multiset
     * the policy only ever counts. A comparator that fell back on input order --
     * the defect already removed three times from this package -- would show up
     * here as two different plans for the same facts.
     */
    const candidates = [
      zulu,
      candidate({ id: "alpha", healthScore: 0.9, videoCodec: null }),
      mike,
      candidate({ id: "bravo", videoCodec: "vp9" }),
      candidate({ id: "kilo", healthScore: 0.4 })
    ];
    const failures = [
      failed("zulu", "network_transient"),
      failed("zulu", "network_transient"),
      failed("alpha", "decode_failed"),
      failed("kilo", "network_transient")
    ];

    const forward = planFailover(candidates, capabilities, failures, generous);
    const reverse = planFailover(
      [...candidates].reverse(),
      capabilities,
      [...failures].reverse(),
      generous
    );

    expect(reverse).toEqual(forward);
    expect(forward.next?.candidate.id).toBe("mike");
    expect(forward.excluded.map((entry) => entry.candidateId)).toEqual(["alpha", "zulu"]);
    expect(forward.unattributedFailures).toEqual(["kilo"]);
  });

  it("orders the excluded list by code point, not host collation", () => {
    // localeCompare without an explicit locale uses the host's collation, so the
    // same failures would order differently on different machines.
    const plan = planFailover(
      [candidate({ id: "a" }), candidate({ id: "B" })],
      capabilities,
      [failed("a", "decode_failed"), failed("B", "decode_failed")],
      generous
    );

    expect(plan.excluded.map((entry) => entry.candidateId)).toEqual(["B", "a"]);
  });

  it("keeps the attemptable list in rank order rather than id order", () => {
    // The one list whose order is meaning rather than presentation, and it is the
    // ranking's own order -- not a second opinion derived here that could
    // disagree with `decision.ranked`.
    const plan = planFailover([mike, alpha, zulu], capabilities, [], generous);

    expect(plan.attemptable).toEqual(["zulu", "alpha", "mike"]);
    expect(plan.attemptable).toEqual(plan.decision.ranked.map((entry) => entry.candidate.id));
  });
});

describe("a policy that cannot state a bound", () => {
  /*
   * `FailoverPolicy` is a pair of `number`s and `number` includes `NaN`.
   * `failoverPolicySchema` rejects one at the WIRE boundary, but the browser
   * calls `scheduleAttempts` with a policy that arrived as a typed object and was
   * never parsed. Every comparison against the budget is `>` or `>=` and every
   * comparison against `NaN` is false, so before `boundedPolicy` a single
   * `Number(...)` that produced `NaN` did not loosen the bound -- it REMOVED it,
   * silently, in the one direction this module exists to prevent.
   */
  it("reads a NaN attempt budget as no budget rather than as no bound", () => {
    const schedule = scheduleAttempts(["zulu", "alpha"], [], {
      maxAttempts: Number.NaN,
      maxTransientRetriesPerCandidate: 1
    });

    expect(schedule.next).toBeNull();
    expect(schedule.reason).toBe("attempt_limit_reached");
    // Not `candidates_exhausted`: both candidates are still attemptable and the
    // remedy is the policy, not the provider.
    expect(schedule.attemptable).toEqual(["zulu", "alpha"]);
    expect(schedule.attemptsRemaining).toBe(0);
  });

  it("reads a NaN per-candidate retry budget as no retries", () => {
    // The conservative direction, matching `ChargedAttempts`: an unstatable bound
    // may rule a candidate out, never in.
    const schedule = scheduleAttempts(["zulu", "alpha"], [failed("zulu", "network_transient")], {
      maxAttempts: 8,
      maxTransientRetriesPerCandidate: Number.NaN
    });

    expect(schedule.excluded).toEqual([
      { candidateId: "zulu", reason: "transient_retries_exhausted", attempts: 1 }
    ]);
    expect(schedule.next).toBe("alpha");
  });

  it("quotes the ENFORCED budget in the trail, never the stated one", () => {
    // A trail reading `0/NaN attempts used` sends its reader looking for a bound
    // the scheduler never applied -- the published-versus-enforced divergence
    // this module exists to prevent, in miniature.
    const plan = planFailover([zulu], capabilities, [], {
      maxAttempts: Number.NaN,
      maxTransientRetriesPerCandidate: 1
    });

    expect(plan.reason).toBe("attempt_limit_reached");
    expect(plan.explanation).toContain("0/0 attempts used");
    expect(plan.explanation).not.toContain("NaN");
  });

  it("leaves an infinite budget alone, because that one was meant", () => {
    // `Infinity` is a caller STATING a bound and the comparisons express it
    // exactly. Only `NaN` is never anything a caller meant.
    const schedule = scheduleAttempts(["zulu"], [], {
      maxAttempts: Number.POSITIVE_INFINITY,
      maxTransientRetriesPerCandidate: 1
    });

    expect(schedule.next).toBe("zulu");
    expect(schedule.reason).toBe("first_attempt");
    expect(schedule.attemptsRemaining).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("the shapes a client hits, asked of the scheduler directly", () => {
  /*
   * `planFailover` covers these through a ranking. These ask the SCHEDULER,
   * because that is the half `apps/web`'s playback machine runs and the half a
   * charge can reach -- and because two of the answers below are deliberately
   * different from the ranked ones. A homogeneous reason is a claim about a SET,
   * and an ordered list of ids cannot see the pre-attempt refusals three of those
   * claims rest on.
   */
  const charged = (attemptsByCandidate: Record<string, number>) => ({
    attemptsUsed: Object.values(attemptsByCandidate).reduce((total, n) => total + n, 0),
    attemptsByCandidate
  });

  it("says nothing was supplied, rather than a vacuous claim about everything", () => {
    const schedule = scheduleAttempts([], [], generous);

    expect(schedule.next).toBeNull();
    expect(schedule.reason).toBe("no_candidates");
    expect(schedule.attemptable).toEqual([]);
    expect(schedule.excluded).toEqual([]);
    expect(schedule.attemptsRemaining).toBe(generous.maxAttempts);
  });

  it("starts a single candidate at its first attempt", () => {
    const schedule = scheduleAttempts(["zulu"], [], generous);

    expect(schedule.next).toBe("zulu");
    expect(schedule.reason).toBe("first_attempt");
  });

  it("declines the wholesale rights verdict the ranked plan is entitled to make", () => {
    /*
     * THE REFINEMENT, from both ends, in one test. The same facts produce
     * `candidates_exhausted` from an id list and `all_candidates_rights_blocked`
     * from a caller holding a `PlaybackDecision` -- not because the two disagree,
     * but because the second has evidence the first was never shown: rights can
     * be refused BEFORE any attempt, and a claim about every candidate is false
     * unless it covers the ones ranking already threw out. Guessing it here would
     * be exactly the vacuous confidence the vocabulary refuses.
     */
    const failures = [failed("zulu", "rights_unverifiable"), failed("alpha", "rights_unverifiable")];

    const schedule = scheduleAttempts(["zulu", "alpha"], failures, generous);
    const plan = planFailover([zulu, alpha], capabilities, failures, generous);

    expect(schedule.reason).toBe("candidates_exhausted");
    expect(schedule.excluded.map((entry) => entry.reason)).toEqual([
      "rights_not_established",
      "rights_not_established"
    ]);
    expect(plan.reason).toBe("all_candidates_rights_blocked");
  });

  it("refuses a homogeneous reason for a pool that is rights-blocked AND unclassified", () => {
    /*
     * The mixed case the fifth exclusion reason made reachable, and the one a
     * homogeneous `every()` silently falsifies. One candidate we may not play and
     * one whose failure nobody could name are two findings with two remedies --
     * the licensing pipeline and the reporter -- so the answer is the generic
     * reason plus the itemised trail, never the nearest plausible headline.
     */
    const schedule = scheduleAttempts(
      ["zulu", "alpha"],
      [failed("zulu", "rights_unverifiable")],
      generous,
      charged({ zulu: 1, alpha: 1 })
    );

    expect(schedule.reason).toBe("candidates_exhausted");
    expect(schedule.excluded).toEqual([
      { candidateId: "alpha", reason: "attempt_failed_unclassified", attempts: 1 },
      { candidateId: "zulu", reason: "rights_not_established", attempts: 1 }
    ]);
    expect(schedule.attemptable).toEqual([]);
  });

  it("names the untried survivor when the budget is smaller than the pool", () => {
    // "We ran out of budget while a stream nobody tried remained" and "we tried
    // everything" send a reader to two different places.
    const schedule = scheduleAttempts(
      ["zulu", "alpha", "mike"],
      [failed("zulu", "decode_failed"), failed("alpha", "decode_failed")],
      { maxAttempts: 2, maxTransientRetriesPerCandidate: 1 }
    );

    expect(schedule.next).toBeNull();
    expect(schedule.reason).toBe("attempt_limit_reached");
    expect(schedule.attemptable).toEqual(["mike"]);
    expect(schedule.attemptsRemaining).toBe(0);
  });

  it("reports exhaustion, not the limit, when the budget is larger than the pool", () => {
    // Exhaustion outranks the budget: reporting the limit with six attempts left
    // would tell an operator to raise a ceiling that would change nothing.
    const schedule = scheduleAttempts(
      ["zulu", "alpha"],
      [failed("zulu", "decode_failed"), failed("alpha", "decode_failed")],
      generous
    );

    expect(schedule.next).toBeNull();
    expect(schedule.reason).toBe("candidates_exhausted");
    expect(schedule.attemptsRemaining).toBe(6);
  });

  it("lets the more informative kind speak when one candidate collected two", () => {
    // Precedence comes from the policy table, so the answer does not depend on
    // which of the two the caller happened to list first -- and a charge cannot
    // demote a classified finding to "an attempt ended and we cannot say why".
    const failures = [failed("zulu", "network_transient"), failed("zulu", "decode_failed")];

    const forward = scheduleAttempts(["zulu", "alpha"], failures, generous, charged({ zulu: 2 }));
    const reverse = scheduleAttempts(
      ["zulu", "alpha"],
      [...failures].reverse(),
      generous,
      charged({ zulu: 2 })
    );

    expect(forward.excluded).toEqual([
      { candidateId: "zulu", reason: "compatibility_disproven", attempts: 2 }
    ]);
    expect(reverse).toEqual(forward);
    expect(forward.next).toBe("alpha");
  });

  it("takes the session total from the map when that is the only count supplied", () => {
    /*
     * The half-supplied argument. A caller that supplies `attemptsByCandidate` is
     * asserting a count more complete than its own failure list -- the map exists
     * because an unclassifiable failure is absent from `failures` by contract --
     * so deriving the TOTAL from `failures.length` while the tried/untried
     * partition read the map ran the budget on the books that omit exactly those
     * attempts. Here that mistake reads as two attempts unspent that were spent.
     */
    const schedule = scheduleAttempts(
      ["zulu", "alpha"],
      [],
      { maxAttempts: 2, maxTransientRetriesPerCandidate: 1 },
      { attemptsByCandidate: { zulu: 2 } }
    );

    expect(schedule.attemptsUsed).toBe(2);
    expect(schedule.attemptsRemaining).toBe(0);
    expect(schedule.next).toBeNull();
    expect(schedule.reason).toBe("attempt_limit_reached");
    expect(schedule.attemptable).toEqual(["alpha"]);
  });
});
