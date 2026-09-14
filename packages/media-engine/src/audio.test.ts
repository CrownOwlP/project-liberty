import { describe, expect, it } from "vitest";
import type { AudioTrack } from "@liberty/contracts/domains/audio";
import type { PlaybackCapabilities } from "@liberty/contracts/domains/playback";
import {
  languageMatch,
  matchesOnlyAcrossMacrolanguage,
  matchesOnlyAcrossScripts,
  normaliseLanguageTag,
  primarySubtag,
  selectAudioTrack,
  spokenLanguage
} from "./audio";

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

  it("normalises before it splits, so padding never becomes part of the language", () => {
    // `" en-gb"` used to reduce to `" en"`, which equals no internally derived
    // tag, so a padded manifest tag matched nothing at all and nothing in the
    // result said why.
    expect(primarySubtag(" EN-GB ")).toBe("en");
    expect(primarySubtag("\tja\n")).toBe("ja");
  });
});

describe("normaliseLanguageTag", () => {
  it("is the one normalisation both sides of every comparison run", () => {
    expect(normaliseLanguageTag("  PT-BR  ")).toBe("pt-br");
    expect(normaliseLanguageTag("pt-br")).toBe("pt-br");
    // Idempotent, which is what lets the trail print through it and still agree
    // with what the matcher compared.
    expect(normaliseLanguageTag(normaliseLanguageTag(" EN-GB "))).toBe("en-gb");
  });
});

describe("languageMatch", () => {
  it("reports an exact match with its position in the preference list", () => {
    expect(languageMatch("fr", ["en", "fr"], "ignore_script")).toEqual({ groupIndex: 1, exactIndex: 1 });
  });

  it("matches on the primary subtag when the region differs", () => {
    expect(languageMatch("en-us", ["en-gb"], "ignore_script")).toEqual({ groupIndex: 0, exactIndex: null });
  });

  it("returns null when the language was not asked for at all", () => {
    expect(languageMatch("de", ["en", "fr"], "ignore_script")).toBeNull();
  });

  it("prefers an earlier exact match over a later one", () => {
    // Ordering is meaningful: the list is preferences, not a set.
    expect(languageMatch("en", ["en", "en-us"], "ignore_script")).toEqual({ groupIndex: 0, exactIndex: 0 });
  });

  it("does not let a later exact match beat an earlier subtag match's position", () => {
    expect(languageMatch("en-gb", ["en", "de"], "ignore_script")).toEqual({ groupIndex: 0, exactIndex: null });
  });

  /*
   * groupIndex and exactIndex are separate because one number cannot carry both
   * facts, and the two failed attempts were mirror images of each other:
   * returning the exact position let an unrequested en-AU beat an explicit
   * en-GB; collapsing everything to the group position let en-GB tie with en-US
   * and win on channels, discarding the viewer's stated order.
   */
  it("keeps the language group and the exact position as separate coordinates", () => {
    expect(languageMatch("en-us", ["en-us", "en-gb"], "ignore_script")).toEqual({ groupIndex: 0, exactIndex: 0 });
    expect(languageMatch("en-gb", ["en-us", "en-gb"], "ignore_script")).toEqual({ groupIndex: 0, exactIndex: 1 });
    expect(languageMatch("en-au", ["en-us", "en-gb"], "ignore_script")).toEqual({ groupIndex: 0, exactIndex: null });
  });

  it("takes the FIRST same-language preference as the group, not the last", () => {
    expect(languageMatch("en-au", ["en-gb", "en-us"], "ignore_script")).toEqual({ groupIndex: 0, exactIndex: null });
  });

  it("ignores blank and whitespace-only preference entries", () => {
    expect(languageMatch("fr", ["", "  ", "fr"], "ignore_script")).toEqual({ groupIndex: 2, exactIndex: 2 });
  });

  it("normalises case on both sides", () => {
    expect(languageMatch("EN-GB", ["en-gb"], "ignore_script")).toEqual({ groupIndex: 0, exactIndex: 0 });
    expect(primarySubtag("EN-GB")).toBe("en");
  });

  it("normalises WHITESPACE on both sides too, not only on the preference side", () => {
    /*
     * The asymmetry this replaces: `want` was trimmed and `trackLanguage` was
     * only lower-cased, so two logically equivalent raw values got different
     * answers depending on which side they arrived on. `"en-gb "` kept its
     * language group and silently lost its EXACT match; `" en"` put the padding
     * inside the primary subtag and matched nothing at all. Both lines below
     * fail against that code -- the first as `exactIndex: null`, the second as
     * `null` -- and neither outcome was visible to a caller.
     */
    expect(languageMatch("en-gb ", ["en-gb"], "ignore_script")).toEqual({ groupIndex: 0, exactIndex: 0 });
    expect(languageMatch(" en", ["en"], "ignore_script")).toEqual({ groupIndex: 0, exactIndex: 0 });
    expect(languageMatch("  EN-GB\t", ["  en-gb  "], "ignore_script")).toEqual({
      groupIndex: 0,
      exactIndex: 0
    });
  });
});

