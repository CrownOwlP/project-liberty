import {
  MAX_PREFERRED_LANGUAGES,
  NO_MEDIA_PREFERENCES,
  mediaPreferencesSchema,
  type MediaPreferences,
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

/* =========================================================================
 * A VERSIONED, SERIALISABLE PREFERENCE RECORD AND A TOTAL MIGRATION (W132-F)
 * =========================================================================
 *
 * ==========================================================================
 * THE DEFECT CLASS THIS HALF OF THE FILE REMOVES
 * ==========================================================================
 *
 * A STORED PREFERENCE OUTLIVES THE BUILD THAT WROTE IT. This is an installed
 * desktop application: a household's row was written months ago by a version
 * that no longer exists, and nothing upgrades it on the way in. Every shape
 * above is read through `mediaPreferencesSchema`, which is `.strict()` -- a row
 * holding a field a later build removed, or missing one a later build added, is
 * a PARSE FAILURE. Today that failure lands in the `catch` above and degrades
 * to `NOT_CHOSEN`, which is survivable for languages. It is not survivable as a
 * pattern: the moment a consumer does `record.playbackRate * duration` on a
 * shape it assumed, an old row is a `NaN` seek or a thrown property access on
 * `undefined`, on the one screen the viewer came for.
 *
 * So the extension this round adds is not another bare object. It is a record
 * that CARRIES ITS OWN VERSION and is read through a MIGRATION THAT IS TOTAL:
 * every input -- `undefined`, `null`, a number, a string, an array, a JSON blob
 * from a build that no longer exists, a row with one field of the right name
 * and the wrong type -- produces a complete, valid record. There is no input
 * for which the answer is a throw, and there is no partial return.
 *
 * ==========================================================================
 * FIELD-BY-FIELD RECOVERY, NOT ALL-OR-NOTHING
 * ==========================================================================
 *
 * `migrateViewerPreferences` does NOT validate the whole object and fall back
 * wholesale on the first problem, which is what a single `safeParse` would do.
 * It recovers each field independently, because the realistic damage is one
 * field: a build that stored `subtitleMode: "on"` before the vocabulary was
 * closed to `auto | off` should cost that viewer their subtitle mode, not their
 * eight-language audio ranking. Wholesale fallback turns a one-field defect
 * into a full reset, silently, and the viewer's only evidence is that their
 * settings "went back to normal".
 *
 * ==========================================================================
 * WHAT IT IS NOT, AND MAY NOT BECOME
 * ==========================================================================
 *
 * NOT A SECOND PERSISTENCE LAYER. Nothing here reads or writes anything. There
 * is no `localStorage`, no `sessionStorage`, no cookie and no file: this
 * repository forbids browser storage by rule and the tests in
 * `components/auth/auth-ui.test.tsx` and `components/profiles/profile-ui.test.tsx`
 * enforce it. These are PURE FUNCTIONS over a value a caller already holds,
 * and the caller gets that value from the server-side repository port.
 *
 * NOT AN ENTITLEMENT. `preferences.ts` in `@liberty/contracts` states the rule
 * in terms: "A PREFERENCE IS A STATEMENT ABOUT TASTE, NOT A CLAIM ABOUT
 * ENTITLEMENT." Nothing in this record may widen what a viewer may play, reach
 * or decode -- no rating override, no capability claim, no "allow insecure
 * source". A field here is a value a CLIENT SUPPLIES, so a capability-shaped
 * field in it is an attacker-supplied capability. `maxRating` stays on the
 * profile row, set through the profile API, and must not be mirrored here.
 * ---------------------------------------------------------------------- */

/**
 * The version a record written by THIS build carries.
 *
 * AN INTEGER THAT ONLY EVER GOES UP, and a record whose version is unknown --
 * higher than this, negative, fractional, a string, absent -- is migrated by
 * the same field-by-field recovery as any other, rather than refused. A
 * HIGHER version is the realistic case and the one a refusal would handle
 * worst: a household that ran a newer build (a beta, a rollback) has a record
 * from the future, and the honest answer is "keep every field I still
 * understand" rather than "your settings are gone".
 */
export const VIEWER_PREFERENCES_VERSION = 1;

/**
 * How fast playback runs, as a multiplier.
 *
 * ==========================================================================
 * WHY THE BOUNDS ARE HERE AND NOT IN THE PLAYER
 * ==========================================================================
 *
 * This value is handed to `HTMLMediaElement.playbackRate`, and that setter
 * throws `NotSupportedError` for a value outside what the engine supports and
 * silently does nothing useful for `0` (which is not "paused", it is a rate
 * the spec leaves to the implementation) or a negative (no browser plays
 * backwards). A stored `0`, a stored `-1`, a stored `1e9` or a stored `NaN` is
 * therefore a THROW OR A STALL AT THE START OF PLAYBACK, which is the worst
 * place in this product to discover a bad number.
 *
 * The clamp lives beside the migration rather than in the player because the
 * record is where the bad value enters: a player that clamps is a player that
 * has already been handed something invalid, and every other consumer of the
 * same record -- the settings screen showing the value, a rail describing it --
 * would each need their own copy of the rule.
 *
 * 0.25 and 4 are the range every shipping media element accepts; the ladder
 * below is what a control offers. A rate NOT on the ladder is kept if it is in
 * range, because a household that set 1.75 in a build with a finer ladder has
 * expressed something real and a later build narrowing its own menu is not a
 * reason to overwrite it.
 */
export const MIN_PLAYBACK_RATE = 0.25;
export const MAX_PLAYBACK_RATE = 4;
export const DEFAULT_PLAYBACK_RATE = 1;

/** What a rate control offers. Not a validator: see the note above. */
export const PLAYBACK_RATE_LADDER: readonly number[] = Object.freeze([
  0.5, 0.75, 1, 1.25, 1.5, 1.75, 2
]);

/**
 * One profile's preferences, versioned, and serialisable with `JSON.stringify`
 * and nothing else.
 *
 * `media` IS THE CONTRACT'S OWN SHAPE, NOT A COPY OF IT. The languages, the
 * subtitle mode, the hearing-impaired flag and the diagnostics consent are
 * defined in `@liberty/contracts/domains/preferences` and that definition is
 * imported. A second declaration of those five fields here would be a second
 * answer to "which subtitle should play", and the one that drifted would be the
 * one nobody noticed.
 *
 * `playbackRate` IS NEW AND HAS NO STORED COLUMN YET. It is in the record
 * because the record is the shape consumers bind to, and adding it later
 * without a version and a migration is the exact failure this file exists to
 * prevent. Until the persistence column exists, a loaded record carries
 * `DEFAULT_PLAYBACK_RATE` -- which is what the product does today -- so nothing
 * changes behaviour for anybody and the migration path is in place before the
 * data is. The proposed persistence diff is in this round's report.
 */
export interface ViewerPreferencesRecord {
  readonly version: number;
  readonly media: MediaPreferences;
  readonly playbackRate: number;
}

/**
 * What a profile that has expressed nothing looks like, as a record.
 *
 * Built from `NO_MEDIA_PREFERENCES` rather than from literals, so the "neutral
 * value is whatever the product did before preferences existed" rule that
 * contract documents is stated once. In particular `playbackDiagnostics` is
 * `true` there and must stay `true` here: writing `false` would change what
 * every unconfigured profile does.
 */
export const DEFAULT_VIEWER_PREFERENCES: ViewerPreferencesRecord = Object.freeze({
  version: VIEWER_PREFERENCES_VERSION,
  media: NO_MEDIA_PREFERENCES,
  playbackRate: DEFAULT_PLAYBACK_RATE
});

/** A JSON object, or nothing. The only shape anything below will index into. */
function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null) return null;
  /* An array is an object and is NOT a record. A stored `[]` -- which is what a
   * bug that wrote the wrong variable produces -- would otherwise index as a
   * record whose every field is absent and look like a clean default. */
  if (Array.isArray(value)) return null;
  return value as Readonly<Record<string, unknown>>;
}

