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
import { NO_CHOICE, type TrackChoice } from "../tracks";
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

type MenuName = "audio" | "subtitle" | null;

interface AdapterView {
  readonly positionSeconds: number;
  readonly durationSeconds: number | null;
  readonly buffered: readonly BufferedRange[];
  readonly tracks: readonly PlayerTrack[];
  readonly audioTrackId: string | null;
  readonly subtitleTrackId: string | null;
  readonly volume: number;
  readonly muted: boolean;
}

const INITIAL_VIEW: AdapterView = {
  positionSeconds: 0,
  durationSeconds: null,
  buffered: [],
  tracks: [],
  audioTrackId: null,
  subtitleTrackId: null,
  volume: 1,
  muted: false
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

function subscribeCoarsePointer(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia("(pointer: coarse)");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function readCoarsePointer(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(pointer: coarse)").matches;
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
    [adapter, menu, togglePlay, toggleMute, toggleFullscreen, view]
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>): void => {
      const command = commandForKey({
        key: event.key,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
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

  const selectTrack = (kind: "audio" | "subtitle", id: string | null): void => {
    setMenu(null);
    /* REMEMBERED BEFORE THE COMMAND, and from the list the menu was built
     * from, because that is the list the viewer was looking at. */
    choiceRef.current = rememberFromMenu(choiceRef.current, kind, id, view.tracks);
    void (kind === "audio" ? adapter.selectAudioTrack(id) : adapter.selectSubtitleTrack(id)).catch(
      () => {
        /* The adapter refuses an unknown id and refuses to deselect audio; it
         * says so by throwing, and the menu still reflects what is selected
         * because that comes back as a `trackselected` event or does not. */
      }
    );
  };

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
