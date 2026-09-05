import { describe, expect, it } from "vitest";
import type { AudioTrack } from "@liberty/contracts/domains/audio";
import type { PlaybackCapabilities } from "@liberty/contracts/domains/playback";
import type { SubtitlePolicy, SubtitleTrack } from "@liberty/contracts/domains/subtitles";
import { selectAudioTrack } from "./audio";
import { SUBTITLE_OUTCOME_BY_REASON, selectSubtitleTrack, withSelectedAudio } from "./subtitles";

const track = (over: Partial<SubtitleTrack> & { id: string }): SubtitleTrack => ({
  language: "en",
  kind: "subtitles",
  format: "webvtt",
  isDefault: false,
  ...over
});

const policy = (over: Partial<SubtitlePolicy> = {}): SubtitlePolicy => ({
  mode: "auto",
  preferredLanguages: [],
  hearingImpaired: false,
  audioLanguage: null,
  supportedFormats: ["webvtt", "ttml", "srt", "ass"],
  ...over
});

/*
 * Audio fixtures, identical in shape to `audio.test.ts`'s.
 *
 * Present because `withSelectedAudio` couples the two policies, and a fixture
 * `AudioSelection` written by hand would let this file assert a coupling to a
 * decision `selectAudioTrack` never makes. The audio policy is run for real.
 */
const audioTrack = (over: Partial<AudioTrack> & { id: string }): AudioTrack => ({
  language: "en",
  codec: "aac",
  channels: 2,
  role: "main",
  isDefault: false,
  ...over
});

const audioCaps = (over: Partial<PlaybackCapabilities> = {}): PlaybackCapabilities => ({
  maxHeight: 2160,
  supportedVideoCodecs: ["h264", "hevc"],
  supportedAudioCodecs: ["aac", "eac3", "opus"],
  preferredAudioLanguages: [],
  ...over
});

describe("selectSubtitleTrack eligibility", () => {
  it("rejects a format the client cannot render", () => {
    const result = selectSubtitleTrack(
      [track({ id: "a", format: "ass" })],
      policy({ preferredLanguages: ["en"], supportedFormats: ["webvtt"] })
    );
    expect(result.selected).toBeNull();
    expect(result.reason).toBe("no_eligible_tracks");
    expect(result.rejected).toEqual([{ trackId: "a", reason: "unsupported_subtitle_format" }]);
  });

  it("treats an empty format list as 'renders none', not as unconstrained", () => {
    // The opposite reading of `maxAudioChannels`, and deliberately so: a client
    // that named no renderable format has told us it can draw none of them, and
    // silently accepting every track would select something that never appears.
    const result = selectSubtitleTrack(
      [track({ id: "a" })],
      policy({ preferredLanguages: ["en"], supportedFormats: [] })
    );
    expect(result.reason).toBe("no_eligible_tracks");
    expect(result.rejected).toEqual([{ trackId: "a", reason: "unsupported_subtitle_format" }]);
  });

  it("distinguishes no tracks offered from no track renderable", () => {
    // A stream with no subtitles is a provider/manifest gap; a stream whose
    // tracks the client cannot draw is a capability limit. Reporting the first
    // as the second sends whoever debugs it to the wrong system.
    const result = selectSubtitleTrack([], policy({ preferredLanguages: ["en"] }));
    expect(result.reason).toBe("no_subtitle_tracks");
    expect(result.explanation).toContain("no subtitle tracks at all");
    expect(result.ordered).toEqual([]);
    expect(result.forced).toEqual([]);
    expect(result.manualOnly).toEqual([]);
  });

  it("reports an unrenderable commentary track as a format rejection, not as manual-only", () => {
    // The pool split happens after eligibility, so the reason a track is
    // unavailable stays accurate.
    const result = selectSubtitleTrack(
      [track({ id: "comm", kind: "commentary", format: "ass" })],
      policy({ preferredLanguages: ["en"], supportedFormats: ["webvtt"] })
    );
    expect(result.rejected).toEqual([{ trackId: "comm", reason: "unsupported_subtitle_format" }]);
    expect(result.manualOnly).toEqual([]);
  });
});

