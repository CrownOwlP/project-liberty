/* -------------------------------------------------------------------------
 * What a profile may be called, and how many of them there may be (PL-0402)
 *
 * The pure half of `createProfile`, split out for the same reason
 * `writer-epoch.ts` is split out of `progress-repository.ts`: the rules below
 * are decidable from stated facts, so they can be tested without PostgreSQL,
 * and the repository is left holding only the statement it issues.
 *
 * PURE. No clock, no I/O, no ambient state. The caller supplies the current
 * profile count; this module does not go and look.
 *
 * Two defects are prevented here, and they are unrelated to each other except
 * that both are reachable by an ordinary authenticated user:
 *
 *   1. AN UNBOUNDED CHILD-RECORD COUNT. One account, a loop, and the `profile`
 *      table grows without limit -- and every profile is a cascade root for
 *      `playback_progress` and `watchlist_entry`, so the growth is not linear in
 *      what the attacker sends.
 *   2. A DISPLAY NAME THAT IS NOT A NAME. `display_name` is `text NOT NULL`, so
 *      PostgreSQL accepts `""`, `"   "` and a zero-width space just as readily
 *      as "Dad" -- and the picker renders all four as an unlabelled tile.
 * ---------------------------------------------------------------------- */

/**
 * The ceiling on profiles per account.
 *
 * A NUMBER, NOT A `null`. `heartbeat.ts` ships `heartbeatSeconds: null` and
 * refuses rather than invent a product number, and that is right there because
 * an undecided heartbeat interval costs granularity and nothing else. This is
 * the opposite case: an undecided ceiling is not a degraded feature, it is an
 * open availability hole that an authenticated user can walk through today, and
 * refusing ALL profile creation until somebody picks a number would make the
 * product unusable rather than cautious. "Unknown" is not a bound.
 *
 * WHY FIVE. It is a household ceiling, not a product tier and not a quota to be
 * sold. The requirement it has to satisfy is "comfortably more than the people
 * who share one television, and far below any number at which the cascade
 * matters", and five satisfies it with room to spare. The value being
 * defensible matters much less than its EXISTING: raising it is one edit to one
 * constant, whereas discovering the absence of a bound after a household has
 * ten thousand profiles is a data-repair job.
 *
 * It is deliberately not a per-account column. A limit that varies per account
 * is an entitlement, entitlements need an administrative surface to set them,
 * and that surface is the thing an attacker would go for instead.
 */
export const MAX_PROFILES_PER_ACCOUNT = 5;

/**
 * The longest a display name may be, counted in CODE POINTS.
 *
 * Not UTF-16 units: `[...name].length` counts an emoji or an astral character
 * once, where `name.length` counts it twice and would refuse a legitimate name
 * at half the stated limit. Not graphemes either -- `Intl.Segmenter` would count
 * a family emoji as one, which is more correct and is more machinery than a
 * length cap is worth.
 *
 * The cap exists because `text` in PostgreSQL is unbounded, and an unbounded
 * caller-supplied string on a row an authenticated user can create as many of as
 * the ceiling above allows is the same availability concern as the count, just
 * measured along the other axis.
 */
export const MAX_DISPLAY_NAME_CODE_POINTS = 64;

/**
 * The order the checks run in, which is also their PRECEDENCE.
 *
 * Exported and asserted by test, for the same reason as
 * `PROFILE_ACCESS_CHECK_ORDER` in `@liberty/auth`: more than one of these can be
 * true at once and which one is REPORTED must be a stated policy rather than an
 * artefact of statement order.
 *
 * The ceiling is reported first even though it is the least specific complaint,
 * because it is the only one the caller cannot fix by editing the form. Telling
 * somebody at the limit that their name is blank sends them to correct a field
 * on a request that was never going to be accepted.
 */
export const PROFILE_CREATION_CHECK_ORDER = [
  "profile_limit_reached",
  "display_name_is_blank",
  "display_name_too_long"
] as const;

export type ProfileCreationRefusalReason = (typeof PROFILE_CREATION_CHECK_ORDER)[number];

export interface ProfileCreationRefusal {
  readonly ok: false;
  readonly reason: ProfileCreationRefusalReason;
  /** Never empty. A refusal whose detail is blank explains as little as one with no reason at all. */
  readonly detail: string;
}

/**
 * The values that will actually be written.
 *
 * The resolver returns the NORMALISED fields rather than merely approving the
 * input, so the repository cannot write one spelling while this module approved
 * another. A validator that returns a boolean is a validator whose result the
 * caller is free to ignore.
 */
