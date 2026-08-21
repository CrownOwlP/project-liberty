/* -------------------------------------------------------------------------
 * Every side effect the machine has, declared as a named no-op
 *
 * `docs/RESEARCH_PLAYBACK.md` names this as the thing worth copying from the
 * most mature public video statechart: declare each effect as a named no-op and
 * inject the real one, so the machine is pure and unit-testable without a DOM.
 * That is not a testing convenience. The machine is a PROJECTION of the video
 * element and the engine, and a projection that can reach into the thing it
 * projects will eventually disagree with it and then correct it — which is the
 * desync this whole design exists to prevent.
 *
 * So: THE MACHINE NEVER TOUCHES THE ELEMENT. It asks, through these four names,
 * and the answer comes back as an event like every other fact. Nothing in
 * `playback-machine.ts` imports `PlaybackController`, `<liberty-video>`, or
 * anything that resolves to a browser global. `playback-machine.test.ts`
 * asserts that the no-op set drives a full failover with no element at all.
 *
 * FOUR, AND NO MORE. Anything the controls layer owns — play, pause, seek,
 * rate, volume, fullscreen — is deliberately absent. media-chrome already owns
 * those through `<media-controller>` and duplicating them here is the named
 * over-engineering failure mode. The machine OBSERVES a seek; it never asks for
 * one.
 *
 * There is also no `reportTrail`. The trail lives in the machine's context and
 * is read by subscribing to the actor, so PL-0503 attaches a transport without
 * this file growing a fifth member and without every trail-appending action
 * having to remember to fire it.
 * ---------------------------------------------------------------------- */

import type { PlaybackCandidate } from "./playback-session";

export interface LoadCandidateRequest {
  /**
   * `null` when the machine's candidate index does not name a candidate.
   *
   * Not narrowed away with a cast, and this is not defensiveness. Under
   * `noUncheckedIndexedAccess` an indexed read is `T | undefined`, and the
   * machine cannot prove to the compiler that its own index is in range. A cast
   * here would be the single place where the reason trail could claim an
   * attempt on a candidate that does not exist — so the `null` travels to the
   * implementation, which does nothing with it.
   */
  readonly candidate: PlaybackCandidate | null;
  /**
   * Where to resume, in SECONDS, passed straight to Shaka's `load()`.
   *
   * This is the whole of position preservation across a failover. Shaka has no
   * API to swap the source of a live session — `load(newUri)` resets the stats,
   * discards the buffer and re-establishes DRM — so a candidate switch is a
   * restart, and the ONLY thing that carries across it is this number.
   */
  readonly startAtSeconds: number | null;
  /** 1-based, and charged against `FailoverPolicy.maxAttempts`. For the trail. */
  readonly attempt: number;
}

export interface PlaybackEffects {
  /**
   * Ask for an authorized session. The seam for PL-0501.
   *
   * The answer arrives as `SESSION_RESOLVED` or `SESSION_UNAVAILABLE`, never as
   * a return value: resolution is a network round trip today and will stay one,
   * and a machine that could receive the answer synchronously would be modelling
   * a world that does not exist.
   */
  readonly requestSession: () => void;
  /**
   * Start a candidate. A TEARDOWN AND RESTART, always — see
   * `LoadCandidateRequest.startAtSeconds` and `PlaybackController.setSource`.
   */
  readonly loadCandidate: (request: LoadCandidateRequest) => void;
  /**
   * Release the media pipeline. Called once, when the session is over.
   *
   * Deliberately NOT called before a failover: `load()` is itself the teardown,
   * and an extra `unload()` in front of it only creates a superseded operation
   * for the controller to filter out of the error stream.
   */
  readonly stopCandidate: () => void;
  /**
   * Shaka's `retryStreaming()` — the cheapest recovery there is, and the reason
   * a RECOVERABLE error is not a failover. It resumes a stalled stream without
   * touching the manifest, the buffer or the CDM session.
   */
  readonly retryStreaming: () => void;
}

/**
 * The default implementations, and the ones the machine is defined with.
 *
 * A machine constructed without `.provide()` is therefore complete, inert and
 * safe: it transitions exactly as it would in production and drives nothing. A
 * test that wants to observe what WOULD have happened reads the trail, or
 * substitutes a recording double.
 */
export const NO_OP_PLAYBACK_EFFECTS: PlaybackEffects = {
  requestSession: () => {
    /* Injected by the client boundary; PL-0501 supplies the session. */
  },
  loadCandidate: () => {
    /* Injected by the client boundary; routed to `PlaybackController.setSource`. */
  },
  stopCandidate: () => {
    /* Injected by the client boundary; routed to `setSource(null)`. */
  },
  retryStreaming: () => {
    /* Injected by the client boundary; routed to Shaka's `retryStreaming()`. */
  }
};

/** A double that records what the machine asked for, in order. For tests. */
export interface RecordedPlaybackEffects extends PlaybackEffects {
  readonly sessionRequests: number[];
  readonly loads: LoadCandidateRequest[];
  readonly stops: number[];
  readonly streamingRetries: number[];
}

/**
 * Lives beside the effects rather than in the test file because three test
 * files need it, and a second copy of it would be a second opinion about what
 * "the machine asked for a load" means.
 *
 * The counters hold a call ORDINAL rather than a timestamp — the machine has no
 * clock and neither does its double, so an assertion about ordering stays an
 * assertion about ordering rather than about how fast the test ran.
 */
export function recordPlaybackEffects(): RecordedPlaybackEffects {
  const sessionRequests: number[] = [];
  const loads: LoadCandidateRequest[] = [];
  const stops: number[] = [];
  const streamingRetries: number[] = [];
  let ordinal = 0;

  return {
    sessionRequests,
    loads,
    stops,
    streamingRetries,
    requestSession: () => {
      ordinal += 1;
      sessionRequests.push(ordinal);
    },
    loadCandidate: (request) => {
      ordinal += 1;
      loads.push(request);
    },
    stopCandidate: () => {
      ordinal += 1;
      stops.push(ordinal);
    },
    retryStreaming: () => {
      ordinal += 1;
      streamingRetries.push(ordinal);
    }
  };
}
