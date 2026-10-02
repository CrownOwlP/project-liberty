/* -------------------------------------------------------------------------
 * Track selection between the engine and the contracted policy (PW-0206).
 *
 * WHAT IS TESTED HERE AND WHAT IS NOT. The policy itself belongs to
 * `@liberty/media-engine` and has its own suites, property tests included;
 * nothing below re-asserts what `selectAudioTrack` or `selectSubtitleTrack`
 * decide. What is tested is this module's three jobs: the conversion, which
 * must never invent a field without saying so; the identity, which is what
 * survives a candidate switch; and the resolution, which must put the viewer
 * ahead of the policy and the policy ahead of nothing.
 * ---------------------------------------------------------------------- */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { PlaybackCapabilities } from "@liberty/contracts/domains/playback";

import type { PlayerTrack } from "./player-adapter";
import {
  NO_CHOICE,
  identify,
  reapply,
  rememberChoice,
  resolveTracks,
  toAudioCodec,
  toAudioTrack,
  toSubtitleTrack,
  type SubtitlePreferences,
  type TrackChoice
} from "./tracks";

function audio(overrides: Partial<PlayerTrack> = {}): PlayerTrack {
  return {
    id: "a-en",
    kind: "audio",
    label: "English",
    language: "en",
    codec: "mp4a.40.2",
    channels: 2,
    isDefault: true,
    isForced: false,
    audioRole: "main",
    subtitleKind: null,
    textFormat: null,
    ...overrides
  };
}