describe("selectSubtitleTrack preferred language", () => {
  it("honours the viewer's language over kind, provider default and format", () => {
    const result = selectSubtitleTrack(
      [
        track({ id: "en", language: "en", isDefault: true, format: "webvtt" }),
        track({ id: "fr", language: "fr", format: "srt" })
      ],
      policy({ preferredLanguages: ["fr"] })
    );
    // The English track is better on provider default and on format. Neither
    // may outrank the language the viewer asked for.
    expect(result.selected?.id).toBe("fr");
    expect(result.reason).toBe("preferred_language_exact");
  });

  it("respects the order of the preference list", () => {
    const result = selectSubtitleTrack(
      [track({ id: "de", language: "de" }), track({ id: "es", language: "es" })],
      policy({ preferredLanguages: ["es", "de"] })
    );
    expect(result.selected?.id).toBe("es");
  });

  it("prefers an exact regional match over a bare primary subtag", () => {
    const result = selectSubtitleTrack(
      [track({ id: "pt", language: "pt" }), track({ id: "pt-br", language: "pt-br" })],
      policy({ preferredLanguages: ["pt-br"] })
    );
    expect(result.selected?.id).toBe("pt-br");
    expect(result.reason).toBe("preferred_language_exact");
  });

  it("does not let an unrequested regional variant beat a requested one", () => {
    /*
     * The defect this reviewer caught in the audio comparator, restated for
     * subtitles: with preferences ["pt-br", "pt-pt"], a pt-AO track nobody asked
     * for shared the language GROUP with the requested pt-PT, and comparing the
     * wrong coordinate first handed it the win.
     *
     * Every criterion below language is stacked in pt-AO's favour here -- it is
     * the provider default and it is WebVTT against pt-PT's SRT -- so this fails
     * if language ever stops being decided first, not merely if the match
     * coordinates regress.
     */
    const result = selectSubtitleTrack(
      [
        track({ id: "pt-ao", language: "pt-ao", isDefault: true, format: "webvtt" }),
        track({ id: "pt-pt", language: "pt-pt", format: "srt" })
      ],
      policy({ preferredLanguages: ["pt-br", "pt-pt"] })
    );
    expect(result.selected?.id).toBe("pt-pt");
    expect(result.reason).toBe("preferred_language_exact");
  });

  it("respects the viewer's ordering of regional variants", () => {
    // The mirror of the case above: once both variants count as exact matches,
    // the earlier preference must still win rather than a lower criterion
    // deciding something the viewer had already decided.
    const result = selectSubtitleTrack(
      [
        track({ id: "pt-br", language: "pt-br", isDefault: true, format: "webvtt" }),
        track({ id: "pt-pt", language: "pt-pt", format: "srt" })
      ],
      policy({ preferredLanguages: ["pt-pt", "pt-br"] })
    );
    expect(result.selected?.id).toBe("pt-pt");
  });

  it("does not let a different script beat the requested one", () => {
    // zh-Hans and zh-Hant share a primary subtag but not a reader. They match as
    // variants of one another, which is a fallback -- never a way to outrank the
    // exact tag the viewer named.
    const result = selectSubtitleTrack(
      [
        track({ id: "zh-hans", language: "zh-hans", isDefault: true }),
        track({ id: "zh-hant", language: "zh-hant" })
      ],
      policy({ preferredLanguages: ["zh-hant"] })
    );
    expect(result.selected?.id).toBe("zh-hant");
    expect(result.reason).toBe("preferred_language_exact");
  });

  it("falls back to a different script as a variant, and says that is what happened", () => {
    // A last-resort fallback, and the reason value is what lets a UI mark it as
    // one. If the product later decides a script mismatch is no fallback at all,
    // that belongs in the shared `languageMatch` rather than here, so audio and
    // subtitles cannot disagree about what "the same language" means.
    const result = selectSubtitleTrack(
      [track({ id: "zh-hans", language: "zh-hans" })],
      policy({ preferredLanguages: ["zh-hant"] })
    );
    expect(result.selected?.id).toBe("zh-hans");
    expect(result.reason).toBe("preferred_language_primary_subtag");
  });

  it("cannot yet tell a script fallback from a regional one, and this pins that", () => {
    /*
     * KNOWN DEFECT, asserted as it currently behaves rather than left
     * undocumented. `primarySubtag` reduces both `zh-Hant` and `zh-Hans` to
     * `zh`, so "requested zh-Hant, served zh-Hans" reports the SAME reason value
     * as "requested en-GB, served en-US" -- and those are not comparable
     * degradations. en-GB to en-US costs a reader nothing; zh-Hant to zh-Hans
     * hands a traditional-script reader a script they may not read, while the
     * trail tells them their language was matched.
     *
     * The selection itself is right: an exact tag always wins, which the test
     * above this one pins. Only the reported outcome is wrong, and the fix
     * belongs in the shared `languageMatch` -- it carries one binary where this
     * needs a degree of match -- as one cross-lane change spanning PL-0202 and
     * PL-0203, so audio and subtitles cannot end up disagreeing about what "the
     * same language" means.
     *
     * THIS ASSERTION IS EXPECTED TO CHANGE when that lands: the two reasons
     * should stop being equal, and the script case should carry a value of its
     * own. Until then, the equality is the honest record of what we report.
     */
    const script = selectSubtitleTrack(
      [track({ id: "zh-hans", language: "zh-hans" })],
      policy({ preferredLanguages: ["zh-hant"] })
    );
    const region = selectSubtitleTrack(
      [track({ id: "en-us", language: "en-us" })],
      policy({ preferredLanguages: ["en-gb"] })
    );

    expect(script.selected?.id).toBe("zh-hans");
    expect(script.reason).toBe("preferred_language_primary_subtag");
    expect(script.reason).toBe(region.reason);
  });

  it("still serves a regional variant when the exact tag is absent", () => {
    const result = selectSubtitleTrack(
      [track({ id: "en-us", language: "en-us" })],
      policy({ preferredLanguages: ["en-gb"] })
    );
    expect(result.selected?.id).toBe("en-us");
    expect(result.reason).toBe("preferred_language_primary_subtag");
  });

  it("matches a bare tag against a regional one in both directions", () => {
    /*
     * The matching rule is SYMMETRIC on the primary subtag, which `startsWith`
     * is not: `startsWith` accepts `pt-BR` for a `pt` preference, rejects `pt`
     * for a `pt-BR` one, and would additionally accept `sventon` for `sv`. Both
     * directions here are VARIANT matches, so neither can beat an exact tag --
     * the tests above pin that half -- but both must be reachable, or a viewer
     * who wrote the broader tag is told their language does not exist.
     */
    const broadPreference = selectSubtitleTrack(
      [track({ id: "pt-br", language: "pt-br" })],
      policy({ preferredLanguages: ["pt"] })
    );
    const narrowPreference = selectSubtitleTrack(
      [track({ id: "sv", language: "sv" })],
      policy({ preferredLanguages: ["sv-fi"] })
    );

    expect(broadPreference.selected?.id).toBe("pt-br");
    expect(broadPreference.reason).toBe("preferred_language_primary_subtag");
    expect(narrowPreference.selected?.id).toBe("sv");
    expect(narrowPreference.reason).toBe("preferred_language_primary_subtag");
  });

  it("treats a UN M.49 region as an ordinary subtag", () => {
    /*
     * `es-419` is Latin American Spanish and its region is three digits rather
     * than two letters. Nothing special-cases that: it matches `es` and `es-ES`
     * as a variant and is exact only against itself, exactly as `es-MX` would
     * be. The trap is an implementation that reads `419` as a country code, or
     * one that compares tag lengths to decide which is "more specific".
     *
     * `es-es` is the provider default here, so the exact case fails if the tag
     * comparison is ever dropped rather than merely reordered.
     */
    const exact = selectSubtitleTrack(
      [
        track({ id: "es-es", language: "es-es", isDefault: true }),
        track({ id: "es-419", language: "es-419" })
      ],
      policy({ preferredLanguages: ["es-419"] })
    );
    const fallback = selectSubtitleTrack(
      [track({ id: "es-es", language: "es-es" })],
      policy({ preferredLanguages: ["es-419"] })
    );

    expect(exact.selected?.id).toBe("es-419");
    expect(exact.reason).toBe("preferred_language_exact");
    expect(fallback.selected?.id).toBe("es-es");
    expect(fallback.reason).toBe("preferred_language_primary_subtag");
  });

  it("normalises case on both sides", () => {
    // The schema's `.transform()` only runs on `.parse()`, and this function
    // takes the TYPE, so a provider adapter constructing a track literal never
    // invokes it. Matching has to fold case itself or "PT-BR" is a language of
    // its own.
    const result = selectSubtitleTrack(
      [track({ id: "pt", language: "PT-BR" })],
      policy({ preferredLanguages: ["pt-br"] })
    );
    expect(result.selected?.id).toBe("pt");
    expect(result.reason).toBe("preferred_language_exact");
  });

  it("says which languages it looked for when none of them exist", () => {
    const result = selectSubtitleTrack(
      [track({ id: "de", language: "de" }), track({ id: "it", language: "it" })],
      policy({ preferredLanguages: ["fr"] })
    );
    expect(result.selected).toBeNull();
    expect(result.reason).toBe("no_preferred_language_available");
    expect(result.explanation).toContain("looked for: fr");
    // Offered, so the viewer can still pick one; just not chosen for them.
    expect(result.ordered.map((t) => t.id)).toEqual(["de", "it"]);
  });

  it("puts no subtitles on screen for a viewer who asked for none", () => {
    // The load-bearing difference from audio selection: there is no
    // "first eligible" fallback, because audio must play something and
    // subtitles must not appear uninvited.
    const result = selectSubtitleTrack(
      [track({ id: "en", isDefault: true })],
      policy({ preferredLanguages: [] })
    );
    expect(result.selected).toBeNull();
    expect(result.reason).toBe("no_preference_expressed");
  });
});

