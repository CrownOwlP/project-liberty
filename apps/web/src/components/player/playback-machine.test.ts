import { describe, expect, it } from "vitest";
import type { FailoverPolicy } from "@liberty/contracts/domains/failover";
import type { EngineState } from "./playback-controller";
import { recordPlaybackEffects, type RecordedPlaybackEffects } from "./playback-effects";
import {
  MAX_STREAMING_RECOVERIES_PER_CANDIDATE,
  createPlaybackActor,
  playbackPhase,
  type PlaybackActor,
  type PlaybackEvent,
  type PlaybackPhase,
  type PlaybackTrailEntry
} from "./playback-machine";
import type { PlaybackCandidate, PlaybackSession } from "./playback-session";
import { describePlaybackError } from "./shaka-error";

/*
 * NO DOM, NO ELEMENT, NO SHAKA. That is the point of the whole design rather
 * than a property of this file: the machine's four side effects are named no-ops
 * that are injected, so a five-candidate failover with position preservation and
 * a bounded recovery budget runs in this app's `node` environment with nothing
 * mocked out. Every `expect` below is about the lifecycle; none of them is about
 * whether a stub behaves like a stub.
 */

const POLICY: FailoverPolicy = { maxAttempts: 4, maxTransientRetriesPerCandidate: 1 };

function candidate(id: string): PlaybackCandidate {
  return { id, providerId: "fixture", source: { uri: `https://cdn.example.com/${id}.mpd` } };
}

function sessionOf(ids: readonly string[], startAtSeconds: number | null = null): PlaybackSession {
  return {
    contentId: "aurora-fall",
    candidates: ids.map(candidate),
    startAtSeconds,
    reasons: ["highest_eligible_score"]
  };
}

/** A `shaka.util.Error` is a plain object and is NOT `instanceof Error`. */
function shakaError(init: { severity: number; category: number; code: number; data?: readonly unknown[] }) {
  return describePlaybackError(
    { severity: init.severity, category: init.category, code: init.code, data: init.data ?? [], handled: false },
    "player-event"
  );
}

/** MANIFEST, critical. Classifies as `source_unavailable`: never retryable. */
const manifestFailure = () => shakaError({ severity: 2, category: 4, code: 4001 });
/** NETWORK/TIMEOUT, critical. Classifies as `network_transient`: retryable once. */
const timeoutFailure = () => shakaError({ severity: 2, category: 1, code: 1003 });
/** DRM, critical. Classifies as `rights_unverifiable`: never retryable, at any budget. */
const drmFailure = () => shakaError({ severity: 2, category: 6, code: 6007 });
/** NETWORK/HTTP_ERROR, RECOVERABLE. Shaka is still retrying it itself. */
const recoverableFailure = () => shakaError({ severity: 1, category: 1, code: 1002 });
/**
 * DRM, RECOVERABLE. Severity is Shaka's to choose and it does not choose it per
 * category: a licence renewal that keeps failing arrives at RECOVERABLE for as
 * long as Shaka intends to try again. The rights question is settled by the
 * CATEGORY, so this is `rights_unverifiable` exactly as the critical one is.
 */
const recoverableDrmFailure = () => shakaError({ severity: 1, category: 6, code: 6007 });
/** LOAD_INTERRUPTED. Critical, but it describes OUR control flow. */
const interruptedFailure = () => shakaError({ severity: 2, category: 7, code: 7000 });
/**
 * STREAMING (category 5), critical, and DELIBERATELY UNCLASSIFIABLE.
 *
 * `classifyPlaybackFailure` returns `null` for it by design rather than by
 * omission: category 5 mixes decode failures, transmux failures and control-flow
 * errors, so a category-level answer would be a guess, and the contract says a
 * reporter that cannot tell must report nothing. Reachable in the field for
 * Shaka categories 2/5/7/8/9/10, for NETWORK codes outside {1001,1002,1003}, and
 * for a `BAD_HTTP_STATUS` carrying an unmapped status such as 400 or 451.
 */
const unclassifiedFailure = () => shakaError({ severity: 2, category: 5, code: 3016 });
/**
 * BAD_HTTP_STATUS 451, RECOVERABLE, and the sharpest shape of the same thing.
 *
 * `classifyHttpStatus` refuses to rule on 451 — "Unavailable For Legal Reasons"
 * is not a status this player has a remedy for, and the contract says a reporter
 * that cannot tell must report nothing. Because the severity is RECOVERABLE it
 * reaches `recordCandidateFailure` only after the per-candidate recovery budget
 * is spent, which is exactly the branch that used to answer `network_transient`
 * — the one kind `PLAYBACK_FAILURE_POLICY` marks retryable. So a legal refusal
 * bought itself another `load()`.
 *
 * The URI carries a query string on purpose: the same fixture doubles as the
 * assertion that nothing routes around `redactMediaUrl` on its way into the
 * trail.
 */
const recoverableLegalRefusal = () =>
  shakaError({
    severity: 1,
    category: 1,
    code: 1001,
    /* A host of its own, distinct from the one `candidate()` builds, so the
     * "origin and path survive" assertion can only be satisfied by the redacted
     * error detail and not by the session's own candidate list. */
    data: ["https://edge-7.cdn.example.com/a.mpd?token=SIGNATURE-MUST-NOT-LEAK", 451]
  });

const ENGINE_READY: EngineState = { status: "ready" };
const ENGINE_LOADING: EngineState = { status: "loading" };
const ENGINE_DESTROYED: EngineState = { status: "destroyed" };
const ENGINE_UNAVAILABLE: EngineState = {
  status: "unavailable",
  reason: "browser_unsupported",
  error: shakaError({ severity: 2, category: 7, code: 7002 })
};

interface Harness {
  readonly actor: PlaybackActor;
  readonly effects: RecordedPlaybackEffects;
  readonly send: (event: PlaybackEvent) => void;
  readonly phase: () => PlaybackPhase;
  readonly trail: () => readonly PlaybackTrailEntry[];
}

function harness(options: { policy?: FailoverPolicy } = {}): Harness {
  const effects = recordPlaybackEffects();
  const actor = createPlaybackActor({ input: { policy: options.policy ?? POLICY }, effects });
  actor.start();
  const send = (event: PlaybackEvent): void => {
    actor.send(event);
  };
  return {
    actor,
    effects,
    send,
    phase: () => playbackPhase(actor.getSnapshot()),
    trail: () => actor.getSnapshot().context.trail
  };
}

/** Drive to the first frame of the first candidate. The common preamble. */
function playing(ids: readonly string[] = ["a", "b", "c"], policy: FailoverPolicy = POLICY): Harness {
  const h = harness({ policy });
  h.send({ type: "START" });
  h.send({ type: "ENGINE_STATE", state: ENGINE_LOADING });
  h.send({ type: "SESSION_RESOLVED", session: sessionOf(ids) });
  h.send({ type: "ENGINE_STATE", state: ENGINE_READY });
  h.send({ type: "MEDIA_PLAYING" });
  return h;
}

