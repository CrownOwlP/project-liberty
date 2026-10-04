import { type ProfileScope, profileIdFromScope } from "@liberty/auth";
import {
  NO_MEDIA_PREFERENCES,
  type MediaPreferences,
  type StoredMediaPreferences
} from "@liberty/contracts/domains/preferences";
import { eq } from "drizzle-orm";

import type { LibertyDatabase } from "./client";
import { profileMediaPreference } from "./schema";

/* -------------------------------------------------------------------------
 * Reading and writing one profile's media preferences (PL-0723)
 *
 * ==========================================================================
 * THE SCOPE IS A TOKEN, NOT A STRING
 * ==========================================================================
 *
 * Every function here takes a `ProfileScope` and derives the profile id from
 * it, exactly as the progress and watchlist repositories do. The point is that
 * a caller CANNOT pass a profile id: `ProfileScope` is a branded type whose
 * symbol is module-private to `@liberty/auth`, so the only way to have one is
 * to have been through `authorizeProfileAccess`. A repository that took a
 * `profileId: string` would be one SQL query away from serving another
 * household's settings to whoever asked, and no amount of care at the call
 * site would make that unreachable.
 *
 * ==========================================================================
 * ABSENCE IS AN ANSWER, AND IT IS NOT THE SAME ANSWER AS AN EMPTY LIST
 * ==========================================================================
 *
 * PL-0723's acceptance requires that "nothing chosen" is representable and is
 * DIFFERENT from "an empty list chosen". A profile that has never opened the
 * settings screen has expressed no opinion and the player should keep doing
 * whatever it did before; a viewer who deliberately cleared the list has
 * expressed a strong one -- "do not prefer any language for me" -- and the
 * player must honour it rather than quietly reinstating a default.
 *
 * The schema carries that as the presence or absence of a ROW, which is why
 * this is a table rather than four nullable columns. This module carries it as
 * `stored: boolean` beside the values, so a caller that only wants values can
 * read `preferences` and be correct, and a caller that needs to know whether
 * anybody has chosen can ask. Nothing here normalises one into the other.
 *
 * ==========================================================================
 * WHAT THIS MODULE DOES NOT VALIDATE, AND WHY THAT IS RIGHT
 * ==========================================================================
 *
 * It does not check language tags, list lengths or duplicates. Those are the
 * CONTRACT's rules, enforced at the HTTP boundary by `mediaPreferencesSchema`
 * before anything reaches here, and re-implementing them would create a second
 * definition free to drift from the first. What this module does enforce is
 * the thing only it can: that a write lands on the profile the scope names.
 * ---------------------------------------------------------------------- */

/**
 * What this profile has chosen, or the neutral value and `stored: false`.
 *
 * NEVER THROWS FOR AN ABSENT ROW. A profile with no preferences is the normal
 * case -- it is every profile until somebody opens the settings screen -- so
 * absence is data, not an error.
 */
export async function readMediaPreferences(
  db: LibertyDatabase,
  input: { readonly scope: ProfileScope }
): Promise<StoredMediaPreferences> {
  const profileId = profileIdFromScope(input.scope);
  const rows = await db
    .select()
    .from(profileMediaPreference)
    .where(eq(profileMediaPreference.profileId, profileId))
    .limit(1);

  const row = rows[0];
  if (row === undefined) return { stored: false, preferences: NO_MEDIA_PREFERENCES };

  return {
    stored: true,
    preferences: {
      /*
       * COPIED OUT OF THE DRIVER'S ARRAYS rather than handed straight back.
       * `pg` returns a fresh array per row today, but a caller that mutated
       * what it was given would be mutating a result set, and the ordering in
       * these arrays is the only information they carry.
       */
      preferredAudioLanguages: [...row.preferredAudioLanguages],
      preferredSubtitleLanguages: [...row.preferredSubtitleLanguages],
      /*
       * The column is `text` and the contract owns the value set, so a value
       * written by an older build could in principle be one this build does
       * not know. It is returned as-is rather than coerced: the HTTP boundary
       * parses what this returns, so an unknown mode surfaces there as a
       * refusal naming the field, instead of being silently rewritten to
       * "auto" and telling the viewer their choice was honoured.
       */
      subtitleMode: row.subtitleMode as MediaPreferences["subtitleMode"],
      hearingImpaired: row.hearingImpaired,
      playbackDiagnostics: row.playbackDiagnostics
    }
  };
}

