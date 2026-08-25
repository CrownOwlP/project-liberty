import {
  MAX_LIST_LENGTH,
  defined,
  distinctByIdArb,
  failoverPolicyArb,
  idArb,
  permutationKeysArb,
  permute
} from "@liberty/contracts/testing/arbitraries";
import type { Arbitrary } from "fast-check";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { EngineState } from "./playback-controller";
import { recordPlaybackEffects } from "./playback-effects";
import {
  PLAYBACK_TRAIL_LIMIT,
  createPlaybackActor,
  playbackPhase,
  type PlaybackEvent,
  type PlaybackPhase
} from "./playback-machine";
import type { PlaybackCandidate } from "./playback-session";
import { describePlaybackError } from "./shaka-error";

/**
 * Playback lifecycle properties (fast-check).
 *
 * The example suite pins specific sequences. These pin the two guarantees that
 * a sequence cannot: that failover TERMINATES for any candidate list and any
 * budget, and that it never loses a line of the reason trail while doing so.
 * Both are invariant-4 questions — a failover with no recorded reason is the
 * same defect as a rights denial with no reason — and both are exactly the kind
 * of thing that holds for the three sequences somebody wrote down and fails for
 * the fourth.
 *
 * The seed is pinned by importing `@liberty/contracts/testing/arbitraries`,
 * which calls `fc.configureGlobal` on first import. An unpinned property suite
 * fails on one CI run in forty with a counterexample nobody can reproduce, and
 * a test that cannot be reproduced gets retried until it passes.
 *
 * There is no clock anywhere in the machine, so none of these properties is
 * time-dependent and no counterexample can be a flake.
 */

const ENGINE_READY: EngineState = { status: "ready" };
const ENGINE_LOADING: EngineState = { status: "loading" };
const ENGINE_DESTROYED: EngineState = { status: "destroyed" };

function shakaError(init: { severity: number; category: number; code: number }) {
  return describePlaybackError(
    { severity: init.severity, category: init.category, code: init.code, data: [], handled: false },
    "player-event"
  );
}

/** Critical MANIFEST. `source_unavailable`: consumes the candidate outright. */
const terminalFailure = () => shakaError({ severity: 2, category: 4, code: 4001 });
/** RECOVERABLE NETWORK. Answered with `retryStreaming()`, not a failover. */
const recoverableFailure = () => shakaError({ severity: 1, category: 1, code: 1002 });
/** LOAD_INTERRUPTED. Critical, but it is our own control flow. */
const abortedFailure = () => shakaError({ severity: 2, category: 7, code: 7000 });

/**
 * `idArb` draws from a deliberately narrow pool including non-ASCII, so the ids
 * here collide often and are not URL-safe on their own. Both are wanted: the
 * machine keys its per-candidate retry budget by id, and a machine that only
 * ever saw distinct ASCII ids would never exercise that map honestly.
 */
const candidateArb: Arbitrary<PlaybackCandidate> = idArb.map((id) => ({
  id,
  providerId: "fixture",
  source: { uri: `https://cdn.example.com/${encodeURIComponent(id)}.mpd` }
}));

const candidatesArb: Arbitrary<PlaybackCandidate[]> = distinctByIdArb(candidateArb, MAX_LIST_LENGTH);

const PHASES: readonly PlaybackPhase[] = [
  "idle",
  "resolving",
  "engineLoading",
  "loading",
  "playing",
  "buffering",
  "seeking",
  "recovering",
  "failingOver",
  "ended",
  "fatal"
];

/**
 * Everything the element and the engine can say, including the things they are
 * not supposed to say when they say them.
 *
 * Built from the generated candidates so `SESSION_RESOLVED` and `RETRY` are in
 * the pool: the reset path is where a counter or a trail is most likely to be
 * left in an impossible state, and leaving it out would make the storm test a
 * test of the happy region only.
 */