function kinds(trail: readonly PlaybackTrailEntry[]): string[] {
  return trail.map((entry) => entry.kind);
}

describe("engine readiness", () => {
  it("starts the first candidate when the engine becomes ready after the session", () => {
    const h = harness();
    h.send({ type: "START" });
    expect(h.phase()).toBe("resolving");
    expect(h.effects.sessionRequests).toHaveLength(1);

    h.send({ type: "SESSION_RESOLVED", session: sessionOf(["a", "b"]) });
    expect(h.phase()).toBe("engineLoading");
    expect(h.effects.loads).toHaveLength(0);

    h.send({ type: "ENGINE_STATE", state: ENGINE_READY });
    expect(h.phase()).toBe("loading");
    expect(h.effects.loads[0]?.candidate?.id).toBe("a");
  });

  it("starts the first candidate when the engine was ALREADY ready before the session", () => {
    /*
     * The deadlock this closes. The controller attaches on mount and can be
     * ready long before a session resolves, and Shaka does not replay state for
     * a late subscriber — so a machine that only ever leaves `engineLoading` on
     * an incoming event waits for one that is never sent again, and the player
     * spins forever with no error anywhere.
     */
    const h = harness();
    h.send({ type: "ENGINE_STATE", state: ENGINE_READY });
    h.send({ type: "START" });
    h.send({ type: "SESSION_RESOLVED", session: sessionOf(["a"]) });

    expect(h.phase()).toBe("loading");
    expect(h.effects.loads).toHaveLength(1);
  });

  it("stops with a reason when the engine cannot run at all", () => {
    const h = harness();
    h.send({ type: "START" });
    h.send({ type: "SESSION_RESOLVED", session: sessionOf(["a"]) });
    h.send({ type: "ENGINE_STATE", state: ENGINE_UNAVAILABLE });

    expect(h.phase()).toBe("fatal");
    expect(h.actor.getSnapshot().context.stopReason).toBe("engine_unavailable");
    expect(h.effects.loads).toHaveLength(0);
    expect(h.effects.stops).toHaveLength(1);
  });

  it("reports a granted session that named no candidates as its own reason", () => {
    const h = harness();
    h.send({ type: "START" });
    h.send({ type: "SESSION_RESOLVED", session: sessionOf([]) });

    expect(h.phase()).toBe("fatal");
    expect(h.actor.getSnapshot().context.stopReason).toBe("no_candidates");
  });
});