/**
 * Replace this profile's preferences, creating the row if there is none.
 *
 * A WHOLE-OBJECT REPLACE RATHER THAN A PATCH, and the settings screen is why.
 * The screen shows every field at once and submits every field at once, so a
 * partial update would be a shape no caller needs and a second way for two
 * concurrent writers to interleave into a state neither chose. `onConflict`
 * makes it one statement, so there is no read-then-write window in which two
 * tabs can both decide the row does not exist.
 *
 * Returns what is now stored, read back from the same statement rather than
 * echoed from the input, so a caller is told what the database has and not
 * what it was asked for.
 */
export async function writeMediaPreferences(
  db: LibertyDatabase,
  input: {
    readonly scope: ProfileScope;
    readonly preferences: MediaPreferences;
    readonly instant: Date;
  }
): Promise<StoredMediaPreferences> {
  const profileId = profileIdFromScope(input.scope);
  const values = {
    profileId,
    preferredAudioLanguages: [...input.preferences.preferredAudioLanguages],
    preferredSubtitleLanguages: [...input.preferences.preferredSubtitleLanguages],
    subtitleMode: input.preferences.subtitleMode,
    hearingImpaired: input.preferences.hearingImpaired,
    playbackDiagnostics: input.preferences.playbackDiagnostics,
    updatedAt: input.instant
  };

  const written = await db
    .insert(profileMediaPreference)
    .values(values)
    .onConflictDoUpdate({
      target: profileMediaPreference.profileId,
      set: {
        preferredAudioLanguages: values.preferredAudioLanguages,
        preferredSubtitleLanguages: values.preferredSubtitleLanguages,
        subtitleMode: values.subtitleMode,
        hearingImpaired: values.hearingImpaired,
        /*
         * NAMED IN THE CONFLICT UPDATE, like every other field (PL-0724).
         * The column has a database DEFAULT for migration 0002's backfill,
         * and a field omitted here would quietly keep its previous value on
         * an upsert -- so a viewer who declined diagnostics and then changed
         * a language would have the decline silently preserved rather than
         * written, which looks identical until the two disagree.
         */
        playbackDiagnostics: values.playbackDiagnostics,
        updatedAt: values.updatedAt
      }
    })
    .returning();

  const row = written[0];
  /*
   * An insert with `onConflictDoUpdate` always returns a row -- the conflict
   * branch updates and returns too -- so an empty result means something this
   * function does not understand happened, and saying so beats returning the
   * input and calling it stored.
   */
  if (row === undefined) {
    throw new Error(
      "writing media preferences returned no row, which an upsert cannot do; the statement did " +
        "not execute as written and nothing should be reported to the viewer as saved"
    );
  }

  return {
    stored: true,
    preferences: {
      preferredAudioLanguages: [...row.preferredAudioLanguages],
      preferredSubtitleLanguages: [...row.preferredSubtitleLanguages],
      subtitleMode: row.subtitleMode as MediaPreferences["subtitleMode"],
      hearingImpaired: row.hearingImpaired,
      playbackDiagnostics: row.playbackDiagnostics
    }
  };
}

/**
 * Forget this profile's preferences entirely.
 *
 * DELETING THE ROW RATHER THAN STORING EMPTY LISTS, because those are the two
 * different answers this module exists to keep apart. "Reset to no opinion" is
 * the absence of a row; "prefer nothing" is a row holding empty lists. A reset
 * that wrote empty lists would take away the viewer's ability to express the
 * second.
 *
 * Idempotent: deleting preferences a profile does not have is not an error,
 * and reporting one would make a second click look like a failure.
 */
export async function forgetMediaPreferences(
  db: LibertyDatabase,
  input: { readonly scope: ProfileScope }
): Promise<void> {
  await db
    .delete(profileMediaPreference)
    .where(eq(profileMediaPreference.profileId, profileIdFromScope(input.scope)));
}