/**
 * One language list, recovered.
 *
 * ORDER IS PRESERVED AND NOTHING IS SORTED, because the contract says "order is
 * meaningful, not a set". Unusable entries are DROPPED rather than failing the
 * list: the alternative is that one malformed tag from an old build costs the
 * viewer the other seven. The boundary that a viewer TYPES at still refuses --
 * `languageTagSchema` is a refusal there on purpose, so somebody who mistypes
 * is told -- and that is a different job from reading a row nobody is sitting
 * in front of.
 *
 * The cap is applied last and by `slice`, so a stored list longer than the
 * contract's maximum yields the most-preferred `MAX_PREFERRED_LANGUAGES`
 * rather than nothing. Duplicates are removed case-insensitively, keeping the
 * FIRST mention, because that is the one the viewer ranked higher and a second
 * mention cannot mean anything.
 */
function recoverLanguages(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    /* The contract's own shape test, applied rather than re-described. */
    if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(trimmed)) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length === MAX_PREFERRED_LANGUAGES) break;
  }
  return out;
}

/**
 * A rate, recovered and clamped.
 *
 * `Number.isFinite` FIRST AND NOT A TRUTHINESS TEST, because the three values
 * that actually arrive from a damaged record are `NaN`, `Infinity` and `null`,
 * and `NaN` passes every comparison-based guard by failing all of them. A
 * `NaN` reaching `playbackRate` is a player that never starts.
 *
 * AN INFINITY LANDS ON THE DEFAULT, NOT ON A BOUND, and that is a deliberate
 * difference from a merely absurd finite number. Clamping `Infinity` to 4
 * would assert that this viewer asked for quadruple speed; a finite `1e9` is
 * at least a number somebody or something computed, so it clamps. The
 * `Number.isFinite` test draws exactly that line.
 *
 * A STRING IS NOT ACCEPTED, deliberately, even though `Number("1.5")` would
 * work. A stored rate that is a string means something wrote the wrong type,
 * and silently coercing it is how `"1.5x"` becomes `NaN` two builds later. The
 * default is the honest answer.
 */