describe("failover is a restart, and the restart keeps the viewer's place", () => {
  it("carries the playback position into the next candidate's load", () => {
    /*
     * The constraint being modelled: Shaka has NO API to swap the source of a
     * live session. `load(newUri)` resets the stats, discards the buffer and
     * re-establishes DRM, so the position has to be handed back to the engine
     * explicitly or the viewer restarts the film.
     */
    const h = playing(["a", "b"]);
    h.send({ type: "MEDIA_TIME_UPDATE", positionSeconds: 42.5 });
    h.send({ type: "ENGINE_ERROR", error: manifestFailure() });

    expect(h.phase()).toBe("loading");
    expect(h.effects.loads).toHaveLength(2);
    expect(h.effects.loads[0]?.startAtSeconds).toBeNull();
    expect(h.effects.loads[1]?.candidate?.id).toBe("b");
    expect(h.effects.loads[1]?.startAtSeconds).toBe(42.5);
  });

  it("does not let the torn-down element's clock overwrite the preserved position", () => {
    /*
     * The bug this closes reads as "failover works, but only from the
     * beginning". Between the teardown and the resume seek the element reports
     * `timeupdate` at 0 for the OLD session; mirroring it discards the position
     * being preserved a microsecond earlier.
     */
    const h = playing(["a", "b"]);
    h.send({ type: "MEDIA_TIME_UPDATE", positionSeconds: 90 });
    h.send({ type: "ENGINE_ERROR", error: manifestFailure() });

    h.send({ type: "MEDIA_EMPTIED" });
    h.send({ type: "MEDIA_TIME_UPDATE", positionSeconds: 0 });
    h.send({ type: "MEDIA_SEEKED", positionSeconds: 0 });

    expect(h.actor.getSnapshot().context.positionSeconds).toBe(90);
    expect(h.actor.getSnapshot().context.resumeAtSeconds).toBe(90);

    /* And once the new candidate genuinely presents, the clock is ours again. */
    h.send({ type: "MEDIA_PLAYING" });
    h.send({ type: "MEDIA_TIME_UPDATE", positionSeconds: 91 });
    expect(h.actor.getSnapshot().context.positionSeconds).toBe(91);
  });

  it("records the failover in the reason trail, naming both candidates", () => {
    /* Product invariant 4. A failover with no recorded reason is the same
     * defect as a rights denial with no reason. */
    const h = playing(["a", "b"]);
    h.send({ type: "MEDIA_TIME_UPDATE", positionSeconds: 12 });
    h.send({ type: "ENGINE_ERROR", error: manifestFailure() });

    const failover = h.trail().find((entry) => entry.kind === "failover");
    expect(failover).toBeDefined();
    expect(failover?.candidateId).toBe("a");
    expect(failover?.failureKind).toBe("source_unavailable");
    expect(failover?.resumeAtSeconds).toBe(12);
    expect(failover?.detail).toContain("b");

    const failed = h.trail().find((entry) => entry.kind === "candidate_failed");
    expect(failed?.failureKind).toBe("source_unavailable");
    expect(failed?.error?.category).toBe(4);
    /* The raw Shaka error never enters the trail: it can hold a signed URL. */
    expect(Object.keys(failed?.error ?? {})).not.toContain("raw");
  });

  it("tries the untried candidate first, and defers the retry rather than cancelling it", () => {
    /*
     * THIS ASSERTION USED TO BE THE OPPOSITE — `["a","a"]` then `["a","a","b"]`
     * — and it was pinning a policy this machine had invented for itself. The
     * machine's `failingOver` branches tried a retry before a fresh candidate;
     * `@liberty/media-engine` had already been fixed to do the reverse and
     * nothing in real playback called it, so the two disagreed while comments in
     * both files said they agreed. The machine now calls `scheduleAttempts` and
     * this records the engine's answer.
     *
     * A retry is a bet that an identical request to an identical URL behaves
     * differently; `b` is a different SOURCE. `network_transient` is the only
     * retryable kind precisely because it is the AMBIGUOUS one — a player reports
     * it when it cannot tell a CORS rejection from a refused connection from real
     * packet loss — so repeating `a` learns strictly less than trying `b`.
     *
     * `a` is not demoted and nothing is ruled out: it gets its retry out of the
     * budget left once every candidate has been tried once, which is the third
     * load below.
     */
    const h = playing(["a", "b"], { maxAttempts: 4, maxTransientRetriesPerCandidate: 1 });
    h.send({ type: "ENGINE_ERROR", error: timeoutFailure() });
    expect(h.effects.loads.map((load) => load.candidate?.id)).toEqual(["a", "b"]);

    h.send({ type: "MEDIA_PLAYING" });
    h.send({ type: "ENGINE_ERROR", error: timeoutFailure() });
    expect(h.effects.loads.map((load) => load.candidate?.id)).toEqual(["a", "b", "a"]);
    expect(kinds(h.trail())).toContain("candidate_retry");
  });

  it("attempts a third candidate rather than spending the budget on two retries", () => {
    /*
     * THE REGRESSION, at the budget where it bites, and the reason the scheduling
     * policy had to stop being written twice. Three authorized candidates, four
     * attempts, one retry each. The machine's own scheduler produced a, a, b, b
     * and then stopped with `attempt_limit_reached` while `c` — a different
     * source that might simply have worked — had never been loaded once.
     *
     * `packages/media-engine/src/failover.test.ts` pins the identical sequence
     * against `planFailover`. Two tests rather than one because the defect was
     * never that the engine's policy was wrong; it was that the player did not
     * use it, and only a test driven through the real actor can catch that.
     */
    const h = playing(["a", "b", "c"], { maxAttempts: 4, maxTransientRetriesPerCandidate: 1 });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      h.send({ type: "MEDIA_PLAYING" });
      h.send({ type: "ENGINE_ERROR", error: timeoutFailure() });
    }

    const attempted = h.effects.loads.map((load) => load.candidate?.id);
    expect(attempted).toEqual([
      "a",
      "b",
      "c",
      // Only now, with the budget left over, does anything get repeated.
      "a"
    ]);
    /* Stated separately from the sequence, because THIS is the defect: the third
     * candidate was never attempted even once. */
    expect(new Set(attempted).size).toBe(3);
    expect(attempted).toContain("c");

    expect(h.phase()).toBe("fatal");
    expect(h.actor.getSnapshot().context.attemptsUsed).toBe(4);
    expect(h.actor.getSnapshot().context.stopReason).toBe("attempt_limit_reached");

    /*
     * And the trail speaks the ENGINE's vocabulary rather than a parallel set of
     * words this file chose, so a client trail and a server plan describing one
     * decision can no longer disagree about what it was.
     */
    const failover = h.trail().find((entry) => entry.kind === "failover");
    expect(failover?.detail).toContain("failover_to_next_candidate");
    const retry = h.trail().find((entry) => entry.kind === "candidate_retry");
    expect(retry?.detail).toContain("retry_after_transient_failure");
  });

  it("never retries a candidate whose rights could not be established", () => {
    /* Invariants 1 and 2: retrying is not robustness here, it is a second
     * attempt to play something we are not entitled to play. */
    const h = playing(["a"], { maxAttempts: 5, maxTransientRetriesPerCandidate: 3 });
    h.send({ type: "ENGINE_ERROR", error: drmFailure() });

    expect(h.phase()).toBe("fatal");
    expect(h.effects.loads).toHaveLength(1);
    expect(h.actor.getSnapshot().context.stopReason).toBe("all_candidates_rights_blocked");
    expect(h.actor.getSnapshot().context.failures).toEqual([
      { candidateId: "a", kind: "rights_unverifiable" }
    ]);
  });

  it("never retries a RECOVERABLE rights failure either, once its recovery budget is spent", () => {
    /*
     * The severity is not what decides retryability — the CLASSIFIER is. A
     * recoverable error that outlives `MAX_STREAMING_RECOVERIES_PER_CANDIDATE`
     * arrives at `recordCandidateFailure` having exhausted a budget, and reading
     * "budget exhausted" as `network_transient` describes how we got here rather
     * than what went wrong. `network_transient` is the only kind
     * `RETRYABLE_FAILURE_KINDS` admits, so that reading buys a DRM candidate a
     * second `load()` — invariants 1 and 2 forbid exactly that, at any budget.
     *
     * Deliberately generous bounds: the retry budget is spent here only if the
     * machine decides the failure is retryable, so a pass cannot be an artefact
     * of running out of room.
     */
    const h = playing(["a", "b"], { maxAttempts: 6, maxTransientRetriesPerCandidate: 3 });
    for (let attempt = 0; attempt <= MAX_STREAMING_RECOVERIES_PER_CANDIDATE; attempt += 1) {
      h.send({ type: "ENGINE_ERROR", error: recoverableDrmFailure() });
    }

    expect(h.effects.streamingRetries).toHaveLength(MAX_STREAMING_RECOVERIES_PER_CANDIDATE);
    /* `a` is left behind rather than re-loaded. */
    expect(h.effects.loads.map((load) => load.candidate?.id)).toEqual(["a", "b"]);
    expect(h.actor.getSnapshot().context.failures).toEqual([
      { candidateId: "a", kind: "rights_unverifiable" }
    ]);
    expect(h.trail().find((entry) => entry.kind === "candidate_retry")).toBeUndefined();
  });

  it("hands back a failure list shaped exactly like PlaybackAttemptFailure", () => {
    /* So the client trail can be fed straight into `planFailover()` without a
     * translation step that could lose or invent an attribution. */
    const h = playing(["a", "b"]);
    h.send({ type: "ENGINE_ERROR", error: manifestFailure() });
    h.send({ type: "MEDIA_PLAYING" });
    h.send({ type: "ENGINE_ERROR", error: drmFailure() });

    expect(h.actor.getSnapshot().context.failures).toEqual([
      { candidateId: "a", kind: "source_unavailable" },
      { candidateId: "b", kind: "rights_unverifiable" }
    ]);
  });
});