function eventPool(candidates: readonly PlaybackCandidate[]): readonly PlaybackEvent[] {
  return [
    { type: "START" },
    {
      type: "SESSION_RESOLVED",
      session: { contentId: "aurora-fall", candidates, startAtSeconds: null, reasons: ["fixture"] }
    },
    { type: "SESSION_UNAVAILABLE", reasons: ["provider_unreachable"] },
    { type: "RETRY" },
    { type: "ENGINE_STATE", state: ENGINE_LOADING },
    { type: "ENGINE_STATE", state: ENGINE_READY },
    { type: "ENGINE_STATE", state: ENGINE_DESTROYED },
    { type: "ENGINE_ERROR", error: terminalFailure() },
    { type: "ENGINE_ERROR", error: recoverableFailure() },
    { type: "ENGINE_ERROR", error: abortedFailure() },
    { type: "MEDIA_LOAD_START" },
    { type: "MEDIA_LOADED_METADATA", durationSeconds: 600 },
    { type: "MEDIA_CAN_PLAY" },
    { type: "MEDIA_PLAYING" },
    { type: "MEDIA_WAITING" },
    { type: "MEDIA_STALLED" },
    { type: "MEDIA_SEEKING", positionSeconds: 30 },
    { type: "MEDIA_SEEKED", positionSeconds: 30 },
    { type: "MEDIA_TIME_UPDATE", positionSeconds: 31 },
    { type: "MEDIA_DURATION_CHANGE", durationSeconds: null },
    { type: "MEDIA_PLAY" },
    { type: "MEDIA_PAUSE" },
    { type: "MEDIA_ENDED" },
    { type: "MEDIA_EMPTIED" },
    { type: "MEDIA_ERROR", mediaErrorCode: 3 },
    { type: "MEDIA_ERROR", mediaErrorCode: 1 }
  ];
}

describe("failover terminates and keeps its trail", () => {
  it("stops after exactly min(budget, candidates) attempts, whatever the list", () => {
    fc.assert(
      fc.property(candidatesArb, failoverPolicyArb, (candidates, policy) => {
        const effects = recordPlaybackEffects();
        const actor = createPlaybackActor({ input: { policy }, effects });
        actor.start();
        actor.send({ type: "START" });
        actor.send({ type: "ENGINE_STATE", state: ENGINE_READY });
        actor.send({
          type: "SESSION_RESOLVED",
          session: { contentId: "aurora-fall", candidates, startAtSeconds: null, reasons: ["fixture"] }
        });

        /*
         * Bounded far above any reachable number of attempts. The property is
         * that the machine stops on its own; the loop bound only exists so a
         * REGRESSION reports as a failed expectation rather than as a test that
         * never returns.
         */
        for (let step = 0; step < 64; step += 1) {
          if (playbackPhase(actor.getSnapshot()) === "fatal") break;
          actor.send({ type: "MEDIA_PLAYING" });
          actor.send({ type: "MEDIA_TIME_UPDATE", positionSeconds: step + 1 });
          actor.send({ type: "ENGINE_ERROR", error: terminalFailure() });
        }

        const snapshot = actor.getSnapshot();
        const context = snapshot.context;

        expect(playbackPhase(snapshot)).toBe("fatal");
        expect(context.stopReason).not.toBeNull();
        /* Every failure here is non-retryable, so one attempt is spent per
         * candidate and the two bounds meet exactly rather than approximately. */
        expect(effects.loads).toHaveLength(Math.min(policy.maxAttempts, candidates.length));

        /* THE TRAIL IS COMPLETE. One attempt line and one failure line for every
         * load the machine asked for, and a stop line at the end. */
        const attempts = context.trail.filter((entry) => entry.kind === "candidate_attempt");
        const failures = context.trail.filter((entry) => entry.kind === "candidate_failed");
        expect(attempts).toHaveLength(effects.loads.length);
        expect(failures).toHaveLength(effects.loads.length);
        expect(context.trail.some((entry) => entry.kind === "stopped")).toBe(true);
        if (effects.loads.length > 1) {
          expect(context.trail.some((entry) => entry.kind === "failover")).toBe(true);
        }
        for (const failure of failures) {
          expect(failure.candidateId).not.toBeNull();
          expect(failure.detail.length).toBeGreaterThan(0);
        }

        /* NOTHING WAS SILENTLY DROPPED. `sequence` counts every entry ever
         * appended, so this equality is what makes `trailDropped` an honest
         * statement rather than a field nobody maintains. */
        expect(context.trail.length + context.trailDropped).toBe(context.sequence);
      })
    );
  });

  /* The name is about the RESUME POSITION, not about candidate order. Since
   * scheduling became breadth-before-depth the machine deliberately revisits
   * earlier candidates — `candidateIndex` may move backwards — so a name
   * implying candidate monotonicity would describe a property this suite does
   * not hold and would send the next reader looking for a bug in the scheduler.
   * What is asserted below is that each `load()` starts at or after the previous
   * one. */
  it("never hands a load a start position earlier than the previous load's", () => {
    fc.assert(
      fc.property(candidatesArb, failoverPolicyArb, (candidates, policy) => {
        const effects = recordPlaybackEffects();
        const actor = createPlaybackActor({ input: { policy }, effects });
        actor.start();
        actor.send({ type: "START" });
        actor.send({ type: "ENGINE_STATE", state: ENGINE_READY });
        actor.send({
          type: "SESSION_RESOLVED",
          session: { contentId: "aurora-fall", candidates, startAtSeconds: null, reasons: ["fixture"] }
        });

        for (let step = 0; step < 64; step += 1) {
          if (playbackPhase(actor.getSnapshot()) === "fatal") break;
          actor.send({ type: "MEDIA_PLAYING" });
          actor.send({ type: "MEDIA_TIME_UPDATE", positionSeconds: (step + 1) * 10 });
          actor.send({ type: "ENGINE_ERROR", error: terminalFailure() });
        }

        /*
         * The failover-as-restart guarantee, stated as an inequality. Shaka
         * cannot swap a source, so every candidate switch is a `load()` that
         * must be handed the position back; the failure mode is that the torn
         * down element's clock overwrites it and the viewer silently restarts.
         */
        for (let index = 1; index < effects.loads.length; index += 1) {
          const previous = defined(effects.loads[index - 1], "previous load").startAtSeconds ?? 0;
          const current = defined(effects.loads[index], "current load").startAtSeconds ?? 0;
          expect(current).toBeGreaterThanOrEqual(previous);
        }
      })
    );
  });
});