function recoverPlaybackRate(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_PLAYBACK_RATE;
  if (value < MIN_PLAYBACK_RATE) return MIN_PLAYBACK_RATE;
  if (value > MAX_PLAYBACK_RATE) return MAX_PLAYBACK_RATE;
  return value;
}

/**
 * Turn anything at all into a usable record.
 *
 * TOTAL. There is no input for which this throws and no input for which it
 * returns a partial object: the return always satisfies
 * `mediaPreferencesSchema` in its `media` field and always carries an in-range
 * rate. That is the property `viewer-preferences.test.ts` asserts over a table
 * of hostile inputs rather than over a happy path.
 *
 * IT IGNORES THE VERSION FOR DISPATCH, AND THAT IS DELIBERATE AT VERSION 1.
 * There is exactly one shape in the field, so a `switch (version)` would have
 * one arm and a default that did the same thing -- a branch that has never been
 * executed is a guess about behaviour. The version is carried, returned, and
 * asserted on; when a real second shape exists, the per-field recovery below is
 * where the old spelling is read, and the field comments are where it is named.
 */
export function migrateViewerPreferences(value: unknown): ViewerPreferencesRecord {
  const record = asRecord(value);
  if (record === null) return DEFAULT_VIEWER_PREFERENCES;

  /* A record may hold `media` as a nested object (this shape) or may BE the
   * bare media object (what a build predating this envelope stored, and what
   * `readMediaPreferences` returns today). Both are read, nested first, so an
   * envelope with an empty nested object is not quietly overridden by a
   * same-named field beside it. */
  const nested = asRecord(record["media"]);
  const media = nested ?? record;

  const subtitleMode = media["subtitleMode"];
  const recovered: MediaPreferences = {
    preferredAudioLanguages: recoverLanguages(media["preferredAudioLanguages"]),
    preferredSubtitleLanguages: recoverLanguages(media["preferredSubtitleLanguages"]),
    /* The vocabulary is closed to two values and an unknown one is NOT kept.
     * `subtitlePolicySchema` branches on it, so a third value would reach a
     * policy that has no arm for it. "auto" is the neutral answer the contract
     * names. */
    subtitleMode: subtitleMode === "off" ? "off" : "auto",
    hearingImpaired: media["hearingImpaired"] === true,
    /* `!== false` RATHER THAN `=== true`. The neutral value for this one field
     * is `true` -- the contract says so and says why -- so an absent or
     * damaged value must land on `true`, and only a stored `false` is an
     * opt-out. `=== true` would silently revoke consent for every profile
     * whose record predates the field. */
    playbackDiagnostics: media["playbackDiagnostics"] !== false
  };

  /*
   * THE LAST GATE IS THE CONTRACT ITSELF, so this function cannot be the place
   * a shape the rest of the application refuses gets invented. If the
   * field-by-field recovery above ever produces something
   * `mediaPreferencesSchema` rejects, that is a defect HERE, and the honest
   * answer is the documented neutral record rather than a value the boundary
   * would not have accepted from a client.
   */
  const checked = mediaPreferencesSchema.safeParse(recovered);

  return {
    version: typeof record["version"] === "number" ? record["version"] : VIEWER_PREFERENCES_VERSION,
    media: checked.success ? checked.data : NO_MEDIA_PREFERENCES,
    playbackRate: recoverPlaybackRate(record["playbackRate"])
  };
}

