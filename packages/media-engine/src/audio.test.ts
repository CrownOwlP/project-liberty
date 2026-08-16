import { describe, expect, it } from "vitest";
import type { AudioTrack, PlaybackCapabilities } from "@liberty/contracts";
import { languageMatch, primarySubtag, selectAudioTrack } from "./audio";

const track = (over: Partial<AudioTrack> & { id: string }): AudioTrack => ({
  language: "en",
  codec: "aac",
  channels: 2,
  role: "main",
  isDefault: false,
  ...over
});

const caps = (over: Partial<PlaybackCapabilities> = {}): PlaybackCapabilities => ({
  maxHeight: 2160,
  supportedVideoCodecs: ["h264", "hevc"],
  supportedAudioCodecs: ["aac", "eac3", "opus"],
  preferredAudioLanguages: [],
  ...over
});

describe("primarySubtag", () => {
  it("reduces a region-qualified tag to its language", () => {
    expect(primarySubtag("en-gb")).toBe("en");
    expect(primarySubtag("pt-br")).toBe("pt");
  });

  it("leaves a bare language alone", () => {
    expect(primarySubtag("ja")).toBe("ja");
  });
});

describe("languageMatch", () => {
  it("reports an exact match with its position in the preference list", () => {
    expect(languageMatch("fr", ["en", "fr"])).toEqual({ index: 1, exact: true });
  });

  it("matches on the primary subtag when the region differs", () => {
    expect(languageMatch("en-us", ["en-gb"])).toEqual({ index: 0, exact: false });
  });

  it("returns null when the language was not asked for at all", () => {
    expect(languageMatch("de", ["en", "fr"])).toBeNull();
  });

  it("prefers an earlier exact match over a later one", () => {
    // Ordering is meaningful: the list is preferences, not a set.
    expect(languageMatch("en", ["en", "en-us"])).toEqual({ index: 0, exact: true });
  });

  it("does not let a later exact match beat an earlier subtag match's position", () => {
    // "en-gb" matches preference 0 by subtag; nothing matches exactly, so the
    // position is what carries.
    expect(languageMatch("en-gb", ["en", "de"])).toEqual({ index: 0, exact: false });
  });

  it("reports the GROUP position, so index and exact stay comparable", () => {
    // The regression that mattered: index used to be the exact preference's own
    // position while a subtag match reported the group's, so the two fields
    // measured different things. compareTracks compares index first, which made
    // an unrequested variant beat an explicitly requested one.
    expect(languageMatch("en-gb", ["en-us", "en-gb"])).toEqual({ index: 0, exact: true });
    expect(languageMatch("en-au", ["en-us", "en-gb"])).toEqual({ index: 0, exact: false });
  });

  it("takes the FIRST same-language preference, not the last", () => {
    expect(languageMatch("en-au", ["en-gb", "en-us"])).toEqual({ index: 0, exact: false });
  });

  it("ignores blank and whitespace-only preference entries", () => {
    expect(languageMatch("fr", ["", "  ", "fr"])).toEqual({ index: 2, exact: true });
  });

  it("normalises case on both sides", () => {
    expect(languageMatch("EN-GB", ["en-gb"])).toEqual({ index: 0, exact: true });
    expect(primarySubtag("EN-GB")).toBe("en");
  });
});

describe("selectAudioTrack eligibility", () => {
  it("rejects a codec the device cannot decode", () => {
    const result = selectAudioTrack([track({ id: "a", codec: "ac3" })], caps());
    expect(result.selected).toBeNull();
    expect(result.reason).toBe("no_eligible_tracks");
    expect(result.rejected).toEqual([{ trackId: "a", reason: "unsupported_audio_codec" }]);
  });

  it("rejects more channels than the device declares", () => {
    const result = selectAudioTrack(
      [track({ id: "surround", channels: 6 })],
      caps({ maxAudioChannels: 2 })
    );
    expect(result.rejected).toEqual([{ trackId: "surround", reason: "channels_exceed_capability" }]);
  });

  it("accepts a track that exactly meets the channel limit", () => {
    // Boundary. With `>` mutated to `>=`, a stereo track on a stereo-only
    // device becomes ineligible -- total playback failure on the most common
    // device class -- and every other test in this file still passes.
    const result = selectAudioTrack(
      [track({ id: "stereo", channels: 2 })],
      caps({ maxAudioChannels: 2 })
    );
    expect(result.selected?.id).toBe("stereo");
    expect(result.rejected).toEqual([]);
  });

  it("treats an absent channel capability as unconstrained, not as stereo", () => {
    // A device that never told us its layout must not be silently downmixed.
    const result = selectAudioTrack([track({ id: "surround", channels: 8 })], caps());
    expect(result.selected?.id).toBe("surround");
    expect(result.rejected).toEqual([]);
  });
});

