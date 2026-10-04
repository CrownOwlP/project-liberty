/* -------------------------------------------------------------------------
 * What a profile's media preferences are allowed to be (PL-0723).
 *
 * The boundary, tested as a boundary: what it accepts, what it refuses, and
 * what reason it gives for refusing. The storage layer and the API handler
 * both depend on this shape being the only definition of a valid preference,
 * so everything they are allowed to assume is asserted here.
 * ---------------------------------------------------------------------- */
import { describe, expect, it } from "vitest";

import {
  MAX_PREFERRED_LANGUAGES,
  NO_MEDIA_PREFERENCES,
  languageTagSchema,
  mediaPreferencesReason,
  mediaPreferencesSchema
} from "./preferences";
import { subtitleModeSchema } from "./subtitles";

function preferences(over: Record<string, unknown> = {}) {
  return {
    preferredAudioLanguages: ["en"],
    preferredSubtitleLanguages: ["en"],
    subtitleMode: "auto",
    hearingImpaired: false,
    playbackDiagnostics: true,
    ...over
  };
}

describe("what counts as a language tag", () => {
  it("accepts the shapes real viewers actually have", () => {
    for (const tag of ["en", "fr", "pt-BR", "zh-Hant", "en-GB", "gsw", "sr-Latn-RS"]) {
      expect(languageTagSchema.safeParse(tag).success, tag).toBe(true);
    }
  });

  it("REFUSES THE THINGS THAT ARRIVE BY MISTAKE", () => {
    /* Each of these is something that has plausibly been posted at a language
     * field somewhere: a blank, a sentence, a path, markup, an id. */
    for (const tag of ["", " ", "english please", "../../etc/passwd", "<script>", "123", "e"]) {
      expect(languageTagSchema.safeParse(tag).success, JSON.stringify(tag)).toBe(false);
    }
  });

  it("checks SHAPE and does not pretend to know the registry", () => {
    /*
     * `qq` is not an assigned language. This accepts it, deliberately: the
     * IANA registry is a living document and a snapshot of it in this file
     * would start refusing valid regional tags the week after it was written.
     * Stated as a test so the limit is a decision rather than a gap somebody
     * discovers.
     */
    expect(languageTagSchema.safeParse("qq").success).toBe(true);
  });
});