describe("selectSubtitleTrack with a language nobody stated", () => {
  /*
   * `subtitleTrackSchema.language` is `.min(2)`, but this policy takes the TYPE
   * and not parsed output, so an adapter constructing a track literal can hand
   * over `""` -- and the shared `languageTagArb` never generates one, so the
   * property suite cannot reach these cases either. They are the subtitle
   * analogue of PL-0205's rule: an absent language is UNKNOWN, and unknown must
   * not be treated as a value. In particular it must not become a wildcard that
   * matches whatever was asked for, which is what a `startsWith`-style
   * comparator would do with an empty needle.
   */
  it("never matches a track whose language is absent, and still offers it", () => {
    const result = selectSubtitleTrack(
      [track({ id: "blank", language: "" }), track({ id: "de", language: "de" })],
      policy({ preferredLanguages: ["fr"] })
    );
    expect(result.selected).toBeNull();
    expect(result.reason).toBe("no_preferred_language_available");
    // Offered rather than dropped: a viewer can still pick it, and a track that
    // vanished from every list would be invisible to whoever debugs the stream.
    expect(result.ordered.map((t) => t.id).sort()).toEqual(["blank", "de"]);
  });

  it("does not let an absent language stand in for the one the viewer asked for", () => {
    // Every criterion below language favours the blank track -- provider default
    // and WebVTT against SRT -- so this fails if an empty tag ever starts
    // matching rather than merely if the ordering changes.
    const result = selectSubtitleTrack(
      [
        track({ id: "blank", language: "", isDefault: true, format: "webvtt" }),
        track({ id: "fr", language: "fr", format: "srt" })
      ],
      policy({ preferredLanguages: ["fr"] })
    );
    expect(result.selected?.id).toBe("fr");
    expect(result.reason).toBe("preferred_language_exact");
  });

  it("shows no forced track whose language is absent, whatever the audio is", () => {
    // A forced track is keyed to the audio language. One that states no language
    // cannot be shown to belong to this soundtrack, so it is offered and never
    // taken -- the same reading `audioLanguage: null` already gets.
    const result = selectSubtitleTrack(
      [track({ id: "blank-forced", language: "", kind: "forced" })],
      policy({ preferredLanguages: [], audioLanguage: "ja" })
    );
    expect(result.selected).toBeNull();
    expect(result.reason).toBe("no_preference_expressed");
    expect(result.forced.map((t) => t.id)).toEqual(["blank-forced"]);
  });

  it("ignores a blank preference without renumbering the ones around it", () => {
    /*
     * `effectiveLanguages` tests the list with `.some` rather than filtering it,
     * so the indices `languageMatch` reports stay the ones the caller wrote.
     * Filtering would renumber the list; the ORDER would survive, but this pins
     * the property the comment claims rather than the weaker one that happens to
     * follow from it.
     */
    const result = selectSubtitleTrack(
      [track({ id: "de", language: "de" }), track({ id: "fr", language: "fr" })],
      policy({ preferredLanguages: ["", "de", "fr"] })
    );
    expect(result.selected?.id).toBe("de");
    expect(result.reason).toBe("preferred_language_exact");
  });

  it("does not claim to have looked for a blank preference", () => {
    const result = selectSubtitleTrack(
      [track({ id: "de", language: "de" })],
      policy({ preferredLanguages: ["", "fr"] })
    );
    expect(result.explanation).toContain("looked for: fr");
  });
});

describe("selectSubtitleTrack off policy", () => {
  it("selects nothing while still reporting what could be switched on", () => {
    const result = selectSubtitleTrack(
      [track({ id: "en" }), track({ id: "fr", language: "fr" })],
      policy({ mode: "off", preferredLanguages: ["en"] })
    );
    expect(result.selected).toBeNull();
    expect(result.reason).toBe("off_by_viewer_preference");
    expect(result.ordered.map((t) => t.id)).toEqual(["en", "fr"]);
    expect(result.explanation).toContain("2 track(s) available if switched on");
  });

  it("keeps 'you turned these off' distinct from 'there is nothing to turn on'", () => {
    /*
     * The two collapse into one empty screen for the viewer, and a player has to
     * tell them apart: one needs a "no subtitles available for this title"
     * affordance and the other must never see it. Both the reason AND the
     * populated `ordered` list carry the distinction, so it survives a caller
     * that only reads one of them.
     */
    const off = selectSubtitleTrack(
      [track({ id: "en" })],
      policy({ mode: "off", preferredLanguages: ["en"] })
    );
    const nothing = selectSubtitleTrack([], policy({ mode: "off", preferredLanguages: ["en"] }));

    expect(off.selected).toBeNull();
    expect(nothing.selected).toBeNull();
    expect(off.reason).not.toBe(nothing.reason);
    expect(off.reason).toBe("off_by_viewer_preference");
    expect(nothing.reason).toBe("no_subtitle_tracks");
    expect(off.ordered).toHaveLength(1);
    expect(nothing.ordered).toHaveLength(0);
  });

  it("does not suppress a forced narrative track", () => {
    /*
     * The one thing "off" does not switch off. A forced track carries dialogue
     * the soundtrack does not deliver, so withholding it does not give the
     * viewer a cleaner picture -- it gives them a scene in a language they
     * cannot follow with nothing to say anything is missing. Turning subtitles
     * off is a statement about reading full dialogue.
     */
    const result = selectSubtitleTrack(
      [
        track({ id: "en-full", language: "en" }),
        track({ id: "en-forced", language: "en", kind: "forced" })
      ],
      policy({ mode: "off", preferredLanguages: ["en"], audioLanguage: "en" })
    );
    expect(result.selected?.id).toBe("en-forced");
    expect(result.reason).toBe("forced_narrative_with_subtitles_off");
    // The full track is suppressed; only the forced one survives.
    expect(result.ordered.map((t) => t.id)).toEqual(["en-full"]);
  });

  it("suppresses an SDH track while still showing the forced one", () => {
    // SDH is a normal reading track for this purpose, however necessary it is to
    // the viewer who chose it: "off" is their own instruction. Forced is not.
    const result = selectSubtitleTrack(
      [
        track({ id: "en-sdh", language: "en", kind: "sdh" }),
        track({ id: "en-forced", language: "en", kind: "forced" })
      ],
      policy({
        mode: "off",
        hearingImpaired: true,
        preferredLanguages: ["en"],
        audioLanguage: "en"
      })
    );
    expect(result.selected?.id).toBe("en-forced");
  });

  it("shows no forced track that does not belong to the audio in play", () => {
    const result = selectSubtitleTrack(
      [track({ id: "en-forced", language: "en", kind: "forced" })],
      policy({ mode: "off", audioLanguage: "fr" })
    );
    expect(result.selected).toBeNull();
    expect(result.reason).toBe("off_by_viewer_preference");
    // Still returned, so a player can offer it deliberately.
    expect(result.forced.map((t) => t.id)).toEqual(["en-forced"]);
  });
});

