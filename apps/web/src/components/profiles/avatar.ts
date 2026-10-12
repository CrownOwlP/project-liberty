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
 * The first UTF-16 CODE POINT of a string, never half of one.
 *
 * THE FALLBACK USED TO BE `trimmed.slice(0, 1)` AND THAT REPRODUCED THE EXACT
 * DEFECT THE SEGMENTER WAS ADDED TO AVOID. A name beginning with an emoji or
 * any character outside the basic plane is two UTF-16 code units, and
 * `slice(0, 1)` returns a lone high surrogate -- an unpaired code unit, which
 * every renderer draws as U+FFFD. So the degraded path was not "slightly worse
 * initials", it was a replacement glyph on precisely the names the better path
 * exists for.
 *
 * Written with `charCodeAt` and surrogate arithmetic rather than
 * `codePointAt`, `Array.from`, the spread of a string or a `for...of` over it.
 * All four are correct and all four are ES2015+, and the whole purpose of this
 * function is to be the thing that still works when a runtime turns out to be
 * missing something -- a fallback that needs its own fallback is not one.
 * `charCodeAt` is ES1.
 *
 * It does NOT combine a base character with its combining marks, and does not
 * join a ZWJ emoji sequence or a regional-indicator flag pair. That is what the
 * segmenter is for; this is the honest, boring answer for a runtime that has
 * none, and its guarantee is narrower and absolute: whatever comes back is a
 * complete code point.
 */
function firstCodePoint(value: string): string {
  const high = value.charCodeAt(0);
  /* A high surrogate followed by a low surrogate is ONE character in two code
   * units. Both halves are taken, or neither -- an unpaired high surrogate
   * (malformed input, or a truncated name) falls through to the single unit,
   * because inventing a pair for it would be worse than drawing the glyph the
   * platform draws for a lone surrogate. */
  if (high >= 0xd800 && high <= 0xdbff && value.length > 1) {
    const low = value.charCodeAt(1);
    if (low >= 0xdc00 && low <= 0xdfff) return value.slice(0, 2);
  }
  return value.slice(0, 1);
}

/**
 * The character drawn on the tile.
 *
 * `Intl.Segmenter` rather than `displayName[0]`, because a name beginning with
 * an emoji, a flag, or any character outside the basic plane is TWO UTF-16 code
 * units and indexing gives half of one -- rendered as a replacement glyph. It
 * also keeps a base character together with its combining marks, which no
 * amount of index arithmetic does.
 *
 * ==========================================================================
 * THE GUARD BELOW IS THREE GUARDS, AND THE OLD COMMENT WAS WRONG ABOUT WHY
 * ==========================================================================
 *
 * This header used to say "a segmenter is in every runtime this application
 * targets, and the fallback below exists FOR THE TYPE rather than for a known
 * runtime". That sentence is the defect class this change removes. The
 * application targets a PACKAGED DESKTOP BUILD rendering in WebView2, whose
 * version is whatever Edge runtime the host Windows machine happens to carry --
 * not something this repository pins and not something the Next.js compiler can
 * do anything about, because `Intl.Segmenter` is a built-in rather than syntax,
 * so there is nothing to transpile and no polyfill is injected. A build can be
 * clean, typed and green and still be missing it at the only moment it is used.
 * "Exists for the type" is how a real fallback comes to be written, left
 * untested, and never executed until a household sees it fail.
 *
 * The three things that can go wrong, each handled rather than assumed away:
 *
 *   1. `Intl` ITSELF. `Intl.Segmenter` is a PROPERTY ACCESS, and a property
 *      access on an undefined `Intl` throws before any `typeof` on the result
 *      can run. ICU-less and size-stripped embeddings are the case; `typeof
 *      Intl` is the only spelling that is safe when the binding may not exist.
 *
 *   2. `Intl.Segmenter` MISSING. The original guard, kept.
 *
 *   3. CONSTRUCTION OR ITERATION THROWING, which the original did not consider
 *      and is the sharpest of the three. `const [first] = ...segment(trimmed)`
 *      DESTRUCTURES, and destructuring requires `Symbol.iterator` on the
 *      `Segments` object: an implementation that exposes `Segmenter` without an
 *      iterable `Segments`, or one that rejects `granularity: "grapheme"`
 *      against a trimmed ICU, throws a `TypeError` from a line that looks like
 *      it is only reading a value. Inside a React render that is a blank
 *      screen, in exchange for one letter on a tile.
 *
 * So the whole modern path is inside a `try`, and every failure lands on the
 * same complete-code-point answer as a missing API. NOTHING HERE RUNS AT
 * MODULE-EVALUATION TIME -- the feature test is in the function body, so a
 * runtime missing it cannot fail while this module is being loaded, which would
 * take down every screen that imports it rather than one initial.
 *
 * `toLocaleUpperCase` with no locale argument, deliberately: the correct
 * uppercase of a name depends on the name's language and not on ours, and
 * passing our locale is how a Turkish dotless i becomes an I. It is ES5 and
 * needs no guard of its own.
 *
 * Returns `null` for a name with no first segment. The caller decides what to
 * draw; this function does not invent a "?" that would then be somebody's
 * initial.
 */
export function profileInitial(displayName: string): string | null {
  const trimmed = displayName.trim();
  if (trimmed.length === 0) return null;

  const fallback = firstCodePoint(trimmed).toLocaleUpperCase();

  /* Guard 1: the namespace, by `typeof`, because the access itself can throw. */
  if (typeof Intl === "undefined") return fallback;
  const Segmenter = Intl.Segmenter;
  /* Guard 2: the constructor. */
  if (typeof Segmenter !== "function") return fallback;

  /* Guard 3: everything the constructor and its iterator can do. */
  try {
    const [first] = new Segmenter(undefined, { granularity: "grapheme" }).segment(trimmed);
    /*
     * A non-empty string with no first segment is not a state any conforming
     * implementation produces, so this is a non-conforming one -- and the
     * answer is the fallback, not `null`. Returning `null` here would hand the
     * caller "this name has no initial" for a name that plainly has one.
     */
    if (first === undefined) return fallback;
    const segment = first.segment;
    if (typeof segment !== "string" || segment.length === 0) return fallback;
    return segment.toLocaleUpperCase();
  } catch {
    return fallback;
  }
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
