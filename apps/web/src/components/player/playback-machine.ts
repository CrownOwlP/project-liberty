/* -------------------------------------------------------------------------
 * PL-0502 — the session and candidate lifecycle, and nothing else
 *
 * SCOPE, because the scope is the design. This models WHICH CANDIDATE IS BEING
 * PLAYED AND WHY. It does not model controls visibility, hotkeys, menus,
 * fullscreen, volume or playback rate: media-chrome already owns those through
 * `<media-controller>`, and `docs/RESEARCH_PLAYBACK.md` names duplicating them
 * here as the over-engineering failure mode for this exact task. Pause is the
 * closest call and it is resolved the same way — `paused` is mirrored into
 * context as a FACT about the element, never as a state, because the moment it
 * is a state the controls layer has a second opinion about it.
 *
 * THE MACHINE IS A MIRROR OF TRUTH, NOT THE SOURCE OF IT. The `<video>` element
 * and Shaka are authoritative; this is a validated projection of them. Three
 * consequences, all load-bearing:
 *
 *   - Every engine and media event has an inbound transition in every state,
 *     including states where it "cannot" happen. Where a state has nothing to
 *     do with an event, an ancestor handles it; where no ancestor does, the
 *     wildcard on the `session` region catches it and counts it. NOTHING
 *     THROWS AND NOTHING IS DROPPED SILENTLY. Teams that invert this end up
 *     with desynced players, and that is the explicit retrospective lesson from
 *     the most mature public example of a video statechart.
 *   - The machine drives nothing. Its four side effects are declared as named
 *     no-ops in `playback-effects.ts` and injected, so a full failover runs in
 *     a `node` test with no DOM in sight.
 *   - `unroutedEvents` is a real diagnostic rather than an assertion: a player
 *     that has drifted out of step with its element shows up there first.
 *
 * NO CLOCK. There is no `Date.now()`, no `after`, and no delayed transition
 * anywhere below. Every bound is a COUNT, and the only "time" the machine knows
 * is media time that the element told it. This project has had six
 * order-dependence defects and treats determinism as correctness; a backoff
 * delay would make every test in this directory time-dependent, and backoff
 * belongs in the effect implementation, which is where a clock legitimately
 * lives.
 *
 * FAILOVER IS A RESTART AND IS MODELLED AS ONE. Shaka has no API to swap the
 * source of a live session: `player.load(newUri)` resets the stats, discards
 * the buffer, re-seeks and re-establishes DRM. Pretending otherwise would put a
 * lie in the API contract, so `failingOver` exits through `loading` like any
 * other attempt, and the single thing carried across the restart is
 * `resumeAtSeconds`. See `preserveResumePosition` and `awaitingFirstFrame`.
 *
 * XState 5.x, MIT — the licence verified against
 * https://registry.npmjs.org/xstate/latest on 2026-08-20, not recalled. The
 * range and not a version, because `apps/web/package.json` declares `^5.32.5`
 * and that installs any 5.x: a comment naming an exact version would be a pin
 * this repo does not actually hold, and the next reader would trust it. Nothing
 * below depends on a 5.x minor, which is why the range is left open — contrast
 * `shaka-player`, pinned `~5.2.6` precisely because `playback-failure.ts` reads
 * category and code numbers that a minor may renumber.
 *
 * `@xstate/react` is deliberately NOT a dependency: the one place this is
 * consumed is `player-surface.tsx`, which already owns an
 * imperative effect for the custom element and subscribes to the actor in the
 * same effect. A React binding would add a package and a peer range to keep in
 * step for a `useState` call.
 *
 * DELIBERATELY LEFT TO THE TASKS THAT ATTACH HERE NEXT:
 *   - PL-0503 (telemetry). No transport, no batching, no CMCD mapping. The
 *     trail and the snapshot are the seam; subscribe to the actor.
 *   - PL-0504 (A/V sync). No drift measurement, no `requestVideoFrameCallback`,
 *     no orthogonal drift region. When it exists it is a third region here, and
 *     it is a region rather than a branch precisely because drift is
 *     independent of which candidate is playing.
 *   - PL-0501 (session API). `requestSession` is the seam and
 *     `playback-session.ts` states why the wire contract is not declared here.
 * ---------------------------------------------------------------------- */

import type { FailoverPolicy, PlaybackAttemptFailure, PlaybackFailureKind } from "@liberty/contracts/domains/failover";
/*
 * THE SUBPATH, NOT THE BARREL, AND IT IS NOT A STYLE PREFERENCE.
 *
 * This file is reached from `player-surface.tsx`, which is `"use client"`, so
 * every module on this import's transitive graph is downloaded by a viewer.
 * `@liberty/media-engine`'s barrel re-exports `ranking`, `scoring`, `audio` and
 * `subtitles`; `@liberty/media-engine/scheduling` is the one module
 * `scheduleAttempts` actually lives in, and it is the half of failover that has
 * no path to `./ranking` at all. `./failover` would NOT do -- it value-imports
 * `rankStreamCandidates` for `planFailover`, which this file never calls.
 *
 * Widening this back to the barrel would not break a test or a type; it would
 * quietly put the ranking and scoring engine back in the player bundle. That is
 * why the narrow path is stated here rather than left to a bundler to discover.
 */
import { scheduleAttempts, type AttemptSchedule } from "@liberty/media-engine/scheduling";
import { assign, createActor, setup } from "xstate";
import {
  NO_OP_PLAYBACK_EFFECTS,
  type LoadCandidateRequest,
  type PlaybackEffects
} from "./playback-effects";
import {
  classifyMediaElementError,
  classifyPlaybackFailure,
  isAbortedMediaElementError
} from "./playback-failure";
import type { PlaybackCandidate, PlaybackSession } from "./playback-session";
import type { EngineState } from "./playback-controller";
import type { PlaybackError } from "./shaka-error";

/* -------------------------------------------------------------------------
 * Vocabulary
 * ---------------------------------------------------------------------- */

/**
 * The flattened lifecycle, in the order the acceptance criterion names it.
 *
 * `engineLoading` and everything after it are nested under an `active` node in
 * the statechart so that the handlers which must apply to ALL of them — an
 * engine that vanished, a candidate error, the end of the media — are written
 * once. `playbackPhase()` flattens that back out, so nothing outside this file
 * has to know or care about the nesting.
 */
export type PlaybackPhase =
  | "idle"
  | "resolving"
  | "engineLoading"
  | "loading"
  | "playing"
  | "buffering"
  | "seeking"
  | "recovering"
  | "failingOver"
  | "ended"
  | "fatal";