describe("an error the classifier could not place ends the attempt without earning a retry", () => {
  /*
   * BOTH HALVES OF `playback-failure.ts` RULE 1, and only one of them used to
   * hold. An unclassified failure does not enter `failures` — a guessed kind is
   * a claim the contract forbids — and it also DOES NOT EARN A RETRY. Because it
   * is absent from `failures`, `exclusionFor` cannot see it; counting it in
   * `attemptsByCandidate` made the candidate merely tried, and breadth-first
   * scheduling hands a tried-but-not-excluded candidate straight back the moment
   * nothing is untried. The engine now excludes it as
   * `attempt_failed_unclassified`, on the arithmetic alone, so no failure kind is
   * invented anywhere on this path.
   */

  it("loads a single fatally-broken candidate ONCE, then stops", () => {
    /*
     * The regression at its sharpest, and the case no other test drives. One
     * candidate, a budget of four, an error nobody can classify: the machine used
     * to `load()` the same dead stream four times, tell the viewer nothing new
     * three times over, and then print "attempt budget of 4 spent while 1
     * candidate(s) remained" — where the candidate that "remained" was the stream
     * that had just died four times. A false line in the reason trail is an
     * invariant-4 defect on top of three wasted loads.
     */
    const h = playing(["a"], { maxAttempts: 4, maxTransientRetriesPerCandidate: 1 });
    for (let attempt = 0; attempt < 6; attempt += 1) {
      h.send({ type: "MEDIA_PLAYING" });
      h.send({ type: "ENGINE_ERROR", error: unclassifiedFailure() });
    }

    expect(h.effects.loads.map((load) => load.candidate?.id)).toEqual(["a"]);
    expect(h.phase()).toBe("fatal");
    expect(h.actor.getSnapshot().context.attemptsUsed).toBe(1);

    /* Exhaustion, not the budget: three attempts were still unspent and there
     * was simply nothing left to spend them on. */
    expect(h.actor.getSnapshot().context.stopReason).toBe("candidates_exhausted");

    /* And nothing was invented to achieve it. The failure list stays empty, the
     * trail carries the event with no kind, and the finding is stated in the
     * engine's exclusion vocabulary where it belongs. */
    expect(h.actor.getSnapshot().context.failures).toEqual([]);
    const failed = h.trail().find((entry) => entry.kind === "candidate_failed");
    expect(failed?.failureKind).toBeNull();
    expect(failed?.candidateId).toBe("a");
    const stopped = h.trail().find((entry) => entry.kind === "stopped");
    expect(stopped?.detail).toContain("a=attempt_failed_unclassified");
  });

  it("gives two unclassifiable candidates one attempt each, not the whole budget", () => {
    /*
     * The second shape of the same defect. With nothing untried left, `head`
     * falls back to the pool's own head, so `a` sat permanently at the front: it
     * used to collect three loads to `b`'s one out of a four-attempt budget. A
     * candidate that taught us nothing is not a better bet than one we have
     * never tried, and after one attempt each there is nothing to prefer between
     * them because both are out.
     */
    const h = playing(["a", "b"], { maxAttempts: 4, maxTransientRetriesPerCandidate: 1 });
    for (let attempt = 0; attempt < 6; attempt += 1) {
      h.send({ type: "MEDIA_PLAYING" });
      h.send({ type: "ENGINE_ERROR", error: unclassifiedFailure() });
    }

    expect(h.effects.loads.map((load) => load.candidate?.id)).toEqual(["a", "b"]);
    expect(h.actor.getSnapshot().context.stopReason).toBe("candidates_exhausted");
    expect(h.actor.getSnapshot().context.failures).toEqual([]);
    /* The failover between them is a failover and says so — it is not the first
     * attempt of the session and it is not a retry of anything. */
    const failover = h.trail().find((entry) => entry.kind === "failover");
    expect(failover?.detail).toContain("a -> b: failover_to_next_candidate");
    expect(h.trail().find((entry) => entry.kind === "candidate_retry")).toBeUndefined();
    const stopped = h.trail().find((entry) => entry.kind === "stopped");
    expect(stopped?.detail).toContain("a=attempt_failed_unclassified");
    expect(stopped?.detail).toContain("b=attempt_failed_unclassified");
  });

  it("treats a media element error with no code the same way", () => {
    /*
     * The other reachable route, and `player-surface.tsx` documents it as a real
     * degradation path rather than a hypothetical: a `<video>` error whose
     * `MediaError` is missing tells us the element gave up and nothing else.
     */
    const h = playing(["a", "b"], { maxAttempts: 4, maxTransientRetriesPerCandidate: 1 });
    h.send({ type: "MEDIA_ERROR", mediaErrorCode: null });
    h.send({ type: "MEDIA_PLAYING" });
    h.send({ type: "MEDIA_ERROR", mediaErrorCode: null });

    expect(h.effects.loads.map((load) => load.candidate?.id)).toEqual(["a", "b"]);
    expect(h.phase()).toBe("fatal");
    expect(h.actor.getSnapshot().context.failures).toEqual([]);
  });

  it("does not call a failover the first attempt when the error arrived before the load", () => {
    /*
     * `ENGINE_ERROR` in `engineLoading`, before the engine ever reached `ready`,
     * so no attempt has been charged. The scheduler used to read the untouched
     * budget as "nothing has happened yet" and hand back `first_attempt` for a
     * candidate being failed over TO — printing `a -> b: first_attempt`, which
     * describes neither the candidate nor the event. `a` is already ruled out at
     * that point, and an exclusion is history whatever the budget says.
     */
    const h = harness({ policy: { maxAttempts: 4, maxTransientRetriesPerCandidate: 1 } });
    h.send({ type: "START" });
    h.send({ type: "ENGINE_STATE", state: ENGINE_LOADING });
    h.send({ type: "SESSION_RESOLVED", session: sessionOf(["a", "b"]) });
    expect(h.phase()).toBe("engineLoading");
    expect(h.actor.getSnapshot().context.attemptsUsed).toBe(0);

    h.send({ type: "ENGINE_ERROR", error: manifestFailure() });

    const failover = h.trail().find((entry) => entry.kind === "failover");
    expect(failover?.detail).toContain("a -> b: failover_to_next_candidate");
    expect(failover?.detail).not.toContain("first_attempt");
    expect(h.effects.loads.map((load) => load.candidate?.id)).toEqual(["b"]);
  });

  it("does not answer a RECOVERABLE error it cannot place with a retryable kind", () => {
    /*
     * THE REGRESSION THIS FILE EXISTS TO PIN. `recordCandidateFailure` used to
     * fall back to `network_transient` for any non-fatal error the classifier
     * could not place, reasoning that a non-fatal error reaching that branch has
     * spent its recovery budget and that "is" a transient exhaustion. Every step
     * of that is true and the conclusion is a guessed kind — the ONE kind
     * `PLAYBACK_FAILURE_POLICY` marks retryable.
     *
     * A RECOVERABLE 451 is where it bit. One candidate, four attempts of budget:
     * the fallback recorded `network_transient`, `exclusionFor` left the
     * candidate attemptable because one transient failure is inside a
     * per-candidate budget of one, and `failingOver` re-loaded it — a second
     * attempt to play something a legal refusal had just declined, which
     * invariants 1 and 2 forbid at any budget. It loads ONCE now, and the
     * candidate leaves the pool on the arithmetic alone.
     */
    const h = playing(["a"], { maxAttempts: 4, maxTransientRetriesPerCandidate: 1 });
    for (let attempt = 0; attempt <= MAX_STREAMING_RECOVERIES_PER_CANDIDATE; attempt += 1) {
      h.send({ type: "ENGINE_ERROR", error: recoverableLegalRefusal() });
    }

    expect(h.effects.streamingRetries).toHaveLength(MAX_STREAMING_RECOVERIES_PER_CANDIDATE);
    expect(h.effects.loads.map((load) => load.candidate?.id)).toEqual(["a"]);
    expect(h.phase()).toBe("fatal");

    /* Nothing was claimed. The trail carries the event with no kind, and the
     * finding is stated in the engine's exclusion vocabulary. */
    expect(h.actor.getSnapshot().context.failures).toEqual([]);
    const failed = h.trail().find((entry) => entry.kind === "candidate_failed");
    expect(failed?.failureKind).toBeNull();
    expect(h.actor.getSnapshot().context.stopReason).toBe("candidates_exhausted");
    expect(h.trail().find((entry) => entry.kind === "stopped")?.detail).toContain(
      "a=attempt_failed_unclassified"
    );
    expect(h.trail().find((entry) => entry.kind === "candidate_retry")).toBeUndefined();
  });

  it("names the recovery bound in the trail, since it is not on the wire", () => {
    /*
     * `MAX_STREAMING_RECOVERIES_PER_CANDIDATE` is a second per-candidate bound
     * that no session response states, so the limit a viewer experiences is the
     * product of two policies. It cannot go on the wire — `retryStreaming()` is
     * an optional member of the engine port — so it is published where it decides
     * something instead. Without this line a support engineer sees a run of
     * recoverable errors end for no stated reason.
     */
    const h = playing(["a", "b"], { maxAttempts: 4, maxTransientRetriesPerCandidate: 0 });
    for (let attempt = 0; attempt <= MAX_STREAMING_RECOVERIES_PER_CANDIDATE; attempt += 1) {
      h.send({ type: "ENGINE_ERROR", error: recoverableFailure() });
    }

    const failed = h.trail().find((entry) => entry.kind === "candidate_failed");
    expect(failed?.detail).toContain(
      `${MAX_STREAMING_RECOVERIES_PER_CANDIDATE} stream recoveries allowed on one candidate`
    );

    /* A FATAL failure was never subject to that bound and does not mention it. */
    const g = playing(["a", "b"]);
    g.send({ type: "ENGINE_ERROR", error: manifestFailure() });
    expect(g.trail().find((entry) => entry.kind === "candidate_failed")?.detail).not.toContain(
      "stream recoveries"
    );
  });

  it("keeps a signed query string out of the trail on every entry it writes", () => {
    /*
     * `redactMediaUrl` strips a media URL to origin and path because an error
     * object is the one place a credential travels without anyone deciding to log
     * it. The check that matters is not that the redactor works — `shaka-error`'s
     * own suite covers that — but that nothing ROUTES AROUND it: the trail is the
     * most likely thing to be serialised, into telemetry by PL-0503 or into a bug
     * report by a human, and it is assembled from `detail`, from `message` and
     * from prose this file writes.
     */
    const h = playing(["a"], { maxAttempts: 4, maxTransientRetriesPerCandidate: 1 });
    for (let attempt = 0; attempt <= MAX_STREAMING_RECOVERIES_PER_CANDIDATE; attempt += 1) {
      h.send({ type: "ENGINE_ERROR", error: recoverableLegalRefusal() });
    }

    const serialised = JSON.stringify(h.trail());
    expect(serialised).not.toContain("SIGNATURE-MUST-NOT-LEAK");
    expect(serialised).not.toContain("token=");
    /* The half that IS wanted: origin and path survive, because they are what
     * identify a failing CDN edge. */
    expect(serialised).toContain("https://edge-7.cdn.example.com/a.mpd");

    /* And `raw` — which holds the unredacted original for a debugger — never
     * reaches the trail at all. `summarisePlaybackError` drops it by listing the
     * fields it keeps rather than by spreading and deleting. */
    for (const entry of h.trail()) {
      expect(entry.error === null || !("raw" in entry.error)).toBe(true);
    }
  });
});