describe("selectSubtitleTrack forced policy", () => {
  it("is not merely a high-ranking normal subtitle", () => {
    // A full track in the viewer's language already contains the foreign
    // dialogue the forced track exists for, so it supersedes it. Forced is never
    // in the automatic pool at all, which is what makes that structural rather
    // than a matter of where it happens to rank.
    const result = selectSubtitleTrack(
      [
        track({ id: "en-forced", language: "en", kind: "forced", isDefault: true }),
        track({ id: "en-full", language: "en" })
      ],
      policy({ preferredLanguages: ["en"], audioLanguage: "en" })
    );
    expect(result.selected?.id).toBe("en-full");
    expect(result.reason).toBe("preferred_language_exact");
    expect(result.ordered.map((t) => t.id)).toEqual(["en-full"]);
    expect(result.forced.map((t) => t.id)).toEqual(["en-forced"]);
  });

  it("translates the foreign dialogue for a viewer who asked for no subtitles", () => {
    // The canonical case: Japanese audio with untranslated inserts, a viewer who
    // never turned subtitles on, and a forced track that is part of presenting
    // the film rather than a preference being honoured.
    const result = selectSubtitleTrack(
      [
        track({ id: "en-full", language: "en" }),
        track({ id: "ja-forced", language: "ja", kind: "forced" })
      ],
      policy({ preferredLanguages: [], audioLanguage: "ja" })
    );
    expect(result.selected?.id).toBe("ja-forced");
    expect(result.reason).toBe("forced_narrative_for_audio_language");
  });

  it("applies when nothing in a preferred language exists", () => {
    const result = selectSubtitleTrack(
      [
        track({ id: "de", language: "de" }),
        track({ id: "en-forced", language: "en", kind: "forced" })
      ],
      policy({ preferredLanguages: ["fr"], audioLanguage: "en" })
    );
    expect(result.selected?.id).toBe("en-forced");
    expect(result.reason).toBe("forced_narrative_for_audio_language");
  });

  it("matches the audio language by primary subtag", () => {
    const result = selectSubtitleTrack(
      [track({ id: "pt-forced", language: "pt", kind: "forced" })],
      policy({ preferredLanguages: [], audioLanguage: "pt-br" })
    );
    expect(result.selected?.id).toBe("pt-forced");
    expect(result.reason).toBe("forced_narrative_for_audio_language");
  });

  it("prefers the forced track that exactly matches the audio tag", () => {
    // Ids, provider default and format are all stacked against the winner, so
    // deleting the audio-tag comparison changes the answer.
    const result = selectSubtitleTrack(
      [
        track({ id: "a-en-us", language: "en-us", kind: "forced", isDefault: true }),
        track({ id: "z-en-gb", language: "en-gb", kind: "forced", format: "srt" })
      ],
      policy({ preferredLanguages: [], audioLanguage: "en-gb" })
    );
    expect(result.selected?.id).toBe("z-en-gb");
  });

  it("shows no forced track when the audio language was never established", () => {
    /*
     * `null` is unknown, not a licence to guess. A forced track belongs to a
     * specific soundtrack, and showing the wrong one captions dialogue the
     * viewer already understands while leaving the foreign lines untouched.
     *
     * The reason is the one this whole trail exists for: the viewer's language
     * DOES exist on this stream, just not as something they can read in full.
     */
    const result = selectSubtitleTrack(
      [track({ id: "en-forced", language: "en", kind: "forced" })],
      policy({ preferredLanguages: ["en"], audioLanguage: null })
    );
    expect(result.selected).toBeNull();
    expect(result.reason).toBe("preferred_language_forced_only");
    expect(result.explanation).toContain("not full subtitles");
  });

  it("is never offered as a normal subtitle in the automatic pool", () => {
    const result = selectSubtitleTrack(
      [track({ id: "en-forced", language: "en", kind: "forced" })],
      policy({ preferredLanguages: ["en"], audioLanguage: "en" })
    );
    expect(result.ordered).toEqual([]);
    expect(result.manualOnly).toEqual([]);
    expect(result.forced.map((t) => t.id)).toEqual(["en-forced"]);
  });
});