const PLAYBACK_PHASES: readonly string[] = [
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
 * Why the session stopped, when it stopped without playing to the end.
 *
 * The four that overlap with `FailoverStopReason` in `@liberty/media-engine`
 * carry the SAME names on purpose, so a support engineer reading a client trail
 * and a server plan is reading one vocabulary — and since this file now calls
 * `scheduleAttempts` they are not merely spelled alike, they are the values that
 * scheduler returned, mapped through `stopReasonFor`.
 *
 * Still restated as a TYPE rather than aliased to `FailoverStopReason`, because
 * this list is neither a subset nor a superset of that one: `session_unavailable`
 * and `engine_unavailable` describe things only a client can observe, and the
 * three homogeneous engine reasons that need pre-attempt refusals
 * (`no_eligible_candidates`, `all_eligible_candidates_incompatible`) are
 * unreachable here because the session did the eligibility work before this
 * machine was handed anything. A type alias would offer a player two reasons it
 * can never report and hide the two it always could.
 */
export type PlaybackStopReason =
  | "no_candidates"
  | "session_unavailable"
  | "engine_unavailable"
  | "all_candidates_rights_blocked"
  | "candidates_exhausted"
  | "attempt_limit_reached";

export type PlaybackTrailKind =
  | "session_requested"
  | "session_resolved"
  | "session_unavailable"
  | "candidate_attempt"
  | "candidate_playing"
  | "rebuffer"
  | "recoverable_error"
  | "candidate_failed"
  | "candidate_retry"
  | "failover"
  | "engine_lost"
  | "ended"
  | "stopped";

/**
 * A `PlaybackError` with `raw` removed.
 *
 * `shaka-error.ts` is explicit that `raw` can hold manifest URLs with signed
 * query strings and must not go on a wire. The trail is the thing most likely
 * to be serialised — into telemetry by PL-0503, into a bug report by a human —
 * so the credential is dropped at the point the trail is built rather than at
 * every place the trail is read. `detail` survives, and its URLs are already
 * stripped to origin and path.
 */
export interface PlaybackErrorSummary {
  readonly origin: PlaybackError["origin"];
  readonly severity: PlaybackError["severity"];
  readonly fatal: boolean;
  readonly aborted: boolean;
  readonly code: number | null;
  readonly category: number | null;
  readonly categoryName: string | null;
  readonly message: string;
  readonly detail: PlaybackError["detail"];
}

export function summarisePlaybackError(error: PlaybackError): PlaybackErrorSummary {
  /* Written out field by field rather than destructured with a rest, so that a
   * field added to `PlaybackError` is an explicit decision here instead of
   * arriving in the trail — and possibly on a wire — by default. */
  return {
    origin: error.origin,
    severity: error.severity,
    fatal: error.fatal,
    aborted: error.aborted,
    code: error.code,
    category: error.category,
    categoryName: error.categoryName,
    message: error.message,
    detail: error.detail
  };
}

/**
 * One line of the reason trail product invariant 4 asks for.
 *
 * FLAT rather than a discriminated union on `kind`, and that is a decision
 * about how it is read rather than laziness: every consumer of this — a log
 * line, a telemetry record, a debug panel — wants the same five columns for
 * every kind, and a union would make each of them write a switch to find out
 * whether this particular entry happens to carry a candidate id.
 *
 * `sequence` rather than a timestamp. The machine has no clock (see the file
 * header); ordering is what the trail is for, and an instant is something the
 * boundary that reports the trail can stamp if it wants one.
 */
export interface PlaybackTrailEntry {
  readonly sequence: number;
  readonly kind: PlaybackTrailKind;
  /** Which candidate this is about, or `null` for session-level entries. */
  readonly candidateId: string | null;
  /** Media time when this was recorded, in SECONDS. Not a wall clock. */
  readonly positionSeconds: number;
  /** Already-redacted prose. Safe to log. */
  readonly detail: string;
  readonly failureKind: PlaybackFailureKind | null;
  readonly error: PlaybackErrorSummary | null;
  /** The position a restart will resume at. Present on every restart entry. */
  readonly resumeAtSeconds: number | null;
}

/* -------------------------------------------------------------------------
 * Events
 *
 * The MEDIA_* set is exactly the DOM media events that are session or candidate
 * FACTS. `ratechange`, `volumechange`, `resize` and the rest are absent because
 * they say nothing about which candidate is playing — they belong to the
 * controls layer. `suspend` and `abort` are absent for a sharper reason: they
 * fire during entirely normal playback (the buffer filled; a load was
 * superseded) and a machine that treated either as a stall would report a
 * rebuffer on every well-behaved session.
 * ---------------------------------------------------------------------- */

export type PlaybackEvent =
  | { readonly type: "START" }
  | { readonly type: "SESSION_RESOLVED"; readonly session: PlaybackSession }
  | { readonly type: "SESSION_UNAVAILABLE"; readonly reasons: readonly string[] }
  | { readonly type: "RETRY" }
  | { readonly type: "ENGINE_STATE"; readonly state: EngineState }
  | { readonly type: "ENGINE_ERROR"; readonly error: PlaybackError }
  | { readonly type: "MEDIA_LOAD_START" }
  | { readonly type: "MEDIA_LOADED_METADATA"; readonly durationSeconds: number | null }
  | { readonly type: "MEDIA_CAN_PLAY" }
  | { readonly type: "MEDIA_PLAYING" }
  | { readonly type: "MEDIA_WAITING" }
  | { readonly type: "MEDIA_STALLED" }
  | { readonly type: "MEDIA_SEEKING"; readonly positionSeconds: number }
  | { readonly type: "MEDIA_SEEKED"; readonly positionSeconds: number }
  | { readonly type: "MEDIA_TIME_UPDATE"; readonly positionSeconds: number }
  | { readonly type: "MEDIA_DURATION_CHANGE"; readonly durationSeconds: number | null }
  | { readonly type: "MEDIA_PLAY" }
  | { readonly type: "MEDIA_PAUSE" }
  | { readonly type: "MEDIA_ENDED" }
  | { readonly type: "MEDIA_EMPTIED" }
  | { readonly type: "MEDIA_ERROR"; readonly mediaErrorCode: number | null };

export type PlaybackEventType = PlaybackEvent["type"];

/* -------------------------------------------------------------------------
 * Context
 * ---------------------------------------------------------------------- */

export interface PlaybackMachineContext {
  readonly contentId: string | null;
  /**
   * In preference order, exactly as the session supplied them. Never re-sorted.
   *
   * This is why the machine calls `scheduleAttempts` and not `planFailover`. The
   * server already ranked; re-ranking here would need a `PlaybackCapabilities`
   * this machine does not have, and would produce a second opinion about
   * preference that could disagree with the session's — after which the reason
   * trail would explain a choice nobody made. The list goes into the scheduler
   * in the order it arrived and comes back out untouched.
   */
  readonly candidates: readonly PlaybackCandidate[];
  /**
   * Which candidate is current. `-1` until a session is adopted.
   *
   * NOT MONOTONIC, and it was the assumption that it were which made the old
   * hand-rolled failover unable to express the engine's policy at all: an index
   * that only ever moves forward cannot say "retry candidate 0 now that 1 and 2
   * have both been tried". It is now DERIVED — `applyScheduledAttempt` looks up
   * whatever id `scheduleAttempts` returned — so it may move backwards, stay
   * put, or skip. Nothing may read it as a high-water mark; in particular
   * `candidates.length - candidateIndex - 1` is no longer "how many are left"
   * and the scheduler's own `attemptable.length` is.
   *
   * Kept as an index rather than replaced by the id because `currentCandidate`,
   * `loadRequestFor` and every trail entry want the candidate OBJECT, and one
   * lookup at the point of decision is cheaper and easier to audit than a lookup
   * at each of those reads. With duplicate ids in one session the first match
   * wins, which is the same candidate the scheduler was talking about.
   */
  readonly candidateIndex: number;
  readonly policy: FailoverPolicy;
  /** Charged against `policy.maxAttempts`. Incremented per genuine attempt. */
  readonly attemptsUsed: number;
  /**
   * The same charge, split by candidate.
   *
   * NOT DERIVABLE FROM `failures`, which is the whole reason it exists. An
   * attempt whose error the classifier could not place is absent from `failures`
   * by contract (see `playback-failure.ts` rule 1) but it still happened and it
   * still cost a load. Without this the scheduler would see that candidate as
   * never attempted, hand it back for ever, and never advance the budget — the
   * old guards avoided that only by advancing an index instead of consulting a
   * policy. Handed to `scheduleAttempts` as `ChargedAttempts`.
   *
   * IT IS ALSO THE OTHER HALF OF RULE 1. Counting an unclassified attempt only
   * de-prioritised the candidate: breadth-first put it last, and then handed it
   * straight back once nothing was untried, so one fatally-broken stream with an
   * unclassifiable error was loaded until the budget ran out and the trail
   * reported it as a candidate that "remained". The engine reads this count
   * against `failures` — more attempts than named failures means an attempt
   * taught us nothing — and excludes the candidate as
   * `attempt_failed_unclassified`. The claim stays exactly as strong as the
   * evidence: the attempt ended and earned no retry, and no failure kind is
   * invented to say so.
   *
   * Read through `attemptsCharged`, never by bare indexing. See its note.
   */
  readonly attemptsByCandidate: Readonly<Record<string, number>>;
  /** `retryStreaming()` calls spent on the current candidate. */
  readonly recoveriesOnCandidate: number;
  /**
   * Exactly `PlaybackAttemptFailure[]`, and it is handed to
   * `@liberty/media-engine` unchanged on every failover rather than merely being
   * shaped so that it COULD be. Unclassified failures are NOT here — an entry
   * with a guessed kind would be a claim the contract says we must not make —
   * but they are always in the trail, and they are always in
   * `attemptsByCandidate`.
   */
  readonly failures: readonly PlaybackAttemptFailure[];
  readonly lastFailureKind: PlaybackFailureKind | null;
  /** Mirrored from the element, in SECONDS. Frozen while `awaitingFirstFrame`. */
  readonly positionSeconds: number;
  readonly durationSeconds: number | null;
  /** Where the next `load()` will start. The whole of position preservation. */
  readonly resumeAtSeconds: number | null;
  /**
   * A load is in flight and the element's clock still belongs to the PREVIOUS
   * session.
   *
   * This flag is the difference between a failover that resumes and one that
   * restarts from zero. `player.load()` tears the session down, and the
   * `timeupdate` events that arrive between the teardown and the resume seek
   * report the old element's position — usually 0. Mirroring those would
   * overwrite the position we are in the middle of preserving, and the bug
   * would look like "failover works, but only from the beginning".
   */
  readonly awaitingFirstFrame: boolean;
  /**
   * The engine went away under us and a new one is being built — a React
   * remount or a DOM move, both of which destroy the Shaka session. Distinguished
   * from a failover because it is NOT the candidate's fault and must not be
   * charged against the attempt budget.
   */
  readonly reattaching: boolean;
  /** Mirrored, never commanded. The controls layer owns pausing. */
  readonly paused: boolean;
  readonly engine: EngineState;
  readonly lastError: PlaybackErrorSummary | null;
  readonly stopReason: PlaybackStopReason | null;
  readonly trail: readonly PlaybackTrailEntry[];
  /**
   * Entries the cap discarded. Present so that a trimmed trail says so: a
   * silently truncated reason trail is worse than a short one, because it reads
   * as a complete account of a session that it is not.
   */
  readonly trailDropped: number;
  readonly sequence: number;
  /**
   * Events that reached the wildcard — no state in the session region had
   * anything to do with them.
   *
   * Not an error and never a throw. The element and the engine are authoritative
   * and may report anything at any moment, which is the whole premise. It is a
   * DIAGNOSTIC: a player that has drifted out of step with its element starts
   * reporting `playing` while the machine thinks it is idle, and this is where
   * that shows up first.
   */
  readonly unroutedEvents: number;
  readonly lastUnroutedEvent: PlaybackEventType | null;
  /** The last inert media signal seen. `loadstart`, `canplay`, `emptied`. */
  readonly lastMediaSignal: PlaybackEventType | null;
}

export interface PlaybackMachineInput {
  /**
   * The attempt budget. An INPUT rather than a constant because the contract
   * says so: a living-room client on a flaky link and a server-side probe are
   * meant to differ without either forking the policy.
   */
  readonly policy: FailoverPolicy;
}

/**
 * How many `retryStreaming()` calls one candidate is worth before the failure
 * is promoted to a failover.
 *
 * Shaka never raises a CRITICAL for a segment it is still retrying, so without
 * a bound here a stream that stalls forever produces an endless sequence of
 * RECOVERABLE errors and a player that sits in `recovering` for the rest of the
 * session. Three, because `retryStreaming()` is cheap enough that one is worth
 * spending on a genuine blip and expensive enough — it re-requests segments —
 * that a dozen is a retry storm.
 *
 * A COUNT rather than a window, because a window needs a clock. See the header.
 */
export const MAX_STREAMING_RECOVERIES_PER_CANDIDATE = 3;

/**
 * The trail cap.
 *
 * A three-hour stream on a bad link can produce thousands of recoverable
 * errors, and an unbounded array in a long-lived actor is a leak that grows
 * with exactly the sessions most worth debugging. Two hundred entries covers a
 * five-candidate failover with its full error history many times over.
 */
export const PLAYBACK_TRAIL_LIMIT = 200;

/* -------------------------------------------------------------------------
 * Context helpers — pure, exported where a test or a consumer needs them
 * ---------------------------------------------------------------------- */

export function currentCandidate(context: PlaybackMachineContext): PlaybackCandidate | null {
  return context.candidates[context.candidateIndex] ?? null;
}

export function currentCandidateId(context: PlaybackMachineContext): string | null {
  return currentCandidate(context)?.id ?? null;
}

/**
 * How many attempts have been charged to one candidate.
 *
 * `Object.hasOwn` rather than a bare `counts[id] ?? 0`, and the guard is not
 * defensive programming — it is the difference between arithmetic and a string.
 * `attemptsByCandidate` is a plain object keyed by PROVIDER-SUPPLIED ids, so
 * `counts["constructor"]` and `counts["toString"]` return functions off
 * `Object.prototype`, `?? 0` never fires, `fn + 1` concatenates rather than
 * adds, and the poisoned value then travels into `scheduleAttempts` where it
 * decides both the tried/untried partition and, now, whether the candidate is
 * excluded at all. One candidate named `toString` would silently break failover
 * for the whole session.
 *
 * The engine's `kindsById` has this immunity for free by being a `Map`, and
 * `scheduleAttempts` copies this record into one for the same reason. The
 * record shape is kept here rather than swapped for a `Map` because
 * `PlaybackMachineContext` is a snapshot other code reads and PL-0503 will
 * serialise, and a `Map` does not survive `JSON.stringify`.
 *
 * WRITES ARE SAFE ALREADY and stay in the object-literal form on purpose: a
 * computed key in a literal DEFINES an own property, so `{ ...counts,
 * ["__proto__"]: 1 }` records an attempt, while the equivalent `next[id] = 1`
 * assignment would invoke the prototype setter and record nothing.
 */
function attemptsCharged(
  counts: Readonly<Record<string, number>>,
  candidateId: string
): number {
  return Object.hasOwn(counts, candidateId) ? (counts[candidateId] ?? 0) : 0;
}

function finiteSeconds(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function trailEntry(
  context: PlaybackMachineContext,
  kind: PlaybackTrailKind,
  detail: string,
  extra: {
    candidateId?: string | null;
    failureKind?: PlaybackFailureKind | null;
    error?: PlaybackErrorSummary | null;
    resumeAtSeconds?: number | null;
  } = {}
): PlaybackTrailEntry {
  return {
    sequence: context.sequence,
    kind,
    /* An explicit `undefined` test rather than `??`, because `null` is a VALUE
     * here and not an absence: the session-level callers pass `candidateId:
     * null` to say "this line is about the session, not about a candidate", and
     * `null ?? currentCandidateId(context)` hands them back whichever candidate
     * happens to be selected. Today they are all correct by accident — each of
     * them runs while no candidate is selected, so the fallback returns `null`
     * anyway — and the next session-level entry added inside `active` would be
     * silently attributed to the candidate that was playing at the time. */
    candidateId: extra.candidateId === undefined ? currentCandidateId(context) : extra.candidateId,
    positionSeconds: context.positionSeconds,
    detail,
    failureKind: extra.failureKind ?? null,
    error: extra.error ?? null,
    resumeAtSeconds: extra.resumeAtSeconds ?? null
  };
}

function appendTrail(
  context: PlaybackMachineContext,
  entry: PlaybackTrailEntry
): Pick<PlaybackMachineContext, "trail" | "trailDropped" | "sequence"> {
  const combined = [...context.trail, entry];
  const overflow = combined.length - PLAYBACK_TRAIL_LIMIT;
  return {
    trail: overflow > 0 ? combined.slice(overflow) : combined,
    trailDropped: context.trailDropped + (overflow > 0 ? overflow : 0),
    sequence: context.sequence + 1
  };
}

export function initialPlaybackContext(input: PlaybackMachineInput): PlaybackMachineContext {
  return {
    contentId: null,
    candidates: [],
    candidateIndex: -1,
    policy: input.policy,
    attemptsUsed: 0,
    attemptsByCandidate: {},
    recoveriesOnCandidate: 0,
    failures: [],
    lastFailureKind: null,
    positionSeconds: 0,
    durationSeconds: null,
    resumeAtSeconds: null,
    awaitingFirstFrame: false,
    reattaching: false,
    paused: true,
    engine: { status: "idle" },
    lastError: null,
    stopReason: null,
    trail: [],
    trailDropped: 0,
    sequence: 0,
    unroutedEvents: 0,
    lastUnroutedEvent: null,
    lastMediaSignal: null
  };
}

/**
 * What `loadCandidate` is asked for, computed from context alone.
 *
 * Every transition that reaches `loading` has already finished updating the
 * index and the resume point by the time this runs — XState resolves a
 * transition's actions before the target's entry actions — so this reads a
 * settled context and never has to know which path it arrived by.
 */
function loadRequestFor(context: PlaybackMachineContext): LoadCandidateRequest {
  return {
    candidate: currentCandidate(context),
    startAtSeconds: context.resumeAtSeconds,
    attempt: context.attemptsUsed
  };
}

/**
 * WHAT TO ATTEMPT NEXT — asked of `@liberty/media-engine`, never decided here.
 *
 * The one call that replaced the machine's own failover scheduling. The previous
 * version had guards named `canRetrySameCandidate` and `canAdvanceCandidate`
 * that reimplemented the engine's policy and got it wrong in a way no local
 * assertion could see: a retry was tried BEFORE a fresh candidate, so a
 * four-attempt budget could be spent two-apiece on two candidates while a third
 * authorized stream was never loaded once. The engine's own scheduler had
 * already been fixed for exactly that; nothing in real playback called it. Now
 * there is one policy, and this is the seam.
 *
 * `context.candidates` goes in UNSORTED-BY-US, in the session's preference
 * order. `scheduleAttempts` is the half of failover that does not rank, which is
 * why the client can call it (see `PlaybackMachineContext.candidates`).
 *
 * The `ChargedAttempts` argument is what makes the client's accounting honest
 * rather than a subset of it: `context.failures` omits attempts whose error the
 * classifier could not place, and those still spent the budget and still tried
 * the candidate. See `attemptsByCandidate`.
 *
 * PURE, so calling it from several guards and actions within one eventless step
 * is safe and gives one answer. It is recomputed rather than cached in context
 * on purpose: a cached schedule is stale the instant the step ends, and a stale
 * plan that still looks authoritative is the failure mode this whole task was
 * about. The cost is a linear pass over the candidate list a handful of times
 * per failover, against a budget of single-digit attempts.
 */
function scheduleFor(context: PlaybackMachineContext): AttemptSchedule {
  return scheduleAttempts(
    context.candidates.map((candidate) => candidate.id),
    context.failures,
    context.policy,
    { attemptsUsed: context.attemptsUsed, attemptsByCandidate: context.attemptsByCandidate }
  );
}

/**
 * The engine's terminal reason, in the client's vocabulary.
 *
 * A TRANSLATION, not a second decision. `scheduleAttempts` decides THAT the
 * session is over and why, out of the shared `FailoverStopReason` vocabulary;
 * this maps that answer onto `PlaybackStopReason`, which differs only where the
 * two vantage points genuinely differ.
 *
 * The one place it adds anything is `all_candidates_rights_blocked`. The engine
 * refuses to claim it without `decision.rejected` — the pre-attempt refusals it
 * cannot see from an id list — and a client has no `PlaybackDecision` at all.
 * A client's pool is exactly the session's candidate list, so what the engine
 * decides over `decision.ranked` this decides over the same set with no
 * refusals in it.
 *
 * READ OFF `schedule.excluded`, NOT OFF `context.failures`, and the difference
 * is a claim that used to be false. The old test was "every recorded failure was
 * a rights failure", justified by the premise that an exhausted pool means every
 * candidate contributed at least one failure. `attempt_failed_unclassified`
 * broke that premise: a candidate can now leave the pool having recorded NO
 * failure at all, so one rights failure plus one unclassifiable error would have
 * printed "every candidate was rights-blocked" about a candidate whose rights
 * were never in question. The exclusions are the per-candidate findings, one per
 * candidate, so asking them is the same scope rule the engine states — a
 * homogeneous reason asserts something about a SET, and when the set is mixed
 * the honest answer is `candidates_exhausted` plus the itemised trail rather
 * than the nearest plausible headline.
 */
function stopReasonFor(schedule: AttemptSchedule): PlaybackStopReason {
  if (schedule.reason === "attempt_limit_reached") return "attempt_limit_reached";
  /* Unreachable while `failingOver` is only entered from inside `active`, which
   * a session with no candidates never reaches — carried anyway so the mapping
   * is total over the vocabulary rather than over today's reachable subset. */
  if (schedule.reason === "no_candidates") return "no_candidates";
  /* Vacuously true on an empty list, and "every candidate was rights-blocked"
   * about nothing at all is the same fabricated finding the engine separates
   * `no_candidates` out to avoid. Unreachable — an exhausted pool has an
   * exclusion for every candidate — and cheap to state. */
  const allRights =
    schedule.excluded.length > 0 &&
    schedule.excluded.every((entry) => entry.reason === "rights_not_established");
  return allRights ? "all_candidates_rights_blocked" : "candidates_exhausted";
}

function recordFailure(
  context: PlaybackMachineContext,
  summary: PlaybackErrorSummary,
  kind: PlaybackFailureKind | null,
  detail: string
): Partial<PlaybackMachineContext> {
  const candidateId = currentCandidateId(context);
  /*
   * An unclassified failure is deliberately absent from `failures`. That list is
   * `PlaybackAttemptFailure[]` and its `kind` is a CLAIM; inventing one to keep
   * the list complete is precisely what the contract forbids. The trail entry
   * below carries the same event with `failureKind: null`, so nothing is lost —
   * only the unfounded claim is.
   *
   * IT STILL ENDS THE ATTEMPT. Whichever branch this took, the caller is on its
   * way to `failingOver`, the attempt has already been charged to the candidate,
   * and the engine reads that charge against this list: more attempts than
   * failures means the candidate is out as `attempt_failed_unclassified`. So the
   * candidate is not retried, and no kind was guessed to achieve it.
   */
  const failures: readonly PlaybackAttemptFailure[] =
    kind !== null && candidateId !== null ? [...context.failures, { candidateId, kind }] : context.failures;

  return {
    failures,
    lastFailureKind: kind,
    lastError: summary,
    ...appendTrail(
      context,
      trailEntry(context, "candidate_failed", detail, { failureKind: kind, error: summary })
    )
  };
}

/* -------------------------------------------------------------------------
 * The machine
 * ---------------------------------------------------------------------- */

export const playbackMachine = setup({
  types: {
    context: {} as PlaybackMachineContext,
    events: {} as PlaybackEvent,
    input: {} as PlaybackMachineInput
  },

  guards: {
    sessionHasCandidates: ({ event }) =>
      event.type === "SESSION_RESOLVED" && event.session.candidates.length > 0,

    /* Read from the EVENT, so a decision never depends on which of the two
     * parallel regions the runtime resolved first. */
    engineEventIsLoading: ({ event }) => event.type === "ENGINE_STATE" && event.state.status === "loading",
    engineEventIsReady: ({ event }) => event.type === "ENGINE_STATE" && event.state.status === "ready",
    engineEventIsUnavailable: ({ event }) =>
      event.type === "ENGINE_STATE" && event.state.status === "unavailable",
    engineEventIsDestroyed: ({ event }) =>
      event.type === "ENGINE_STATE" && event.state.status === "destroyed",
    engineEventIsReadyAfterReattach: ({ context, event }) =>
      event.type === "ENGINE_STATE" && event.state.status === "ready" && context.reattaching,

    /* Read from CONTEXT, for the case where the engine became ready before the
     * session did and no further event is coming. */
    engineIsReady: ({ context }) => context.engine.status === "ready",
    engineIsReadyAfterReattach: ({ context }) => context.engine.status === "ready" && context.reattaching,
    engineIsUnavailable: ({ context }) => context.engine.status === "unavailable",

    errorIsAborted: ({ event }) => event.type === "ENGINE_ERROR" && event.error.aborted,
    /**
     * A RECOVERABLE Shaka error, with recovery budget left on this candidate.
     *
     * `fatal` is not a synonym for `severity === "critical"` — `shaka-error.ts`
     * computes it as critical-and-not-aborted — so this reads the field rather
     * than the severity, and the aborted case has already been taken by the
     * branch above.
     */
    errorIsRecoverableWithinBudget: ({ context, event }) =>
      event.type === "ENGINE_ERROR" &&
      !event.error.fatal &&
      !event.error.aborted &&
      context.recoveriesOnCandidate < MAX_STREAMING_RECOVERIES_PER_CANDIDATE,

    mediaErrorIsIgnorable: ({ event }) =>
      event.type === "MEDIA_ERROR" && isAbortedMediaElementError(event.mediaErrorCode),

    /**
     * The two failover guards, and both of them are questions rather than
     * policies.
     *
     * They replaced `canRetrySameCandidate`, `canAdvanceCandidate` and
     * `hasNextCandidate`, which between them re-decided retryability, the
     * per-candidate transient budget, the whole-session budget and candidate
     * ordering — every one of which `@liberty/media-engine` already decides, and
     * one of which it decided differently. Nothing below re-derives any of it:
     * the schedule is asked, and the answer is routed.
     *
     * Note what is NOT here. There is no `hasNextCandidate`: "were streams still
     * available when the budget ran out" is `schedule.attemptable`, and asking it
     * separately is how the two lists drifted apart in the first place. There is
     * no retryability test either — a candidate the engine still lists as
     * attemptable is by definition one nothing has ruled out, and
     * `rights_unverifiable` can never be among them at any budget.
     */
    scheduleProceeds: ({ context }) => scheduleFor(context).next !== null,
    scheduleSpentTheBudget: ({ context }) => scheduleFor(context).reason === "attempt_limit_reached",

    /**
     * The element's clock moved forward.
     *
     * This is what un-stalls `buffering` and `recovering` when Shaka resumed
     * without firing `playing` — which it does when the stall was short enough
     * that the element never left its playing state. Without it the machine
     * reports a rebuffer that is still in progress while the viewer is watching,
     * which is the desync the mirror rule is about. Guarded on
     * `awaitingFirstFrame` so a restarted session's stale clock cannot do it.
     */
    positionAdvanced: ({ context, event }) =>
      event.type === "MEDIA_TIME_UPDATE" &&
      !context.awaitingFirstFrame &&
      Number.isFinite(event.positionSeconds) &&
      event.positionSeconds > context.positionSeconds
  },

  actions: {
    /* --- the four injected effects, as named no-ops. See playback-effects.ts. */
    requestSession: () => NO_OP_PLAYBACK_EFFECTS.requestSession(),
    loadCandidate: (_, request: LoadCandidateRequest) => NO_OP_PLAYBACK_EFFECTS.loadCandidate(request),
    stopCandidate: () => NO_OP_PLAYBACK_EFFECTS.stopCandidate(),
    retryStreaming: () => NO_OP_PLAYBACK_EFFECTS.retryStreaming(),

    /* --- mirrors: facts the element or the engine reported, written down --- */

    /**
     * Named in three places, and every one of them is load-bearing rather than
     * defensive.
     *
     * A descendant that handles `ENGINE_STATE` SHADOWS the region-level handler
     * — an exact event match stops the search, it does not merge with the
     * ancestor's. So `engineLoading` and the two guarded branches on `active`
     * each have to re-assert this, or `context.engine` would silently stop
     * updating in exactly the states whose eventless transitions read it, and
     * `engineLoading` would wait forever for a readiness it had already been
     * told about. The assignment is idempotent, so the cost is one object.
     */
    mirrorEngineState: assign(({ event }) =>
      event.type === "ENGINE_STATE" ? { engine: event.state } : {}
    ),

    mirrorPosition: assign(({ context, event }) => {
      if (event.type !== "MEDIA_SEEKING" && event.type !== "MEDIA_SEEKED" && event.type !== "MEDIA_TIME_UPDATE") {
        return {};
      }
      /* The element's clock belongs to the previous session until the first
       * frame of this one. See `awaitingFirstFrame`. */
      if (context.awaitingFirstFrame) return {};
      const reported = finiteSeconds(event.positionSeconds);
      return reported === null ? {} : { positionSeconds: reported };
    }),

    mirrorDuration: assign(({ event }) => {
      if (event.type !== "MEDIA_LOADED_METADATA" && event.type !== "MEDIA_DURATION_CHANGE") return {};
      return { durationSeconds: finiteSeconds(event.durationSeconds) };
    }),

    mirrorPlayIntent: assign(() => ({ paused: false })),
    mirrorPauseIntent: assign(() => ({ paused: true })),

    noteMediaSignal: assign(({ event }) => ({ lastMediaSignal: event.type })),

    noteUnroutedEvent: assign(({ context, event }) => ({
      unroutedEvents: context.unroutedEvents + 1,
      lastUnroutedEvent: event.type
    })),

    /**
     * An error we caused, recorded and then dropped.
     *
     * LOAD_INTERRUPTED and OPERATION_ABORTED arrive with CRITICAL severity but
     * describe our own control flow — usually the `load()` this machine
     * superseded one microsecond ago. Charging them to a candidate would make
     * every failover look like a fault caused by the candidate it failed over
     * TO, and would spend the attempt budget twice as fast as the policy says.
     */
    noteIgnoredError: assign(({ event }) => {
      if (event.type !== "ENGINE_ERROR") return { lastMediaSignal: event.type };
      return { lastError: summarisePlaybackError(event.error) };
    }),

    /* --- session lifecycle --- */

    recordSessionRequest: assign(({ context }) => ({
      ...appendTrail(context, trailEntry(context, "session_requested", "asked for an authorized session"))
    })),

    adoptSession: assign(({ context, event }) => {
      if (event.type !== "SESSION_RESOLVED") return {};
      const session = event.session;
      const start = finiteSeconds(session.startAtSeconds);
      return {
        contentId: session.contentId,
        candidates: session.candidates,
        candidateIndex: 0,
        resumeAtSeconds: session.startAtSeconds,
        positionSeconds: start ?? 0,
        ...appendTrail(
          context,
          trailEntry(
            context,
            "session_resolved",
            `${session.candidates.length} authorized candidate(s): ${
              session.reasons.length > 0 ? session.reasons.join("; ") : "no reasons supplied"
            }`,
            { candidateId: null }
          )
        )
      };
    }),

    stopWithNoCandidates: assign(({ context }) => ({
      stopReason: "no_candidates" as const,
      ...appendTrail(
        context,
        trailEntry(context, "stopped", "the session was granted but named no candidates", {
          candidateId: null
        })
      )
    })),

    stopWithSessionUnavailable: assign(({ context, event }) => {
      const reasons = event.type === "SESSION_UNAVAILABLE" ? event.reasons : [];
      return {
        stopReason: "session_unavailable" as const,
        ...appendTrail(
          context,
          trailEntry(
            context,
            "session_unavailable",
            reasons.length > 0 ? reasons.join("; ") : "no reasons supplied",
            { candidateId: null }
          )
        )
      };
    }),

    stopWithEngineUnavailable: assign(({ context }) => ({
      stopReason: "engine_unavailable" as const,
      ...appendTrail(
        context,
        trailEntry(
          context,
          "stopped",
          context.engine.status === "unavailable"
            ? `playback engine unavailable: ${context.engine.reason}`
            : "playback engine unavailable"
        )
      )
    })),

    stopWithAttemptLimit: assign(({ context }) => {
      /*
       * The count comes from the SCHEDULE, not from the index. It used to be
       * `candidates.length - candidateIndex - 1`, which was only ever "how many
       * are left" while the index marched forward one candidate at a time and
       * every candidate ahead of it was assumed untried — an arithmetic identity
       * that the engine's policy breaks on both sides. `attemptable` is the
       * answer to the question the sentence actually asks: which streams were
       * still worth loading at the moment the budget ran out.
       *
       * AND "REMAINED" IS SPLIT IN TWO, because `attemptable` answers a question
       * one word narrower than the sentence used to ask. It is "not ruled out",
       * which includes candidates that have already been loaded and failed
       * without being disqualified — a transient failure with retry budget left.
       * "N candidates remained" reads as "there were N streams we never got to",
       * and pointing an operator at a raised attempt limit to reach streams that
       * had all already been tried is the wrong remedy from a true sentence.
       * Under breadth-before-depth the untried ones are also the load-bearing
       * half: reaching the limit with any of them left is the case where a
       * larger budget would genuinely have played something new, and they are
       * NAMED because "which stream did we never reach" is the first question
       * anybody reading this line asks (invariant 4).
       *
       * `attemptable` is never empty here — the branch is guarded on
       * `attempt_limit_reached`, which the engine only reports when it had a
       * candidate to hand back — so neither sentence can be vacuous.
       */
      const schedule = scheduleFor(context);
      const untried = schedule.attemptable.filter(
        (candidateId) => attemptsCharged(context.attemptsByCandidate, candidateId) === 0
      );
      return {
        stopReason: "attempt_limit_reached" as const,
        ...appendTrail(
          context,
          trailEntry(
            context,
            "stopped",
            untried.length > 0
              ? `attempt budget of ${context.policy.maxAttempts} spent while ${untried.length} candidate(s) had never been tried: ${untried.join(", ")}`
              : `attempt budget of ${context.policy.maxAttempts} spent; the ${schedule.attemptable.length} candidate(s) still attemptable had all been tried at least once`
          )
        )
      };
    }),

    stopWithExhausted: assign(({ context }) => {
      const schedule = scheduleFor(context);
      const reason = stopReasonFor(schedule);
      /*
       * ITEMISED, in the engine's own exclusion vocabulary and in the same
       * `id=reason` shape `planFailover`'s explanation uses.
       *
       * "Every attemptable candidate has been ruled out" names no candidate and
       * no finding, and for one of the exclusions there is now NOTHING ELSE in
       * the trail that carries the finding: an attempt the classifier could not
       * place leaves `failures` empty by contract, so `attempt_failed_unclassified`
       * is the only place the session says why that stream is gone. Invariant 4
       * asks for a reason trail sufficient to debug candidate selection, and a
       * headline with no itemisation is not one.
       */
      const itemised = schedule.excluded
        .map((entry) => `${entry.candidateId}=${entry.reason}`)
        .join(", ");
      return {
        stopReason: reason,
        ...appendTrail(
          context,
          trailEntry(
            context,
            "stopped",
            reason === "all_candidates_rights_blocked"
              ? `every attempted candidate failed on rights; none of them may be retried: ${itemised}`
              : `every attemptable candidate has been ruled out: ${
                  itemised.length > 0 ? itemised : "nothing was ever attemptable"
                }`
          )
        )
      };
    }),

    resetForRetry: assign(({ context }) => ({
      candidateIndex: -1,
      attemptsUsed: 0,
      attemptsByCandidate: {},
      recoveriesOnCandidate: 0,
      failures: [],
      lastFailureKind: null,
      lastError: null,
      stopReason: null,
      reattaching: false,
      awaitingFirstFrame: false,
      /*
       * `positionSeconds` and `resumeAtSeconds` deliberately survive. A viewer
       * who asks to try again after a failure is asking to carry on watching,
       * not to start the film over — and the trail survives too, because the
       * reason the first attempt failed is the most useful thing in it.
       */
      ...appendTrail(context, trailEntry(context, "session_requested", "retry requested by the viewer"))
    })),

    /* --- attempts, recovery and failover --- */

    /**
     * One attempt, charged twice over: to the session budget and to the
     * candidate it is about to be spent on.
     *
     * Runs AFTER `applyScheduledAttempt` on the failover path, so
     * `currentCandidateId` is already the candidate being started rather than the
     * one being left. On the `engineLoading -> loading` path the candidate is the
     * one `adoptSession` selected. Rebuilding a destroyed engine deliberately
     * does not run this at all: that reload is not the candidate's fault and must
     * not make the candidate look tried a second time either.
     */
    countAttempt: assign(({ context }) => {
      const id = currentCandidateId(context);
      return {
        attemptsUsed: context.attemptsUsed + 1,
        attemptsByCandidate:
          id === null
            ? context.attemptsByCandidate
            : { ...context.attemptsByCandidate, [id]: attemptsCharged(context.attemptsByCandidate, id) + 1 }
      };
    }),

    /**
     * The engine went away, so the element's clock stopped being ours.
     *
     * `awaitingFirstFrame` is raised HERE and not left to `loading`'s entry,
     * because between `ENGINE_STATE destroyed` and the next `ENGINE_STATE ready`
     * the machine sits in `engineLoading` with no load in flight — while the
     * region's `MEDIA_TIME_UPDATE` mirror and `active`'s `MEDIA_SEEKED` mirror
     * are still listening, because they must be. A torn-down element reports 0,
     * `finiteSeconds(0)` is `0` rather than `null`, and the position
     * `recordEngineLost` preserves one action later is then overwritten with
     * zero before the rebuilt engine ever loads. The failover path has no such
     * window:
     * `failingOver -> loading` completes in a single macrostep, so no event can
     * be delivered in the middle of it.
     */
    markReattaching: assign(() => ({ reattaching: true, awaitingFirstFrame: true })),
    clearReattaching: assign(() => ({ reattaching: false })),

    recordEngineLost: assign(({ context }) => ({
      /*
       * The engine, not the candidate, went away — a React remount or a DOM
       * move, both of which destroy the Shaka session. The position is preserved
       * exactly as it is for a failover, because from the element's point of
       * view the two are the same restart.
       */
      resumeAtSeconds: context.positionSeconds > 0 ? context.positionSeconds : context.resumeAtSeconds,
      ...appendTrail(
        context,
        trailEntry(context, "engine_lost", "the playback engine was destroyed; rebuilding and resuming", {
          resumeAtSeconds: context.positionSeconds > 0 ? context.positionSeconds : context.resumeAtSeconds
        })
      )
    })),

    recordAttempt: assign(({ context }) => ({
      awaitingFirstFrame: true,
      ...appendTrail(
        context,
        trailEntry(
          context,
          "candidate_attempt",
          `attempt ${context.attemptsUsed} on ${currentCandidateId(context) ?? "no candidate"} from ${
            context.resumeAtSeconds ?? 0
          }s`,
          { resumeAtSeconds: context.resumeAtSeconds }
        )
      )
    })),

    recordPlaying: assign(({ context }) => {
      /* Only the FIRST frame of an attempt is worth a line. Every unstall also
       * fires `playing`, and those are already recorded as `rebuffer` on the way
       * in — recording both would double every stall in the trail. */
      if (!context.awaitingFirstFrame) return {};
      return appendTrail(
        context,
        trailEntry(context, "candidate_playing", "first frame presented", {
          resumeAtSeconds: context.resumeAtSeconds
        })
      );
    }),

    settleRestart: assign(() => ({ awaitingFirstFrame: false })),

    recordRebuffer: assign(({ context }) =>
      appendTrail(context, trailEntry(context, "rebuffer", "playback stalled waiting for data"))
    ),

    recordRecoverableError: assign(({ context, event }) => {
      if (event.type !== "ENGINE_ERROR") return {};
      const summary = summarisePlaybackError(event.error);
      return {
        lastError: summary,
        ...appendTrail(
          context,
          trailEntry(context, "recoverable_error", summary.message, { error: summary })
        )
      };
    }),

    countRecovery: assign(({ context }) => ({
      recoveriesOnCandidate: context.recoveriesOnCandidate + 1
    })),

    recordCandidateFailure: assign(({ context, event }) => {
      if (event.type !== "ENGINE_ERROR") return {};
      const summary = summarisePlaybackError(event.error);
      /*
       * THE CLASSIFIER GETS FIRST SAY, WHATEVER THE SEVERITY.
       *
       * A non-fatal error only reaches this branch when the recovery budget for
       * this candidate is already spent — `errorIsRecoverableWithinBudget` took
       * every other case — and that is `transient_retries_exhausted` in the
       * failover vocabulary. But "the budget ran out" describes how we got here,
       * not what went wrong, and asserting `network_transient` from it asserts
       * the ONE kind `RETRYABLE_FAILURE_KINDS` admits. A RECOVERABLE DRM or
       * MANIFEST error recorded as transient would reach `scheduleAttempts` as a
       * kind `PLAYBACK_FAILURE_POLICY` marks retryable, `exclusionFor` would
       * leave the candidate in the attemptable pool, and `failingOver` would
       * re-load it: a second attempt to play something we may not be entitled to
       * play, which invariants 1 and 2 forbid outright. That is not a guard this
       * file could tighten to compensate — `failures` IS the evidence the engine
       * decides on, so the guess would become policy the moment it is written.
       *
       * The transient fallback therefore applies only where the classifier
       * genuinely cannot tell AND the error was not fatal — a stall Shaka
       * reported under a category with no category-level answer, which is the
       * case the budget bound was written for. A FATAL error the classifier
       * cannot place stays `null`: unclassified, absent from `failures`, and not
       * retried. That is rule 1 in `playback-failure.ts`, and `null` there is an
       * answer rather than a failure to answer.
       */
      const classified = classifyPlaybackFailure(event.error);
      const kind = classified ?? (event.error.fatal ? null : "network_transient");
      return recordFailure(context, summary, kind, summary.message);
    }),

    recordMediaFailure: assign(({ context, event }) => {
      if (event.type !== "MEDIA_ERROR") return {};
      const code = event.mediaErrorCode;
      const summary: PlaybackErrorSummary = {
        origin: "player-event",
        severity: "critical",
        fatal: true,
        aborted: false,
        code: null,
        category: null,
        categoryName: null,
        message: `media element error ${code ?? "unknown"}`,
        detail: { kind: "media-element", mediaErrorCode: code }
      };
      return recordFailure(context, summary, classifyMediaElementError(code), summary.message);
    }),

    /**
     * Freeze the position the restart will resume from.
     *
     * Runs on entry to `failingOver`, BEFORE the eventless transitions decide
     * where to go, so every branch reads a settled resume point. A zero position
     * falls back to what the session asked for rather than overwriting it —
     * failing over before the first frame must not silently convert "start at 20
     * minutes" into "start at the beginning".
     *
     * DELIBERATELY INDEPENDENT OF WHICH CANDIDATE COMES BACK, which is what
     * makes it survive breadth-before-depth. The resume point is a fact about the
     * VIEWER — where they are in the film — not about the stream that was
     * carrying it, so it is preserved before the scheduler is asked and applies
     * unchanged whether the next candidate is a fresh one, the one we just left,
     * or one attempted several failovers ago.
     */
    preserveResumePosition: assign(({ context }) => ({
      resumeAtSeconds: context.positionSeconds > 0 ? context.positionSeconds : context.resumeAtSeconds
    })),

    /**
     * The failover itself: adopt whatever `scheduleAttempts` chose, and say so.
     *
     * ONE ACTION WHERE THERE WERE TWO. `countTransientRetry` and
     * `advanceCandidate` used to be separate because the machine's own policy
     * treated "retry this one" and "move to the next one" as different KINDS of
     * decision reached through different guards. Under the engine's policy they
     * are one decision — pick the best candidate the budget can still buy — and
     * the difference between them is an observation about the candidate that came
     * back, not a branch that had to be taken to get here. Keeping them apart is
     * what let the machine's wording and the engine's disagree.
     *
     * THE TRAIL SPEAKS THE ENGINE'S VOCABULARY. `schedule.reason` is a
     * `FailoverReason` and it is printed verbatim in the detail, so a client
     * trail and a server plan describing the same decision now use the same word
     * and cannot drift into two accounts of one event. The KIND is still the
     * client's own — `candidate_retry` when the engine handed back a candidate
     * that has already been attempted, `failover` otherwise — because that is
     * the distinction the debug panel groups by.
     *
     * Both candidates are named whichever kind it is. Under breadth-before-depth
     * a repeat need not be the candidate we just left (a -> b -> a is an ordinary
     * sequence now), so "which did we leave" and "which are we starting" are two
     * facts and the line carries both. Product invariant 4: a failover with no
     * recorded reason is the same defect as a rights denial with no reason.
     */
    applyScheduledAttempt: assign(({ context }) => {
      const schedule = scheduleFor(context);
      const nextId = schedule.next;
      /* Unreachable: `scheduleProceeds` guarded this branch on the same pure
       * function over the same context. Returning an empty patch rather than
       * asserting keeps the mirror rule — nothing here throws — and the state we
       * would be left in is the one we were already in. */
      if (nextId === null) return {};

      const from = currentCandidateId(context);
      /* Total for the same reason: `next` is drawn from `attemptable`, which is
       * drawn from the very id list this searches. A `-1` would degrade to "no
       * candidate", which `loadRequestFor` and `recordAttempt` already handle. */
      const index = context.candidates.findIndex((candidate) => candidate.id === nextId);
      const repeat = schedule.reason === "retry_after_transient_failure";

      return {
        candidateIndex: index,
        recoveriesOnCandidate: 0,
        lastFailureKind: null,
        ...appendTrail(
          context,
          trailEntry(
            context,
            repeat ? "candidate_retry" : "failover",
            `${from ?? "no candidate"} -> ${nextId}: ${schedule.reason}; restarting at ${
              context.resumeAtSeconds ?? 0
            }s because Shaka cannot swap the source of a live session`,
            { candidateId: from, failureKind: context.lastFailureKind, resumeAtSeconds: context.resumeAtSeconds }
          )
        )
      };
    }),

    recordEnded: assign(({ context }) =>
      appendTrail(context, trailEntry(context, "ended", "the media reached its end"))
    )
  }
}).createMachine({
  id: "playback",
  type: "parallel",
  context: ({ input }) => initialPlaybackContext(input),

  states: {
    /* ===================================================================
     * The session and candidate lifecycle.
     * =================================================================== */
    session: {
      initial: "idle",

      /*
       * THE BACKSTOP, and the reason nothing throws.
       *
       * These sit on the region rather than on the machine root because in a
       * parallel machine an event that no region handled walks up from EVERY
       * region — so a wildcard at the root would fire once for the `engine`
       * region on every media event, and `unroutedEvents` would count normal
       * traffic. On the region, the wildcard means exactly what it says: the
       * session lifecycle had nothing to do with this.
       *
       * The named entries above it are the mirrors that must run in every
       * state, including `idle` and `fatal`. An exact match always wins over
       * the wildcard within one node, so listing them here is what keeps
       * position, duration, pause and engine state truthful after the session
       * has stopped — a viewer scrubbing a fatal player still moves the clock.
       */
      on: {
        MEDIA_TIME_UPDATE: { actions: "mirrorPosition" },
        MEDIA_DURATION_CHANGE: { actions: "mirrorDuration" },
        MEDIA_LOADED_METADATA: { actions: "mirrorDuration" },
        MEDIA_PLAY: { actions: "mirrorPlayIntent" },
        MEDIA_PAUSE: { actions: "mirrorPauseIntent" },
        ENGINE_STATE: { actions: "mirrorEngineState" },
        "*": { actions: "noteUnroutedEvent" }
      },

      states: {
        idle: {
          on: {
            START: { target: "resolving" }
          }
        },

        resolving: {
          id: "resolving",
          entry: ["recordSessionRequest", "requestSession"],
          on: {
            SESSION_RESOLVED: [
              { guard: "sessionHasCandidates", target: "active", actions: "adoptSession" },
              { target: "fatal", actions: ["adoptSession", "stopWithNoCandidates"] }
            ],
            SESSION_UNAVAILABLE: { target: "fatal", actions: "stopWithSessionUnavailable" }
          }
        },

        active: {
          id: "active",
          initial: "engineLoading",

          /*
           * Handlers that apply to every candidate state. An engine that
           * vanished, a candidate error, a media error and the end of the media
           * are all facts that can arrive in any of them, and writing them once
           * here is what makes "every event has an inbound transition in every
           * state" true without eleven copies of it.
           */
          on: {
            ENGINE_STATE: [
              {
                guard: "engineEventIsDestroyed",
                target: "#active.engineLoading",
                actions: ["mirrorEngineState", "markReattaching", "recordEngineLost"]
              },
              {
                guard: "engineEventIsUnavailable",
                target: "#fatal",
                actions: ["mirrorEngineState", "stopWithEngineUnavailable"]
              }
              /* Anything else falls through to the region's mirror above. */
            ],

            MEDIA_ENDED: { target: "#ended" },
            MEDIA_PLAYING: { target: "#active.playing" },
            MEDIA_WAITING: { target: "#active.buffering" },
            MEDIA_STALLED: { target: "#active.buffering" },
            MEDIA_SEEKING: { target: "#active.seeking", actions: "mirrorPosition" },
            MEDIA_SEEKED: { actions: "mirrorPosition" },

            /* Real, frequent, and not lifecycle facts. Recorded, not routed. */
            MEDIA_LOAD_START: { actions: "noteMediaSignal" },
            MEDIA_CAN_PLAY: { actions: "noteMediaSignal" },
            MEDIA_EMPTIED: { actions: "noteMediaSignal" },

            MEDIA_ERROR: [
              { guard: "mediaErrorIsIgnorable", actions: "noteIgnoredError" },
              { target: "#active.failingOver", actions: "recordMediaFailure" }
            ],

            ENGINE_ERROR: [
              { guard: "errorIsAborted", actions: "noteIgnoredError" },
              {
                guard: "errorIsRecoverableWithinBudget",
                target: "#active.recovering",
                actions: "recordRecoverableError"
              },
              { target: "#active.failingOver", actions: "recordCandidateFailure" }
            ]
          },

          states: {
            /**
             * Waiting for a usable Shaka session.
             *
             * Reached twice for different reasons — once at the start, and again
             * whenever the engine is destroyed under us — which is why the
             * reattach case is guarded separately: rebuilding an engine after a
             * remount is not a failed attempt and must not be charged to the
             * budget.
             *
             * The eventless list and the event list below say the same thing
             * twice, and both are needed. The eventless one covers an engine
             * that was ALREADY ready when the session resolved, where no further
             * `ENGINE_STATE` is coming and waiting for one would hang forever.
             * The event one covers the ordinary case without depending on when
             * the sibling region's assignment becomes visible.
             */
            engineLoading: {
              always: [
                { guard: "engineIsUnavailable", target: "#fatal", actions: "stopWithEngineUnavailable" },
                { guard: "engineIsReadyAfterReattach", target: "loading", actions: "clearReattaching" },
                { guard: "engineIsReady", target: "loading", actions: "countAttempt" }
              ],
              on: {
                ENGINE_STATE: [
                  {
                    guard: "engineEventIsUnavailable",
                    target: "#fatal",
                    actions: ["mirrorEngineState", "stopWithEngineUnavailable"]
                  },
                  {
                    guard: "engineEventIsReadyAfterReattach",
                    target: "loading",
                    actions: ["mirrorEngineState", "clearReattaching"]
                  },
                  {
                    guard: "engineEventIsReady",
                    target: "loading",
                    actions: ["mirrorEngineState", "countAttempt"]
                  },
                  { actions: "mirrorEngineState" }
                ]
              }
            },

            /**
             * A candidate is being started. ALWAYS A FULL RESTART — see the file
             * header. `loadCandidate` receives the resume point, which is the
             * only thing that survives the teardown.
             */
            loading: {
              entry: [
                "recordAttempt",
                { type: "loadCandidate", params: ({ context }) => loadRequestFor(context) }
              ],
              on: {
                /*
                 * `waiting`, `stalled` and the resume `seeking` are all normal
                 * during startup. Routed to nothing so that startup buffering is
                 * not reported as a rebuffer — a rebuffer is a stall in
                 * something that was already playing, and conflating the two
                 * makes the metric PL-0503 will build on meaningless.
                 */
                MEDIA_WAITING: { actions: "noteMediaSignal" },
                MEDIA_STALLED: { actions: "noteMediaSignal" },
                MEDIA_SEEKING: { actions: "noteMediaSignal" },
                MEDIA_SEEKED: { actions: "noteMediaSignal" }
              }
            },

            playing: {
              entry: ["recordPlaying", "settleRestart"],
              on: {
                /* Already playing. Targetless so the entry actions above do not
                 * re-run and put a second `candidate_playing` in the trail. */
                MEDIA_PLAYING: { actions: "settleRestart" }
              }
            },

            buffering: {
              entry: "recordRebuffer",
              on: {
                MEDIA_WAITING: { actions: "noteMediaSignal" },
                MEDIA_STALLED: { actions: "noteMediaSignal" },
                MEDIA_TIME_UPDATE: {
                  guard: "positionAdvanced",
                  target: "playing",
                  actions: "mirrorPosition"
                }
              }
            },

            seeking: {
              on: {
                MEDIA_SEEKING: { actions: "mirrorPosition" },
                /*
                 * `seeked` means the position moved, not that data is there.
                 * Landing in `buffering` rather than `playing` is the honest
                 * projection; the element's own `playing`, or its clock moving,
                 * takes it the rest of the way.
                 */
                MEDIA_SEEKED: { target: "buffering", actions: "mirrorPosition" },
                MEDIA_WAITING: { actions: "noteMediaSignal" },
                MEDIA_STALLED: { actions: "noteMediaSignal" }
              }
            },

            /**
             * A RECOVERABLE error, being answered with the cheapest thing Shaka
             * offers. This state is why a recoverable error is not a failover:
             * `retryStreaming()` resumes a stalled stream without touching the
             * manifest, the buffer or the CDM session.
             *
             * Bounded by `MAX_STREAMING_RECOVERIES_PER_CANDIDATE`. Shaka never
             * raises a CRITICAL for a segment it is still retrying, so an
             * unbounded version of this state is a player that never gives up on
             * a dead stream.
             */
            recovering: {
              entry: ["countRecovery", "retryStreaming"],
              on: {
                MEDIA_TIME_UPDATE: {
                  guard: "positionAdvanced",
                  target: "playing",
                  actions: "mirrorPosition"
                }
              }
            },

            /**
             * The candidate is out. ASK THE ENGINE what replaces it, or stop.
             *
             * THE ORDER OF THESE BRANCHES IS NOT THE POLICY, AND THAT IS THE
             * CHANGE. It used to be: retry the same candidate if it had budget,
             * else advance one, else stop. That list WAS the scheduling policy,
             * written here, in a statechart, one layer away from the module that
             * owns it — and it disagreed with that module. Trying a retry first
             * meant a four-attempt budget could be spent two-apiece on two
             * candidates while a third authorized stream sat untried;
             * `@liberty/media-engine` had already been fixed to prefer untried
             * candidates and nothing in real playback ever called it.
             *
             * These three branches now ROUTE a decision that has already been
             * made. `scheduleAttempts` says proceed, budget-spent or exhausted;
             * each guard asks which, and each action records it. Reordering them
             * cannot change what the player does, only which of three mutually
             * exclusive answers is checked first — and the last is unguarded so
             * the routing is total.
             *
             * Still eventless, so the decision is a pure function of the context
             * the failure actions just wrote and no event can arrive between the
             * failure and the decision and change the answer. That also makes it
             * safe for the guards and the actions to recompute the schedule
             * independently: same pure function, same frozen context, same
             * answer.
             *
             * The budget-spent and exhausted branches stay separate for the
             * reason `@liberty/media-engine` separates them: "we ran out of
             * budget while streams remained" sends a reader to the policy and "we
             * tried everything" sends them to the provider, and a single
             * "failover failed" sends them nowhere.
             */
            failingOver: {
              entry: "preserveResumePosition",
              always: [
                {
                  guard: "scheduleProceeds",
                  target: "loading",
                  actions: ["applyScheduledAttempt", "countAttempt"]
                },
                { guard: "scheduleSpentTheBudget", target: "#fatal", actions: "stopWithAttemptLimit" },
                { target: "#fatal", actions: "stopWithExhausted" }
              ]
            }
          }
        },

        /**
         * The media reached its end. NOT `type: "final"` — see `fatal`.
         *
         * Scrubbing backwards from here is ordinary viewer behaviour and the
         * element will happily play again, so the two events that mean it do
         * come back into `active`. A machine that treated `ended` as absorbing
         * would report a finished session while the viewer watched the last ten
         * minutes again.
         */
        ended: {
          id: "ended",
          entry: "recordEnded",
          on: {
            MEDIA_SEEKING: { target: "#active.seeking", actions: "mirrorPosition" },
            MEDIA_PLAYING: { target: "#active.playing" },
            RETRY: { target: "resolving", actions: "resetForRetry" }
          }
        },

        /**
         * The session is over and no candidate remains.
         *
         * NOT `type: "final"`, and that is deliberate rather than an oversight:
         * when every region of a parallel machine reaches a final state the
         * actor stops, and a stopped actor cannot mirror the teardown events
         * that still arrive — `emptied`, the engine's `destroyed`, a last
         * `timeupdate`. Silence after a fatal error is precisely the desync the
         * mirror rule exists to prevent, so this is an ordinary state that
         * happens to have one way out.
         *
         * `stopCandidate` runs here and only here. Everywhere else the next
         * `load()` is itself the teardown.
         */
        fatal: {
          id: "fatal",
          entry: "stopCandidate",
          on: {
            RETRY: { target: "resolving", actions: "resetForRetry" }
          }
        }
      }
    },

    /* ===================================================================
     * The engine, as its own axis.
     *
     * Genuinely orthogonal, not a decomposition for its own sake: the Shaka
     * session is created and destroyed by the element's connection to the DOM,
     * so a React remount or a DOM move tears it down at whatever point in the
     * candidate lifecycle happens to be current. Folded into the region above it
     * would need a copy of itself under every one of eleven states.
     *
     * The last branch is unguarded, which is what gives `ENGINE_STATE` an
     * inbound transition from every engine state including the ones it "cannot"
     * arrive in.
     * =================================================================== */
    engine: {
      initial: "idle",
      on: {
        ENGINE_STATE: [
          { guard: "engineEventIsLoading", target: ".loading" },
          { guard: "engineEventIsReady", target: ".ready" },
          { guard: "engineEventIsUnavailable", target: ".unavailable" },
          { guard: "engineEventIsDestroyed", target: ".destroyed" },
          { target: ".idle" }
        ]
      },
      states: {
        idle: {},
        loading: {},
        ready: {},
        unavailable: {},
        destroyed: {}
      }
    }
  }
});

/* -------------------------------------------------------------------------
 * Public surface
 * ---------------------------------------------------------------------- */

export interface CreatePlaybackActorOptions {
  readonly input: PlaybackMachineInput;
  /** Omitted, the machine runs completely inert. See `playback-effects.ts`. */
  readonly effects?: PlaybackEffects;
}

/**
 * The only intended way to build a running machine.
 *
 * `provide` replaces the four named no-ops and nothing else — no guard, no
 * assignment and no transition is overridable from outside this file, so the
 * lifecycle a test exercises is the lifecycle production runs.
 */
export function createPlaybackActor(options: CreatePlaybackActorOptions) {
  const effects = options.effects ?? NO_OP_PLAYBACK_EFFECTS;
  const machine = playbackMachine.provide({
    actions: {
      requestSession: () => effects.requestSession(),
      loadCandidate: (_, request) => effects.loadCandidate(request),
      stopCandidate: () => effects.stopCandidate(),
      retryStreaming: () => effects.retryStreaming()
    }
  });
  return createActor(machine, { input: options.input });
}

/*
 * Derived from the factory rather than from the machine with `ActorRefFrom` /
 * `SnapshotFrom`. Both spellings describe the same thing, but this one is exact
 * BY CONSTRUCTION — `provide()` returns a new machine type, and a helper alias
 * that merely ought to be assignable to it is a compile error waiting for an
 * XState minor rather than a documented guarantee.
 */
export type PlaybackActor = ReturnType<typeof createPlaybackActor>;
export type PlaybackSnapshot = ReturnType<PlaybackActor["getSnapshot"]>;

function asPhase(value: unknown): PlaybackPhase | null {
  return typeof value === "string" && PLAYBACK_PHASES.includes(value) ? (value as PlaybackPhase) : null;
}

/**
 * The session region's state, flattened.
 *
 * Nothing outside this file should have to know that the candidate states are
 * nested under `active` — that nesting exists so the shared handlers can be
 * written once, and it is an implementation detail of the statechart rather
 * than of the lifecycle. Falls back to `idle` rather than throwing: a selector
 * that can crash a render on an unexpected state value is a worse failure than
 * one that reports the initial phase.
 */
export function playbackPhase(snapshot: PlaybackSnapshot): PlaybackPhase {
  const value: unknown = snapshot.value;
  if (typeof value !== "object" || value === null) return "idle";

  const session: unknown = (value as Record<string, unknown>).session;
  const direct = asPhase(session);
  if (direct !== null) return direct;

  if (typeof session === "object" && session !== null) {
    return asPhase((session as Record<string, unknown>).active) ?? "idle";
  }
  return "idle";
}

/** `idle`, `loading`, `ready`, `unavailable` or `destroyed`, mirrored. */
export function engineStatus(snapshot: PlaybackSnapshot): EngineState["status"] {
  return snapshot.context.engine.status;
}

/** True while a load is in flight and the element's clock is not ours yet. */
export function isRestarting(snapshot: PlaybackSnapshot): boolean {
  return snapshot.context.awaitingFirstFrame;
}