describe("the first attempt is governed by the same policy as every later one", () => {
  /*
   * `engineLoading -> loading` used to charge an attempt and issue a `load()`
   * without asking the schedule whether the budget admitted one, so `maxAttempts`
   * governed attempts 2..n and exempted attempt 1.
   *
   * `failoverPolicySchema` refuses a non-positive `maxAttempts` at the WIRE
   * boundary, but `PlaybackMachineInput.policy` is a `FailoverPolicy` type and
   * not a parse of one — which is the same reason `boundedPolicy` exists inside
   * `scheduleAttempts`. `failoverPolicyArb` generates from 1 upwards, so the
   * property suite cannot reach any of this; these are the cases it cannot see.
   */

  function readied(policy: FailoverPolicy): Harness {
    const h = harness({ policy });
    h.send({ type: "START" });
    h.send({ type: "SESSION_RESOLVED", session: sessionOf(["a", "b"]) });
    h.send({ type: "ENGINE_STATE", state: ENGINE_READY });
    return h;
  }

  it("issues no load at all when the budget admits no attempt", () => {
    const h = readied({ maxAttempts: 0, maxTransientRetriesPerCandidate: 1 });

    expect(h.effects.loads).toEqual([]);
    expect(h.actor.getSnapshot().context.attemptsUsed).toBe(0);
    expect(h.phase()).toBe("fatal");
    expect(h.actor.getSnapshot().context.stopReason).toBe("attempt_limit_reached");
    /* And it says which streams a raised limit would have reached, which is the
     * remedy an operator reading this needs. */
    expect(h.trail().find((entry) => entry.kind === "stopped")?.detail).toContain(
      "attempt budget of 0 spent while 2 candidate(s) had never been tried: a, b"
    );
  });

  it("enforces a NaN budget as zero and says that is what it did", () => {
    /*
     * Every comparison against `NaN` is false, so an unrepaired `NaN` would mean
     * NO bound — an unbounded reload loop pointed at a CDN. `boundedPolicy` reads
     * it as the most conservative bound, and the trail quotes the bound that was
     * ENFORCED. The bound that was SUPPLIED is named too: hiding a caller's bug
     * behind a plausible `0` would make it look like a deliberate policy.
     */
    const h = readied({ maxAttempts: Number.NaN, maxTransientRetriesPerCandidate: 1 });

    expect(h.effects.loads).toEqual([]);
    expect(h.phase()).toBe("fatal");
    const stopped = h.trail().find((entry) => entry.kind === "stopped");
    expect(stopped?.detail).toContain("attempt budget of 0 (enforced;");
    expect(stopped?.detail).toContain("the policy supplied NaN");
  });

  it("still spends a budget of one on the first candidate", () => {
    /* The guard is a bound, not a new refusal: the smallest budget the wire
     * contract can express buys exactly one attempt. */
    const h = readied({ maxAttempts: 1, maxTransientRetriesPerCandidate: 0 });

    expect(h.effects.loads.map((load) => load.candidate?.id)).toEqual(["a"]);
    expect(h.actor.getSnapshot().context.attemptsUsed).toBe(1);
    expect(h.phase()).toBe("loading");
  });

  it("rebuilds a destroyed engine even with the budget spent, because that is not an attempt", () => {
    /*
     * The asymmetry is the point. A React remount or a DOM move destroys the
     * Shaka session through no fault of the candidate, so the rebuild is not
     * charged — and it must not be REFUSABLE either. Stranding a viewer forty
     * minutes into a film because the attempt budget happens to be spent would be
     * enforcing the policy against an event the policy is not about.
     */
    const h = playing(["a"], { maxAttempts: 1, maxTransientRetriesPerCandidate: 0 });
    h.send({ type: "MEDIA_TIME_UPDATE", positionSeconds: 2400 });
    expect(h.actor.getSnapshot().context.attemptsUsed).toBe(1);

    h.send({ type: "ENGINE_STATE", state: ENGINE_DESTROYED });
    h.send({ type: "ENGINE_STATE", state: ENGINE_READY });

    expect(h.actor.getSnapshot().context.attemptsUsed).toBe(1);
    expect(h.effects.loads.map((load) => load.candidate?.id)).toEqual(["a", "a"]);
    expect(h.effects.loads[1]?.startAtSeconds).toBe(2400);
    expect(h.actor.getSnapshot().context.stopReason).toBeNull();
  });

  it("charges an engine rebuild that happens before any attempt, because it is one", () => {
    /*
     * A destruction arriving before the engine was ever ready — a React
     * StrictMode double-mount does exactly this — must not buy a load through the
     * reattach exemption, which is the one door that charges nothing and (since
     * the budget guard landed) refuses nothing. An uncharged first load is also
     * invisible to `scheduleAttempts`: the candidate would look untried, so
     * `charges > kinds.length` would stay false and `attempt_failed_unclassified`
     * could never fire for it.
     *
     * Two mechanisms keep it out and this pins the OUTCOME rather than either of
     * them. `engineLoading` shadows `active`'s destroyed branch, so the flag is
     * never raised here at all; and `isReattach` requires a charged attempt, so
     * the exemption would refuse the load even if it were. The first is a
     * shadowing rule in another node written for another reason — exactly the kind
     * of accidental safety this assertion exists to notice the loss of.
     */
    const h = harness({ policy: { maxAttempts: 4, maxTransientRetriesPerCandidate: 1 } });
    h.send({ type: "START" });
    h.send({ type: "SESSION_RESOLVED", session: sessionOf(["a", "b"]) });
    h.send({ type: "ENGINE_STATE", state: ENGINE_DESTROYED });
    h.send({ type: "ENGINE_STATE", state: ENGINE_READY });

    expect(h.effects.loads.map((load) => load.candidate?.id)).toEqual(["a"]);
    expect(h.actor.getSnapshot().context.attemptsUsed).toBe(1);
    expect(h.actor.getSnapshot().context.attemptsByCandidate).toEqual({ a: 1 });
    expect(h.actor.getSnapshot().context.reattaching).toBe(false);

    /* And because it was charged, an unclassifiable failure on it now rules the
     * candidate out instead of leaving it looking untried for ever. */
    h.send({ type: "ENGINE_ERROR", error: unclassifiedFailure() });
    expect(h.effects.loads.map((load) => load.candidate?.id)).toEqual(["a", "b"]);
  });

  it("refuses no rebuild it would previously have allowed, once an attempt is charged", () => {
    /* The guard narrows the reattach branch; it must not narrow it for the case
     * it was written for. Two destructions in a row, mid-playback, still cost
     * nothing. */
    const h = playing(["a", "b"], { maxAttempts: 2, maxTransientRetriesPerCandidate: 0 });
    for (let round = 0; round < 2; round += 1) {
      h.send({ type: "ENGINE_STATE", state: ENGINE_DESTROYED });
      h.send({ type: "ENGINE_STATE", state: ENGINE_READY });
      h.send({ type: "MEDIA_PLAYING" });
    }

    expect(h.actor.getSnapshot().context.attemptsUsed).toBe(1);
    expect(h.effects.loads.map((load) => load.candidate?.id)).toEqual(["a", "a", "a"]);
    expect(h.actor.getSnapshot().context.stopReason).toBeNull();
  });
});

