import { z } from "zod";

import { subtitleModeSchema } from "./subtitles";

/* -------------------------------------------------------------------------
 * What a viewer has chosen, as opposed to what their device can do (PL-0723)
 *
 * ==========================================================================
 * THIS SUPPLIES VALUES TO POLICIES THAT ALREADY EXIST
 * ==========================================================================
 *
 * PW-0308 requires preferred audio and subtitle languages "persisted per
 * profile and consumed as PW-0206's defaults RATHER THAN AS A SECOND POLICY",
 * and the policies are already written:
 *
 *   - `subtitlePolicySchema` in `./subtitles` decides what subtitle track to
 *     show, from `mode`, `preferredLanguages` and `hearingImpaired`;
 *   - `PlaybackCapabilities` in `./playback` carries `preferredAudioLanguages`
 *     and the media engine ranks audio with it;
 *   - `tracks.ts` in `apps/web` takes a `SubtitlePreferences` with exactly
 *     those fields.
 *
 * So this module invents no vocabulary. `subtitleMode` is imported from the
 * schema that owns it rather than re-declared, and the two language fields
 * carry the names and the ordering semantics the existing contracts already
 * document. The moment this file paraphrases one of them instead, the product
 * has two answers to "which subtitle should play" and they will disagree.
 *
 * ==========================================================================
 * THE DISTINCTION THIS FILE EXISTS TO PRESERVE
 * ==========================================================================
 *
 * "NOTHING CHOSEN" AND "AN EMPTY LIST CHOSEN" ARE DIFFERENT, and collapsing
 * them is the easy mistake. A profile that has never opened the settings
 * screen has expressed no opinion, and the player should fall back to whatever
 * it falls back to today. A profile whose viewer deliberately cleared the list
 * has expressed one -- "I do not want you preferring any language for me" --
 * and the player must honour that rather than quietly reinstating a default.
 *
 * The storage layer carries the distinction as the presence or absence of a
 * row. This module carries it as the difference between no preferences object
 * and a preferences object whose arrays are empty. Nothing in either layer may
 * normalise one into the other.
 *
 * ==========================================================================
 * WHAT MAY NOT GO IN HERE, EVER
 * ==========================================================================
 *
 * A PREFERENCE IS A STATEMENT ABOUT TASTE, NOT A CLAIM ABOUT ENTITLEMENT.
 * Nothing in this shape may widen what a viewer is allowed to play, reach or
 * decode: no capability claim, no rights state, no entitlement, no rating
 * override, no "allow insecure sources". Those are decisions the server makes
 * about a request, and a field here is a value a CLIENT SUPPLIES -- so a
 * capability-shaped field in this object is an attacker-supplied capability.
 * `maxRating` lives on the profile row, set through the profile API, for
 * exactly that reason and must not be mirrored here.
 * ---------------------------------------------------------------------- */

/**
 * A BCP-47 language tag, checked for shape rather than for existence.
 *
 * WHY A PATTERN AND NOT A REGISTRY. The IANA subtag registry is a living
 * document with thousands of entries; shipping a copy would make this contract
 * wrong the week after it was written and would refuse a viewer's perfectly
 * valid regional tag because our snapshot was stale. What a boundary can
 * honestly check is SHAPE -- two to three letters, optional subtags of two to
 * eight alphanumerics -- which rejects the things that actually arrive by
 * mistake: an empty string, a sentence, a path, a script tag, an id.
 *
 * It is deliberately a REFUSAL rather than a filter. PL-0723's acceptance
 * requires that an unusable tag is refused at the boundary with a named
 * reason, not silently dropped: a viewer who typed something wrong must be
 * told, not quietly given a list they did not ask for.
 */
export const languageTagSchema = z
  .string()
  .regex(
    /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/,
    "must be a BCP-47 language tag such as en, pt-BR or zh-Hant"
  );

/**
 * How many languages one list may hold.
 *
 * A BOUND RATHER THAN A JUDGEMENT ABOUT MULTILINGUAL HOUSEHOLDS. Eight is far
 * more than any ranked preference list is useful at -- nothing consults the
 * eighth entry if the first seven missed -- and the reason to have a limit at
 * all is that this is a client-supplied array that goes into a database
 * column: unbounded means a single request can store a megabyte per profile.
 */
export const MAX_PREFERRED_LANGUAGES = 8;

const languageListSchema = z
  .array(languageTagSchema)
  .max(MAX_PREFERRED_LANGUAGES)
  /*
   * ORDER IS THE INFORMATION. `subtitlePolicySchema` says it in terms:
   * "Ordered, most-preferred first. Order is meaningful, not a set." So this
   * never sorts and never de-duplicates into a set -- but it does refuse a
   * list containing the same tag twice, because a second mention cannot mean
   * anything and silently removing it would change a list the viewer can see.
   */
  .refine(
    (languages) => new Set(languages.map((tag) => tag.toLowerCase())).size === languages.length,
    { message: "the same language is listed twice; order is meaningful but repetition is not" }
  );

/**
 * One profile's media preferences.
 *
 * `.strict()` like every other request contract here, so a client posting a
 * field this shape does not declare is refused rather than having it ignored.
 * An ignored field is how a caller comes to believe it set something.
 */
