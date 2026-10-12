"use client";

/* -------------------------------------------------------------------------
 * The control bar (PW-0306)
 *
 * ===========================================================================
 * WHAT IT TALKS TO, AND WHAT IT DELIBERATELY DOES NOT
 * ===========================================================================
 *
 * COMMANDS GO TO THE ADAPTER. `play`, `pause`, `seek`, `setVolume`,
 * `selectAudioTrack`, `selectSubtitleTrack` — every one of them is a
 * `PlayerAdapter` call and none of them is a Shaka call, a `<video>` property
 * assignment or a state-machine event. That is the acceptance clause written
 * in capitals, and the reason for it is that the same component has to operate
 * libmpv when PW-0205 lands.
 *
 * STATE COMES FROM TWO PLACES, AND THE SPLIT IS NOT ARBITRARY. Position,
 * duration, buffered ranges, volume and the track list are the ADAPTER's, read
 * through its events and its pull-side reads. Whether playback is RUNNING is
 * the state machine's, handed down as a prop, because `player-surface.tsx`
 * says the machine is the single source of that truth and `web-player-adapter`
 * correlates its `playing`/`paused` events to a load id this player does not
 * own. A control bar that kept its own opinion about whether the picture is
 * moving would be the source-of-truth inversion the whole directory is built
 * to avoid.
 *
 * NO FIFTH EFFECT. `playback-effects.ts` says "FOUR, AND NO MORE" and names
 * play, pause, seek, rate, volume and fullscreen as the controls layer's.
 * Nothing here sends the machine an event or asks it for an action; the
 * machine observes the element and hears about all of this the same way it
 * hears about everything else.
 *
 * FULLSCREEN IS THE DOM'S, NOT THE ADAPTER'S, and that is correct rather than
 * a shortcut: fullscreen is a property of a window and an element, there is no
 * `fullscreen()` on `PlayerAdapter`, and on the native engine it will be the
 * shell's to grant. The target element is injected so this component never
 * reaches for a container it does not own.
 *
 * ===========================================================================
 * THE OVERLAY NEVER LEAVES THE ACCESSIBILITY TREE
 * ===========================================================================
 *
 * The acceptance asks for an idle-hide overlay "that never hides a control
 * from a keyboard or screen-reader user", so the idle state is `opacity: 0`
 * and nothing else. No `display: none`, no `visibility: hidden`, no
 * `aria-hidden`, no `inert` — each of those removes the controls from the
 * accessibility tree or from the tab order, which is precisely the thing being
 * forbidden. Focus entering the bar brings it back, and `controls-state.ts`
 * holds that rule with its own tests.
 * ---------------------------------------------------------------------- */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import type { BufferedRange } from "../diagnostics/buffered-ranges";
import type { PlayerAdapter, PlayerTrack } from "../player-adapter";
import {
  IDLE_HIDE_AFTER_MS,
  bufferedSegments,
  commandForKey,
  describeSourceState,
  formatTimecode,
  menuIsEmpty,
  nextPosition,
  nextVolume,
  overlayVisibility,
  progressPercent,
  seekTargetFrom,
  speakTimecode,
  rememberFromMenu,
  restoreCommands,
  trackOptions,
  type ControlCommand
} from "./controls-state";
import { NO_CHOICE, reapply, type TrackChoice } from "../tracks";
import {
  PLAYBACK_RATES,
  describeRate,
  rateStep,
  remainingWallClockSeconds
} from "../playback-rate";
import styles from "./player-controls.module.css";

export interface PlayerControlsProps {
  readonly adapter: PlayerAdapter;
  /** The element fullscreen applies to. Supplied, never looked up. */
  readonly fullscreenTarget: HTMLElement | null;
  /** From the state machine, which owns this fact. `null` before the first snapshot. */
  readonly running: boolean | null;
  /** Rendered as the source/quality line the acceptance asks the viewer to be able to read. */
  readonly candidateId: string | null;
  readonly attemptsUsed: number;
  readonly maxAttempts: number;
  readonly engineStatus: string;
  readonly restarting: boolean;
}

type MenuName = "audio" | "subtitle" | "rate" | null;