export interface ProfileCreationAccepted {
  readonly ok: true;
  readonly displayName: string;
  readonly avatarKey: string | null;
  readonly maxRating: string | null;
}

export type ProfileCreationResolution = ProfileCreationAccepted | ProfileCreationRefusal;

/**
 * Characters that occupy no visual space and are not part of any name.
 *
 * `Cc` is the control characters; `Cf` is the format characters, which is where
 * Unicode files the zero-width space (U+200B), the left-to-right mark, and the
 * byte order mark. They matter because U+200B is NOT matched by `\s` -- it was
 * reclassified out of the whitespace category -- so a name made entirely of them
 * survives `.trim()` intact and reaches the picker as a tile with nothing on it.
 *
 * THEY ARE NOT REPLACED WITH THE SAME THING, and the difference matters. A
 * control character is a separator in disguise -- a newline or a tab pasted out
 * of another application sits BETWEEN two words -- so it becomes a space and is
 * then collapsed with its neighbours. Deleting it instead would turn
 * "Dad\nJunior" into "DadJunior", silently joining two words the account holder
 * kept apart. A format character genuinely occupies no space and is deleted.
 */
const CONTROL = /\p{Cc}/gu;
const FORMAT = /\p{Cf}/gu;

/**
 * The one format character that is kept.
 *
 * U+200D ZERO WIDTH JOINER is `Cf` like the rest, and stripping it would take a
 * family emoji apart into its component people mid-name. It is preserved and
 * then treated as invisible for the blankness test below, so it can appear in a
 * name without being able to CONSTITUTE one.
 *
 * Built from its CODE POINT rather than typed as itself, here and in the
 * pattern below. A literal zero-width joiner in source is invisible in every
 * diff and every review, which is a poor property for the one exception in a
 * security-adjacent filter -- and it is the kind of character an editor is
 * liable to normalise away on save without anybody noticing the rule changed.
 */
const ZERO_WIDTH_JOINER = String.fromCodePoint(0x200d);

/**
 * Everything a viewer would NOT see, for the blankness test.
 *
 * Constructed rather than written as a regex literal for the reason above; the
 * joiner has to appear inside a character class and there is no way to put it
 * there literally without putting an invisible character in the source.
 */
const WHITESPACE_OR_JOINER = new RegExp(`[\\s${ZERO_WIDTH_JOINER}]`, "gu");

/**
 * Reduce a submitted display name to its canonical form, or to `null` if it is
 * not a name at all.
 *
 * `null` rather than `""`, and never a fabricated "Profile 1": an empty string
 * is a value that claims the name is the empty string, and an invented default
 * claims a name the account holder did not choose. Both are the same defect --
 * an unknown stored as though it were known -- and the caller decides what to do
 * about it. `resolveProfileCreation` below turns it into a refusal, because
 * `profile.display_name` is `NOT NULL` and a viewer profile with no label is
 * unselectable in the only interface that selects one.
 *
 * THREE NORMALISATIONS, EACH PREVENTING A DIFFERENT DEFECT:
 *
 *   - NFC, so that a name typed with a combining accent and the same name typed
 *     with a precomposed character are one name. Without it
 *     `UNIQUE (user_id, display_name)` compares two byte sequences that render
 *     identically and permits both, which defeats the constraint's whole stated
 *     purpose of keeping the picker unambiguous.
 *   - Invisible characters removed, so blankness can be decided at all.
 *   - Internal whitespace runs collapsed and the ends trimmed, so `"Dad"` and
 *     `"Dad "` are also one name, for the same uniqueness reason. This is a live
 *     hole today: the constraint is on the raw column, so a second "Dad " is
 *     accepted and is indistinguishable from the first on screen.
 */
export function normalizeDisplayName(value: string): string | null {
  const stripped = value
    .normalize("NFC")
    .replace(CONTROL, " ")
    .replace(FORMAT, (character) => (character === ZERO_WIDTH_JOINER ? character : ""));
  const collapsed = stripped.replace(/\s+/gu, " ").trim();
  // Blankness is decided on what is LEFT once everything invisible is removed,
  // not on `collapsed === ""`. A name of nothing but joiners survives the trim
  // as a non-empty string and would otherwise be stored as a nameless tile.
  return collapsed.replace(WHITESPACE_OR_JOINER, "") === "" ? null : collapsed;
}