describe("selectSubtitleTrack provider default policy", () => {
  it("breaks a tie between tracks that already satisfy the viewer", () => {
    // Ids are ordered AGAINST the expected winner, so removing the criterion
    // entirely would change the result rather than being masked by the id
    // tiebreak below it.
    const result = selectSubtitleTrack(
      [track({ id: "aaa", isDefault: false }), track({ id: "zzz", isDefault: true })],
      policy({ preferredLanguages: ["en"] })
    );
    expect(result.selected?.id).toBe("zzz");
  });

  it("never outranks the viewer's language", () => {
    const result = selectSubtitleTrack(
      [
        track({ id: "en", language: "en", isDefault: true }),
        track({ id: "fr", language: "fr" })
      ],
      policy({ preferredLanguages: ["fr"] })
    );
    expect(result.selected?.id).toBe("fr");
  });

  it("never outranks the kind a hearing-impaired viewer needs", () => {
    const result = selectSubtitleTrack(
      [
        track({ id: "plain", kind: "subtitles", isDefault: true }),
        track({ id: "sdh", kind: "sdh" })
      ],
      policy({ preferredLanguages: ["en"], hearingImpaired: true })
    );
    expect(result.selected?.id).toBe("sdh");
  });

  it("does not by itself put subtitles on screen", () => {
    /*
     * A `DEFAULT=YES` in a manifest is frequently just whichever rendition was
     * written first. Letting it switch subtitles on for a viewer who never asked
     * is precisely the silent trade an ordered comparison exists to prevent, so
     * it is consulted only among tracks that already matched a preference.
     */
    const result = selectSubtitleTrack(
      [track({ id: "en-default", isDefault: true })],
      policy({ preferredLanguages: [], audioLanguage: "en" })
    );
    expect(result.selected).toBeNull();
    expect(result.reason).toBe("no_preference_expressed");
  });

  it("cannot switch subtitles on for a viewer who turned them off", () => {
    // The weakest input meeting the strongest one. `isDefault` is the
    // publisher's hint and is consulted only among tracks that have already
    // qualified; `off` is the viewer's own instruction and ends the decision
    // before any pool is consulted at all.
    const result = selectSubtitleTrack(
      [track({ id: "en-default", isDefault: true })],
      policy({ mode: "off", preferredLanguages: ["en"] })
    );
    expect(result.selected).toBeNull();
    expect(result.reason).toBe("off_by_viewer_preference");
  });
});

describe("selectSubtitleTrack SDH and commentary", () => {
  it("gives a hearing-impaired viewer SDH over a plain track in the same language", () => {
    const result = selectSubtitleTrack(
      [track({ id: "plain", kind: "subtitles" }), track({ id: "sdh", kind: "sdh" })],
      policy({ preferredLanguages: ["en"], hearingImpaired: true })
    );
    expect(result.selected?.id).toBe("sdh");
  });

  it("gives a hearing viewer the plain track over SDH in the same language", () => {
    // The extra speaker labels and sound cues are the point of the track for one
    // viewer and clutter for another, which is why kind rank is a function of
    // the viewer rather than a constant.
    const result = selectSubtitleTrack(
      [track({ id: "sdh", kind: "sdh", isDefault: true }), track({ id: "plain" })],
      policy({ preferredLanguages: ["en"] })
    );
    expect(result.selected?.id).toBe("plain");
  });

  it("still selects SDH for a hearing viewer when it is the only track in their language", () => {
    /*
     * The accessibility half of the commentary reasoning. Commentary is removed
     * from automatic selection because nobody wants it by accident; SDH is
     * ordinary subtitles plus cues, and it is frequently the ONLY track a title
     * ships in a language. Treating it like commentary would leave a viewer with
     * nothing and look like "this title has no French subtitles".
     */
    const result = selectSubtitleTrack(
      [
        track({ id: "fr-sdh", language: "fr", kind: "sdh" }),
        track({ id: "en-plain", language: "en" })
      ],
      policy({ preferredLanguages: ["fr"] })
    );
    expect(result.selected?.id).toBe("fr-sdh");
    expect(result.reason).toBe("preferred_language_exact");
    expect(result.manualOnly).toEqual([]);
  });

  it("uses the audio language for a hearing-impaired viewer who stated none", () => {
    /*
     * A derivation, not a guess: a viewer who cannot hear the soundtrack needs it
     * transcribed in the language it is in. The alternative is that an
     * accessibility toggle set without a language yields no subtitles at all,
     * which is a real harm and not one the viewer could diagnose.
     *
     * This is the ONLY place the policy supplies a language nobody stated, and
     * the reason value says so rather than posing as an honoured preference.
     */
    const result = selectSubtitleTrack(
      [
        track({ id: "ja-sdh", language: "ja", kind: "sdh" }),
        track({ id: "en-plain", language: "en" })
      ],
      policy({ preferredLanguages: [], hearingImpaired: true, audioLanguage: "ja" })
    );
    expect(result.selected?.id).toBe("ja-sdh");
    expect(result.reason).toBe("hearing_impaired_audio_language");
    expect(result.explanation).toContain("cannot hear");
  });

  it("says whether the derived language matched exactly or only by subtag", () => {
    /*
     * The derivation is the one place this policy supplies a language nobody
     * stated, which makes it the place where "we transcribed the audio" and "we
     * approximated it" most need telling apart -- the viewer it serves cannot
     * check the result against the soundtrack. Every other honoured path here
     * distinguishes exact from subtag; this one reported a single value for
     * both, so `audioLanguage: "ja"` on a `ja` track and `audioLanguage:
     * "pt-br"` on a bare `pt` track read identically in the trail.
     */
    const exact = selectSubtitleTrack(
      [track({ id: "ja-sdh", language: "ja", kind: "sdh" })],
      policy({ preferredLanguages: [], hearingImpaired: true, audioLanguage: "ja" })
    );
    const subtag = selectSubtitleTrack(
      [track({ id: "pt-sdh", language: "pt", kind: "sdh" })],
      policy({ preferredLanguages: [], hearingImpaired: true, audioLanguage: "pt-br" })
    );

    expect(exact.selected?.id).toBe("ja-sdh");
    expect(exact.reason).toBe("hearing_impaired_audio_language");
    expect(subtag.selected?.id).toBe("pt-sdh");
    expect(subtag.reason).toBe("hearing_impaired_audio_language_primary_subtag");
    expect(subtag.reason).not.toBe(exact.reason);
    // Still says WHY a language was supplied at all, so the split does not cost
    // the derivation its own explanation.
    expect(subtag.explanation).toContain("cannot hear");
    expect(subtag.explanation).toContain("primary subtag");
  });

  it("does not derive a language for a hearing viewer", () => {
    // The pair that pins the derivation to the accessibility setting: identical
    // tracks and audio, and nothing is selected.
    const result = selectSubtitleTrack(
      [
        track({ id: "ja-sdh", language: "ja", kind: "sdh" }),
        track({ id: "en-plain", language: "en" })
      ],
      policy({ preferredLanguages: [], hearingImpaired: false, audioLanguage: "ja" })
    );
    expect(result.selected).toBeNull();
    expect(result.reason).toBe("no_preference_expressed");
  });

  it("derives nothing when the audio language is unknown", () => {
    const result = selectSubtitleTrack(
      [track({ id: "ja-sdh", language: "ja", kind: "sdh" })],
      policy({ preferredLanguages: [], hearingImpaired: true, audioLanguage: null })
    );
    expect(result.selected).toBeNull();
    expect(result.reason).toBe("no_preference_expressed");
  });

  it("never overrides a stated preference with the derived language", () => {
    const result = selectSubtitleTrack(
      [
        track({ id: "ja-sdh", language: "ja", kind: "sdh" }),
        track({ id: "fr-sdh", language: "fr", kind: "sdh" })
      ],
      policy({ preferredLanguages: ["fr"], hearingImpaired: true, audioLanguage: "ja" })
    );
    expect(result.selected?.id).toBe("fr-sdh");
    expect(result.reason).toBe("preferred_language_exact");
  });

  it("never auto-selects commentary, even as the only track in the preferred language", () => {
    // Ranking alone guarantees nothing: language is compared before kind, so a
    // commentary track in the viewer's language would beat everything else, and
    // as the sole eligible track it would necessarily be chosen. Keeping the
    // pools disjoint makes "never auto-selected" a property of the code.
    const result = selectSubtitleTrack(
      [track({ id: "comm", kind: "commentary" })],
      policy({ preferredLanguages: ["en"] })
    );
    expect(result.selected).toBeNull();
    expect(result.reason).toBe("preferred_language_manual_only");
    expect(result.manualOnly.map((t) => t.id)).toEqual(["comm"]);
    expect(result.explanation).toContain("explicit choice");
  });

  it("does not let commentary in the preferred language beat an unmatched plain track", () => {
    // And does not select the unmatched plain track either: putting German
    // subtitles in front of someone who asked for French is not a fallback, it
    // is a different defect.
    const result = selectSubtitleTrack(
      [
        track({ id: "fr-comm", language: "fr", kind: "commentary" }),
        track({ id: "de", language: "de" })
      ],
      policy({ preferredLanguages: ["fr"] })
    );
    expect(result.selected).toBeNull();
    expect(result.manualOnly.map((t) => t.id)).toEqual(["fr-comm"]);
    expect(result.ordered.map((t) => t.id)).toEqual(["de"]);
  });
});