interface AdapterView {
  readonly positionSeconds: number;
  readonly durationSeconds: number | null;
  readonly buffered: readonly BufferedRange[];
  readonly tracks: readonly PlayerTrack[];
  readonly audioTrackId: string | null;
  readonly subtitleTrackId: string | null;
  readonly volume: number;
  readonly muted: boolean;
  /** As the ELEMENT last reported it, never as it was last requested. */
  readonly rate: number;
}

const INITIAL_VIEW: AdapterView = {
  positionSeconds: 0,
  durationSeconds: null,
  buffered: [],
  tracks: [],
  audioTrackId: null,
  subtitleTrackId: null,
  volume: 1,
  muted: false,
  /* 1 is both the element's initial rate and the value `decodeRate` answers for
   * a viewer who has never chosen, so the control starts honest either way. */
  rate: 1
};

/**
 * Whether a keystroke belongs to something that owns its keys.
 *
 * Asked of the EVENT TARGET rather than guessed from the key, because the
 * space bar is both "play" and the commonest character in written language.
 * `isContentEditable` is checked as well as the tag, because a rich-text
 * surface is a `div`.
 */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function falseOnServer(): boolean {
  return false;
}

/**
 * Subscribe to the coarse-pointer query, on a host that may not implement the
 * modern listener API (W132-D, fixed in passing).
 *
 * THE DEFECT CLASS: AN EXISTENCE CHECK ON THE WRONG OBJECT. The previous version
 * guarded `typeof window.matchMedia !== "function"` and then called
 * `query.addEventListener(...)` — a guard on the FACTORY followed by an
 * unguarded call on the PRODUCT. `MediaQueryList` only gained
 * `addEventListener` when it began inheriting from `EventTarget`; before that
 * the API was `addListener`/`removeListener`, and several embedded WebView
 * builds still ship the older object. On one of those,
 * `query.addEventListener is not a function` is thrown from inside a
 * `useSyncExternalStore` subscribe — which React calls during commit, so the
 * exception takes down the whole player surface rather than disabling one
 * pointer heuristic. That is the shape of the Windows-only client TypeError
 * being chased in the installed WebView2 build, and this is one instance of it.
 *
 * Both APIs are therefore probed on the object that has to answer, the
 * deprecated pair is used as the fallback, and a host with neither gets a
 * no-op subscription — a player with a working control bar that simply does not
 * notice a pointer type changing mid-session, which is the correct degradation.
 */
function subscribeCoarsePointer(onChange: () => void): () => void {
  const query = coarsePointerQuery();
  if (query === null) return () => {};
  if (typeof query.addEventListener === "function") {
    query.addEventListener("change", onChange);
    return () => {
      /* Guarded independently: an object can expose one half of a pair, and a
       * throw from a cleanup function is an unhandled error during unmount. */
      if (typeof query.removeEventListener === "function") {
        query.removeEventListener("change", onChange);
      }
    };
  }
  const legacy = query as MediaQueryList & {
    addListener?: (listener: () => void) => void;
    removeListener?: (listener: () => void) => void;
  };
  if (typeof legacy.addListener === "function") {
    legacy.addListener(onChange);
    return () => {
      if (typeof legacy.removeListener === "function") legacy.removeListener(onChange);
    };
  }
  return () => {};
}

/**
 * The query object, or `null` on any host that cannot produce one.
 *
 * Wrapped in `try`/`catch` as well as guarded, because `matchMedia` is
 * permitted to throw on a malformed query string and at least one embedded
 * engine throws on a valid one when no display is attached — a headless
 * screenshot run, which is where this would be discovered by a failing CI job
 * rather than by a viewer.
 */
function coarsePointerQuery(): MediaQueryList | null {
  try {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
    return window.matchMedia("(pointer: coarse)");
  } catch {
    return null;
  }
}

function readCoarsePointer(): boolean {
  const query = coarsePointerQuery();
  return query === null ? false : query.matches === true;
}

function subscribeFullscreen(onChange: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  document.addEventListener("fullscreenchange", onChange);
  return () => document.removeEventListener("fullscreenchange", onChange);
}

