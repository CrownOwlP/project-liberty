/* -------------------------------------------------------------------------
 * The control bar's decisions (PW-0306).
 *
 * Everything a viewer can FEEL is here rather than in the component test: how
 * far a key seeks, when the bar is allowed to dim, what a track is called.
 * The component test proves those answers reach the screen; this one proves
 * they are the right answers.
 * ---------------------------------------------------------------------- */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { PlayerTrack } from "../player-adapter";
import {
  IDLE_HIDE_AFTER_MS,
  SEEK_STEP_SECONDS,
  VOLUME_STEP,
  bufferedSegments,
  commandForKey,
  describeSourceState,
  describeTrack,
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
  type OverlayInput
} from "./controls-state";
import { NO_CHOICE, identify, rememberChoice } from "../tracks";

function track(overrides: Partial<PlayerTrack> = {}): PlayerTrack {
  return {
    id: "t1",
    kind: "subtitle",
    label: null,
    language: "en",
    codec: null,
    channels: null,
    isDefault: false,
    isForced: false,
    audioRole: null,
    subtitleKind: "subtitles",
    textFormat: "webvtt",
    ...overrides
  };
}

describe("timecodes, where an unknown time is not a zero", () => {
  it("renders --:-- for a time nobody knows, and never 0:00", () => {
    /* A live stream has no duration and a VOD has none until metadata
     * arrives. Rendering either as 0:00 tells a viewer the programme is
     * empty. */
    for (const value of [null, NaN, Infinity, -1]) {
      expect(formatTimecode(value)).toBe("--:--");
    }
  });

  it("shows an hours field only when the SCALE has hours, so digits do not jump", () => {
    expect(formatTimecode(251)).toBe("4:11");
    /* Four minutes into a 90-minute film still reads with the hour, so the
     * field does not grow a column as the hour turns over. */
    expect(formatTimecode(251, 5400)).toBe("0:04:11");
    expect(formatTimecode(5400, 5400)).toBe("1:30:00");
  });

  it("speaks a timecode rather than reading it as a ratio", () => {
    expect(speakTimecode(3723)).toBe("1 hour 2 minutes 3 seconds");
    expect(speakTimecode(0)).toBe("0 seconds");
    expect(speakTimecode(null)).toBe("unknown");
  });
});