describe("languageMatch and the script rule", () => {
  it("accepts a stated script conflict loosely and refuses it strictly", () => {
    expect(languageMatch("zh-hans", ["zh-hant"], "ignore_script")).toEqual({
      groupIndex: 0,
      exactIndex: null
    });
    expect(languageMatch("zh-hans", ["zh-hant"], "require_compatible_script")).toBeNull();
  });

  it("still matches the SAME script exactly under the strict rule", () => {
    expect(languageMatch("zh-hant", ["zh-hant"], "require_compatible_script")).toEqual({
      groupIndex: 0,
      exactIndex: 0
    });
  });

  it("treats a script stated on only one side as no conflict at all", () => {
    // A bare `zh` preference expressed no script, so it stays broad; and a bare
    // `zh` track never claimed to be the other script, so a viewer who named one
    // is not refused it. Only two STATED, DIFFERING scripts conflict.
    expect(languageMatch("zh-hans", ["zh"], "require_compatible_script")).toEqual({
      groupIndex: 0,
      exactIndex: null
    });
    expect(languageMatch("zh", ["zh-hant"], "require_compatible_script")).toEqual({
      groupIndex: 0,
      exactIndex: null
    });
  });

  it("refuses a PAIR and not a track, so a later compatible preference still matches", () => {
    expect(languageMatch("zh-hans", ["zh-hant", "zh"], "require_compatible_script")).toEqual({
      groupIndex: 1,
      exactIndex: null
    });
  });

  it("does not mistake a REGION for a script, which a positional test would", () => {
    /*
     * `en-GB` and `en-US` differ in their second subtag exactly as `zh-Hant` and
     * `zh-Hans` do; only SHAPE separates the two cases. A script subtag is four
     * letters, a region is two letters or three digits, and a variant of four
     * characters must begin with a digit. A rule reading "the second subtag
     * differs" would break every regional fallback in the package.
     */
    expect(languageMatch("en-us", ["en-gb"], "require_compatible_script")).toEqual({
      groupIndex: 0,
      exactIndex: null
    });
    expect(languageMatch("es-419", ["es-es"], "require_compatible_script")).toEqual({
      groupIndex: 0,
      exactIndex: null
    });
    expect(languageMatch("de-1996", ["de-de"], "require_compatible_script")).toEqual({
      groupIndex: 0,
      exactIndex: null
    });
  });

  it("finds a script behind an extlang, and reads none inside a private-use sequence", () => {
    // BCP-47 allows one extlang before the script (`zh-cmn-Hans-CN`), so a rule
    // reading only the second subtag would miss the conflict. A one-character
    // subtag opens an extension or private-use sequence whose contents are
    // free-form, so a four-letter subtag there states nothing about writing.
    expect(languageMatch("zh-cmn-hans-cn", ["zh-hant"], "require_compatible_script")).toBeNull();
    /*
     * THIS ASSERTION USED TO EXPECT A MATCH, AND PL-0206 IS WHY IT DOES NOT.
     *
     * Under `ignore_script` the script conflict is set aside, and the old rule
     * then reduced both tags to `zh` and called them the same language. They are
     * not: `zh-cmn` is Mandarin and a bare `zh` names the macrolanguage without
     * choosing a variety. The comparator now asks `spokenLanguage`, so this pair
     * no longer matches at all -- and `matchesOnlyAcrossMacrolanguage` is what
     * reports that a Chinese track nevertheless exists.
     *
     * The script half of this test is unchanged, which is the point of keeping
     * both halves here: the extlang offset that lets `scriptSubtag` find `hans`
     * in position 2 is the same offset that lets `spokenLanguage` find `cmn` in
     * position 1, and neither rule was disturbed by the other.
     */
    expect(languageMatch("zh-cmn-hans-cn", ["zh-hant"], "ignore_script")).toBeNull();
    expect(matchesOnlyAcrossMacrolanguage("zh-cmn-hans-cn", ["zh-hant"])).toBe(true);
    expect(languageMatch("zh-x-hant", ["zh-hans"], "require_compatible_script")).toEqual({
      groupIndex: 0,
      exactIndex: null
    });
  });
});