describe("bounds", () => {
  it("does not retry a fatal error forever: the candidate pool runs out", () => {
    const h = playing(["a"], { maxAttempts: 6, maxTransientRetriesPerCandidate: 0 });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      h.send({ type: "ENGINE_ERROR", error: manifestFailure() });
    }

    expect(h.phase()).toBe("fatal");
    expect(h.effects.loads).toHaveLength(1);
    expect(h.actor.getSnapshot().context.stopReason).toBe("candidates_exhausted");
  });

  it("separates a spent attempt budget from an exhausted candidate pool", () => {
    /*
     * `@liberty/media-engine` keeps these apart and so does this: "we ran out of
     * budget while streams remained" sends a reader to the policy and "we tried
     * everything" sends them to the provider. A single `failover_failed` sends
     * them nowhere.
     */
    const h = playing(["a", "b", "c", "d", "e"], { maxAttempts: 3, maxTransientRetriesPerCandidate: 0 });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      h.send({ type: "ENGINE_ERROR", error: manifestFailure() });
    }

    expect(h.phase()).toBe("fatal");
    expect(h.effects.loads).toHaveLength(3);
    expect(h.actor.getSnapshot().context.stopReason).toBe("attempt_limit_reached");
  });

  it("treats a recoverable error as recovery, not as the end of the session", () => {
    const h = playing(["a", "b"]);
    h.send({ type: "MEDIA_TIME_UPDATE", positionSeconds: 10 });
    h.send({ type: "ENGINE_ERROR", error: recoverableFailure() });

    expect(h.phase()).toBe("recovering");
    expect(h.effects.streamingRetries).toHaveLength(1);
    expect(h.effects.loads).toHaveLength(1);
    expect(h.actor.getSnapshot().context.stopReason).toBeNull();
    expect(h.actor.getSnapshot().context.failures).toEqual([]);

    /* The element's own clock moving forward is what says the stall is over —
     * Shaka often resumes without ever firing `playing`. */
    h.send({ type: "MEDIA_TIME_UPDATE", positionSeconds: 11 });
    expect(h.phase()).toBe("playing");
  });

  it("stops recovering the same candidate forever and promotes it to a failover", () => {
    /* Shaka never raises a CRITICAL for a segment it is still retrying, so
     * without a bound this state is a player that never gives up on a dead
     * stream. */
    /* Zero per-candidate transient retries, so the promotion is visible as a
     * move to the next candidate rather than as a retry of this one — the retry
     * bound has its own test above. */
    const h = playing(["a", "b"], { maxAttempts: 4, maxTransientRetriesPerCandidate: 0 });
    for (let attempt = 0; attempt <= MAX_STREAMING_RECOVERIES_PER_CANDIDATE; attempt += 1) {
      h.send({ type: "ENGINE_ERROR", error: recoverableFailure() });
    }

    expect(h.effects.streamingRetries).toHaveLength(MAX_STREAMING_RECOVERIES_PER_CANDIDATE);
    expect(h.effects.loads.map((load) => load.candidate?.id)).toEqual(["a", "b"]);
    expect(h.actor.getSnapshot().context.failures).toEqual([
      { candidateId: "a", kind: "network_transient" }
    ]);
  });

  it("never charges the candidate for an error we caused ourselves", () => {
    /* LOAD_INTERRUPTED arrives with CRITICAL severity but describes our own
     * control flow — usually the `load()` we superseded. Charging it would make
     * every failover look like a fault caused by the candidate it failed over
     * TO, and would spend the budget twice as fast as the policy says. */
    const h = playing(["a", "b"]);
    h.send({ type: "ENGINE_ERROR", error: interruptedFailure() });

    expect(h.phase()).toBe("playing");
    expect(h.effects.loads).toHaveLength(1);
    expect(h.actor.getSnapshot().context.failures).toEqual([]);
  });

  it("caps the trail and says how much it dropped", () => {
    const h = playing(["a"]);
    for (let tick = 0; tick < 400; tick += 1) {
      h.send({ type: "ENGINE_ERROR", error: interruptedFailure() });
      h.send({ type: "MEDIA_WAITING" });
      h.send({ type: "MEDIA_PLAYING" });
    }

    const context = h.actor.getSnapshot().context;
    expect(context.trail.length).toBeLessThanOrEqual(200);
    /* A silently truncated reason trail is worse than a short one: it reads as
     * a complete account of a session that it is not. */
    expect(context.trailDropped).toBeGreaterThan(0);
  });
});