export const mediaPreferencesSchema = z
  .object({
    /**
     * Ordered, most-preferred first. Feeds `PlaybackCapabilities.
     * preferredAudioLanguages`, which is what the media engine ranks audio
     * with.
     */
    preferredAudioLanguages: languageListSchema,
    /**
     * Ordered, most-preferred first. Feeds `subtitlePolicySchema.
     * preferredLanguages`.
     */
    preferredSubtitleLanguages: languageListSchema,
    /**
     * Whether subtitles are shown at all when nothing else decides. Imported
     * from `./subtitles` rather than redeclared: there is one definition of
     * what "off" means and it is that one.
     */
    subtitleMode: subtitleModeSchema,
    /**
     * WHICH KIND of subtitle track this viewer needs when subtitles are shown
     * -- not, by itself, whether they are shown. `subtitlePolicySchema` makes
     * the same distinction in the same words, and the exception where it does
     * affect visibility is documented there, not here.
     */
    hearingImpaired: z.boolean(),
    /**
     * Whether this viewer allows playback diagnostics to be reported
     * (PL-0724).
     *
     * `true` IS THE DEFAULT AND THAT IS NOT AN OPINION ABOUT PRIVACY, it is
     * the rule `NO_MEDIA_PREFERENCES` follows for every field here: the
     * neutral value is whatever the product did before preferences existed.
     * `player-surface.tsx` passed `enabled: true` as a literal, so an
     * unconfigured profile must keep getting that. This task changes what a
     * viewer CAN DO, not what happens to a viewer who has done nothing.
     *
     * IT CAN ONLY EVER SUBTRACT. `decidePlaybackTelemetry` tests `!enabled`
     * FIRST and returns `telemetry_disabled` before any other branch, so
     * `false` here is a short-circuit. `true` is not a permission: it only
     * means "do not short-circuit", and every safety refusal below it --
     * `collector_path_not_first_party`, `session_id_not_transmittable`,
     * `content_id_not_transmittable`, `client_key_allowlist_empty` -- still
     * runs and still wins. A viewer may decline; a viewer cannot override a
     * refusal, and the ordering in that function is what makes that
     * structural rather than remembered.
     */
    playbackDiagnostics: z.boolean()
  })
  .strict();

export type MediaPreferences = z.infer<typeof mediaPreferencesSchema>;

/**
 * What a profile that has never expressed an opinion looks like.
 *
 * NOT A DEFAULT THAT GETS STORED. Nothing writes this row. It is what a reader
 * is handed when there are no stored preferences, so every consumer has one
 * shape to handle instead of a null and a shape -- and it is deliberately the
 * NEUTRAL value in every field, so a consumer that forgets to distinguish
 * "unset" from "set to this" degrades to the behaviour the product had before
 * preferences existed rather than to a surprise.
 *
 * `subtitleMode: "auto"` rather than "off" for that reason: auto is what the
 * subtitle policy already does when nobody has said otherwise.
 */
export const NO_MEDIA_PREFERENCES: MediaPreferences = Object.freeze({
  preferredAudioLanguages: Object.freeze([]) as readonly string[] as string[],
  preferredSubtitleLanguages: Object.freeze([]) as readonly string[] as string[],
  subtitleMode: "auto",
  hearingImpaired: false,
  /*
   * `true`, and it is the one field here whose neutral value is not the
   * falsy one. The neutral value is defined as "the behaviour the product
   * had before preferences existed", and that was an unconditional
   * `enabled: true` in `player-surface.tsx`. Writing `false` would make this
   * task change what every unconfigured profile does, which its acceptance
   * forbids in terms.
   */
  playbackDiagnostics: true
});

/**
 * What a reader gets back, with the distinction intact.
 *
 * `stored: false` with the neutral value, or `stored: true` with what the
 * viewer chose. A consumer that only wants values reads `preferences` and is
 * correct; a consumer that needs to know whether anybody has chosen -- the
 * settings screen, which must not show cleared lists as though they were
 * untouched -- reads `stored`.
 */
export const storedMediaPreferencesSchema = z.object({
  stored: z.boolean(),
  preferences: mediaPreferencesSchema
});

export type StoredMediaPreferences = z.infer<typeof storedMediaPreferencesSchema>;

/** Why a preferences write was refused. */
export const mediaPreferencesReasonCodeSchema = z.enum([
  /** The body did not parse, or named a field this shape does not declare. */
  "preferences_malformed",
  /** A language tag was not a language tag. Named separately because it is
   *  the one a viewer can cause by typing, and the one a UI must explain. */
  "language_tag_unusable",
  /** More languages than `MAX_PREFERRED_LANGUAGES`. */
  "too_many_languages",
  /** The same language twice in one list. */
  "language_listed_twice"
]);

export type MediaPreferencesReasonCode = z.infer<typeof mediaPreferencesReasonCodeSchema>;

/**
 * Turn a zod failure into the reason a caller is told.
 *
 * MAPPED RATHER THAN FORWARDED. A zod issue path is an implementation detail
 * of this file's shape and a message is written for a developer; a reason code
 * is part of the API contract. Forwarding the raw issues would make every
 * refinement in this module a breaking change to the wire format.
 */
export function mediaPreferencesReason(error: z.ZodError): MediaPreferencesReasonCode {
  for (const issue of error.issues) {
    if (issue.message.includes("listed twice")) return "language_listed_twice";
    if (issue.code === "too_big") return "too_many_languages";
    if (issue.message.includes("BCP-47")) return "language_tag_unusable";
  }
  return "preferences_malformed";
}