/**
 * Reduce an optional profile field to a value or to `null`.
 *
 * `avatarKey` and `maxRating` are already nullable in the schema, and their
 * `null` means something specific -- "no avatar chosen", "unrestricted". A `""`
 * arriving from an untouched form field is neither of those: it is a third state
 * that means the same thing as `null` and does not compare equal to it, so
 * `avatarKey IS NULL` stops finding the profiles that have no avatar. Collapsing
 * blank to `null` here keeps the column's vocabulary to the two values its
 * comments claim it has.
 *
 * No NFC and no format-character stripping, unlike a display name: these are
 * OPAQUE KEYS, not human text, and silently rewriting the bytes of a storage key
 * would make it fail to resolve for reasons nothing logs.
 */
export function normalizeOptionalField(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export interface ProfileCreationRequest {
  /**
   * How many LIVE profiles the account already has.
   *
   * Live, not total: archived profiles are history rather than usable
   * identities, so counting them would make a household that has tidied up its
   * picker permanently unable to add anyone. The repository's count query is
   * what has to agree with this sentence; the resolver only takes the number.
   */
  readonly existingProfileCount: number;
  readonly displayName: string;
  readonly avatarKey: string | null;
  readonly maxRating: string | null;
}

/**
 * Decide whether a profile may be created, and with what values.
 */
export function resolveProfileCreation(
  request: ProfileCreationRequest
): ProfileCreationResolution {
  // `>=` and not `>`: the count is the number that already exist, so an account
  // holding exactly MAX_PROFILES_PER_ACCOUNT is AT the ceiling and the next one
  // would be over it. An off-by-one here silently ships a limit of six.
  if (request.existingProfileCount >= MAX_PROFILES_PER_ACCOUNT) {
    return {
      ok: false,
      reason: "profile_limit_reached",
      detail: `this account already has ${String(request.existingProfileCount)} of a maximum ${String(MAX_PROFILES_PER_ACCOUNT)} profiles; archive one before adding another`
    };
  }

  const displayName = normalizeDisplayName(request.displayName);
  if (displayName === null) {
    // `JSON.stringify` rather than plain interpolation, the same rule
    // `describeUnrepresentableInstant` follows: an empty string, three spaces
    // and a zero-width space all interpolate to nothing, so one log line would
    // stand for three different submissions -- and a detail that is empty is
    // indistinguishable from one that was never populated, which this
    // repository treats as equal to a refusal with no reason at all.
    return {
      ok: false,
      reason: "display_name_is_blank",
      detail: `displayName has no visible characters: ${JSON.stringify(request.displayName)}`
    };
  }

  // Measured AFTER normalisation, so a name is judged on what will be stored.
  // Measuring the raw input would refuse a legitimate name padded with spaces
  // that were about to be removed anyway.
  const length = [...displayName].length;
  if (length > MAX_DISPLAY_NAME_CODE_POINTS) {
    return {
      ok: false,
      reason: "display_name_too_long",
      detail: `displayName is ${String(length)} characters; the maximum is ${String(MAX_DISPLAY_NAME_CODE_POINTS)}`
    };
  }

  return {
    ok: true,
    displayName,
    avatarKey: normalizeOptionalField(request.avatarKey),
    maxRating: normalizeOptionalField(request.maxRating)
  };
}

/**
 * The canonical shape of a Liberty profile id.
 *
 * A lowercase RFC 4122 UUID with the VERSION NIBBLE PINNED TO 4 and the variant
 * bits pinned to `10xx`. Both halves of that matter and only the second is
 * obvious:
 *
 *   - The format check alone is the weak one. A version-1 UUID is the same shape
 *     and encodes a timestamp and a MAC address, so it is partially predictable
 *     -- ids minted seconds apart differ in a handful of bits. Pinning the
 *     version is how "the id is unguessable" becomes a checkable property rather
 *     than a hope about whichever generator the caller reached for.
 *   - Sequential ids are what make the enumeration question in
 *     `externalProfileAccessReason` matter at all. With 122 random bits there is
 *     nothing to enumerate; the collapsed reason code is the second layer, not
 *     the only one.
 *
 * This is a check on OUR OWN minting, not a validation of user input in the
 * usual sense -- `newProfileId` is the only producer. Its value is at the read
 * side: `loadProfileOwnership` can refuse an id that could not have been minted
 * without issuing a query, so a scan of `/profiles/1`, `/profiles/2`, ... costs
 * the database nothing.
 */
const MINTED_PROFILE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Whether a string could have been produced by `newProfileId`. */
export function isMintedProfileId(value: string): boolean {
  return MINTED_PROFILE_ID.test(value);
}