describe("selectSubtitleTrack format ordering", () => {
  it("uses format as a late tiebreak", () => {
    const result = selectSubtitleTrack(
      [track({ id: "a-srt", format: "srt" }), track({ id: "b-vtt", format: "webvtt" })],
      policy({ preferredLanguages: ["en"] })
    );
    expect(result.selected?.id).toBe("b-vtt");
  });

  it("ranks SRT below ASS, not above it", () => {
    // Pins the non-obvious end of the order rather than only its head. SRT
    // carries no positioning at all, so its text lands over burned-in signage;
    // ASS at worst degrades to the same plain text.
    const result = selectSubtitleTrack(
      [track({ id: "a-srt", format: "srt" }), track({ id: "b-ass", format: "ass" })],
      policy({ preferredLanguages: ["en"] })
    );
    expect(result.selected?.id).toBe("b-ass");
  });

  it("never lets format outrank language", () => {
    const result = selectSubtitleTrack(
      [
        track({ id: "en", language: "en", format: "webvtt" }),
        track({ id: "fr", language: "fr", format: "srt" })
      ],
      policy({ preferredLanguages: ["fr"] })
    );
    expect(result.selected?.id).toBe("fr");
  });
});

describe("selectSubtitleTrack whole-result determinism", () => {
  it("returns an identical result when the input order is reversed", () => {
    /*
     * The ENTIRE result, not just `selected`. This reviewer rejected the audio
     * policy twice for order-dependence in fields nobody was asserting on --
     * once `rejected`, once `manualOnly` -- so every list here is sorted by a
     * comparator terminating in a code-point tiebreak on the id, and this
     * asserts the whole object rather than a projection of it.
     */
    const tracks = [
      track({ id: "zz-forced", language: "en", kind: "forced" }),
      track({ id: "aa-commentary", language: "en", kind: "commentary" }),
      track({ id: "mm-sdh", language: "en", kind: "sdh" }),
      track({ id: "bb-plain", language: "en" }),
      track({ id: "yy-unrenderable", language: "en", format: "ass" })
    ];
    const p = policy({
      preferredLanguages: ["en"],
      audioLanguage: "en",
      supportedFormats: ["webvtt"]
    });

    const forward = selectSubtitleTrack(tracks, p);
    const reverse = selectSubtitleTrack([...tracks].reverse(), p);

    expect(reverse).toEqual(forward);
    expect(forward.selected?.id).toBe("bb-plain");
    expect(forward.ordered.map((t) => t.id)).toEqual(["bb-plain", "mm-sdh"]);
    expect(forward.forced.map((t) => t.id)).toEqual(["zz-forced"]);
    expect(forward.manualOnly.map((t) => t.id)).toEqual(["aa-commentary"]);
    expect(forward.rejected).toEqual([
      { trackId: "yy-unrenderable", reason: "unsupported_subtitle_format" }
    ]);
  });

  it("orders rejections by id rather than by provider input order", () => {
    const tracks = [
      track({ id: "zzz", format: "ass" }),
      track({ id: "aaa", format: "srt" }),
      track({ id: "mmm", format: "ttml" })
    ];
    const p = policy({ preferredLanguages: ["en"], supportedFormats: ["webvtt"] });

    const forward = selectSubtitleTrack(tracks, p);
    const reverse = selectSubtitleTrack([...tracks].reverse(), p);

    expect(forward.rejected.map((r) => r.trackId)).toEqual(["aaa", "mmm", "zzz"]);
    expect(reverse.rejected).toEqual(forward.rejected);
  });

  it("orders manual-only tracks by the policy, not by input order", () => {
    const tracks = [
      track({ id: "aa-de", language: "de", kind: "commentary" }),
      track({ id: "zz-fr", language: "fr", kind: "commentary" })
    ];
    const p = policy({ preferredLanguages: ["fr"] });

    const forward = selectSubtitleTrack(tracks, p);
    const reverse = selectSubtitleTrack([...tracks].reverse(), p);

    // The preferred language leads, so the offered order is meaningful rather
    // than alphabetical -- and it is the same either way round.
    expect(forward.manualOnly.map((t) => t.id)).toEqual(["zz-fr", "aa-de"]);
    expect(reverse.manualOnly.map((t) => t.id)).toEqual(forward.manualOnly.map((t) => t.id));
  });

  it("orders forced tracks by fitness for the audio, not by input order", () => {
    const tracks = [
      track({ id: "aa-de", language: "de", kind: "forced" }),
      track({ id: "zz-en", language: "en", kind: "forced" })
    ];
    const p = policy({ audioLanguage: "en" });

    const forward = selectSubtitleTrack(tracks, p);
    const reverse = selectSubtitleTrack([...tracks].reverse(), p);

    expect(forward.forced.map((t) => t.id)).toEqual(["zz-en", "aa-de"]);
    expect(reverse.forced.map((t) => t.id)).toEqual(forward.forced.map((t) => t.id));
  });

  it("breaks a total tie on id so the result never depends on provider ordering", () => {
    const result = selectSubtitleTrack(
      [track({ id: "zzz" }), track({ id: "aaa" })],
      policy({ preferredLanguages: ["en"] })
    );
    expect(result.selected?.id).toBe("aaa");
  });

  it("orders ids by code point rather than host collation", () => {
    // `localeCompare` without an explicit locale uses the host's collation, so
    // the same tracks could order differently on a device with Swedish collation
    // -- which is exactly the property this policy exists to provide.
    const result = selectSubtitleTrack(
      [track({ id: "a" }), track({ id: "B" })],
      policy({ preferredLanguages: ["en"] })
    );
    expect(result.ordered.map((t) => t.id)).toEqual(["B", "a"]);
  });
});

