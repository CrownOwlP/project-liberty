"use client";

/* -------------------------------------------------------------------------
 * The client boundary — where the machine meets a real element
 *
 * This is the ONLY file in which the state machine and the DOM are in the same
 * room, and it is deliberately the dullest one. Everything it does is one of
 * two directions:
 *
 *   element / engine  --(events)-->  machine
 *   machine           --(effects)->  controller
 *
 * There is no third direction. Nothing here reads the machine's state and then
 * decides what the element should do; that would be the source-of-truth
 * inversion `docs/RESEARCH_PLAYBACK.md` warns about, and it is how a player ends
 * up correcting the element towards a state the element already left.
 *
 * The custom element is created with `document.createElement` and appended in an
 * effect rather than rendered as JSX. Three reasons, in order of weight:
 * React must never diff or re-create a node that owns a MediaSource and a CDM
 * session; `HTMLElementTagNameMap` in `liberty-video.ts` already types the
 * result exactly, so no JSX augmentation is needed; and listeners can be
 * attached BEFORE the node enters the document, which is the only way to catch
 * the `enginestatechange` the controller emits synchronously from
 * `connectedCallback`.
 *
 * NO CONTROLS ARE BUILT HERE. The native `controls` attribute is set so the
 * surface is usable, and the eventual `<media-controller>` replaces it. Play,
 * pause, seek, rate, volume and fullscreen are that layer's, not this one's.
 * ---------------------------------------------------------------------- */

import { useEffect, useRef, useState } from "react";
import type { FailoverPolicy } from "@liberty/contracts/domains/failover";
import type { EngineState } from "./playback-controller";
import {
  LIBERTY_VIDEO_ENGINE_STATE_EVENT,
  LIBERTY_VIDEO_ERROR_EVENT,
  LIBERTY_VIDEO_TAG,
  defineLibertyVideo,
  type LibertyVideoElement
} from "./liberty-video";
import type { PlaybackEffects } from "./playback-effects";
import {
  createPlaybackActor,
  currentCandidateId,
  engineStatus,
  isRestarting,
  playbackPhase,
  type PlaybackEvent,
  type PlaybackPhase,
  type PlaybackSnapshot,
  type PlaybackStopReason,
  type PlaybackTrailEntry
} from "./playback-machine";
import type { PlaybackSession } from "./playback-session";
import type { PlaybackError } from "./shaka-error";

export interface PlayerSurfaceProps {
  /** Already authorized. This component never fetches or chooses a source. */
  readonly session: PlaybackSession;
  /** The attempt budget, supplied by the server so both agree on one policy. */
  readonly policy: FailoverPolicy;
}

/**
 * Read defensively rather than through the element's declared type.
 *
 * `custom-media-element` forwards the inner `<video>`'s properties onto the host
 * at runtime, and how completely its type declarations describe that has changed
 * between minors. A forwarding gap must degrade to `null` here rather than
 * putting `undefined` into an event payload where the machine would read it as a
 * position.
 */