describe("spokenLanguage, and the macrolanguage boundary (PL-0206)", () => {
  it("collapses an extlang toward the specific language, not the macrolanguage", () => {
    // Both spellings of one language agree, which is the half of the acceptance
    // that says cmn and zh-cmn are one language in BOTH directions.
    expect(spokenLanguage("zh-cmn")).toBe("cmn");
    expect(spokenLanguage("cmn")).toBe("cmn");
    expect(spokenLanguage("zh-yue")).toBe("yue");
    expect(spokenLanguage("yue")).toBe("yue");
  });

  it("leaves a bare macrolanguage as itself, because it names no variety", () => {
    // The mirror of the script rule: a tag that states nothing is not in
    // conflict with anything, and inventing a variety for the viewer would be
    // the defect this task removes, pointed the other way.
    expect(spokenLanguage("zh")).toBe("zh");
    expect(spokenLanguage("ar")).toBe("ar");
  });

  it("survives a region or script suffix on either side", () => {
    expect(spokenLanguage("zh-yue-hant-hk")).toBe("yue");
    expect(spokenLanguage("yue-hk")).toBe("yue");
    expect(spokenLanguage("zh-cmn-hans-cn")).toBe("cmn");
  });

  it("does not mistake a region, a script or a variant for an extlang", () => {
    // Shape decides, as it does for scripts: a region is two letters or three
    // DIGITS, a script is four letters, a variant is five to eight or four
    // beginning with a digit. Only three ASCII letters in position 1 is an
    // extlang, and nothing else can take that shape there.
    expect(spokenLanguage("en-gb")).toBe("en");
    expect(spokenLanguage("es-419")).toBe("es");
    expect(spokenLanguage("zh-hant")).toBe("zh");
    expect(spokenLanguage("de-1996")).toBe("de");
    expect(spokenLanguage("en-us-x-abc")).toBe("en");
  });

  it("refuses to call Cantonese a fallback for Mandarin, in both directions", () => {
    // The motivating case. A fallback strength here tells the caller it may play
    // Cantonese for a Mandarin preference.
    expect(languageMatch("zh-yue", ["zh-cmn"], "ignore_script")).toBeNull();
    expect(languageMatch("zh-cmn", ["zh-yue"], "ignore_script")).toBeNull();
    expect(matchesOnlyAcrossMacrolanguage("zh-yue", ["zh-cmn"])).toBe(true);
  });

  it("refuses either variety against a bare macrolanguage preference", () => {
    expect(languageMatch("zh-yue", ["zh"], "ignore_script")).toBeNull();
    expect(languageMatch("zh-cmn", ["zh"], "ignore_script")).toBeNull();
    expect(matchesOnlyAcrossMacrolanguage("zh-yue", ["zh"])).toBe(true);
    // And the other way round: a bare zh track against a variety preference.
    expect(languageMatch("zh", ["zh-cmn"], "ignore_script")).toBeNull();
    expect(matchesOnlyAcrossMacrolanguage("zh", ["zh-cmn"])).toBe(true);
  });

  it("still matches the same language across its two spellings", () => {
    // The equivalence has to hold or the rule has merely broken Chinese.
    expect(languageMatch("zh-cmn", ["cmn"], "ignore_script")).toEqual({
      groupIndex: 0,
      exactIndex: null
    });
    expect(languageMatch("yue-hk", ["zh-yue"], "ignore_script")).toEqual({
      groupIndex: 0,
      exactIndex: null
    });
    // Exactness still means the viewer typed THIS tag, not merely this language.
    expect(languageMatch("zh-yue", ["zh-yue"], "ignore_script")).toEqual({
      groupIndex: 0,
      exactIndex: 0
    });
  });

  it("leaves every language without an extlang exactly as it was", () => {
    // The regression that matters most: this task must not narrow anything but
    // the macrolanguage case.
    expect(languageMatch("en-gb", ["en"], "ignore_script")).toEqual({
      groupIndex: 0,
      exactIndex: null
    });
    expect(languageMatch("en-gb", ["en-us", "en-gb"], "ignore_script")).toEqual({
      groupIndex: 0,
      exactIndex: 1
    });
    expect(languageMatch("fr", ["de", "fr"], "ignore_script")).toEqual({
      groupIndex: 1,
      exactIndex: 1
    });
  });

  it("reports nothing across the boundary when the languages are simply unrelated", () => {
    // Otherwise the new reason would fire for every miss and mean nothing.
    expect(matchesOnlyAcrossMacrolanguage("fr", ["zh-cmn"])).toBe(false);
    expect(matchesOnlyAcrossMacrolanguage("en-gb", ["en-us"])).toBe(false);
  });

  it("only detects the boundary when the prefixed spelling is on one side", () => {
    /*
     * The asymmetry, pinned rather than left to be discovered from a reason code
     * that seemed wrong. `spokenLanguage` treats `cmn` and `zh-cmn` as one
     * language in both directions; this reporter cannot, because it needs a
     * shared MACROLANGUAGE to notice and the only place one appears in a tag is
     * the prefix of the prefixed spelling.
     *
     * So a bare `cmn` track against a bare `zh` preference reports
     * `no_preferred_language_available` rather than the variety reason. That is a
     * reporting gap and not a selection defect -- nothing is selected either way
     * -- and closing it needs a macrolanguage registry, which this package has
     * declined to vendor for scripts on the same reasoning.
     */
    expect(matchesOnlyAcrossMacrolanguage("zh", ["zh-cmn"])).toBe(true);
    expect(matchesOnlyAcrossMacrolanguage("cmn", ["zh"])).toBe(false);
    expect(matchesOnlyAcrossMacrolanguage("yue-hk", ["zh"])).toBe(false);
    // The matcher itself stays symmetric, which is the part that decides things.
    expect(languageMatch("cmn", ["zh"], "ignore_script")).toBeNull();
    expect(languageMatch("zh", ["cmn"], "ignore_script")).toBeNull();
  });

  it("selectAudioTrack takes Mandarin over a better Cantonese track", () => {
    /*
     * Through the CONSUMER, not the helper. The acceptance requires the rule to
     * be exercised where it decides something, because a matcher can be correct
     * while the selection built on it is not.
     *
     * The two-channel Mandarin track has to beat the six-channel Cantonese one,
     * and only the language rule can do that: language is the first key in
     * `compareTracks` and channels is the fifth. Under the old rule both tracks
     * matched `zh-cmn` equally, the language key tied, and six channels won --
     * so this assertion fails against the code this task replaces, which is the
     * only kind of regression worth writing.
     */
    const selection = selectAudioTrack(
      [
        track({ id: "yue", language: "zh-yue", channels: 6 }),
        track({ id: "cmn", language: "cmn", channels: 2 })
      ],
      caps({ preferredAudioLanguages: ["zh-cmn"] })
    );

    expect(selection.selected?.id).toBe("cmn");
    // `cmn` and `zh-cmn` are one language spelled two ways, so this is a subtag
    // match rather than an exact one.
    expect(selection.reason).toBe("preferred_language_primary_subtag");
  });
});