describe("the preferences object", () => {
  it("accepts a filled-in set", () => {
    const parsed = mediaPreferencesSchema.safeParse(
      preferences({ preferredAudioLanguages: ["ja", "en"], hearingImpaired: true })
    );
    expect(parsed.success).toBe(true);
  });

  it("PRESERVES ORDER, WHICH IS THE ONLY INFORMATION THE LIST CARRIES", () => {
    /* `subtitlePolicySchema` says it in terms: "Ordered, most-preferred
     * first. Order is meaningful, not a set." A schema that sorted would
     * silently turn a viewer's first choice into their second. */
    const parsed = mediaPreferencesSchema.parse(
      preferences({ preferredAudioLanguages: ["ja", "de", "en"] })
    );
    expect(parsed.preferredAudioLanguages).toEqual(["ja", "de", "en"]);
  });

  it("accepts EMPTY lists, because clearing one is a choice", () => {
    /* "I do not want you preferring any language for me" is a position, and a
     * schema that refused it would make it unexpressible. The difference
     * between this and never having chosen is carried by the storage layer,
     * not by this shape. */
    const parsed = mediaPreferencesSchema.safeParse(
      preferences({ preferredAudioLanguages: [], preferredSubtitleLanguages: [] })
    );
    expect(parsed.success).toBe(true);
  });

  it("refuses the same language twice, with its own reason", () => {
    const parsed = mediaPreferencesSchema.safeParse(
      preferences({ preferredAudioLanguages: ["en", "fr", "EN"] })
    );
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(mediaPreferencesReason(parsed.error)).toBe("language_listed_twice");
  });

  it("refuses more languages than the bound, with its own reason", () => {
    const tooMany = ["en", "fr", "de", "es", "it", "ja", "ko", "nl", "pt"];
    expect(tooMany.length).toBeGreaterThan(MAX_PREFERRED_LANGUAGES);
    const parsed = mediaPreferencesSchema.safeParse(
      preferences({ preferredSubtitleLanguages: tooMany })
    );
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(mediaPreferencesReason(parsed.error)).toBe("too_many_languages");
  });

  it("names an unusable tag separately, because a viewer can cause it by typing", () => {
    const parsed = mediaPreferencesSchema.safeParse(
      preferences({ preferredAudioLanguages: ["english"] })
    );
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(mediaPreferencesReason(parsed.error)).toBe("language_tag_unusable");
  });

  it("IS STRICT, so a field it does not declare is refused rather than ignored", () => {
    /*
     * The security-relevant one. An ignored field is how a caller comes to
     * believe it set something -- and this object is client-supplied, so a
     * silently-accepted `maxRating` or `allowInsecureSources` would be a
     * capability a client nominated for itself.
     */
    for (const extra of [
      { maxRating: "18" },
      { allowInsecureSources: true },
      { profileId: "someone-else" },
      { entitlements: ["everything"] }
    ]) {
      const parsed = mediaPreferencesSchema.safeParse(preferences(extra));
      expect(parsed.success, JSON.stringify(extra)).toBe(false);
      if (parsed.success) continue;
      expect(mediaPreferencesReason(parsed.error)).toBe("preferences_malformed");
    }
  });

  it("requires every field, so a partial write cannot half-set a profile", () => {
    const { subtitleMode: _omitted, ...partial } = preferences();
    expect(mediaPreferencesSchema.safeParse(partial).success).toBe(false);
  });

  it("takes subtitleMode from the schema that OWNS it", () => {
    /* Not a copy of the enum. If `./subtitles` ever grows a third mode, this
     * accepts it without an edit -- and if it did not, the product would have
     * two answers to what "off" means. */
    for (const mode of subtitleModeSchema.options) {
      expect(mediaPreferencesSchema.safeParse(preferences({ subtitleMode: mode })).success).toBe(
        true
      );
    }
    expect(mediaPreferencesSchema.safeParse(preferences({ subtitleMode: "always" })).success).toBe(
      false
    );
  });
});

describe("the value a profile that has chosen nothing is handed", () => {
  it("IS NEUTRAL IN EVERY FIELD, so forgetting the distinction degrades safely", () => {
    /*
     * A consumer that fails to tell "unset" from "set to this" should land on
     * the behaviour the product had before preferences existed, not on a
     * surprise. `auto` is what the subtitle policy already does when nobody
     * has said otherwise.
     */
    expect(NO_MEDIA_PREFERENCES).toEqual({
      preferredAudioLanguages: [],
      preferredSubtitleLanguages: [],
      subtitleMode: "auto",
      hearingImpaired: false,
      /*
       * `true`, AND IT IS THE EXCEPTION THAT PROVES THE RULE (PL-0724). Every
       * other field here is the falsy or empty value, and it would be easy to
       * read "neutral" as "off". It does not mean off: it means the behaviour
       * the product had before preferences existed, and for diagnostics that
       * was `player-surface.tsx` passing `enabled: true` as a literal. A
       * `false` here would make adding a SETTING change what every profile
       * that never opened it does.
       */
      playbackDiagnostics: true
    });
  });

  it("declines nothing on its own, which is what makes it the pre-preferences behaviour", () => {
    /*
     * Stated as its own case because the assertion above compares a whole
     * object and a reader skimming it could take the `true` for a typo. The
     * neutral value must not DECLINE anything: a viewer who has never opened
     * the settings screen has not opted out of diagnostics, and treating
     * silence as an opt-out would be this task inventing a decision on their
     * behalf in the opposite direction from the one it is accused of.
     */
    expect(NO_MEDIA_PREFERENCES.playbackDiagnostics).toBe(true);
  });

  it("is itself a valid preferences object", () => {
    expect(mediaPreferencesSchema.safeParse(NO_MEDIA_PREFERENCES).success).toBe(true);
  });

  it("is frozen, so one reader cannot change what the next one is handed", () => {
    expect(Object.isFrozen(NO_MEDIA_PREFERENCES)).toBe(true);
  });
});