describe("the engine going away is not the candidate's fault", () => {
  it("rebuilds and resumes the SAME candidate without spending the attempt budget", () => {
    /* A React remount or a DOM move destroys the Shaka session. Charging that
     * to the failover budget would let two reparents burn a viewer's fallbacks. */
    const h = playing(["a", "b"]);
    h.send({ type: "MEDIA_TIME_UPDATE", positionSeconds: 30 });

    h.send({ type: "ENGINE_STATE", state: ENGINE_DESTROYED });
    expect(h.phase()).toBe("engineLoading");
    expect(kinds(h.trail())).toContain("engine_lost");

    h.send({ type: "ENGINE_STATE", state: ENGINE_LOADING });
    h.send({ type: "ENGINE_STATE", state: ENGINE_READY });

    expect(h.phase()).toBe("loading");
    expect(h.effects.loads.map((load) => load.candidate?.id)).toEqual(["a", "a"]);
    expect(h.effects.loads[1]?.startAtSeconds).toBe(30);
    expect(h.actor.getSnapshot().context.attemptsUsed).toBe(1);
    expect(h.actor.getSnapshot().context.failures).toEqual([]);
  });

  it("ignores the dead element's clock for the whole time the engine is being rebuilt", () => {
    /*
     * The window a failover does not have. `failingOver -> loading` completes in
     * one macrostep, so nothing can be delivered between preserving the position
     * and marking the clock as not ours. A rebuild is two separate events with
     * an unbounded gap between them — `engineLoading` sits there waiting for the
     * new engine — and the region-level mirrors are live the whole time. The
     * element that Shaka just tore down reports 0, and `finiteSeconds(0)` is `0`
     * rather than `null`, so an unguarded mirror writes the zero straight over
     * the position the viewer is standing at.
     */
    const h = playing(["a", "b"]);
    h.send({ type: "MEDIA_TIME_UPDATE", positionSeconds: 55 });

    h.send({ type: "ENGINE_STATE", state: ENGINE_DESTROYED });
    expect(h.phase()).toBe("engineLoading");

    h.send({ type: "MEDIA_TIME_UPDATE", positionSeconds: 0 });
    h.send({ type: "MEDIA_SEEKED", positionSeconds: 0 });
    expect(h.actor.getSnapshot().context.positionSeconds).toBe(55);

    h.send({ type: "ENGINE_STATE", state: ENGINE_LOADING });
    h.send({ type: "ENGINE_STATE", state: ENGINE_READY });
    expect(h.effects.loads[1]?.candidate?.id).toBe("a");
    expect(h.effects.loads[1]?.startAtSeconds).toBe(55);

    /* And the rebuilt session's first frame hands the clock back. */
    h.send({ type: "MEDIA_PLAYING" });
    h.send({ type: "MEDIA_TIME_UPDATE", positionSeconds: 56 });
    expect(h.actor.getSnapshot().context.positionSeconds).toBe(56);
  });
});