function readFullscreen(): boolean {
  return typeof document !== "undefined" && document.fullscreenElement !== null;
}

export function PlayerControls(props: PlayerControlsProps): React.JSX.Element {
  const { adapter, fullscreenTarget, running } = props;

  const [view, setView] = useState<AdapterView>(INITIAL_VIEW);
  const [menu, setMenu] = useState<MenuName>(null);
  const [focusWithin, setFocusWithin] = useState(false);
  const [pointerActivityAt, setPointerActivityAt] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  const barRef = useRef<HTMLDivElement | null>(null);
  const seekRef = useRef<HTMLInputElement | null>(null);
  /*
   * WHAT THE VIEWER CHOSE, AS A LANGUAGE AND A PURPOSE RATHER THAN A TRACK ID
   * (PW-0206).
   *
   * A ref and not state: nothing renders from it, and putting it in state
   * would re-run the adapter subscription below on every menu selection --
   * tearing down and rebuilding the listener that is meant to be watching.
   *
   * It survives a candidate switch because the identity does. The ids do not:
   * `WebPlayerAdapter` builds audio ids as `audio:<language>` and takes
   * subtitle ids from whatever the manifest said, so a failover to another
   * provider renames every one of them.
   */
  const choiceRef = useRef<TrackChoice>(NO_CHOICE);

  /* ---- the adapter is the source of everything below ------------------ */
  useEffect(() => {
    const pull = (): void => {
      const timeline = adapter.getTimeline();
      setView((current) => ({
        ...current,
        positionSeconds: timeline.positionSeconds,
        durationSeconds: timeline.durationSeconds,
        buffered: adapter.getBufferedRanges(),
        tracks: adapter.getTracks()
      }));
    };

    const unsubscribe = adapter.subscribe((event) => {
      switch (event.type) {
        case "position":
          setView((c) => ({
            ...c,
            positionSeconds: event.positionSeconds,
            /* Read with the position rather than on a timer of our own. The
             * ranges change as the engine buffers and `timeupdate` is already
             * the engine telling us something moved; a second interval would
             * be a second clock disagreeing with the first. */
            buffered: adapter.getBufferedRanges()
          }));
          return;
        case "duration":
          setView((c) => ({ ...c, durationSeconds: event.durationSeconds }));
          return;
        case "seekcompleted":
        case "seekstarted":
          setView((c) => ({ ...c, positionSeconds: event.positionSeconds }));
          return;
        case "buffering":
          setView((c) => ({ ...c, buffered: adapter.getBufferedRanges() }));
          return;
        case "loaded":
        case "tracks":
          setView((c) => {
            /*
             * A NEW TRACK LIST IS THE MOMENT THE VIEWER'S CHOICE IS AT RISK
             * (PW-0206). The decision is `restoreCommands`, which is pure and
             * has its own tests; this only issues what it returns, and it
             * returns nothing when nothing needs doing -- no remembered
             * choice, no match on this candidate, or a match on the track
             * already selected.
             *
             * Commanded from inside the updater rather than from an effect
             * keyed on `tracks`, because an effect would also fire on the
             * re-render this very command causes.
             */
            for (const command of restoreCommands(choiceRef.current, event.tracks, c)) {
              void (command.kind === "audio"
                ? adapter.selectAudioTrack(command.trackId)
                : adapter.selectSubtitleTrack(command.trackId)
              ).catch(() => {
                /* A refused restore is not a failure a viewer should see: the
                 * track they had is simply not on this candidate, the engine's
                 * own choice stands, and the menu shows what is actually
                 * selected either way. */
              });
            }
            return { ...c, tracks: event.tracks };
          });
          return;
        case "trackselected":
          setView((c) =>
            event.kind === "audio"
              ? { ...c, audioTrackId: event.trackId }
              : { ...c, subtitleTrackId: event.trackId }
          );
          return;
        case "rate":
          /* The element answered. Nothing sets this from the request side; see
           * the `rate` event's own comment on `PlayerAdapterEvent`. */
          setView((c) => ({ ...c, rate: event.rate }));
          return;
        case "volume":
          setView((c) => ({ ...c, volume: event.level, muted: event.muted }));
          return;
        default:
          return;
      }
    });

    /*
     * ASK ONCE AT MOUNT, BECAUSE THIS COMPONENT ARRIVED LATE.
     *
     * The session is loaded by the state machine, not by this adapter, so no
     * `loaded` event ever reaches us and the adapter's own track list starts
     * empty. `resynchronise()` is the boundary's answer to exactly that
     * situation — "a load it did not perform" is one of the three cases its
     * contract names — and it publishes the facts as ordinary events rather
     * than letting this component reach past the boundary for them.
     */
    adapter.resynchronise();
    pull();
    return unsubscribe;
  }, [adapter]);

  /* ---- two browser facts, SUBSCRIBED RATHER THAN COPIED ---------------
   *
   * `useSyncExternalStore` and not `useState` + an effect, for the reason
   * `reachability-store.ts` already gives about `navigator.onLine`: copying an
   * external fact into React state means there is a window in which the copy
   * is wrong, and the first render after hydration is reliably inside it. The
   * server snapshot is `false` for both because a server has no pointer and no
   * full screen -- and it is a frozen primitive, so React's
   * "getServerSnapshot should be cached" rule is satisfied by the type.
   */
  const coarsePointer = useSyncExternalStore(subscribeCoarsePointer, readCoarsePointer, falseOnServer);
  const isFullscreen = useSyncExternalStore(subscribeFullscreen, readFullscreen, falseOnServer);

  /*
   * ONE TIMER, ARMED ONLY WHEN SOMETHING COULD HIDE.
   *
   * It exists to re-evaluate the overlay once the idle threshold passes; while
   * focus is inside, a menu is open, playback is paused or the pointer is
   * coarse, nothing can hide and the timer is not set at all. A control bar
   * that ran an interval forever would keep a tab awake to decide, repeatedly,
   * that it is still visible.
   */
  const paused = running === false;
  const couldHide = !focusWithin && menu === null && !paused && !coarsePointer;
  useEffect(() => {
    if (!couldHide || pointerActivityAt === null) return;
    const elapsed = Date.now() - pointerActivityAt;
    if (elapsed >= IDLE_HIDE_AFTER_MS) return;
    const timer = setTimeout(() => setNowMs(Date.now()), IDLE_HIDE_AFTER_MS - elapsed);
    return () => clearTimeout(timer);
  }, [couldHide, pointerActivityAt, nowMs]);

  const visibility = overlayVisibility({
    msSincePointerActivity: pointerActivityAt === null ? null : nowMs - pointerActivityAt,
    focusWithin,
    menuOpen: menu !== null,
    paused,
    pointerIsCoarse: coarsePointer
  });

  const notePointer = useCallback((): void => {
    const at = Date.now();
    setPointerActivityAt(at);
    setNowMs(at);
  }, []);

  /* ---- commands -------------------------------------------------------- */

  const togglePlay = useCallback((): void => {
    /* The MACHINE says whether it is running; the ADAPTER is told what to do
     * about it. Reading one and commanding the other is the whole division of
     * labour in this component. */
    void (running === true ? adapter.pause() : adapter.play());
  }, [adapter, running]);

  const toggleMute = useCallback((): void => {
    void adapter.setVolume(view.volume, { muted: !view.muted });
  }, [adapter, view.volume, view.muted]);

  const toggleFullscreen = useCallback((): void => {
    if (typeof document === "undefined") return;
    if (document.fullscreenElement !== null) {
      void document.exitFullscreen();
      return;
    }
    /* `null` is a real state — the surface has not mounted its stage yet — and
     * asking for fullscreen on nothing is a no-op rather than a throw. */
    void fullscreenTarget?.requestFullscreen();
  }, [fullscreenTarget]);

  /**
   * Apply a rate, or do nothing honestly (W132-D item 1).
   *
   * `setPlaybackRate` is an OPTIONAL member of the adapter port, so an adapter
   * that cannot vary rate is detected rather than assumed — and the menu below
   * is not rendered at all in that case. A control that moved and changed no
   * playback is the thing this check exists to prevent.
   */
  const setRate = useCallback(
    (rate: number): void => {
      if (typeof adapter.setPlaybackRate !== "function") return;
      /* The refusal path is a rejected promise (an off-list rate, or an element
       * with no rate property). Nothing is updated optimistically: the view's
       * rate only ever moves on a `rate` event from the element, so a refused
       * request leaves the badge showing what is really playing. */
      void adapter.setPlaybackRate(rate).catch(() => {});
    },
    [adapter]
  );

  /*
   * HOISTED TO A `useCallback` AHEAD OF `toggleSubtitles` (W132-D item 6),
   * which now calls it. It was a plain function defined further down with the
   * other derived values; the behaviour is unchanged and the comments are the
   * originals. Keeping it as a function declared after its caller would have
   * meant either a ref dance or a stale closure, both of which are worse than
   * moving twelve lines.
   */
  const selectTrack = useCallback(
    (kind: "audio" | "subtitle", id: string | null): void => {
      setMenu(null);
      /* REMEMBERED BEFORE THE COMMAND, and from the list the menu was built
       * from, because that is the list the viewer was looking at. */
      choiceRef.current = rememberFromMenu(choiceRef.current, kind, id, view.tracks);
      void (
        kind === "audio" ? adapter.selectAudioTrack(id) : adapter.selectSubtitleTrack(id)
      ).catch(() => {
        /* The adapter refuses an unknown id and refuses to deselect audio; it
         * says so by throwing, and the menu still reflects what is selected
         * because that comes back as a `trackselected` event or does not. */
      });
    },
    [adapter, view.tracks]
  );

  /**
   * `c`: subtitles off, or back to the last real track the viewer chose.
   *
   * RESTORING RATHER THAN PICKING THE FIRST TRACK. A toggle that turned text
   * back on by selecting `tracks[0]` would switch a viewer from the French
   * subtitles they chose to whatever the manifest happens to list first, every
   * time they toggled — so the last selection is remembered in `choiceRef`,
   * which `rememberFromMenu` already maintains for the failover restore, and
   * `reapply` resolves it against the tracks on the current candidate.
   *
   * With nothing remembered and nothing selected there is no honest answer, so
   * the key OPENS THE MENU instead of guessing: the viewer picks, and the pick
   * is then what gets toggled.
   */
  const toggleSubtitles = useCallback((): void => {
    if (view.subtitleTrackId !== null) {
      selectTrack("subtitle", null);
      return;
    }
    const remembered = choiceRef.current.subtitle;
    if (remembered !== null && remembered !== "off") {
      const restored = reapply(remembered, view.tracks);
      if (restored.trackId !== null) {
        selectTrack("subtitle", restored.trackId);
        return;
      }
    }
    if (!menuIsEmpty(view.tracks, "subtitle")) setMenu("subtitle");
  }, [selectTrack, view.subtitleTrackId, view.tracks]);

  const runCommand = useCallback(
    (command: ControlCommand): void => {
      switch (command.kind) {
        case "toggle-play":
          togglePlay();
          return;
        case "seek-by":
          void adapter.seek(
            nextPosition(view.positionSeconds, command.deltaSeconds, view.durationSeconds)
          );
          return;
        case "volume-by": {
          const level = nextVolume(view.volume, command.delta);
          /* Turning the volume UP unmutes. A viewer pressing the up arrow on a
           * muted player means "let me hear it", and leaving it muted would be
           * a control that appears to do nothing. */
          const muted = command.delta > 0 ? false : view.muted;
          void adapter.setVolume(level, { muted });
          return;
        }
        case "seek-to-fraction": {
          /*
           * `seekTargetFrom` ANSWERS NULL FOR AN UNSEEKABLE PLAYER, and that is
           * why the digit keys form a fraction rather than a position: a live
           * stream and a VOD before metadata both have no duration, and a
           * keystroke must be ignored there rather than seeking to `NaN`.
           */
          const target = seekTargetFrom(command.fraction, view.durationSeconds);
          if (target === null) return;
          void adapter.seek(target);
          return;
        }
        case "toggle-subtitles":
          toggleSubtitles();
          return;
        case "rate-step":
          setRate(rateStep(view.rate, command.direction));
          return;
        case "toggle-mute":
          toggleMute();
          return;
        case "toggle-fullscreen":
          toggleFullscreen();
          return;
        case "dismiss":
          /* A menu first, then fullscreen. Escape means "undo the most recent
           * thing that took over the screen", and a viewer with both open
           * expects one press to close one of them. */
          if (menu !== null) {
            setMenu(null);
            return;
          }
          if (typeof document !== "undefined" && document.fullscreenElement !== null) {
            void document.exitFullscreen();
          }
          return;
      }
    },
    [adapter, menu, togglePlay, toggleMute, toggleFullscreen, toggleSubtitles, setRate, view]
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>): void => {
      const command = commandForKey({
        key: event.key,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        /* Forwarded, and deliberately NOT a veto — see `KeyStroke.shiftKey`. */
        shiftKey: event.shiftKey,
        fromTextEntry: isTextEntry(event.target)
      });
      if (command === null) return;
      /* Claimed only once it is ours. An unhandled key keeps scrolling the
       * page and keeps opening the browser's own find bar. */
      event.preventDefault();
      event.stopPropagation();
      notePointer();
      runCommand(command);
    },
    [notePointer, runCommand]
  );

  /* ---- derived ---------------------------------------------------------- */

  const segments = useMemo(
    () => bufferedSegments(view.buffered, view.durationSeconds),
    [view.buffered, view.durationSeconds]
  );
  const percent = progressPercent(view.positionSeconds, view.durationSeconds);
  const seekable = view.durationSeconds !== null && view.durationSeconds > 0;
  const audioOptions = trackOptions(view.tracks, "audio", view.audioTrackId);
  const subtitleOptions = trackOptions(view.tracks, "subtitle", view.subtitleTrackId);
  const sourceLine = describeSourceState({
    candidateId: props.candidateId,
    attemptsUsed: props.attemptsUsed,
    maxAttempts: props.maxAttempts,
    engineStatus: props.engineStatus,
    restarting: props.restarting
  });

  return (
    <div
      className={`${styles.bar} ${visibility === "dimmed" ? styles.dimmed : ""}`}
      /*
       * A GROUP AND NOT A TOOLBAR. `role="toolbar"` promises arrow-key
       * navigation BETWEEN the controls, and this player spends the arrow keys
       * on seeking and volume, which the acceptance names. Claiming the role
       * and then not honouring it is worse than not claiming it.
       */
      role="group"
      aria-label="Player controls"
      data-visibility={visibility}
      data-testid="player-controls"
      ref={barRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onPointerMove={notePointer}
      onPointerDown={notePointer}
      onFocusCapture={() => setFocusWithin(true)}
      onBlurCapture={(event) => {
        if (!barRef.current?.contains(event.relatedTarget as Node | null)) setFocusWithin(false);
      }}
    >
      <div className={styles.row}>
        <button
          type="button"
          className={styles.button}
          onClick={togglePlay}
          aria-label={running === true ? "Pause" : "Play"}
          data-testid="control-play"
        >
          {running === true ? "Pause" : "Play"}
        </button>

        {/*
          * A RANGE INPUT, NOT A DIV WITH A ROLE.
          *
          * It is the one native control that already has keyboard operation,
          * a value, a minimum, a maximum, drag, and a screen-reader
          * announcement that says "slider" in the viewer's own language. A
          * hand-rolled `role="slider"` would be re-implementing all of that,
          * and the versions of it in the wild are the reason seek bars are a
          * byword for inaccessible. The buffered ranges are painted BEHIND it;
          * the input itself stays a real input.
          */}
        <div className={styles.seek}>
          <div className={styles.track} aria-hidden="true">
            {segments.map((segment, index) => (
              <span
                key={`${String(segment.leftPercent)}-${String(index)}`}
                className={styles.buffered}
                style={{ left: `${String(segment.leftPercent)}%`, width: `${String(segment.widthPercent)}%` }}
              />
            ))}
            <span className={styles.played} style={{ width: `${String(percent)}%` }} />
          </div>
          <input
            ref={seekRef}
            type="range"
            className={styles.range}
            min={0}
            max={100}
            step={0.1}
            value={percent}
            disabled={!seekable}
            data-testid="control-seek"
            aria-label="Seek"
            /* The percentage is what the element carries and the TIME is what
             * a viewer needs, so the announced value is the time. */
            aria-valuetext={`${speakTimecode(view.positionSeconds)} of ${speakTimecode(
              view.durationSeconds
            )}`}
            onChange={(event) => {
              const target = seekTargetFrom(Number(event.target.value) / 100, view.durationSeconds);
              if (target === null) return;
              notePointer();
              void adapter.seek(target);
            }}
          />
        </div>

        <span className={styles.time} data-testid="control-time">
          {formatTimecode(view.positionSeconds, view.durationSeconds)} /{" "}
          {formatTimecode(view.durationSeconds, view.durationSeconds)}
        </span>

        {/*
          * TIME LEFT AT THE RATE IN FORCE (W132-D item 1).
          *
          * Rendered only when the rate is not 1, which is the honest condition:
          * at normal speed this number is the one already on the left of the
          * timecode, and a second copy of it is noise. Off normal speed it is a
          * DIFFERENT number — thirty minutes of media at 1.5x is twenty minutes
          * of the viewer's evening — and a bar showing only media time next to a
          * 1.5x badge is stating a wrong finishing time.
          *
          * `remainingWallClockSeconds` answers `null` for an unknown duration,
          * and `formatTimecode` renders that as `--:--` rather than `0:00`.
          */}
        {view.rate !== 1 ? (
          <span className={styles.time} data-testid="control-time-remaining">
            {formatTimecode(
              remainingWallClockSeconds(view.positionSeconds, view.durationSeconds, view.rate),
              view.durationSeconds
            )}{" "}
            left at {describeRate(view.rate)}
          </span>
        ) : null}

        <button
          type="button"
          className={styles.button}
          onClick={toggleMute}
          aria-label={view.muted ? "Unmute" : "Mute"}
          data-testid="control-mute"
        >
          {view.muted ? "Unmute" : "Mute"}
        </button>

        <input
          type="range"
          className={styles.volume}
          min={0}
          max={100}
          step={1}
          value={Math.round((view.muted ? 0 : view.volume) * 100)}
          aria-label="Volume"
          data-testid="control-volume"
          onChange={(event) => {
            notePointer();
            const level = Number(event.target.value) / 100;
            void adapter.setVolume(level, { muted: level === 0 });
          }}
        />

        <TrackMenu
          name="subtitle"
          label="Subtitles"
          open={menu === "subtitle"}
          empty={menuIsEmpty(view.tracks, "subtitle")}
          options={subtitleOptions}
          onToggle={() => setMenu((current) => (current === "subtitle" ? null : "subtitle"))}
          onSelect={(id) => selectTrack("subtitle", id)}
        />

        <TrackMenu
          name="audio"
          label="Audio"
          open={menu === "audio"}
          empty={menuIsEmpty(view.tracks, "audio")}
          options={audioOptions}
          onToggle={() => setMenu((current) => (current === "audio" ? null : "audio"))}
          onSelect={(id) => selectTrack("audio", id)}
        />

        {/*
          * THE RATE MENU IS RENDERED ONLY IF THE ADAPTER CAN ACTUALLY CHANGE THE
          * RATE (W132-D item 1). `setPlaybackRate` is an optional member of the
          * port, so an adapter without it — a native backend with no such
          * control — gets no menu at all rather than a menu that moves and
          * changes nothing. That is the difference between a control and a
          * decoration, and it is decided here.
          */}
        {typeof adapter.setPlaybackRate === "function" ? (
          <RateMenu
            open={menu === "rate"}
            rate={view.rate}
            onToggle={() => setMenu((current) => (current === "rate" ? null : "rate"))}
            onSelect={(rate) => {
              setMenu(null);
              setRate(rate);
            }}
          />
        ) : null}

        <button
          type="button"
          className={styles.button}
          onClick={toggleFullscreen}
          aria-label={isFullscreen ? "Exit full screen" : "Full screen"}
          data-testid="control-fullscreen"
        >
          {isFullscreen ? "Exit full screen" : "Full screen"}
        </button>
      </div>

      {/*
        * THE SOURCE LINE IS A STATUS, NOT A CONTROL, and it is a polite live
        * region so a failover is announced without interrupting whatever a
        * screen-reader user is reading. The candidate order is a rights and
        * ranking decision taken on the server; this reports it and offers no
        * way to override it.
        */}
      <p className={styles.source} role="status" data-testid="control-source">
        {sourceLine}
      </p>
    </div>
  );
}

