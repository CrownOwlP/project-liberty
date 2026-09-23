/* -------------------------------------------------------------------------
 * What a profile looks like when there is no picture (PW-0303).
 *
 * THERE IS NO IMAGE IN THIS PRODUCT YET AND THIS MODULE DOES NOT INVENT ONE.
 * `profileViewSchema` publishes `avatarKey` as "an opaque storage key and NOT a
 * URL", and its comment gives the reason: a URL there would be a caller-supplied
 * string rendered into an `<img src>`. No asset store exists to resolve the key
 * against -- artwork end to end is PW-0302 -- so the honest avatar is one
 * derived ENTIRELY from values already in the response: an initial, and a hue.
 *
 * DERIVED, NOT RANDOM, AND NOT STORED. A household recognises its tiles by
 * colour, so the colour has to be the same on every render, on every device and
 * after a reload. `Math.random` would reshuffle the picker on every visit and a
 * stored colour would be a new column; a hash of a value the profile already
 * carries is neither. This module is pure: no clock, no randomness, no I/O.
 *
 * IT HASHES `avatarKey` WHEN THERE IS ONE AND `id` OTHERWISE, never
 * `displayName`. Two profiles in one household are frequently two people with
 * the same first letter, and hashing the name would give "Sam" and "Sara" a
 * similar-looking tile only by luck -- but worse, RENAMING a profile would
 * change its colour, and the tile a household aims at without reading would move
 * under them. An id does not change.
 * ---------------------------------------------------------------------- */

/** Exactly the fields this module reads. Structural, so a test needs no fixture factory. */
export interface AvatarSubject {
  readonly id: string;
  readonly displayName: string;
  readonly avatarKey: string | null;
}

/**
 * FNV-1a, 32-bit, over UTF-16 code units.
 *
 * Chosen because it is four lines, has no dependency, and is completely
 * specified by those four lines -- which matters more here than avalanche
 * quality, because the only requirement is that the same string always produces
 * the same number. `>>> 0` after the multiply keeps it in the unsigned 32-bit
 * range that the algorithm is defined over; without it the value goes through
 * JavaScript's signed-32 bitwise coercion and the function stops being FNV.
 *
 * NOT A SECURITY PRIMITIVE, and nothing here treats it as one. It decides a
 * colour.
 */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * The value a profile's colour is derived from.
 *
 * Exported so the test can state the rule rather than infer it from a colour.
 */
export function avatarSeed(subject: AvatarSubject): string {
  return subject.avatarKey ?? subject.id;
}

/**
 * A hue in [0, 360), stable for the life of the profile.
 *
 * Hue only -- saturation and lightness are fixed in CSS -- so every tile has the
 * same contrast against the same text colour whatever hue it draws. Deriving all
 * three would eventually produce a tile whose label cannot be read, and a
 * contrast failure that appears for one household and not another is the kind of
 * defect nobody can reproduce.
 */
export function avatarHue(subject: AvatarSubject): number {
  return fnv1a32(avatarSeed(subject)) % 360;
}

/**
 * The character drawn on the tile.
 *
 * `Intl.Segmenter` rather than `displayName[0]`, because a name beginning with
 * an emoji, a flag, or any character outside the basic plane is TWO UTF-16 code
 * units and indexing gives half of one -- rendered as a replacement glyph. A
 * segmenter is in every runtime this application targets, and the fallback below
 * exists for the type rather than for a known runtime.
 *
 * `toLocaleUpperCase` with no locale argument, deliberately: the correct
 * uppercase of a name depends on the name's language and not on ours, and
 * passing our locale is how a Turkish dotless i becomes an I.
 *
 * Returns `null` for a name with no first segment. The caller decides what to
 * draw; this function does not invent a "?" that would then be somebody's
 * initial.
 */
export function profileInitial(displayName: string): string | null {
  const trimmed = displayName.trim();
  if (trimmed.length === 0) return null;

  const Segmenter = Intl.Segmenter;
  if (typeof Segmenter !== "function") return trimmed.slice(0, 1).toLocaleUpperCase();

  const [first] = new Segmenter(undefined, { granularity: "grapheme" }).segment(trimmed);
  if (first === undefined) return null;
  return first.segment.toLocaleUpperCase();
}

/**
 * The inline custom property the tile is coloured with.
 *
 * A custom property rather than a `background` declaration, so the STYLE stays
 * in `globals.css` and only the one derived number crosses from TypeScript into
 * the DOM. A component that wrote a full gradient here would be a second place
 * the design system lives.
 */
export function avatarStyle(subject: AvatarSubject): Record<string, string> {
  return { "--avatar-hue": String(avatarHue(subject)) };
}
