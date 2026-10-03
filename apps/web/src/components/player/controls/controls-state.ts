/* -------------------------------------------------------------------------
 * Every decision the control bar makes, as pure functions (PW-0306)
 *
 * THE COMPONENT RENDERS; THIS DECIDES. Nothing below touches a DOM node, an
 * adapter or a clock, so every rule a viewer can feel — how far an arrow key
 * seeks, when the overlay is allowed to hide, what a track is called in a menu
 * — is testable without a browser and is written down in one place rather than
 * scattered through JSX.
 *
 * It is also the file to read before changing a keystroke. `player-surface.tsx`
 * states that the machine is the single source of playback truth and that
 * nothing may read the machine's state and then tell the element what to do.
 * These functions therefore map an INTENT to a COMMAND and stop: whether the
 * command is obeyed, and what the player then is, comes back as events like
 * every other fact.
 * ---------------------------------------------------------------------- */
import type { BufferedRange } from "../diagnostics/buffered-ranges";
import type { PlayerTrack, PlayerTrackKind } from "../player-adapter";
import {
  reapply,
  rememberChoice,
  type ReapplyConfidence,
  type TrackChoice
} from "../tracks";

/* ===========================================================================
 * TIME
 * ======================================================================== */

/**
 * `--:--` for a time nobody knows, and an hours field only when there are
 * hours.
 *
 * NULL IS NOT ZERO, and the distinction survives all the way to the screen. A
 * live stream has no duration and a VOD has none until metadata arrives;
 * rendering either as `0:00` tells a viewer the programme is empty.
 *
 * The width is kept stable by the `scale` argument — a 90-minute film shows
 * `0:04:11` rather than `4:11` so the digits do not jump as the hour turns
 * over. Passing `null` scales to the value itself.
 */