interface TrackMenuProps {
  readonly name: "audio" | "subtitle";
  readonly label: string;
  readonly open: boolean;
  readonly empty: boolean;
  readonly options: readonly { readonly id: string | null; readonly label: string; readonly selected: boolean }[];
  readonly onToggle: () => void;
  readonly onSelect: (id: string | null) => void;
}

function TrackMenu(props: TrackMenuProps): React.JSX.Element {
  const listId = `player-${props.name}-menu`;
  return (
    <div className={styles.menuWrap}>
      <button
        type="button"
        className={styles.button}
        aria-expanded={props.open}
        aria-controls={listId}
        aria-haspopup="listbox"
        onClick={props.onToggle}
        data-testid={`control-${props.name}-menu`}
      >
        {props.label}
      </button>
      {props.open ? (
        <ul className={styles.menu} id={listId} role="listbox" aria-label={props.label}>
          {props.empty ? (
            /*
             * A MENU WITH NOTHING IN IT STILL SAYS SO. `web-player-adapter`
             * records the rule this follows: "a menu that appears to change
             * the language and does not is worse than an error". `aria-disabled`
             * rather than `disabled`, so the row is still announced.
             */
            <li className={styles.empty} role="option" aria-disabled="true" aria-selected="false">
              No {props.name} tracks were reported for this source
            </li>
          ) : (
            props.options.map((option) => (
              <li key={option.id ?? "__off"} role="none">
                <button
                  type="button"
                  role="option"
                  aria-selected={option.selected}
                  className={option.selected ? `${styles.option} ${styles.chosen}` : styles.option}
                  onClick={() => props.onSelect(option.id)}
                >
                  {option.label}
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}

interface RateMenuProps {
  readonly open: boolean;
  /** The rate the ELEMENT reported, which is what the tick must mark. */
  readonly rate: number;
  readonly onToggle: () => void;
  readonly onSelect: (rate: number) => void;
}

/**
 * The speed menu (W132-D item 1).
 *
 * A LISTBOX AND NOT A SLIDER, and the same reasoning as the track menus: the
 * offered rates are a closed set, a slider would imply the values in between
 * are available, and a viewer dragging one would be guessing at 1.25x. The
 * rates come from `PLAYBACK_RATES` so this component holds no second list, and
 * the tick follows `view.rate` — the element's own reading — so a rate the
 * element refused is not shown as selected.
 *
 * Deliberately a separate component from `TrackMenu` rather than a
 * generalisation of it: `TrackMenu`'s options are `string | null` ids with an
 * "off" row and an empty state, none of which a rate has. Widening it to carry
 * both would put a discriminator in a component whose whole job is to render a
 * list.
 */
function RateMenu(props: RateMenuProps): React.JSX.Element {
  const listId = "player-rate-menu";
  return (
    <div className={styles.menuWrap}>
      <button
        type="button"
        className={styles.button}
        aria-expanded={props.open}
        aria-controls={listId}
        aria-haspopup="listbox"
        onClick={props.onToggle}
        data-testid="control-rate-menu"
      >
        Speed {describeRate(props.rate)}
      </button>
      {props.open ? (
        <ul className={styles.menu} id={listId} role="listbox" aria-label="Playback speed">
          {PLAYBACK_RATES.map((rate) => (
            <li key={rate} role="none">
              <button
                type="button"
                role="option"
                aria-selected={rate === props.rate}
                className={
                  rate === props.rate ? `${styles.option} ${styles.chosen}` : styles.option
                }
                onClick={() => props.onSelect(rate)}
                data-testid={`control-rate-${rate}`}
              >
                {rate === 1 ? `Normal (${describeRate(rate)})` : describeRate(rate)}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