function readNumber(source: unknown, key: string): number | null {
  if (typeof source !== "object" || source === null) return null;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readPositionSeconds(video: LibertyVideoElement): number {
  return readNumber(video, "currentTime") ?? 0;
}

function readDurationSeconds(video: LibertyVideoElement): number | null {
  /* `NaN` until metadata arrives and `Infinity` for live, and `readNumber`
   * rejects both — which is exactly right, because "unknown" and "endless" are
   * both "not a duration" to everything downstream. */
  return readNumber(video, "duration");
}

function readMediaErrorCode(video: LibertyVideoElement): number | null {
  const error: unknown = (video as unknown as { error?: unknown }).error;
  return readNumber(error, "code");
}

function readDetail<Detail>(event: Event): Detail | null {
  const detail: unknown = (event as CustomEvent<unknown>).detail;
  return (detail ?? null) as Detail | null;
}

/**
 * Shaka's stream-level retry, reached through the engine port.
 *
 * Optional on the port (see `engine.ts`), so its absence is a plan rather than a
 * crash: the machine hears no `playing`, the recovery budget runs out, and the
 * error becomes a failover.
 */
function retryStreamingOn(video: LibertyVideoElement): void {
  const player = video.getEnginePlayer();
  try {
    player?.retryStreaming?.();
  } catch {
    /* A refused retry is not a playback failure and must not become one. The
     * machine is already waiting on the element to say whether it resumed. */
  }
}

interface PlayerView {
  readonly phase: PlaybackPhase;
  readonly candidateId: string | null;
  readonly attemptsUsed: number;
  readonly maxAttempts: number;
  readonly stopReason: PlaybackStopReason | null;
  readonly engineStatus: EngineState["status"];
  /** A load is in flight. The one piece of machine state the markup reacts to. */
  readonly restarting: boolean;
  readonly trail: readonly PlaybackTrailEntry[];
  readonly trailDropped: number;
}

const NOTABLE_TRAIL_KINDS: readonly PlaybackTrailEntry["kind"][] = [
  "session_resolved",
  "session_unavailable",
  "candidate_attempt",
  "candidate_failed",
  "candidate_retry",
  "failover",
  "engine_lost",
  "stopped"
];

function toView(snapshot: PlaybackSnapshot): PlayerView {
  const context = snapshot.context;
  return {
    phase: playbackPhase(snapshot),
    /* Through the exported helper rather than by indexing `candidates` directly.
     * `candidateIndex` is no longer monotonic — the failover scheduler may hand
     * back a candidate that was already attempted — so the one place that knows
     * how to read it should be the machine, not every consumer. */
    candidateId: currentCandidateId(context),
    attemptsUsed: context.attemptsUsed,
    maxAttempts: context.policy.maxAttempts,
    stopReason: context.stopReason,
    engineStatus: engineStatus(snapshot),
    restarting: isRestarting(snapshot),
    trail: context.trail.filter((entry) => NOTABLE_TRAIL_KINDS.includes(entry.kind)),
    trailDropped: context.trailDropped
  };
}

/**
 * Suppress a re-render when nothing a reader can see has changed.
 *
 * `timeupdate` fires about four times a second and every one of them is a
 * transition, so subscribing without this repaints the panel continuously for a
 * position it does not even display. The trail is compared by LENGTH rather than
 * by contents because it only ever grows at the end.
 */
function sameView(a: PlayerView, b: PlayerView): boolean {
  return (
    a.phase === b.phase &&
    a.candidateId === b.candidateId &&
    a.attemptsUsed === b.attemptsUsed &&
    a.stopReason === b.stopReason &&
    a.engineStatus === b.engineStatus &&
    a.restarting === b.restarting &&
    a.trail.length === b.trail.length &&
    a.trailDropped === b.trailDropped
  );
}

const STOP_REASON_COPY: Readonly<Record<PlaybackStopReason, string>> = {
  no_candidates:
    "Playback was authorized, but no stream was offered for it. Nothing failed — there was nothing to try.",
  session_unavailable: "We couldn't set up a playback session for this title. Try again in a moment.",
  engine_unavailable: "This browser can't run the playback engine, or it was blocked from loading.",
  all_candidates_rights_blocked:
    "Every stream we tried refused to confirm we're allowed to play it, so none of them were retried.",
  candidates_exhausted: "We tried every stream available for this title and none of them played.",
  attempt_limit_reached:
    "We stopped after the attempt budget ran out. There were still streams left to try."
};

export function PlayerSurface({ session, policy }: PlayerSurfaceProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<PlayerView | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    defineLibertyVideo();

    const video = document.createElement(LIBERTY_VIDEO_TAG);
    /* Attributes rather than properties: the host forwards them to the inner
     * `<video>` itself, and `src` is deliberately never among them — this
     * element is driven through the controller, never through an attribute a
     * page could set. */
    video.setAttribute("controls", "");
    video.setAttribute("playsinline", "");
    video.style.width = "100%";
    video.style.height = "100%";

    const effects: PlaybackEffects = {
      requestSession: () => {
        /*
         * PL-0501's seam. The session was authorized on the server and is sent
         * below, so there is nothing to fetch yet — but the machine still goes
         * through `resolving`, because when the real API exists this is where it
         * is called and the lifecycle must not change shape on that day.
         */
      },
      loadCandidate: (request) => {
        const candidate = request.candidate;
        if (candidate === null) return;
        /*
         * `setSource` is a teardown-and-restart every single time; Shaka has no
         * source swap. `startTimeSeconds` is the only thing that survives it,
         * and it is why a failover resumes instead of restarting at zero.
         */
        void video.playbackController?.setSource({
          ...candidate.source,
          startTimeSeconds: request.startAtSeconds
        });
      },
      stopCandidate: () => {
        void video.playbackController?.setSource(null);
      },
      retryStreaming: () => retryStreamingOn(video)
    };

    const actor = createPlaybackActor({ input: { policy }, effects });
    const send = (event: PlaybackEvent): void => {
      actor.send(event);
    };

    const listeners: readonly (readonly [string, EventListener])[] = [
      ["loadstart", () => send({ type: "MEDIA_LOAD_START" })],
      [
        "loadedmetadata",
        () => send({ type: "MEDIA_LOADED_METADATA", durationSeconds: readDurationSeconds(video) })
      ],
      ["canplay", () => send({ type: "MEDIA_CAN_PLAY" })],
      ["playing", () => send({ type: "MEDIA_PLAYING" })],
      ["waiting", () => send({ type: "MEDIA_WAITING" })],
      ["stalled", () => send({ type: "MEDIA_STALLED" })],
      ["seeking", () => send({ type: "MEDIA_SEEKING", positionSeconds: readPositionSeconds(video) })],
      ["seeked", () => send({ type: "MEDIA_SEEKED", positionSeconds: readPositionSeconds(video) })],
      ["timeupdate", () => send({ type: "MEDIA_TIME_UPDATE", positionSeconds: readPositionSeconds(video) })],
      [
        "durationchange",
        () => send({ type: "MEDIA_DURATION_CHANGE", durationSeconds: readDurationSeconds(video) })
      ],
      ["play", () => send({ type: "MEDIA_PLAY" })],
      ["pause", () => send({ type: "MEDIA_PAUSE" })],
      ["ended", () => send({ type: "MEDIA_ENDED" })],
      ["emptied", () => send({ type: "MEDIA_EMPTIED" })],
      /*
       * The native `error` event is a `MediaError` and nothing else — that is
       * exactly why `<liberty-video>` namespaces Shaka's errors onto
       * `liberty-error` instead of reusing this one.
       */
      ["error", () => send({ type: "MEDIA_ERROR", mediaErrorCode: readMediaErrorCode(video) })],
      [
        LIBERTY_VIDEO_ERROR_EVENT,
        (event) => {
          const error = readDetail<PlaybackError>(event);
          if (error !== null) send({ type: "ENGINE_ERROR", error });
        }
      ],
      [
        LIBERTY_VIDEO_ENGINE_STATE_EVENT,
        (event) => {
          const state = readDetail<EngineState>(event);
          if (state !== null) send({ type: "ENGINE_STATE", state });
        }
      ]
    ];

    const subscription = actor.subscribe((snapshot) => {
      const next = toView(snapshot);
      setView((previous) => (previous !== null && sameView(previous, next) ? previous : next));
    });
    actor.start();

    /* Listeners before the node is connected: `connectedCallback` starts the
     * engine and emits `enginestatechange` synchronously, and a listener added
     * after `appendChild` has already missed it. */
    for (const [type, listener] of listeners) video.addEventListener(type, listener);
    host.appendChild(video);

    send({ type: "START" });
    send({ type: "SESSION_RESOLVED", session });

    return () => {
      for (const [type, listener] of listeners) video.removeEventListener(type, listener);
      subscription.unsubscribe();
      actor.stop();
      /* Removing the node is what destroys the Shaka session: a player that
       * outlives its element keeps its networking engine, its buffers and its
       * CDM session, and keeps downloading a video nobody is watching. */
      video.remove();
    };
  }, [session, policy]);

  return (
    <section className="player-card">
      {/*
       * `aria-busy` is the one thing the markup reads off the machine, and it
       * is a statement about the SESSION rather than about a control: a
       * candidate is being loaded or reloaded and there is nothing to see yet.
       * Everything else a viewer interacts with belongs to the controls layer.
       */}
      <div className="player-stage" ref={hostRef} aria-busy={view?.restarting === true} />

      <div className="player-meta">
        <strong>Content: {session.contentId}</strong>
        <span>
          State: <span className="code">{view?.phase ?? "idle"}</span>
        </span>
        <span>
          Candidate: <span className="code">{view?.candidateId ?? "none"}</span> (attempt{" "}
          {view?.attemptsUsed ?? 0} of {policy.maxAttempts})
        </span>
        <span>
          Engine: <span className="code">{view?.engineStatus ?? "idle"}</span>
        </span>
      </div>

      {view !== null && view.stopReason !== null ? (
        <div className="state-panel" role="alert">
          <h2>Playback stopped</h2>
          <p>{STOP_REASON_COPY[view.stopReason]}</p>
          <p className="code state-detail">{view.stopReason}</p>
        </div>
      ) : null}

      {/*
       * Product invariant 4, rendered. The trail is what makes a candidate
       * decision debuggable from a screenshot, and a failover with no recorded
       * reason is the same defect as a rights denial with none. It is already
       * redacted: `summarisePlaybackError` drops Shaka's `raw`, which can carry
       * signed manifest URLs.
       */}
      {view && view.trail.length > 0 ? (
        <details className="player-meta">
          <summary>Playback reason trail</summary>
          <ol>
            {view.trail.map((entry) => (
              <li key={entry.sequence}>
                <span className="code">{entry.kind}</span> {entry.detail}
              </li>
            ))}
          </ol>
          {view.trailDropped > 0 ? (
            <p className="state-detail">{view.trailDropped} earlier entries were dropped by the trail cap.</p>
          ) : null}
        </details>
      ) : null}
    </section>
  );
}