export function formatTimecode(seconds: number | null, scaleSeconds: number | null = null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "--:--";
  const scale = scaleSeconds !== null && Number.isFinite(scaleSeconds) ? scaleSeconds : seconds;
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return scale >= 3600 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

/** Spoken, for a screen reader, because `1:02:03` is read as a ratio. */
export function speakTimecode(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "unknown";
  const whole = Math.floor(seconds);
  const parts: string[] = [];
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  if (hours > 0) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  if (minutes > 0) parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs} second${secs === 1 ? "" : "s"}`);
  return parts.join(" ");
}

/* ===========================================================================
 * THE SEEK BAR
 * ======================================================================== */

export interface BarSegment {
  /** Percent of the bar's width, 0–100. */
  readonly leftPercent: number;
  readonly widthPercent: number;
}

/**
 * Buffered ranges as bar segments.
 *
 * RANGES AND NOT A PERCENTAGE, which is the whole reason `getBufferedRanges`
 * was added to the boundary: one range of sixty seconds and two of thirty
 * either side of a gap are the same number and opposite answers to "can I jump
 * there". A viewer reads a seek bar to find the gap.
 *
 * An unknown or non-positive duration yields nothing to draw rather than a
 * division by zero, and ranges are clamped to the bar instead of being
 * discarded: a live edge legitimately reports a buffered end past the duration
 * the element last published, and dropping that range would blank the bar at
 * the only moment it is interesting.
 */
export function bufferedSegments(
  ranges: readonly BufferedRange[],
  durationSeconds: number | null
): readonly BarSegment[] {
  if (durationSeconds === null || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return [];
  }
  const segments: BarSegment[] = [];
  for (const range of ranges) {
    const start = Math.max(0, Math.min(range.startSeconds, durationSeconds));
    const end = Math.max(0, Math.min(range.endSeconds, durationSeconds));
    if (!(end > start)) continue;
    segments.push({
      leftPercent: (start / durationSeconds) * 100,
      widthPercent: ((end - start) / durationSeconds) * 100
    });
  }
  return segments;
}

/** Where a click or drag at `fraction` of the bar's width lands, in seconds. */
export function seekTargetFrom(fraction: number, durationSeconds: number | null): number | null {
  if (durationSeconds === null || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return null;
  }
  const clamped = Math.min(1, Math.max(0, fraction));
  return clamped * durationSeconds;
}

/** How much of the bar the playhead has covered, 0–100. */
export function progressPercent(
  positionSeconds: number,
  durationSeconds: number | null
): number {
  if (durationSeconds === null || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return 0;
  }
  return Math.min(100, Math.max(0, (positionSeconds / durationSeconds) * 100));
}

/* ===========================================================================
 * KEYBOARD
 * ======================================================================== */

export const SEEK_STEP_SECONDS = 5;
export const VOLUME_STEP = 0.05;

/**
 * What a keystroke MEANS. Not what it does.
 *
 * A closed union, so adding a key is a compile error everywhere it has to be
 * handled rather than a quiet no-op in one branch. `null` is "this player has
 * no opinion about that key", which is the common case and must stay cheap:
 * a control bar that swallowed every keystroke would break typing in the page
 * around it.
 */
export type ControlCommand =
  | { readonly kind: "toggle-play" }
  | { readonly kind: "seek-by"; readonly deltaSeconds: number }
  | { readonly kind: "volume-by"; readonly delta: number }
  | { readonly kind: "toggle-mute" }
  | { readonly kind: "toggle-fullscreen" }
  | { readonly kind: "dismiss" };

export interface KeyStroke {
  readonly key: string;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  /** True when the event came from a text field, a menu, or anything that owns its keys. */
  readonly fromTextEntry?: boolean;
}

/**
 * The keys the acceptance names, and nothing else.
 *
 * MODIFIED KEYSTROKES ARE NOT OURS. Ctrl+F is the browser's find, Cmd+M
 * minimises a window on macOS, and a player that ate either would be a bug
 * report about the browser. Alt is left alone for the same reason.
 *
 * A KEYSTROKE FROM A TEXT FIELD IS NEVER OURS EITHER, and that is not a
 * hypothetical: the space bar is both "play" and "the most common character in
 * written language". The caller decides what counts as text entry; this
 * function refuses to guess from a key name.
 */
export function commandForKey(stroke: KeyStroke): ControlCommand | null {
  if (stroke.fromTextEntry === true) return null;
  if (stroke.ctrlKey === true || stroke.metaKey === true || stroke.altKey === true) return null;
  switch (stroke.key) {
    case " ":
    case "Spacebar":
      return { kind: "toggle-play" };
    case "k":
    case "K":
      return { kind: "toggle-play" };
    case "ArrowLeft":
      return { kind: "seek-by", deltaSeconds: -SEEK_STEP_SECONDS };
    case "ArrowRight":
      return { kind: "seek-by", deltaSeconds: SEEK_STEP_SECONDS };
    case "ArrowUp":
      return { kind: "volume-by", delta: VOLUME_STEP };
    case "ArrowDown":
      return { kind: "volume-by", delta: -VOLUME_STEP };
    case "f":
    case "F":
      return { kind: "toggle-fullscreen" };
    case "m":
    case "M":
      return { kind: "toggle-mute" };
    case "Escape":
      return { kind: "dismiss" };
    default:
      return null;
  }
}

/** Clamped to the range a media element accepts, with no opinion about muting. */
export function nextVolume(level: number, delta: number): number {
  const next = level + delta;
  if (!Number.isFinite(next)) return level;
  return Math.min(1, Math.max(0, Math.round(next * 100) / 100));
}

/** Clamped to the timeline, so a key press at either end is a no-op and not an error. */
export function nextPosition(
  positionSeconds: number,
  deltaSeconds: number,
  durationSeconds: number | null
): number {
  const next = positionSeconds + deltaSeconds;
  if (!Number.isFinite(next)) return positionSeconds;
  const ceiling =
    durationSeconds !== null && Number.isFinite(durationSeconds) ? durationSeconds : Infinity;
  return Math.min(ceiling, Math.max(0, next));
}

/* ===========================================================================
 * THE IDLE-HIDE OVERLAY
 * ======================================================================== */

export const IDLE_HIDE_AFTER_MS = 3000;

export interface OverlayInput {
  /** Milliseconds since the pointer last moved over the player. `null` = never. */
  readonly msSincePointerActivity: number | null;
  /** True while focus is inside the control bar. */
  readonly focusWithin: boolean;
  /** True while a menu is open. */
  readonly menuOpen: boolean;
  /** True when playback is not running — nothing is being obscured. */
  readonly paused: boolean;
  /**
   * True when the primary pointer is COARSE — a finger rather than a mouse.
   *
   * (This comment previously described a reduced-motion preference, which this
   * field has never been and which `overlayVisibility` has never read. Left on
   * the record because a comment that describes the wrong input is worse than
   * none: the next person to add a rule here would have reasoned from it.)
   */
  readonly pointerIsCoarse: boolean;
}

export type OverlayVisibility = "shown" | "dimmed";

/**
 * Whether the bar is SHOWN or DIMMED — and `dimmed` is the strongest word this
 * module will use.
 *
 * THE OVERLAY IS NEVER REMOVED, AND THAT IS THE ACCEPTANCE CLAUSE RATHER THAN
 * a stylistic preference: "an idle-hide overlay that never hides a control
 * from a keyboard or screen-reader user". So this function decides a VISUAL
 * state only. The component renders `dimmed` with opacity, which leaves every
 * control in the accessibility tree, focusable, and reachable by Tab —
 * `display: none`, `visibility: hidden` and `aria-hidden` would each remove
 * them from it, and `inert` would remove them from the keyboard.
 *
 * Four reasons to stay shown, each one a case where hiding would be wrong
 * rather than merely unhelpful:
 *   - focus is inside the bar. Dimming the control a keyboard user is standing
 *     on is the single worst thing this component could do.
 *   - a menu is open. It was opened deliberately and it has not been answered.
 *   - playback is paused. There is no moving picture to get out of the way of.
 *   - the pointer is coarse. A touch viewer has no hover to bring the bar back
 *     with, so an idle timeout would strand them.
 */
export function overlayVisibility(input: OverlayInput): OverlayVisibility {
  if (input.focusWithin || input.menuOpen || input.paused || input.pointerIsCoarse) return "shown";
  if (input.msSincePointerActivity === null) return "shown";
  return input.msSincePointerActivity >= IDLE_HIDE_AFTER_MS ? "dimmed" : "shown";
}

/* ===========================================================================
 * TRACK MENUS
 * ======================================================================== */

/**
 * What to call a track in a menu.
 *
 * THE ENGINE'S LABEL FIRST, because a provider that bothered to name a track
 * knows more about it than we do. Then the language. Then an honest admission:
 * a track with neither is `Track <id>`, not a guess at what it contains.
 *
 * THE PURPOSE IS APPENDED RATHER THAN SUBSTITUTED, and only when the engine
 * stated it. `English` and `English (SDH)` are different tracks a viewer
 * chooses between for different reasons, and a menu that showed both as
 * `English` would be a menu that cannot be used. `null` means the engine said
 * nothing, and nothing is what gets appended — PW-0206's rule that an
 * unstated field is never inferred from a label applies in reverse here too.
 */
export function describeTrack(track: PlayerTrack): string {
  const base =
    track.label ?? (track.language !== null ? track.language.toUpperCase() : `Track ${track.id}`);
  const purpose = purposeLabel(track);
  return purpose === null ? base : `${base} (${purpose})`;
}

function purposeLabel(track: PlayerTrack): string | null {
  if (track.kind === "audio") {
    switch (track.audioRole) {
      case "commentary":
        return "commentary";
      case "descriptive":
        return "audio description";
      case "dub":
        return "dubbed";
      case "original":
        return "original language";
      case "main":
      case null:
        return null;
    }
  }
  switch (track.subtitleKind) {
    case "sdh":
      return "SDH";
    case "forced":
      return "forced";
    case "commentary":
      return "commentary";
    case "subtitles":
    case null:
      return track.isForced ? "forced" : null;
  }
}

export interface TrackOption {
  readonly id: string | null;
  readonly label: string;
  readonly selected: boolean;
}

/**
 * The menu for one kind of track.
 *
 * SUBTITLES GET AN "OFF" ROW AND AUDIO DOES NOT. `subtitleModeSchema` records
 * that `off` is a STATE and not the absence of one, and `WebPlayerAdapter`
 * refuses `selectAudioTrack(null)` outright because there is always a
 * soundtrack — so offering the row would be offering a command the adapter is
 * documented to reject.
 *
 * AN EMPTY LIST IS STILL A MENU, with one disabled row saying so. A menu
 * button that silently does nothing is the failure mode `web-player-adapter`
 * already names about track selection: "a menu that appears to change the
 * language and does not is worse than an error".
 */
export function trackOptions(
  tracks: readonly PlayerTrack[],
  kind: PlayerTrackKind,
  selectedId: string | null
): readonly TrackOption[] {
  const matching = tracks.filter((track) => track.kind === kind);
  const options: TrackOption[] = matching.map((track) => ({
    id: track.id,
    label: describeTrack(track),
    selected: track.id === selectedId
  }));
  if (kind === "subtitle") {
    options.unshift({ id: null, label: "Off", selected: selectedId === null });
  }
  return options;
}

/** True when there is nothing to choose between, so the button says so. */
export function menuIsEmpty(tracks: readonly PlayerTrack[], kind: PlayerTrackKind): boolean {
  return tracks.every((track) => track.kind !== kind);
}

/* ===========================================================================
 * SOURCE AND QUALITY, WHICH THE VIEWER READS RATHER THAN SETS
 * ======================================================================== */

export interface SourceStateInput {
  readonly candidateId: string | null;
  readonly attemptsUsed: number;
  readonly maxAttempts: number;
  readonly engineStatus: string;
  readonly restarting: boolean;
}

/**
 * One sentence a viewer can read when a stream misbehaves.
 *
 * THE ACCEPTANCE ASKS FOR A SOURCE/QUALITY STATE THE VIEWER CAN READ, not a
 * quality SELECTOR, and the difference is deliberate: this player's candidate
 * order is a rights-and-ranking decision taken on the server, and a dropdown
 * that let a viewer pick a different candidate would be a second opinion about
 * it. What a viewer is owed is the knowledge that the player moved, and why it
 * is allowed to move again.
 */
export function describeSourceState(input: SourceStateInput): string {
  const where = input.candidateId === null ? "no source selected" : `source ${input.candidateId}`;
  if (input.restarting) {
    return `Switching source — ${where}, attempt ${input.attemptsUsed} of ${input.maxAttempts}`;
  }
  return `${where} — attempt ${input.attemptsUsed} of ${input.maxAttempts}, engine ${input.engineStatus}`;
}

/* ===========================================================================
 * KEEPING A VIEWER'S TRACK CHOICE ACROSS A CANDIDATE SWITCH (PW-0206)
 * ======================================================================== */

/**
 * The command, if any, that restores what the viewer chose on the LAST
 * candidate onto the tracks THIS one reports.
 *
 * WHY THIS EXISTS HERE AND NOT IN THE COMPONENT. PW-0206 shipped the policy
 * and the identity -- `rememberChoice`, `identify`, `reapply` -- and until now
 * nothing in the application imported them. The readiness audit (PL-0716) had
 * to score track selection PARTIAL for exactly that reason: implemented behind
 * a seam a user cannot reach. This is the seam.
 *
 * WHY IT IS THE WHOLE CLAUSE AND NOT A CONVENIENCE. PW-0206's acceptance says
 * a selection "is re-applied after a failover, because a candidate switch is a
 * full teardown and losing the viewer's language on a network blip is the
 * defect this clause exists to prevent". The control bar is the only place a
 * viewer ever makes that selection, so it is the only place the clause can be
 * delivered. A track id does not survive the teardown -- `WebPlayerAdapter`
 * builds audio ids as `audio:<language>` and takes subtitle ids from the
 * manifest -- which is why what is remembered is a `TrackIdentity`.
 *
 * IT RETURNS NOTHING WHEN NOTHING NEEDS DOING, and that is the important half:
 * no remembered choice, no match on this candidate, or a match on the track
 * that is ALREADY selected all produce `null`. Commanding the adapter to
 * select the track it has already selected would emit a `trackselected` event
 * that is not news, on every candidate switch, forever.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: pick a DEFAULT for a viewer who has chosen
 * nothing. That is `resolveTracks`, and it needs a `PlaybackCapabilities` --
 * which this layer does not have and must not invent. `watch-session.ts` says
 * why in its own words: a capability union assembled by something that cannot
 * see the engines "would be a capability claim nobody measured". Routing a
 * real profile down to here is PW-0308's settings work and PL-0502's engine
 * union; until then the engine's own default plays and the viewer's explicit
 * choice is honoured, which is the honest subset.
 */
export interface RestoreCommand {
  readonly kind: PlayerTrackKind;
  readonly trackId: string | null;
  readonly confidence: ReapplyConfidence;
  readonly explanation: string;
}

export interface CurrentSelection {
  readonly audioTrackId: string | null;
  readonly subtitleTrackId: string | null;
}

export function restoreCommands(
  choice: TrackChoice,
  tracks: readonly PlayerTrack[],
  current: CurrentSelection
): readonly RestoreCommand[] {
  const commands: RestoreCommand[] = [];

  if (choice.audio !== null) {
    const restored = reapply(choice.audio, tracks);
    /* Audio is never deselected -- `WebPlayerAdapter.selectAudioTrack(null)`
     * refuses it, because there is always a soundtrack playing -- so a miss
     * here leaves whatever the engine chose and says so rather than issuing a
     * command that would throw. */
    if (restored.trackId !== null && restored.trackId !== current.audioTrackId) {
      commands.push({ kind: "audio", ...restored });
    }
  }

  if (choice.subtitle === "off") {
    /*
     * "Off" IS A CHOICE AND IT HAS TO BE RE-APPLIED TOO. A new candidate whose
     * manifest marks a subtitle track `default` would otherwise turn text back
     * on for a viewer who switched it off thirty seconds ago, every time the
     * stream failed over.
     */
    if (current.subtitleTrackId !== null) {
      commands.push({
        kind: "subtitle",
        trackId: null,
        confidence: "exact",
        explanation: "the viewer had subtitles off; kept them off across the candidate switch"
      });
    }
  } else if (choice.subtitle !== null) {
    const restored = reapply(choice.subtitle, tracks);
    if (restored.trackId !== null && restored.trackId !== current.subtitleTrackId) {
      commands.push({ kind: "subtitle", ...restored });
    }
  }

  return commands;
}

/**
 * What to remember when a viewer picks something from a menu.
 *
 * `null` on the subtitle menu is `"off"` and not "no choice": the contract
 * models those as different states, because a viewer who turned subtitles off
 * and a viewer who never touched the menu must not be treated the same on the
 * next candidate.
 */
export function rememberFromMenu(
  choice: TrackChoice,
  kind: PlayerTrackKind,
  trackId: string | null,
  tracks: readonly PlayerTrack[]
): TrackChoice {
  if (kind === "audio") {
    return trackId === null ? choice : { ...choice, audio: rememberChoice(tracks, trackId) };
  }
  if (trackId === null) return { ...choice, subtitle: "off" };
  return { ...choice, subtitle: rememberChoice(tracks, trackId) };
}