describe("selectSubtitleTrack reason trail", () => {
  it("names every field a debugger would need for a selected track", () => {
    const result = selectSubtitleTrack(
      [track({ id: "fr-sdh", language: "fr", kind: "sdh", format: "ttml" })],
      policy({ preferredLanguages: ["fr"] })
    );
    for (const part of ["fr-sdh", "fr", "sdh", "ttml"]) {
      expect(result.explanation).toContain(part);
    }
    expect(result.explanation).toContain("matched a preferred subtitle language exactly");
  });

  it("prints the language as the matcher saw it, not as the provider wrote it", () => {
    // The schema's `.transform()` never runs for an adapter-constructed literal,
    // so a "PT-BR" track compares as `pt-br` everywhere and used to print as
    // "PT-BR" in the one place a human reads it. Someone debugging why `pt-br`
    // did not match would have been staring at the only rendering of that field
    // that disagreed with the comparison.
    const result = selectSubtitleTrack(
      [track({ id: "pt", language: "PT-BR" })],
      policy({ preferredLanguages: ["pt-br"] })
    );
    expect(result.explanation).toContain("pt (pt-br, subtitles, webvtt)");
    expect(result.explanation).not.toContain("PT-BR");
  });

  it("names the requested languages as the matcher saw them, not as the caller wrote them", () => {
    /*
     * The mirror of the track-side fix above. `languageMatch` compares
     * `want.trim().toLowerCase()`, and this policy takes the TYPE, so a caller
     * can hand over `"PT-BR"` or `" fr"` and have them matched as `pt-br` and
     * `fr`. This line exists for the outcomes where nothing matched, so printing
     * the raw tags made the one sentence telling a reader what we looked for the
     * one sentence disagreeing with what we looked for -- and the obvious
     * conclusion from `PT-BR` beside a `pt-br` track is that the case fold is
     * the bug.
     */
    const result = selectSubtitleTrack(
      [track({ id: "de", language: "de" })],
      policy({ preferredLanguages: ["PT-BR", " fr"] })
    );
    expect(result.reason).toBe("no_preferred_language_available");
    expect(result.explanation).toContain("looked for: pt-br, fr");
    expect(result.explanation).not.toContain("PT-BR");
  });

  it("names the derived audio language the same way, and says it came from the audio", () => {
    const result = selectSubtitleTrack(
      [track({ id: "de", language: "de" })],
      policy({ preferredLanguages: [], hearingImpaired: true, audioLanguage: "PT-BR" })
    );
    expect(result.reason).toBe("no_preferred_language_available");
    expect(result.explanation).toContain("looked for: pt-br (from the audio)");
  });

  it("tells the three empty-screen outcomes apart", () => {
    /*
     * Product invariant 4 in one assertion. All three put nothing on screen and
     * all three need different remedies: turn your setting back on, this title
     * has nothing in your language, this title has your language but only as a
     * forced track. A single "no subtitles" reason would send every one of them
     * to the wrong place.
     */
    const off = selectSubtitleTrack(
      [track({ id: "fr", language: "fr" })],
      policy({ mode: "off", preferredLanguages: ["fr"] })
    );
    const absent = selectSubtitleTrack(
      [track({ id: "de", language: "de" })],
      policy({ preferredLanguages: ["fr"] })
    );
    const forcedOnly = selectSubtitleTrack(
      [track({ id: "fr-forced", language: "fr", kind: "forced" })],
      policy({ preferredLanguages: ["fr"], audioLanguage: null })
    );

    expect(off.reason).toBe("off_by_viewer_preference");
    expect(absent.reason).toBe("no_preferred_language_available");
    expect(forcedOnly.reason).toBe("preferred_language_forced_only");
    expect(new Set([off.reason, absent.reason, forcedOnly.reason]).size).toBe(3);
  });

  it("does not name a language when none was requested", () => {
    // "no subtitle language was requested (no language requested)" says the same
    // thing twice and hides which fact a reader should act on.
    const result = selectSubtitleTrack([track({ id: "en" })], policy({ preferredLanguages: [] }));
    expect(result.explanation).toBe("no subtitle language was requested, so no subtitles were selected");
  });

  it("marks the forced fallback as not being the subtitles that were asked for", () => {
    const result = selectSubtitleTrack(
      [track({ id: "en-forced", language: "en", kind: "forced" })],
      policy({ preferredLanguages: ["fr"], audioLanguage: "en" })
    );
    expect(result.reason).toBe("forced_narrative_for_audio_language");
    expect(result.explanation).toContain("forced narrative track");
  });
});