describe("the machine survives anything the element says, in any order", () => {
  it("stays consistent under an arbitrary permutation of engine and media events", () => {
    fc.assert(
      fc.property(
        candidatesArb,
        failoverPolicyArb,
        fc.array(fc.nat({ max: 1_000_000 }), { maxLength: MAX_LIST_LENGTH * 6 }),
        permutationKeysArb,
        (candidates, policy, picks, keys) => {
          const pool = eventPool(candidates);
          const script = permute(
            picks.map((pick) => defined(pool[pick % pool.length], "pooled event")),
            keys
          );

          const effects = recordPlaybackEffects();
          const actor = createPlaybackActor({ input: { policy }, effects });
          actor.start();

          for (const event of script) {
            /* An event arriving where it "cannot" is HANDLED, never thrown.
             * The element and the engine are authoritative and may report
             * anything at any moment; that is the premise, not an edge case. */
            expect(() => actor.send(event), event.type).not.toThrow();
          }

          const snapshot = actor.getSnapshot();
          const context = snapshot.context;

          /* The actor never stops. `fatal` and `ended` are deliberately not
           * final states, because a stopped actor cannot mirror the teardown
           * events that still arrive. */
          expect(snapshot.status).toBe("active");
          expect(PHASES).toContain(playbackPhase(snapshot));

          /* The budget is a bound, not a suggestion. */
          expect(context.attemptsUsed).toBeLessThanOrEqual(policy.maxAttempts);
          /* Every charged attempt corresponds to a load that was actually
           * requested — the reverse is not asserted, because rebuilding a
           * destroyed engine reloads without charging the candidate for it. */
          expect(effects.loads.length).toBeGreaterThanOrEqual(context.attemptsUsed);

          /* The index never names a candidate that was not supplied. */
          const current = context.candidates[context.candidateIndex] ?? null;
          if (current !== null) expect(candidates).toContainEqual(current);

          /* Every attributed failure names a real candidate, so this list can be
           * handed to `planFailover()` without inventing an attribution. */
          for (const failure of context.failures) {
            expect(candidates.some((entry) => entry.id === failure.candidateId)).toBe(true);
          }

          expect(context.trail.length).toBeLessThanOrEqual(PLAYBACK_TRAIL_LIMIT);
          expect(context.trail.length + context.trailDropped).toBe(context.sequence);
          /* Sequence numbers are dense and strictly increasing: the trail is an
           * order, and a gap in it would be an entry nobody can account for. */
          for (let index = 1; index < context.trail.length; index += 1) {
            const previous = defined(context.trail[index - 1], "previous entry").sequence;
            expect(defined(context.trail[index], "entry").sequence).toBe(previous + 1);
          }
        }
      )
    );
  });
});