describe("matchesOnlyAcrossScripts", () => {
  it("is true exactly when the loose rule matches and the strict one does not", () => {
    expect(matchesOnlyAcrossScripts("zh-hans", ["zh-hant"])).toBe(true);
    // Compatible, so not "only across scripts".
    expect(matchesOnlyAcrossScripts("zh-hant", ["zh-hant"])).toBe(false);
    expect(matchesOnlyAcrossScripts("zh-hans", ["zh"])).toBe(false);
    expect(matchesOnlyAcrossScripts("zh-hans", ["zh-hant", "zh"])).toBe(false);
    // A region difference is not a script difference.
    expect(matchesOnlyAcrossScripts("en-us", ["en-gb"])).toBe(false);
    // No match at all is not a script problem either, and the two must not be
    // reported the same way: one means "your language is here in another
    // script", the other means "your language is not here".
    expect(matchesOnlyAcrossScripts("de", ["zh-hant"])).toBe(false);
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

  it("respects the viewer's ordering of regional variants", () => {
    /*
     * The mirror of the bug below. Once both variants reported the same group
     * index and both counted as exact, they tied on language -- and a later
     * criterion handed the win to en-GB even though the viewer put en-US first.
     * Channel counts differ here so the tie, if it existed, would be broken the
     * wrong way.
     */
    const result = selectAudioTrack(
      [
        track({ id: "en-gb", language: "en-gb", channels: 8 }),
        track({ id: "en-us", language: "en-us", channels: 2 })
      ],
      caps({ preferredAudioLanguages: ["en-us", "en-gb"] })
    );
    expect(result.selected?.id).toBe("en-us");
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

  it("serves a different SCRIPT of the requested language, unlike subtitle selection", () => {
    /*
     * The deliberate half of the shared comparator, and the one place the two
     * consumers disagree on purpose. `selectSubtitleTrack` refuses this pair
     * because the viewer would have to READ it; audio passes `ignore_script`
     * because a listener who cannot read a script can still hear the language,
     * and because this policy must play something -- refusing here would not
     * produce a careful refusal, it would hand the choice to the UNRELATED
     * Japanese track below, which is strictly worse for the listener.
     *
     * This is what fails if someone later "unifies" the two consumers by making
     * the strict rule universal.
     */
    const result = selectAudioTrack(
      [
        track({ id: "zh-hans", language: "zh-hans" }),
        track({ id: "ja", language: "ja", role: "original" })
      ],
      caps({ preferredAudioLanguages: ["zh-hant"] })
    );
    expect(result.selected?.id).toBe("zh-hans");
    expect(result.reason).toBe("preferred_language_primary_subtag");
  });

  it("still prefers the requested script when a track states it", () => {
    // Channels and the provider default are stacked behind the wrong script, so
    // the exact tag has to be what decides this.
    const result = selectAudioTrack(
      [
        track({ id: "zh-hans", language: "zh-hans", channels: 8, isDefault: true }),
        track({ id: "zh-hant", language: "zh-hant", channels: 2 })
      ],
      caps({ preferredAudioLanguages: ["zh-hant"] })
    );
    expect(result.selected?.id).toBe("zh-hant");
    expect(result.reason).toBe("preferred_language_exact");
  });

  it("matches a padded manifest tag exactly, not merely by primary subtag", () => {
    // `selectAudioTrack` takes the TYPE, so the schema's normalising transform
    // never ran on `"en-gb "`. The track side used not to be trimmed, so this
    // reported `preferred_language_primary_subtag` -- a fallback the viewer was
    // never actually served.
    const result = selectAudioTrack(
      [track({ id: "padded", language: "en-gb " })],
      caps({ preferredAudioLanguages: ["en-gb"] })
    );
    expect(result.selected?.id).toBe("padded");
    expect(result.reason).toBe("preferred_language_exact");
  });

  it("never auto-selects commentary or audio description over a main mix", () => {
    const result = selectAudioTrack(
      [
        track({ id: "commentary", role: "commentary", channels: 8 }),
        track({ id: "described", role: "descriptive", channels: 6 }),
        track({ id: "main", role: "main", channels: 2 })
      ],
      caps({ preferredAudioLanguages: ["en"] })
    );
    expect(result.selected?.id).toBe("main");
    // Outside the automatic pool entirely, not merely ranked below it.
    expect(result.ordered.map((t) => t.id)).toEqual(["main"]);
    // Ordered by the policy, not by provider input order: descriptive outranks
    // commentary, so it is offered first regardless of how they arrived.
    expect(result.manualOnly.map((t) => t.id)).toEqual(["described", "commentary"]);
  });

  it("does not let commentary in the preferred language beat an unmatched main mix", () => {
    /*
     * Ranking alone never guaranteed this. Language is compared BEFORE role, so
     * a French commentary track beat a Japanese original for a viewer who
     * preferred French -- the role penalty was never reached. "Never
     * auto-selected" was a claim in a comment, not a property of the code.
     */
    const result = selectAudioTrack(
      [
        track({ id: "fr-commentary", language: "fr", role: "commentary" }),
        track({ id: "ja-original", language: "ja", role: "original" })
      ],
      caps({ preferredAudioLanguages: ["fr"] })
    );
    expect(result.selected?.id).toBe("ja-original");
    expect(result.manualOnly.map((t) => t.id)).toEqual(["fr-commentary"]);
  });

  it("selects nothing rather than imposing audio description when it is all that plays", () => {
    // The other half of the same defect: if commentary or description were the
    // only eligible tracks, one of them was necessarily chosen.
    const result = selectAudioTrack(
      [
        track({ id: "described", role: "descriptive" }),
        track({ id: "commentary", role: "commentary" })
      ],
      caps({ preferredAudioLanguages: ["en"] })
    );
    expect(result.selected).toBeNull();
    expect(result.reason).toBe("no_auto_selectable_tracks");
    // Still offered, so a viewer who wants them can choose.
    expect(result.manualOnly.map((t) => t.id)).toEqual(["described", "commentary"]);
    expect(result.explanation).toContain("explicit choice");
  });

  it("reports an undecodable commentary track as a codec rejection, not as manual-only", () => {
    // The auto/manual split happens after eligibility, so the reason a track is
    // unavailable stays accurate.
    const result = selectAudioTrack(
      [track({ id: "commentary", role: "commentary", codec: "ac3" })],
      caps()
    );
    expect(result.rejected).toEqual([{ trackId: "commentary", reason: "unsupported_audio_codec" }]);
    expect(result.manualOnly).toEqual([]);
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
    expect(result.manualOnly).toEqual([]);
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

  it("orders manual-only tracks deterministically too", () => {
    // The last field still carrying provider input order. Determinism that
    // holds for three of four fields is not determinism: a player rendering
    // this list would show a different running order for the same stream.
    const tracks = [
      track({ id: "zz-commentary", role: "commentary" }),
      track({ id: "aa-described", role: "descriptive" }),
      track({ id: "main", role: "main" })
    ];
    const capabilities = caps({ preferredAudioLanguages: ["en"] });

    const forward = selectAudioTrack(tracks, capabilities);
    const reverse = selectAudioTrack([...tracks].reverse(), capabilities);

    expect(reverse.manualOnly.map((t) => t.id)).toEqual(forward.manualOnly.map((t) => t.id));
    // Ordered by the policy, so descriptive precedes commentary regardless of id.
    expect(forward.manualOnly.map((t) => t.id)).toEqual(["aa-described", "zz-commentary"]);
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