describe("selectAudioTrack ordering", () => {
  it("honours the viewer's language over every technical property", () => {
    const result = selectAudioTrack(
      [
        track({ id: "en-atmos", language: "en", channels: 8, codec: "eac3", isDefault: true }),
        track({ id: "fr-stereo", language: "fr", channels: 2, codec: "aac" })
      ],
      caps({ preferredAudioLanguages: ["fr"] })
    );
    // The English track is better on channels, codec and provider default.
    // None of that may outrank the language the viewer asked for.
    expect(result.selected?.id).toBe("fr-stereo");
    expect(result.reason).toBe("preferred_language_exact");
  });

  it("respects the order of the preference list", () => {
    const result = selectAudioTrack(
      [track({ id: "de", language: "de" }), track({ id: "es", language: "es" })],
      caps({ preferredAudioLanguages: ["es", "de"] })
    );
    expect(result.selected?.id).toBe("es");
  });

  it("prefers an exact region match over a primary-subtag one", () => {
    const result = selectAudioTrack(
      [track({ id: "en-us", language: "en-us" }), track({ id: "en-gb", language: "en-gb" })],
      caps({ preferredAudioLanguages: ["en-gb"] })
    );
    expect(result.selected?.id).toBe("en-gb");
    expect(result.reason).toBe("preferred_language_exact");
  });

  it("serves the requested variant even when it is not first in the list", () => {
    /*
     * The defect this pins: with preferences ["en-us", "en-gb"], the en-GB
     * track scored {index:1, exact:true} while an unrequested en-AU track
     * scored {index:0, exact:false}. index is compared first, so en-AU won --
     * a language the viewer never asked for beating one they explicitly did.
     */
    const result = selectAudioTrack(
      [track({ id: "en-au", language: "en-au" }), track({ id: "en-gb", language: "en-gb" })],
      caps({ preferredAudioLanguages: ["en-us", "en-gb"] })
    );
    expect(result.selected?.id).toBe("en-gb");
    expect(result.reason).toBe("preferred_language_exact");
  });

  it("still serves a region variant when the exact one is absent", () => {
    const result = selectAudioTrack(
      [track({ id: "en-us", language: "en-us" })],
      caps({ preferredAudioLanguages: ["en-gb"] })
    );
    expect(result.selected?.id).toBe("en-us");
    expect(result.reason).toBe("preferred_language_primary_subtag");
  });

  it("never auto-selects commentary or audio description over a main mix", () => {
    // Both would win on channels. Neither may be chosen for someone who did not
    // ask: commentary is jarring, and audio description is a deliberate choice
    // that is a broken experience when imposed on someone who did not make it.
    const result = selectAudioTrack(
      [
        track({ id: "commentary", role: "commentary", channels: 8 }),
        track({ id: "described", role: "descriptive", channels: 6 }),
        track({ id: "main", role: "main", channels: 2 })
      ],
      caps({ preferredAudioLanguages: ["en"] })
    );
    expect(result.selected?.id).toBe("main");
    expect(result.ordered.map((t) => t.id)).toEqual(["main", "described", "commentary"]);
  });

  it("prefers more channels once language and role have tied", () => {
    const result = selectAudioTrack(
      [track({ id: "stereo", channels: 2 }), track({ id: "surround", channels: 6 })],
      caps({ preferredAudioLanguages: ["en"] })
    );
    expect(result.selected?.id).toBe("surround");
  });

  it("consults the provider default only after everything the viewer expressed", () => {
    const result = selectAudioTrack(
      [
        track({ id: "default-stereo", channels: 2, isDefault: true }),
        track({ id: "surround", channels: 6 })
      ],
      caps({ preferredAudioLanguages: ["en"] })
    );
    expect(result.selected?.id).toBe("surround");
  });

  it("does let the provider default decide once everything above it has tied", () => {
    // Ids are ordered AGAINST the expected winner, so deleting the isDefault
    // criterion entirely would change the result. Without that, the previous
    // test alone left the criterion unverified: the id tiebreak below it
    // happened to produce the same answer.
    const result = selectAudioTrack(
      [track({ id: "aaa", isDefault: false }), track({ id: "zzz", isDefault: true })],
      caps({ preferredAudioLanguages: ["en"] })
    );
    expect(result.selected?.id).toBe("zzz");
  });

  it("prefers the original-language track over a main mix when nothing matched", () => {
    // The contract names the original-language track as the correct fallback.
    // With `main` ranked above `original` that outcome was unreachable whenever
    // a main mix existed, and no test paired the two roles directly.
    const result = selectAudioTrack(
      [track({ id: "en-main", language: "en", role: "main" }), track({ id: "ja-orig", language: "ja", role: "original" })],
      caps({ preferredAudioLanguages: ["fr"] })
    );
    expect(result.selected?.id).toBe("ja-orig");
    expect(result.reason).toBe("fallback_original_language");
  });

  it("still prefers a preferred language over the original-language track", () => {
    // Role must never outrank language, in either direction.
    const result = selectAudioTrack(
      [track({ id: "ja-orig", language: "ja", role: "original" }), track({ id: "fr-dub", language: "fr", role: "dub" })],
      caps({ preferredAudioLanguages: ["fr"] })
    );
    expect(result.selected?.id).toBe("fr-dub");
  });

  it("orders codecs by the documented efficiency sequence", () => {
    // Pins the middle of the order, not just its endpoints: eac3's position was
    // asserted only by a comment.
    const result = selectAudioTrack(
      [track({ id: "a-ac3", codec: "ac3" }), track({ id: "b-eac3", codec: "eac3" })],
      caps({ supportedAudioCodecs: ["aac", "ac3", "eac3", "opus"] })
    );
    expect(result.selected?.id).toBe("b-eac3");
  });

  it("uses codec efficiency as a late tiebreak", () => {
    const result = selectAudioTrack(
      [track({ id: "a-aac", codec: "aac" }), track({ id: "b-opus", codec: "opus" })],
      caps()
    );
    expect(result.selected?.id).toBe("b-opus");
  });

  it("is independent of input ordering", () => {
    const tracks = [
      track({ id: "a", language: "fr" }),
      track({ id: "b", language: "en", channels: 6 }),
      track({ id: "c", language: "en", channels: 6, codec: "opus" })
    ];
    const capabilities = caps({ preferredAudioLanguages: ["en"] });

    const forward = selectAudioTrack(tracks, capabilities);
    const reverse = selectAudioTrack([...tracks].reverse(), capabilities);
    expect(reverse.selected).toEqual(forward.selected);
    expect(reverse.ordered.map((t) => t.id)).toEqual(forward.ordered.map((t) => t.id));
  });

  it("breaks a total tie on id so the result never depends on provider ordering", () => {
    const result = selectAudioTrack(
      [track({ id: "zzz" }), track({ id: "aaa" })],
      caps()
    );
    expect(result.selected?.id).toBe("aaa");
  });
});