describe("selectSubtitleTrack outcome classification", () => {
  it("never claims full subtitles without claiming text", () => {
    // The table's two fields are ordered: full subtitles are a kind of text. An
    // entry claiming the second without the first would be unreachable by
    // construction and would still mislead any consumer reading only one field.
    const outcomes = Object.values(SUBTITLE_OUTCOME_BY_REASON);

    // The implication below is vacuously true of an empty table and of one where
    // nothing claims full subtitles, so both are ruled out first. Without these
    // the assertion would keep passing through a table that had lost a reason or
    // had every entry set to false.
    expect(Object.keys(SUBTITLE_OUTCOME_BY_REASON)).toHaveLength(13);
    expect(outcomes.some((outcome) => outcome.showsFullSubtitles)).toBe(true);

    for (const outcome of outcomes) {
      if (outcome.showsFullSubtitles) expect(outcome.showsText).toBe(true);
    }
  });

  it("separates a forced track from the subtitles a viewer asked to read", () => {
    const full = selectSubtitleTrack(
      [track({ id: "fr", language: "fr" })],
      policy({ preferredLanguages: ["fr"] })
    );
    const forced = selectSubtitleTrack(
      [track({ id: "en-forced", language: "en", kind: "forced" })],
      policy({ preferredLanguages: ["fr"], audioLanguage: "en" })
    );

    expect(SUBTITLE_OUTCOME_BY_REASON[full.reason]).toEqual({
      showsText: true,
      showsFullSubtitles: true
    });
    // Text on screen, and not what was asked for. A player reading only
    // `selected !== null` would tell this viewer their French subtitles are
    // working while most of the dialogue goes untitled.
    expect(forced.selected?.id).toBe("en-forced");
    expect(SUBTITLE_OUTCOME_BY_REASON[forced.reason]).toEqual({
      showsText: true,
      showsFullSubtitles: false
    });
  });

  it("is coarser than the reason without replacing it", () => {
    // Both outcomes are "no text", which is the answer a player rendering the
    // screen needs; the reason is still what tells a viewer to turn their
    // setting back on rather than to look for a different title.
    const off = selectSubtitleTrack(
      [track({ id: "en" })],
      policy({ mode: "off", preferredLanguages: ["en"] })
    );
    const none = selectSubtitleTrack([], policy({ preferredLanguages: ["en"] }));

    expect(SUBTITLE_OUTCOME_BY_REASON[off.reason].showsText).toBe(false);
    expect(SUBTITLE_OUTCOME_BY_REASON[none.reason].showsText).toBe(false);
    expect(off.reason).not.toBe(none.reason);
  });
});

describe("withSelectedAudio keys the policy to the audio decision", () => {
  it("takes the language of the track that will play, not the one that was preferred", () => {
    /*
     * The defect this function exists to make unrepresentable. A viewer prefers
     * French audio; no French mix exists, so audio selection serves the Japanese
     * original. Keying forced subtitles to "fr" -- the nearest language-shaped
     * value a caller has to hand -- would hunt a FRENCH forced track over
     * JAPANESE audio: it captions lines the viewer could already follow and
     * leaves untouched the ones they cannot.
     *
     * The French forced track is the provider default and sorts first by id, so
     * it wins or ties every criterion below fitness for the audio. Only the key
     * this function establishes keeps it off screen.
     */
    const audio = selectAudioTrack(
      [audioTrack({ id: "ja-main", language: "ja", role: "original" })],
      audioCaps({ preferredAudioLanguages: ["fr"] })
    );
    expect(audio.selected?.id).toBe("ja-main");

    const coupled = withSelectedAudio(policy({ preferredLanguages: [] }), audio);
    expect(coupled.audioLanguage).toBe("ja");

    const result = selectSubtitleTrack(
      [
        track({ id: "fr-forced", language: "fr", kind: "forced", isDefault: true }),
        track({ id: "ja-forced", language: "ja", kind: "forced" })
      ],
      coupled
    );
    expect(result.selected?.id).toBe("ja-forced");
    expect(result.reason).toBe("forced_narrative_for_audio_language");
  });

  it("leaves the audio language unknown when the audio decision selected nothing", () => {
    /*
     * `no_auto_selectable_tracks`: commentary is playable and never chosen for
     * anyone. Nothing will be heard that a forced track could be keyed to, and
     * `null` is the only honest value -- not the preferred language, and not the
     * language of a track the audio policy deliberately refused.
     *
     * The incoming policy already carries a stale `"en"`, so this pins that the
     * function OVERWRITES rather than merely fills a gap.
     */
    const audio = selectAudioTrack(
      [audioTrack({ id: "comm", language: "en", role: "commentary" })],
      audioCaps({ preferredAudioLanguages: ["en"] })
    );
    expect(audio.selected).toBeNull();
    expect(audio.reason).toBe("no_auto_selectable_tracks");

    const coupled = withSelectedAudio(policy({ audioLanguage: "en" }), audio);
    expect(coupled.audioLanguage).toBeNull();

    const result = selectSubtitleTrack(
      [track({ id: "en-forced", language: "en", kind: "forced" })],
      coupled
    );
    expect(result.selected).toBeNull();
    expect(result.reason).toBe("no_preference_expressed");
  });

  it("treats a chosen track that states no language as unknown, not as blank", () => {
    /*
     * `audioTrackSchema.language` is `.min(2)`, but `selectAudioTrack` takes the
     * TYPE, so an adapter constructing a literal reaches this. An absent tag is
     * UNKNOWN: `""` would be a value the schema forbids, and what it would mean
     * is "a language I cannot name", which is what `null` is for.
     */
    const audio = selectAudioTrack([audioTrack({ id: "blank", language: "" })], audioCaps());
    expect(audio.selected?.id).toBe("blank");
    expect(withSelectedAudio(policy(), audio).audioLanguage).toBeNull();
  });

  it("treats a one-character tag as unknown, because the contract's minimum is two", () => {
    /*
     * The gap an emptiness-only guard leaves. `"e"` is not `""`, so it would be
     * written straight through into a field declared `z.string().min(2)`, and the
     * constructed policy would be one `subtitlePolicySchema` rejects. It is also
     * not a usable language: nothing can be matched against it with any
     * confidence, which is exactly what `null` means here.
     */
    const audio = selectAudioTrack([audioTrack({ id: "short", language: "e" })], audioCaps());
    expect(audio.selected?.id).toBe("short");

    const coupled = withSelectedAudio(policy(), audio);
    expect(coupled.audioLanguage).toBeNull();

    // And the forced branch is therefore off, rather than hunting an "e" track.
    const result = selectSubtitleTrack(
      [track({ id: "e-forced", language: "e", kind: "forced" })],
      coupled
    );
    expect(result.selected).toBeNull();
    expect(result.reason).toBe("no_preference_expressed");
  });

  it("normalises the tag it writes, because it is constructing a contract value", () => {
    // `subtitlePolicySchema` lower-cases this field on `.parse()` and this
    // function never runs the schema. `languageMatch` folds case anyway, so this
    // is about the value being what the contract says it is, not about making
    // the comparison work.
    const audio = selectAudioTrack([audioTrack({ id: "gb", language: "EN-GB" })], audioCaps());
    expect(withSelectedAudio(policy(), audio).audioLanguage).toBe("en-gb");
  });

  it("changes nothing else about the policy", () => {
    // It establishes one fact and has no opinion about the viewer's settings.
    const original = policy({
      mode: "off",
      preferredLanguages: ["fr", "de"],
      hearingImpaired: true,
      supportedFormats: ["webvtt"]
    });
    const audio = selectAudioTrack([audioTrack({ id: "ja", language: "ja" })], audioCaps());

    expect(withSelectedAudio(original, audio)).toEqual({ ...original, audioLanguage: "ja" });
  });
});
