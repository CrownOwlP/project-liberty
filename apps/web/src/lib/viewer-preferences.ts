import {
  NO_MEDIA_PREFERENCES,
  type StoredMediaPreferences
} from "@liberty/contracts/domains/preferences";

import {
  resolveActiveProfileScope,
  resolveRequestContext
} from "./db/request-context";

/* -------------------------------------------------------------------------
 * The active profile's stored media preferences, for a server render
 * (PW-0308)
 *
 * ==========================================================================
 * WHY A LOADER IN `lib/` AND NOT A READ INSIDE `watch-session.ts`
 * ==========================================================================
 *
 * `watch-session.ts` takes its resume point as a PARAMETER and says why in
 * terms: "PASSED IN AS DATA, AND THIS FILE READS NO PROGRESS ITSELF ... its
 * IMPORT GRAPH is unchanged -- reaching the progress store from here would
 * mean importing `lib/continue-watching.ts`, which statically reaches the
 * catalog metadata registry and through it `@liberty/catalog-ingestion`, and
 * this file's own suite asserts what it is allowed to name. A resume point is
 * data; making it an import would have been a dependency."
 *
 * A stored preference is the same kind of fact and takes the same route:
 * loaded here, called by the page, handed down as data. `loadResumePosition`
 * in `lib/continue-watching.ts` is the precedent and this mirrors it,
 * including the shape of its failure handling.
 *
 * ==========================================================================
 * IT RETURNS `stored`, AND AN EARLIER DRAFT OF THIS FILE DID NOT
 * ==========================================================================
 *
 * The first version returned `MediaPreferences` alone, with a comment arguing
 * that the "nobody has chosen" / "chose nothing" distinction "does not matter
 * to the media engine, which is handed an ordered list and treats an empty one
 * as no preference either way". THAT COMMENT WAS WRONG, and the caller it was
 * written for is the one that proves it.
 *
 * Today every viewer's session request carries
 * `CONSERVATIVE_CAPABILITIES.preferredAudioLanguages`, which is `["en"]`. A
 * profile that has never been configured must keep getting that, because
 * changing what an unconfigured viewer is served is not what a settings screen
 * is for. A profile that cleared its lists must get `[]`, because that is the
 * thing it asked for. Both have an empty list in `preferences`, so a caller
 * handed values alone cannot tell the two apart and would have to pick one
 * behaviour for both -- silently re-defaulting a viewer who opted out, or
 * silently changing the product's default for everybody.
 *
 * `storedMediaPreferencesSchema` exists in the contract precisely to carry
 * this, and its own comment names the settings screen as the consumer that
 * needs it. The playback page is the second.
 *
 * ==========================================================================
 * EVERY FAILURE IS "NOT CHOSEN", AND THAT IS A DELIBERATE DIRECTION
 * ==========================================================================
 *
 * No identity system, no active profile, no stored row, an unreachable
 * database, a thrown anything: all of them answer `stored: false` with the
 * neutral value. The alternative would be a playback page that refuses to
 * render because a SETTINGS lookup failed, which trades a working player for a
 * preference.
 *
 * The direction matters and is safe in this one: being wrong here means a
 * viewer gets the player's existing default audio instead of their preferred
 * language. Nothing about rights, authorization or transport is decided by
 * this value -- it is an ordering hint handed to the media engine, and the
 * engine falls back on its own when a preference matches nothing.
 *
 * It is also why the failure answer is `stored: false` rather than
 * `stored: true` with empty lists: a failed read must land on the behaviour
 * the product already had, not on an opt-out the viewer never expressed.
 * ---------------------------------------------------------------------- */

/** What a reader with nothing to report answers. Shared by every failure. */
const NOT_CHOSEN: StoredMediaPreferences = Object.freeze({
  stored: false,
  preferences: NO_MEDIA_PREFERENCES
});

/**
 * What the active profile has chosen, and whether it has chosen at all.
 *
 * Never throws and never refuses: see the header. The caller gets a usable
 * answer in every state this deployment can be in, including having no
 * identity system at all.
 */
export async function loadMediaPreferences(
  requestHeaders: Headers
): Promise<StoredMediaPreferences> {
  try {
    /*
     * A SYNTHESISED REQUEST CARRYING THE PAGE'S OWN HEADERS, exactly as
     * `loadResumePosition` does it. The URL is a placeholder the context
     * resolver does not read -- `.invalid` is reserved by RFC 2606 so it can
     * never be a real host -- and the headers are forwarded whole rather than
     * picked over, so this file holds no second opinion about which header
     * identifies a caller.
     */
    const context = await resolveRequestContext(
      new Request("http://viewer-preferences.invalid/", { headers: requestHeaders })
    );
    if (!context.ok) return NOT_CHOSEN;

    const decision = await resolveActiveProfileScope(context.context);
    if (!decision.allowed) return NOT_CHOSEN;

    return await context.context.repository.readMediaPreferences({
      scope: decision.scope
    });
  } catch {
    return NOT_CHOSEN;
  }
}