describe("selectAudioTrack fallback reasons", () => {
  it("distinguishes the original-language fallback", () => {
    const result = selectAudioTrack(
      [track({ id: "ja", language: "ja", role: "original" }), track({ id: "de-dub", language: "de", role: "dub" })],
      caps({ preferredAudioLanguages: ["fr"] })
    );
    expect(result.selected?.id).toBe("ja");
    expect(result.reason).toBe("fallback_original_language");
  });

  it("distinguishes the provider-default fallback", () => {
    const result = selectAudioTrack(
      [track({ id: "de", language: "de", isDefault: true }), track({ id: "it", language: "it" })],
      caps({ preferredAudioLanguages: ["fr"] })
    );
    expect(result.selected?.id).toBe("de");
    expect(result.reason).toBe("fallback_provider_default");
  });

  it("does not credit the provider default for a decision the channels made", () => {
    /*
     * The German track wins on CHANNELS; isDefault is never consulted. Reading
     * the winner's own fields made this report "used the provider's default
     * track", sending anyone debugging it to inspect a manifest flag that
     * played no part. A reason trail that names the wrong cause is worse than
     * none, because it gets believed.
     */
    const result = selectAudioTrack(
      [
        track({ id: "de", language: "de", channels: 8, isDefault: true }),
        track({ id: "it", language: "it", channels: 2 })
      ],
      caps({ preferredAudioLanguages: ["fr"] })
    );
    expect(result.selected?.id).toBe("de");
    expect(result.reason).toBe("fallback_first_eligible");
  });

  it("does not credit a criterion when there was nothing to choose between", () => {
    const result = selectAudioTrack(
      [track({ id: "only", language: "de", isDefault: true })],
      caps({ preferredAudioLanguages: ["fr"] })
    );
    expect(result.reason).toBe("fallback_first_eligible");
  });

  it("reports a plain first-eligible fallback when there is no better signal", () => {
    const result = selectAudioTrack(
      [track({ id: "de", language: "de" }), track({ id: "it", language: "it" })],
      caps({ preferredAudioLanguages: ["fr"] })
    );
    expect(result.reason).toBe("fallback_first_eligible");
  });

  it("reports an exact match rather than a fallback when the preference is met", () => {
    const result = selectAudioTrack(
      [track({ id: "fr", language: "fr" })],
      caps({ preferredAudioLanguages: ["fr"] })
    );
    expect(result.reason).toBe("preferred_language_exact");
  });

  it("falls back rather than failing when no preference was expressed", () => {
    const result = selectAudioTrack([track({ id: "en" })], caps({ preferredAudioLanguages: [] }));
    expect(result.selected?.id).toBe("en");
    expect(result.reason).toBe("fallback_first_eligible");
  });

  it("explains the choice well enough to debug a surprising one", () => {
    const result = selectAudioTrack(
      [track({ id: "fr-51", language: "fr", channels: 6, codec: "eac3" })],
      caps({ preferredAudioLanguages: ["fr"] })
    );
    expect(result.explanation).toContain("fr-51");
    expect(result.explanation).toContain("6ch");
    expect(result.explanation).toContain("matched a preferred language exactly");
  });

  it("says why nothing was selected", () => {
    const result = selectAudioTrack([track({ id: "a", codec: "ac3" })], caps());
    expect(result.reason).toBe("no_eligible_tracks");
    expect(result.explanation).toContain("codec and channel capabilities");
    expect(result.ordered).toEqual([]);
  });

  it("distinguishes no tracks offered from no track playable", () => {
    // A manifest with no audio is a provider defect; a manifest whose tracks
    // the device cannot decode is a capability limit. Reporting the first as
    // the second sends whoever debugs it to the wrong system.
    const result = selectAudioTrack([], caps());
    expect(result.reason).toBe("no_audio_tracks");
    expect(result.explanation).toContain("no audio tracks at all");
  });

  it("names every field a debugger would need in the explanation", () => {
    const result = selectAudioTrack(
      [track({ id: "fr-51", language: "fr", role: "dub", channels: 6, codec: "eac3" })],
      caps({ preferredAudioLanguages: ["fr"] })
    );
    for (const part of ["fr-51", "fr", "dub", "6ch", "eac3"]) {
      expect(result.explanation).toContain(part);
    }
  });
});

describe("selectAudioTrack whole-result determinism", () => {
  it("orders rejections by id, so the entire result is input-order invariant", () => {
    // `selected` and `ordered` were already deterministic; `rejected` was left
    // in provider order, which made the order-invariance claim false for the
    // AudioSelection as a whole.
    const tracks = [
      track({ id: "zzz", codec: "ac3" }),
      track({ id: "aaa", codec: "ac3" }),
      track({ id: "mmm", channels: 8 })
    ];
    const capabilities = caps({ maxAudioChannels: 2 });

    const forward = selectAudioTrack(tracks, capabilities);
    const reverse = selectAudioTrack([...tracks].reverse(), capabilities);

    expect(forward.rejected.map((r) => r.trackId)).toEqual(["aaa", "mmm", "zzz"]);
    expect(reverse.rejected).toEqual(forward.rejected);
  });

  it("orders ids by code point rather than host collation", () => {
    // localeCompare without an explicit locale uses the host's collation, so
    // the same tracks could order differently on different devices -- which is
    // exactly the property this task exists to provide.
    const result = selectAudioTrack(
      [track({ id: "a" }), track({ id: "B" })],
      caps()
    );
    expect(result.ordered.map((t) => t.id)).toEqual(["B", "a"]);
  });
});