/**
 * The record for what `loadMediaPreferences` answered.
 *
 * THE BRIDGE, AND THE REASON IT IS A SEPARATE FUNCTION. `StoredMediaPreferences`
 * carries `stored`, and that flag is the distinction the whole file above is
 * about: "never chosen" and "chose nothing" are different answers. A record
 * does not carry it, because a record is the VALUES a consumer plays with --
 * so the flag stays on the result of the read and is handed to the settings
 * screen separately, exactly as it is today. Flattening it into the record
 * would destroy the distinction for every consumer at once.
 */
export function recordFromStored(stored: StoredMediaPreferences): ViewerPreferencesRecord {
  return {
    version: VIEWER_PREFERENCES_VERSION,
    media: stored.preferences,
    /* No stored rate yet; see `ViewerPreferencesRecord.playbackRate`. */
    playbackRate: DEFAULT_PLAYBACK_RATE
  };
}

/**
 * The record as a plain JSON value, ready for a persistence port.
 *
 * EXPLICIT RATHER THAN `JSON.parse(JSON.stringify(record))`. A round trip is
 * shorter and would also strip whatever a caller handed in beyond the declared
 * fields -- which is the problem: a consumer that attached something extra
 * would have it silently persisted, and the first anybody would know is a
 * `.strict()` parse failing two builds later. This writes the fields this
 * module declares and nothing else, and the arrays are COPIED so a caller
 * cannot mutate what was serialised after the fact.
 */
export function serialiseViewerPreferences(
  record: ViewerPreferencesRecord
): Record<string, unknown> {
  return {
    version: record.version,
    media: {
      preferredAudioLanguages: [...record.media.preferredAudioLanguages],
      preferredSubtitleLanguages: [...record.media.preferredSubtitleLanguages],
      subtitleMode: record.media.subtitleMode,
      hearingImpaired: record.media.hearingImpaired,
      playbackDiagnostics: record.media.playbackDiagnostics
    },
    playbackRate: record.playbackRate
  };
}