describe("the machine is a mirror, so nothing it is told is an error", () => {
  it("handles an event in a state that cannot receive it, rather than throwing", () => {
    const h = harness();
    expect(() => h.send({ type: "MEDIA_PLAYING" })).not.toThrow();

    expect(h.phase()).toBe("idle");
    expect(h.actor.getSnapshot().context.unroutedEvents).toBe(1);
    expect(h.actor.getSnapshot().context.lastUnroutedEvent).toBe("MEDIA_PLAYING");
  });

  it("accepts every event in every reachable phase", () => {
    /*
     * The acceptance criterion, asserted directly: every engine and media event
     * has an inbound transition even in states where it supposedly cannot occur.
     * `failingOver` is absent because it is eventless and leaves within the same
     * step — there is no moment at which an event can be delivered to it.
     */
    const phases: readonly PlaybackPhase[] = [
      "idle",
      "resolving",
      "engineLoading",
      "loading",
      "playing",
      "buffering",
      "seeking",
      "recovering",
      "ended",
      "fatal"
    ];

    const everyEvent: readonly PlaybackEvent[] = [
      { type: "START" },
      { type: "SESSION_RESOLVED", session: sessionOf(["x", "y"]) },
      { type: "SESSION_UNAVAILABLE", reasons: ["provider_unreachable"] },
      { type: "RETRY" },
      { type: "ENGINE_STATE", state: ENGINE_LOADING },
      { type: "ENGINE_STATE", state: ENGINE_READY },
      { type: "ENGINE_STATE", state: ENGINE_DESTROYED },
      { type: "ENGINE_STATE", state: ENGINE_UNAVAILABLE },
      { type: "ENGINE_ERROR", error: manifestFailure() },
      { type: "ENGINE_ERROR", error: recoverableFailure() },
      { type: "ENGINE_ERROR", error: interruptedFailure() },
      { type: "MEDIA_LOAD_START" },
      { type: "MEDIA_LOADED_METADATA", durationSeconds: 120 },
      { type: "MEDIA_CAN_PLAY" },
      { type: "MEDIA_PLAYING" },
      { type: "MEDIA_WAITING" },
      { type: "MEDIA_STALLED" },
      { type: "MEDIA_SEEKING", positionSeconds: 5 },
      { type: "MEDIA_SEEKED", positionSeconds: 5 },
      { type: "MEDIA_TIME_UPDATE", positionSeconds: 6 },
      { type: "MEDIA_DURATION_CHANGE", durationSeconds: null },
      { type: "MEDIA_PLAY" },
      { type: "MEDIA_PAUSE" },
      { type: "MEDIA_ENDED" },
      { type: "MEDIA_EMPTIED" },
      { type: "MEDIA_ERROR", mediaErrorCode: 3 },
      { type: "MEDIA_ERROR", mediaErrorCode: 1 },
      { type: "MEDIA_ERROR", mediaErrorCode: null }
    ];

    for (const phase of phases) {
      for (const event of everyEvent) {
        const h = actorAt(phase);
        expect(h.phase(), `${phase} should reach itself`).toBe(phase);
        expect(() => h.send(event), `${event.type} in ${phase}`).not.toThrow();
        expect(h.actor.getSnapshot().status, `${event.type} in ${phase}`).toBe("active");
      }
    }
  });

  it("keeps mirroring the element after the session has stopped", () => {
    /* `fatal` is not a final state on purpose: a stopped actor cannot mirror
     * the teardown events that still arrive, and silence after a failure is
     * exactly the desync the mirror rule exists to prevent. */
    const h = playing(["a"], { maxAttempts: 1, maxTransientRetriesPerCandidate: 0 });
    h.send({ type: "ENGINE_ERROR", error: manifestFailure() });
    expect(h.phase()).toBe("fatal");

    h.send({ type: "MEDIA_PAUSE" });
    h.send({ type: "MEDIA_TIME_UPDATE", positionSeconds: 7 });
    h.send({ type: "ENGINE_STATE", state: ENGINE_DESTROYED });

    const context = h.actor.getSnapshot().context;
    expect(context.paused).toBe(true);
    expect(context.positionSeconds).toBe(7);
    expect(context.engine.status).toBe("destroyed");
    expect(h.phase()).toBe("fatal");
  });

  it("lets a viewer scrub backwards out of the end of the media", () => {
    const h = playing(["a"]);
    h.send({ type: "MEDIA_ENDED" });
    expect(h.phase()).toBe("ended");

    h.send({ type: "MEDIA_SEEKING", positionSeconds: 20 });
    expect(h.phase()).toBe("seeking");
    expect(h.actor.getSnapshot().context.positionSeconds).toBe(20);
  });

  it("mirrors pause without modelling it as a state", () => {
    /* Pause belongs to the controls layer. It is a fact here and never a state,
     * because the moment it is a state there are two opinions about it. */
    const h = playing(["a"]);
    h.send({ type: "MEDIA_PAUSE" });
    expect(h.phase()).toBe("playing");
    expect(h.actor.getSnapshot().context.paused).toBe(true);

    h.send({ type: "MEDIA_PLAY" });
    expect(h.actor.getSnapshot().context.paused).toBe(false);
  });
});

describe("purity", () => {
  it("runs a full failover with the default no-op effects and no element at all", () => {
    /*
     * Constructed WITHOUT `effects`, so every side effect is the named no-op
     * from `playback-effects.ts`. The lifecycle is identical, which is the
     * property that makes the machine safe to reason about: it decides, it does
     * not drive.
     */
    const actor = createPlaybackActor({ input: { policy: POLICY } });
    actor.start();
    actor.send({ type: "START" });
    actor.send({ type: "ENGINE_STATE", state: ENGINE_READY });
    actor.send({ type: "SESSION_RESOLVED", session: sessionOf(["a", "b"]) });
    actor.send({ type: "MEDIA_PLAYING" });
    actor.send({ type: "ENGINE_ERROR", error: manifestFailure() });
    actor.send({ type: "MEDIA_PLAYING" });
    actor.send({ type: "ENGINE_ERROR", error: manifestFailure() });

    expect(playbackPhase(actor.getSnapshot())).toBe("fatal");
    expect(actor.getSnapshot().context.stopReason).toBe("candidates_exhausted");
    expect(kinds(actor.getSnapshot().context.trail)).toContain("failover");
  });

  it("produces the same trail for the same events, twice", () => {
    /* There is no clock in the machine — no `Date.now()`, no delayed
     * transition — so two runs of one script are byte-identical. This project
     * has had six order-dependence defects and treats determinism as
     * correctness. */
    const run = () => {
      const h = playing(["a", "b"]);
      h.send({ type: "MEDIA_TIME_UPDATE", positionSeconds: 3 });
      h.send({ type: "ENGINE_ERROR", error: recoverableFailure() });
      h.send({ type: "ENGINE_ERROR", error: manifestFailure() });
      h.send({ type: "MEDIA_PLAYING" });
      h.send({ type: "MEDIA_ENDED" });
      return h.trail();
    };

    expect(run()).toEqual(run());
  });
});

/* -------------------------------------------------------------------------
 * Phase builders, kept at the bottom because they are scaffolding.
 * ---------------------------------------------------------------------- */

function actorAt(phase: PlaybackPhase): Harness {
  const h = harness({ policy: phase === "fatal" ? { maxAttempts: 1, maxTransientRetriesPerCandidate: 0 } : POLICY });
  if (phase === "idle") return h;

  h.send({ type: "START" });
  if (phase === "resolving") return h;

  h.send({ type: "SESSION_RESOLVED", session: sessionOf(["a", "b"]) });
  if (phase === "engineLoading") return h;

  h.send({ type: "ENGINE_STATE", state: ENGINE_READY });
  if (phase === "loading") return h;

  h.send({ type: "MEDIA_PLAYING" });
  if (phase === "playing") return h;

  switch (phase) {
    case "buffering":
      h.send({ type: "MEDIA_WAITING" });
      return h;
    case "seeking":
      h.send({ type: "MEDIA_SEEKING", positionSeconds: 4 });
      return h;
    case "recovering":
      h.send({ type: "ENGINE_ERROR", error: recoverableFailure() });
      return h;
    case "ended":
      h.send({ type: "MEDIA_ENDED" });
      return h;
    default:
      /* `fatal`, reached with a one-attempt budget so a single failure ends it. */
      h.send({ type: "ENGINE_ERROR", error: manifestFailure() });
      return h;
  }
}