function subtitle(overrides: Partial<PlayerTrack> = {}): PlayerTrack {
  return {
    id: "s-en",
    kind: "subtitle",
    label: "English",
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

const CAPABILITIES: PlaybackCapabilities = {
  maxHeight: 1080,
  supportedVideoCodecs: ["h264"],
  supportedAudioCodecs: ["aac", "eac3"],
  preferredAudioLanguages: ["en"]
};

const SUBTITLE_PREFERENCES: SubtitlePreferences = {
  preferredLanguages: [],
  hearingImpaired: false,
  supportedFormats: ["webvtt", "ttml"]
};

describe("codec names, because a wrong one makes the capability check confident about the wrong decoder", () => {
  it("reads the RFC 6381 spellings a manifest actually states", () => {
    expect(toAudioCodec("mp4a.40.2")).toBe("aac");
    expect(toAudioCodec("mp4a.40.5")).toBe("aac");
    expect(toAudioCodec("ac-3")).toBe("ac3");
    expect(toAudioCodec("ec-3")).toBe("eac3");
    expect(toAudioCodec("Opus")).toBe("opus");
  });

  it("returns null for anything it does not recognise, and never a guess", () => {
    for (const codec of [null, "", "   ", "vorbis", "dts", "flac", "mp3", "unknown"]) {
      expect(toAudioCodec(codec)).toBeNull();
    }
  });
});

describe("converting an engine track into the one the policy decides over", () => {
  it("passes a fully described track through with no assumptions at all", () => {
    const result = toAudioTrack(audio());
    expect(result.converted).toBe(true);
    if (!result.converted) return;
    expect(result.assumptions).toEqual([]);
    expect(result.track).toEqual({
      id: "a-en",
      language: "en",
      codec: "aac",
      channels: 2,
      role: "main",
      isDefault: true
    });
  });

  it("ASSUMES A MISSING ROLE AND SAYS SO, rather than silently defaulting it", () => {
    /* The assumption itself is defensible -- DASH marks commentary explicitly.
     * An assumption nobody can see is not, which is what this asserts. */
    const result = toAudioTrack(audio({ audioRole: null }));
    expect(result.converted).toBe(true);
    if (!result.converted) return;
    expect(result.track.role).toBe("main");
    const assumption = result.assumptions.find((entry) => entry.field === "role");
    expect(assumption?.trackId).toBe("a-en");
    expect(assumption?.assumed).toBe("main");
    expect(assumption?.because).toMatch(/mark commentary and audio description explicitly/);
  });

  it("assumes the channel FLOOR, so an undescribed track is never wrongly rejected", () => {
    const result = toAudioTrack(audio({ channels: null }));
    expect(result.converted).toBe(true);
    if (!result.converted) return;
    expect(result.track.channels).toBe(2);
    expect(result.assumptions.map((entry) => entry.field)).toContain("channels");
  });

  it("REFUSES to convert a track with no language or no nameable codec", () => {
    expect(toAudioTrack(audio({ language: null }))).toEqual({
      converted: false,
      fields: ["language"]
    });
    expect(toAudioTrack(audio({ codec: "dts" }))).toEqual({ converted: false, fields: ["codec"] });
    /* Sorted, so one track always reports one list. */
    expect(toAudioTrack(audio({ language: null, codec: null }))).toEqual({
      converted: false,
      fields: ["codec", "language"]
    });
  });

  it("rejects a sub-minimum language tag rather than writing it through", () => {
    /* The contract declares `language` as `.min(2)`, so "e" is a value the
     * schema forbids; converting it would build an object the contract would
     * refuse. */
    expect(toAudioTrack(audio({ language: "e" })).converted).toBe(false);
    expect(toAudioTrack(audio({ language: "  " })).converted).toBe(false);
  });

  it("normalises the language, so EN-US and en-us are one language", () => {
    const upper = toAudioTrack(audio({ language: "EN-US" }));
    expect(upper.converted && upper.track.language).toBe("en-us");
  });
});

describe("converting a subtitle track", () => {
  it("treats a FORCED flag as a stated kind, not as an assumption", () => {
    /* `forced` IS one of the four kinds. The engine said it; nothing was
     * guessed, and the result must not claim otherwise. */
    const result = toSubtitleTrack(subtitle({ subtitleKind: null, isForced: true }));
    expect(result.converted).toBe(true);
    if (!result.converted) return;
    expect(result.track.kind).toBe("forced");
    expect(result.assumptions).toEqual([]);
  });

  it("assumes an unmarked, unforced track is an ordinary subtitle track, and says so", () => {
    const result = toSubtitleTrack(subtitle({ subtitleKind: null }));
    expect(result.converted).toBe(true);
    if (!result.converted) return;
    expect(result.track.kind).toBe("subtitles");
    expect(result.assumptions.map((entry) => entry.field)).toEqual(["kind"]);
  });

  it("WILL NOT ASSUME A FORMAT, because an unrenderable one fails silently", () => {
    /* subtitles.ts: "A subtitle format the renderer does not understand fails
     * silently far more often than an audio codec does". So this is the one
     * field that is undecidable rather than assumed. */
    expect(toSubtitleTrack(subtitle({ textFormat: null }))).toEqual({
      converted: false,
      fields: ["format"]
    });
  });

  it("keeps an engine-stated sdh kind, which a forced boolean could never express", () => {
    const result = toSubtitleTrack(subtitle({ subtitleKind: "sdh" }));
    expect(result.converted && result.track.kind).toBe("sdh");
  });
});

describe("a viewer's choice is an identity, because a track id does not survive a failover", () => {
  it("restores an exact match and says it was exact", () => {
    const chosen = audio({ id: "audio:fr", language: "fr", label: "Français" });
    const identity = identify(chosen);
    const next = [audio(), { ...chosen, id: "different-id-same-track" }];
    expect(reapply(identity, next)).toMatchObject({
      trackId: "different-id-same-track",
      confidence: "exact"
    });
  });

  it("falls back to language AND PURPOSE when something else about the track changed", () => {
    const chosen = subtitle({ id: "s-de", language: "de", label: "Deutsch", subtitleKind: "sdh" });
    const identity = identify(chosen);
    const next = [subtitle({ id: "other", language: "de", subtitleKind: "sdh", label: "German" })];
    expect(reapply(identity, next)).toMatchObject({ trackId: "other", confidence: "purpose" });
  });

  it("falls back to LANGUAGE ONLY, and says that is what it did", () => {
    /* SDH where the viewer had plain subtitles is a different experience, so
     * the confidence has to be visible rather than folded into a success. */
    const identity = identify(subtitle({ language: "de", subtitleKind: "subtitles" }));
    const next = [subtitle({ id: "de-sdh", language: "de", subtitleKind: "sdh" })];
    const restored = reapply(identity, next);
    expect(restored).toMatchObject({ trackId: "de-sdh", confidence: "language" });
    expect(restored.explanation).toMatch(/LANGUAGE ONLY/);
  });

  it("matches nothing when the language is absent from this candidate", () => {
    const identity = identify(audio({ language: "ja" }));
    expect(reapply(identity, [audio()])).toMatchObject({ trackId: null, confidence: "none" });
  });

  it("NEVER MATCHES ON THE ABSENCE OF INFORMATION", () => {
    /* Two tracks that both state no language are not the same track, and
     * pairing them would hand the viewer a language they did not choose. */
    const identity = identify(audio({ id: "x", language: null, label: "Track 1" }));
    const next = [audio({ id: "y", language: null, label: "Track 2" })];
    expect(reapply(identity, next).trackId).toBeNull();
  });

  it("never crosses the audio/subtitle line", () => {
    const identity = identify(audio({ language: "en" }));
    expect(reapply(identity, [subtitle({ language: "en" })]).trackId).toBeNull();
  });

  it("rememberChoice answers null for an id that was never offered", () => {
    expect(rememberChoice([audio()], "a-en")).not.toBeNull();
    expect(rememberChoice([audio()], "not-offered")).toBeNull();
  });
});

describe("resolution: the viewer first, the policy second", () => {
  const tracks = [
    audio({ id: "a-en", language: "en" }),
    audio({ id: "a-fr", language: "fr", label: "Français", isDefault: false }),
    subtitle({ id: "s-en", language: "en" }),
    subtitle({ id: "s-fr", language: "fr", label: "Français" })
  ];

  it("lets the policy decide when the viewer has chosen nothing", () => {
    const resolution = resolveTracks({
      tracks,
      capabilities: CAPABILITIES,
      subtitles: SUBTITLE_PREFERENCES,
      choice: NO_CHOICE
    });
    expect(resolution.audio.source).toBe("policy");
    expect(resolution.audio.trackId).toBe("a-en");
    /* No subtitle preference expressed, so nothing on screen -- which the
     * contract states is the correct default for subtitles and not for audio. */
    expect(resolution.subtitle.trackId).toBeNull();
    expect(resolution.subtitle.source).toBe("policy");
  });

  it("OVERRIDES THE POLICY with the viewer's remembered choice", () => {
    const choice: TrackChoice = {
      audio: rememberChoice(tracks, "a-fr"),
      subtitle: rememberChoice(tracks, "s-fr")
    };
    const resolution = resolveTracks({
      tracks,
      capabilities: CAPABILITIES,
      subtitles: SUBTITLE_PREFERENCES,
      choice
    });
    expect(resolution.audio).toMatchObject({ trackId: "a-fr", source: "viewer" });
    expect(resolution.subtitle).toMatchObject({ trackId: "s-fr", source: "viewer" });
  });

  it("SURVIVES A CANDIDATE SWITCH THAT RENAMES EVERY ID -- the clause this exists for", () => {
    const choice: TrackChoice = {
      audio: rememberChoice(tracks, "a-fr"),
      subtitle: rememberChoice(tracks, "s-fr")
    };
    /* A different provider, a different manifest, different ids, same tracks. */
    const afterFailover = tracks.map((track) => ({ ...track, id: `cdn2/${track.id}` }));
    const resolution = resolveTracks({
      tracks: afterFailover,
      capabilities: CAPABILITIES,
      subtitles: SUBTITLE_PREFERENCES,
      choice
    });
    expect(resolution.audio).toMatchObject({ trackId: "cdn2/a-fr", source: "viewer" });
    expect(resolution.subtitle).toMatchObject({ trackId: "cdn2/s-fr", source: "viewer" });
  });

  it("falls back to the policy when the choice is gone, and gives BOTH reasons", () => {
    const choice: TrackChoice = { audio: identify(audio({ language: "ja" })), subtitle: null };
    const resolution = resolveTracks({
      tracks,
      capabilities: CAPABILITIES,
      subtitles: SUBTITLE_PREFERENCES,
      choice
    });
    expect(resolution.audio.source).toBe("policy");
    expect(resolution.audio.trackId).toBe("a-en");
    expect(resolution.audio.explanation).toMatch(/offers no audio track in ja/);
    expect(resolution.audio.explanation).toMatch(/matched a preferred language/);
  });

  it("A VIEWER'S \"OFF\" STILL LETS A FORCED TRACK THROUGH", () => {
    /* The contract is explicit that `off` does not mean "never put text on
     * screen": a forced track translates the lines the soundtrack does not
     * deliver, for a viewer who is not reading. Short-circuiting on "off"
     * would delete the one kind of subtitle that viewer needs. */
    const withForced = [
      audio({ id: "a-en", language: "en" }),
      subtitle({ id: "s-en-forced", language: "en", subtitleKind: "forced", isForced: true })
    ];
    const resolution = resolveTracks({
      tracks: withForced,
      capabilities: CAPABILITIES,
      subtitles: SUBTITLE_PREFERENCES,
      choice: { audio: null, subtitle: "off" }
    });
    expect(resolution.subtitle.trackId).toBe("s-en-forced");
    expect(resolution.subtitle.source).toBe("viewer");
  });

  it("decides AUDIO FIRST, because a forced track is keyed to what comes out of the speakers", () => {
    /* French audio chosen by the viewer, French and English forced tracks
     * available. The French one is correct; picking by the viewer's reading
     * preference rather than by the audio would caption dialogue they can
     * already understand and leave the foreign lines untouched. */
    const both = [
      audio({ id: "a-en", language: "en" }),
      audio({ id: "a-fr", language: "fr", isDefault: false }),
      subtitle({ id: "s-en-forced", language: "en", subtitleKind: "forced", isForced: true }),
      subtitle({ id: "s-fr-forced", language: "fr", subtitleKind: "forced", isForced: true })
    ];
    const resolution = resolveTracks({
      tracks: both,
      capabilities: CAPABILITIES,
      subtitles: SUBTITLE_PREFERENCES,
      choice: { audio: rememberChoice(both, "a-fr"), subtitle: "off" }
    });
    expect(resolution.audio.trackId).toBe("a-fr");
    expect(resolution.subtitle.trackId).toBe("s-fr-forced");
  });

  it("keeps a commentary track OFF the automatic list and ON the manual one", () => {
    const withCommentary = [
      audio({ id: "a-en", language: "en" }),
      audio({ id: "a-comm", language: "en", audioRole: "commentary", isDefault: false })
    ];
    const resolution = resolveTracks({
      tracks: withCommentary,
      capabilities: CAPABILITIES,
      subtitles: SUBTITLE_PREFERENCES
    });
    expect(resolution.audio.trackId).toBe("a-en");
    expect(resolution.audio.manualOnly).toContain("a-comm");
    expect(resolution.audio.offered).not.toContain("a-comm");
  });

  it("REPORTS AN UNDECIDABLE TRACK RATHER THAN HIDING IT, with the fields that were missing", () => {
    const withMystery = [
      audio({ id: "a-en", language: "en" }),
      audio({ id: "a-dts", language: "en", codec: "dts", isDefault: false }),
      subtitle({ id: "s-noformat", language: "en", textFormat: null })
    ];
    const resolution = resolveTracks({
      tracks: withMystery,
      capabilities: CAPABILITIES,
      subtitles: SUBTITLE_PREFERENCES
    });
    expect(resolution.audio.undecidable).toEqual([{ trackId: "a-dts", fields: ["codec"] }]);
    expect(resolution.subtitle.undecidable).toEqual([
      { trackId: "s-noformat", fields: ["format"] }
    ]);
    /* Excluded from the automatic lists -- the policy never saw them. */
    expect(resolution.audio.offered).not.toContain("a-dts");
  });

  it("still restores a viewer's choice OF an undecidable track", () => {
    /* The policy could not reason about it. The viewer could, and did. */
    const withMystery = [
      audio({ id: "a-en", language: "en" }),
      audio({ id: "a-dts", language: "de", codec: "dts", isDefault: false })
    ];
    const resolution = resolveTracks({
      tracks: withMystery,
      capabilities: CAPABILITIES,
      subtitles: SUBTITLE_PREFERENCES,
      choice: { audio: rememberChoice(withMystery, "a-dts"), subtitle: null }
    });
    expect(resolution.audio).toMatchObject({ trackId: "a-dts", source: "viewer" });
  });

  it("carries every assumption it made into the result", () => {
    const vague = [audio({ id: "a-en", language: "en", audioRole: null, channels: null })];
    const resolution = resolveTracks({
      tracks: vague,
      capabilities: CAPABILITIES,
      subtitles: SUBTITLE_PREFERENCES
    });
    expect(resolution.audio.assumptions.map((entry) => entry.field).sort()).toEqual([
      "channels",
      "role"
    ]);
  });

  it("answers the same way whatever order the engine listed the tracks in", () => {
    /* The policy claims order-invariance; this module must not reintroduce an
     * ordering dependency on the way in. */
    fc.assert(
      fc.property(fc.shuffledSubarray(tracks, { minLength: 4, maxLength: 4 }), (shuffled) => {
        const resolution = resolveTracks({
          tracks: shuffled,
          capabilities: CAPABILITIES,
          subtitles: { ...SUBTITLE_PREFERENCES, preferredLanguages: ["fr"] }
        });
        expect(resolution.audio.trackId).toBe("a-en");
        expect(resolution.subtitle.trackId).toBe("s-fr");
      }),
      { numRuns: 60 }
    );
  });

  it("says nothing played rather than throwing, when a title ships no tracks at all", () => {
    const resolution = resolveTracks({
      tracks: [],
      capabilities: CAPABILITIES,
      subtitles: SUBTITLE_PREFERENCES
    });
    expect(resolution.audio.trackId).toBeNull();
    expect(resolution.audio.reason).toBe("no_audio_tracks");
    expect(resolution.subtitle.trackId).toBeNull();
  });
});