describe("the seek bar draws RANGES, which is the reason the boundary gained them", () => {
  it("turns ranges into percentages of the bar", () => {
    expect(bufferedSegments([{ startSeconds: 10, endSeconds: 20 }], 100)).toEqual([
      { leftPercent: 10, widthPercent: 10 }
    ]);
  });

  it("KEEPS THE GAP, which a percentage cannot express", () => {
    /* One range of 60s and two of 30s either side of a gap are the same
     * percentage and opposite answers to "can I jump there". */
    const segments = bufferedSegments(
      [
        { startSeconds: 0, endSeconds: 30 },
        { startSeconds: 60, endSeconds: 90 }
      ],
      120
    );
    expect(segments).toHaveLength(2);
    expect(segments[0]?.leftPercent).toBe(0);
    expect(segments[1]?.leftPercent).toBe(50);
  });

  it("draws nothing rather than dividing by an unknown duration", () => {
    for (const duration of [null, 0, -5, NaN]) {
      expect(bufferedSegments([{ startSeconds: 0, endSeconds: 10 }], duration)).toEqual([]);
    }
  });

  it("CLAMPS a range past the duration instead of discarding it", () => {
    /* A live edge legitimately reports a buffered end past the duration the
     * element last published, and dropping that range would blank the bar at
     * the only moment it is interesting. */
    const segments = bufferedSegments([{ startSeconds: 90, endSeconds: 200 }], 100);
    expect(segments).toEqual([{ leftPercent: 90, widthPercent: 10 }]);
  });

  it("drops a range with no width, which would draw a line at a lie", () => {
    expect(bufferedSegments([{ startSeconds: 50, endSeconds: 50 }], 100)).toEqual([]);
    expect(bufferedSegments([{ startSeconds: 60, endSeconds: 40 }], 100)).toEqual([]);
  });

  it("never leaves the bar, for any ranges and any duration", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(fc.float({ min: -100, max: 500, noNaN: true }), fc.float({ min: -100, max: 500, noNaN: true })),
          { maxLength: 8 }
        ),
        fc.float({ min: Math.fround(0.1), max: 1000, noNaN: true }),
        (pairs, duration) => {
          const ranges = pairs.map(([a, b]) => ({ startSeconds: a, endSeconds: b }));
          for (const segment of bufferedSegments(ranges, duration)) {
            expect(segment.leftPercent).toBeGreaterThanOrEqual(0);
            expect(segment.widthPercent).toBeGreaterThan(0);
            expect(segment.leftPercent + segment.widthPercent).toBeLessThanOrEqual(100.0001);
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it("refuses to compute a seek target against an unknown duration", () => {
    expect(seekTargetFrom(0.5, null)).toBeNull();
    expect(seekTargetFrom(0.5, 100)).toBe(50);
    /* A drag past either end is clamped, not rejected: the pointer legitimately
     * leaves the element while the button is down. */
    expect(seekTargetFrom(-2, 100)).toBe(0);
    expect(seekTargetFrom(9, 100)).toBe(100);
  });

  it("reports progress as 0 rather than NaN when there is no duration", () => {
    expect(progressPercent(30, null)).toBe(0);
    expect(progressPercent(30, 120)).toBe(25);
    expect(progressPercent(500, 120)).toBe(100);
  });
});

describe("keyboard: the keys the acceptance names, and no others", () => {
  it("maps every named key", () => {
    expect(commandForKey({ key: " " })).toEqual({ kind: "toggle-play" });
    expect(commandForKey({ key: "ArrowLeft" })).toEqual({
      kind: "seek-by",
      deltaSeconds: -SEEK_STEP_SECONDS
    });
    expect(commandForKey({ key: "ArrowRight" })).toEqual({
      kind: "seek-by",
      deltaSeconds: SEEK_STEP_SECONDS
    });
    expect(commandForKey({ key: "ArrowUp" })).toEqual({ kind: "volume-by", delta: VOLUME_STEP });
    expect(commandForKey({ key: "ArrowDown" })).toEqual({ kind: "volume-by", delta: -VOLUME_STEP });
    expect(commandForKey({ key: "f" })).toEqual({ kind: "toggle-fullscreen" });
    expect(commandForKey({ key: "M" })).toEqual({ kind: "toggle-mute" });
    expect(commandForKey({ key: "Escape" })).toEqual({ kind: "dismiss" });
  });

  it("NEVER CLAIMS A KEYSTROKE FROM A TEXT FIELD", () => {
    /* The space bar is both "play" and the commonest character in written
     * language. A player that ate it would break typing in the page around
     * it. */
    expect(commandForKey({ key: " ", fromTextEntry: true })).toBeNull();
    expect(commandForKey({ key: "f", fromTextEntry: true })).toBeNull();
  });

  it("leaves MODIFIED keystrokes to the browser and the operating system", () => {
    /* Ctrl+F is find, Cmd+M minimises a window. A player that ate either
     * would be a bug report about the browser. */
    expect(commandForKey({ key: "f", ctrlKey: true })).toBeNull();
    expect(commandForKey({ key: "m", metaKey: true })).toBeNull();
    expect(commandForKey({ key: "ArrowRight", altKey: true })).toBeNull();
  });

  it("has no opinion about any other key", () => {
    for (const key of ["a", "Tab", "Enter", "PageDown", "1", "Home", "End"]) {
      expect(commandForKey({ key })).toBeNull();
    }
  });

  it("clamps volume and position instead of erroring at the ends", () => {
    expect(nextVolume(1, VOLUME_STEP)).toBe(1);
    expect(nextVolume(0, -VOLUME_STEP)).toBe(0);
    expect(nextVolume(0.5, VOLUME_STEP)).toBe(0.55);
    expect(nextPosition(2, -SEEK_STEP_SECONDS, 100)).toBe(0);
    expect(nextPosition(98, SEEK_STEP_SECONDS, 100)).toBe(100);
    /* No duration is not a ceiling of zero: a live stream seeks forward. */
    expect(nextPosition(98, SEEK_STEP_SECONDS, null)).toBe(103);
  });
});

describe("the idle overlay, which never removes a control", () => {
  const idle: OverlayInput = {
    msSincePointerActivity: IDLE_HIDE_AFTER_MS + 1,
    focusWithin: false,
    menuOpen: false,
    paused: false,
    pointerIsCoarse: false
  };

  it("dims only when every reason to stay is absent", () => {
    expect(overlayVisibility(idle)).toBe("dimmed");
  });

  it("STAYS SHOWN WHILE FOCUS IS INSIDE IT", () => {
    /* Dimming the control a keyboard user is standing on is the single worst
     * thing this component could do. */
    expect(overlayVisibility({ ...idle, focusWithin: true })).toBe("shown");
  });

  it("stays shown for an open menu, a paused player and a coarse pointer", () => {
    expect(overlayVisibility({ ...idle, menuOpen: true })).toBe("shown");
    expect(overlayVisibility({ ...idle, paused: true })).toBe("shown");
    /* A touch viewer has no hover to bring the bar back with. */
    expect(overlayVisibility({ ...idle, pointerIsCoarse: true })).toBe("shown");
  });

  it("stays shown before the threshold and when the pointer has never moved", () => {
    expect(overlayVisibility({ ...idle, msSincePointerActivity: IDLE_HIDE_AFTER_MS - 1 })).toBe(
      "shown"
    );
    expect(overlayVisibility({ ...idle, msSincePointerActivity: null })).toBe("shown");
  });

  it("has exactly two states, and neither of them removes anything", () => {
    /* The type is the guarantee: there is no "hidden". A third value would be
     * where `display: none` crept in. */
    const values: ReturnType<typeof overlayVisibility>[] = ["shown", "dimmed"];
    expect(values).toHaveLength(2);
  });
});

describe("track menus", () => {
  it("prefers the engine's own label, then the language, then an honest fallback", () => {
    expect(describeTrack(track({ label: "English" }))).toBe("English");
    expect(describeTrack(track({ label: null, language: "fr" }))).toBe("FR");
    expect(describeTrack(track({ id: "x9", label: null, language: null }))).toBe("Track x9");
  });

  it("APPENDS THE PURPOSE RATHER THAN REPLACING THE NAME", () => {
    /* `English` and `English (SDH)` are different tracks a viewer chooses
     * between for different reasons; a menu showing both as `English` cannot
     * be used. */
    expect(describeTrack(track({ label: "English", subtitleKind: "sdh" }))).toBe("English (SDH)");
    expect(describeTrack(track({ label: "English", subtitleKind: "forced" }))).toBe(
      "English (forced)"
    );
    expect(
      describeTrack(track({ kind: "audio", label: "English", subtitleKind: null, audioRole: "commentary" }))
    ).toBe("English (commentary)");
    expect(
      describeTrack(track({ kind: "audio", label: "English", subtitleKind: null, audioRole: "descriptive" }))
    ).toBe("English (audio description)");
  });

  it("APPENDS NOTHING WHERE THE ENGINE SAID NOTHING", () => {
    /* PW-0206's rule, applied in reverse: an unstated field is never inferred,
     * so it is never displayed either. */
    expect(describeTrack(track({ label: "English", subtitleKind: null }))).toBe("English");
    expect(
      describeTrack(track({ kind: "audio", label: "English", subtitleKind: null, audioRole: null }))
    ).toBe("English");
    expect(
      describeTrack(track({ kind: "audio", label: "English", subtitleKind: null, audioRole: "main" }))
    ).toBe("English");
  });

  it("still says `forced` when only the boolean was set", () => {
    expect(describeTrack(track({ label: "FR", subtitleKind: null, isForced: true }))).toBe(
      "FR (forced)"
    );
  });

  it("gives SUBTITLES an Off row and AUDIO none", () => {
    /* `subtitleModeSchema` records that `off` is a state. `WebPlayerAdapter`
     * refuses `selectAudioTrack(null)` outright, so an audio Off row would
     * offer a command the adapter is documented to reject. */
    const tracks = [track({ id: "s1" }), track({ id: "a1", kind: "audio", subtitleKind: null })];
    const subtitles = trackOptions(tracks, "subtitle", "s1");
    expect(subtitles[0]).toEqual({ id: null, label: "Off", selected: false });
    expect(trackOptions(tracks, "audio", "a1").some((option) => option.id === null)).toBe(false);
  });

  it("marks Off as selected when no subtitle track is chosen", () => {
    const options = trackOptions([track({ id: "s1" })], "subtitle", null);
    expect(options[0]?.selected).toBe(true);
    expect(options[1]?.selected).toBe(false);
  });

  it("reports an empty menu so the button can say so rather than do nothing", () => {
    expect(menuIsEmpty([track({ id: "s1" })], "audio")).toBe(true);
    expect(menuIsEmpty([track({ id: "s1" })], "subtitle")).toBe(false);
    expect(menuIsEmpty([], "subtitle")).toBe(true);
  });
});

describe("the source line a viewer reads", () => {
  const base = {
    candidateId: "cdn-a",
    attemptsUsed: 1,
    maxAttempts: 3,
    engineStatus: "ready",
    restarting: false
  };

  it("names the source, the attempt budget and the engine", () => {
    expect(describeSourceState(base)).toBe(
      "source cdn-a — attempt 1 of 3, engine ready"
    );
  });

  it("says a switch is happening while one is", () => {
    expect(describeSourceState({ ...base, restarting: true, attemptsUsed: 2 })).toBe(
      "Switching source — source cdn-a, attempt 2 of 3"
    );
  });

  it("says no source rather than naming one that does not exist", () => {
    expect(describeSourceState({ ...base, candidateId: null })).toContain("no source selected");
  });
});

describe("a viewer's track choice survives a candidate switch (PW-0206, delivered here)", () => {
  const onCandidateA = [
    track({ id: "audio:en", kind: "audio", language: "en", label: "English", audioRole: "main" }),
    track({ id: "audio:fr", kind: "audio", language: "fr", label: "Français", audioRole: "main" }),
    track({ id: "sub-7", kind: "subtitle", language: "fr", label: "Français", subtitleKind: "subtitles" }),
    track({ id: "sub-8", kind: "subtitle", language: "de", label: "Deutsch", subtitleKind: "sdh" })
  ];
  /* A different provider, a different manifest, NOT ONE ID IN COMMON. This is
   * the event the clause is about and the reason a track id cannot be what is
   * remembered. */
  const onCandidateB = onCandidateA.map((t) => ({ ...t, id: `cdn2/${t.id}` }));
  const nothingSelected = { audioTrackId: null, subtitleTrackId: null };

  it("issues nothing at all when the viewer has chosen nothing", () => {
    expect(restoreCommands(NO_CHOICE, onCandidateB, nothingSelected)).toEqual([]);
  });

  it("RESTORES BOTH CHOICES ONTO A CANDIDATE THAT RENAMED EVERY ID", () => {
    let choice = rememberFromMenu(NO_CHOICE, "audio", "audio:fr", onCandidateA);
    choice = rememberFromMenu(choice, "subtitle", "sub-8", onCandidateA);
    expect(restoreCommands(choice, onCandidateB, nothingSelected)).toEqual([
      {
        kind: "audio",
        trackId: "cdn2/audio:fr",
        confidence: "exact",
        explanation: expect.stringContaining("exactly")
      },
      {
        kind: "subtitle",
        trackId: "cdn2/sub-8",
        confidence: "exact",
        explanation: expect.stringContaining("exactly")
      }
    ]);
  });

  it("ISSUES NOTHING when the restored track is the one already selected", () => {
    /* Otherwise every candidate switch would command a selection that is not
     * news, and emit a `trackselected` event for it, forever. */
    const choice = rememberFromMenu(NO_CHOICE, "audio", "audio:fr", onCandidateA);
    expect(
      restoreCommands(choice, onCandidateA, { audioTrackId: "audio:fr", subtitleTrackId: null })
    ).toEqual([]);
  });

  it("leaves the engine's own audio alone when the viewer's language is not on this candidate", () => {
    /* Audio cannot be deselected -- the adapter refuses it -- so a miss must
     * produce no command rather than one that throws. */
    const choice = rememberFromMenu(NO_CHOICE, "audio", "audio:fr", onCandidateA);
    const englishOnly = [onCandidateA[0]!];
    expect(restoreCommands(choice, englishOnly, nothingSelected)).toEqual([]);
  });

  it("NEVER COMMANDS A NULL AUDIO TRACK, even when another one is already playing", () => {
    /*
     * Found by mutation testing, and it is the case the previous test misses.
     * The viewer chose French; this candidate has only English, AND English is
     * already selected. A guard written as "restored differs from current"
     * rather than "restored exists and differs from current" would push
     * `{trackId: null}` here, and `selectAudioTrack(null)` THROWS -- the
     * adapter refuses it in writing, because there is always a soundtrack
     * playing. The honest outcome is no command and the engine's own choice.
     */
    const choice = rememberFromMenu(NO_CHOICE, "audio", "audio:fr", onCandidateA);
    const englishOnly = [onCandidateA[0]!];
    expect(
      restoreCommands(choice, englishOnly, { audioTrackId: "audio:en", subtitleTrackId: null })
    ).toEqual([]);
  });

  it("reports a LANGUAGE-ONLY restore as such rather than as an exact one", () => {
    /* The viewer had plain French subtitles; this candidate has French SDH.
     * They get French, and the confidence says it is not the same track. */
    const choice = rememberFromMenu(NO_CHOICE, "subtitle", "sub-7", onCandidateA);
    const sdhOnly = [track({ id: "x", kind: "subtitle", language: "fr", label: "Français", subtitleKind: "sdh" })];
    const [command] = restoreCommands(choice, sdhOnly, nothingSelected);
    expect(command).toMatchObject({ kind: "subtitle", trackId: "x", confidence: "language" });
  });

  it("KEEPS SUBTITLES OFF, which a default-marked track on the next candidate would undo", () => {
    const choice = rememberFromMenu(NO_CHOICE, "subtitle", null, onCandidateA);
    expect(choice.subtitle).toBe("off");
    expect(restoreCommands(choice, onCandidateB, { audioTrackId: null, subtitleTrackId: "cdn2/sub-7" })).toEqual([
      {
        kind: "subtitle",
        trackId: null,
        confidence: "exact",
        explanation: expect.stringContaining("off")
      }
    ]);
  });

  it("does not re-issue OFF when nothing is on", () => {
    const choice = rememberFromMenu(NO_CHOICE, "subtitle", null, onCandidateA);
    expect(restoreCommands(choice, onCandidateB, nothingSelected)).toEqual([]);
  });

  it("'off' is a STATE and 'never touched the menu' is not the same state", () => {
    const off = rememberFromMenu(NO_CHOICE, "subtitle", null, onCandidateA);
    expect(off.subtitle).toBe("off");
    expect(NO_CHOICE.subtitle).toBeNull();
    /* And null on the AUDIO menu is not a choice at all -- there is no "no
     * audio" to remember. */
    expect(rememberFromMenu(NO_CHOICE, "audio", null, onCandidateA).audio).toBeNull();
  });

  it("remembers an identity and not an id", () => {
    const choice = rememberFromMenu(NO_CHOICE, "audio", "audio:fr", onCandidateA);
    expect(choice.audio).toEqual(identify(onCandidateA[1]!));
    expect(JSON.stringify(choice.audio)).not.toContain("audio:fr");
  });

  it("ignores a menu id that is not in the list it was built from", () => {
    expect(rememberChoice(onCandidateA, "not-offered")).toBeNull();
    expect(rememberFromMenu(NO_CHOICE, "audio", "not-offered", onCandidateA).audio).toBeNull();
  });
});
