/* -------------------------------------------------------------------------
 * The CMCD v2 key registry — the vocabulary, and the allowlist
 *
 * `docs/RESEARCH_PLAYBACK.md` rules that CMCD v2 (CTA-5004-B) is the canonical
 * telemetry vocabulary and that we do not invent metric names. This table IS
 * that ruling, expressed once, and everything else in this package reads it
 * rather than restating a key list.
 *
 * PROVENANCE. Every key, every value type and every token vocabulary below was
 * read out of the SVTA reference library that shaka-player 5.2.6 vendors, at
 * `node_modules/shaka-player/third_party/cml-cmcd/` — `cmcd_key_types.js`,
 * `cmcd_token_values.js`, `cmcd_inner_list_keys.js`, `cmcd_event.js` and
 * `cmcd_string_length_limits.js`. They are not transcribed from prose. A Shaka
 * upgrade that changes the vocabulary changes those files, which is where to
 * re-derive this one.
 *
 * THE TABLE IS AN ALLOWLIST, AND THAT IS THE SECURITY PROPERTY. The collector
 * emits nothing for a key that has no entry here. So the leak control for the
 * URL-bearing keys is not "remember to redact `url`" — it is that a key reaches
 * output only by being classified first, and classification is what selects the
 * emitter. A key added here without a `sensitivity` is a compile error.
 *
 * THAT LAST SENTENCE WAS FALSE UNTIL IT WAS AUDITED, and the way it was false is
 * the reason `spec()` now takes `sensitivity` as a required second argument.
 * `spec()` used to declare `sensitivity: CmcdSensitivity = "safe"`, so `url` and
 * `nor` were classified only because somebody remembered to classify them, and
 * the next CTA-5004-B key — v2 is a living draft and has already gained
 * `ttfbb`, `smrt` and the buffer-starvation family — would have been written
 * `spec("string")` by somebody who never thought about the question, and would
 * have entered `CMCD_V2_CLIENT_SAFE_KEYS` on the strength of an omission.
 * A default that picks the permissive answer turns
 * "derived, so it cannot drift" into "derived from whatever the default was",
 * which is the same leak wearing the vocabulary of a control. Defaults remain on
 * `unit`, `maxLength` and `tokens` because for all three the omitted value is
 * the CONSERVATIVE one: no unit claimed, the generic length bound, no closed
 * vocabulary asserted.
 *
 * WHAT IS NOT HERE. `nrr` was REMOVED in CMCD v2; its range information moved
 * onto `nor`. The vendored library still lists it because it also encodes v1,
 * so a client CAN emit it and mean nothing valid by it. It is enumerated
 * separately below as removed rather than omitted, so that a report carrying it
 * is rejected with a reason instead of being silently indistinguishable from a
 * typo.
 * ---------------------------------------------------------------------- */

export type CmcdValueKind =
  | "integer"
  | "number"
  | "boolean"
  | "string"
  | "token"
  | "string-list"
  | "number-list";

export type CmcdSensitivity = "safe" | "url-bearing";

/**
 * The unit a key's numbers are in, or `null` for "this specification does not
 * define one".
 *
 * `null` is stated rather than guessed, and the guessing is the point. CMCD is
 * milliseconds throughout while Shaka's `getStats()` is seconds throughout, and
 * the research names that as the most likely unit bug in this area — so a key
 * whose unit this file is not certain of gets no unit suffix in its emitted
 * field name, and a reader sees an unadorned number and knows not to assume.
 * Labelling a key `ms` on a hunch is strictly worse than labelling it nothing:
 * the wrong label is believed.
 */
export type CmcdUnit = "ms" | "epoch-ms" | "kbps" | null;

export interface CmcdKeySpec {
  readonly kind: CmcdValueKind;
  readonly unit: CmcdUnit;
  readonly sensitivity: CmcdSensitivity;
  /** Per CTA-5004-B's string length table, or `null` for the generic bound. */
  readonly maxLength: number | null;
  /** The closed token vocabulary, for `kind: "token"` keys only. */
  readonly tokens: readonly string[] | null;
}

/**
 * CMCD object types, in the specification's own order.
 *
 * The ORDER is load-bearing, not decorative. A v2 inner-list value such as
 * `bl=(3000;v 2000;a)` carries one number per object type, and emitting those
 * in the order they happened to arrive would make the output depend on how a
 * decoder walked a structured-field list. Emission follows this array instead,
 * so the same measurement always produces the same record.
 */
export const CMCD_OBJECT_TYPES: readonly string[] = [
  "m",
  "a",
  "v",
  "av",
  "i",
  "c",
  "tt",
  "k",
  "o"
];

const CMCD_OBJECT_TYPE_SET: ReadonlySet<string> = new Set(CMCD_OBJECT_TYPES);

export function isCmcdObjectType(value: string): boolean {
  return CMCD_OBJECT_TYPE_SET.has(value);
}

/** `cml.cmcd.CMCD_TOKEN_VALUES.e` — the CMCD v2 event types. */
const EVENT_TYPES: readonly string[] = [
  "bc",
  "ps",
  "pr",
  "e",
  "t",
  "c",
  "b",
  "m",
  "um",
  "pe",
  "pc",
  "rr",
  "as",
  "ae",
  "abs",
  "abe",
  "sk",
  "ce"
];

/** `cml.cmcd.CMCD_TOKEN_VALUES.sf` — DASH, HLS, Smooth, other. */
const STREAMING_FORMATS: readonly string[] = ["d", "h", "s", "o"];

/** `cml.cmcd.CMCD_TOKEN_VALUES.st` — VOD, live, low-latency live. */
const STREAM_TYPES: readonly string[] = ["v", "l", "ll"];

/** `cml.cmcd.CMCD_TOKEN_VALUES.sta` — the v2 player states. */
const PLAYER_STATES: readonly string[] = ["s", "p", "k", "r", "a", "w", "e", "f", "q", "d"];

/**
 * `sensitivity` IS SECOND AND IT HAS NO DEFAULT. See the file header: it is the
 * one argument whose omitted value would be the permissive one, so it is the one
 * argument the compiler makes you write. Position rather than an options object
 * because a table this size stays readable as a table.
 */
function spec(
  kind: CmcdValueKind,
  sensitivity: CmcdSensitivity,
  unit: CmcdUnit = null,
  maxLength: number | null = null,
  tokens: readonly string[] | null = null
): CmcdKeySpec {
  return { kind, unit, sensitivity, maxLength, tokens };
}

/**
 * The CMCD v2 keys this boundary understands.
 *
 * THE THREE URL-BEARING ONES. `url` is set by shaka's CmcdManager to the
 * segment URI with only the CMCD query parameter removed — every other query
 * parameter, including a CDN signature, survives into the report. `nor` is the
 * next object request, specified as a RELATIVE url, so its entire content is
 * the object path. `h` is classified with them deliberately and conservatively:
 * it is a 128-character string that CTA-5004-B groups with the identifier keys,
 * and if it turns out to carry a page or referrer URL then it has already been
 * redacted, while if it does not then the cost is one hostname nobody needed.
 * Guessing wrong in the other direction is a leak.
 *
 * UNITS ARE ASSERTED ONLY WHERE THE SPECIFICATION IS UNAMBIGUOUS. `d`, `dl`,
 * `ltc`, `msd`, `pt`, `ttfb`, `ttfbb`, `ttlb` and `bl` are milliseconds; `ts` is
 * epoch milliseconds and is given its own unit so that a wall-clock instant
 * cannot be read as a duration; `br`, `tb`, `mtp` and `rtp` are kilobits per
 * second. `bsd` and `bsda` are buffer starvation DURATIONS and CMCD has no time
 * unit other than the millisecond. Everything else — `ab`, `bsa`, `lab`, `lb`,
 * `pb`, `tab`, `tbl`, `tpb` — is left unlabelled on purpose; see `CmcdUnit`.
 */
export const CMCD_V2_KEYS: Readonly<Record<string, CmcdKeySpec>> = {
  ab: spec("number-list", "safe"),
  bg: spec("boolean", "safe"),
  bl: spec("number-list", "safe", "ms"),
  br: spec("number-list", "safe", "kbps"),
  bs: spec("boolean", "safe"),
  bsa: spec("number-list", "safe"),
  bsd: spec("number-list", "safe", "ms"),
  bsda: spec("number-list", "safe", "ms"),
  cdn: spec("string", "safe", null, 128),
  cen: spec("string", "safe", null, 64),
  cid: spec("string", "safe", null, 128),
  cmsdd: spec("string", "safe", null, 256),
  cmsds: spec("string", "safe", null, 256),
  cs: spec("string", "safe", null, 256),
  d: spec("integer", "safe", "ms"),
  dfa: spec("integer", "safe"),
  dl: spec("integer", "safe", "ms"),
  e: spec("token", "safe", null, null, EVENT_TYPES),
  ec: spec("string-list", "safe"),
  h: spec("string", "url-bearing", null, 128),
  lab: spec("number-list", "safe"),
  lb: spec("number-list", "safe"),
  ltc: spec("integer", "safe", "ms"),
  msd: spec("integer", "safe", "ms"),
  mtp: spec("number-list", "safe", "kbps"),
  nor: spec("string-list", "url-bearing"),
  nr: spec("boolean", "safe"),
  ot: spec("token", "safe", null, null, CMCD_OBJECT_TYPES),
  pb: spec("number-list", "safe"),
  pr: spec("number", "safe"),
  pt: spec("integer", "safe", "ms"),
  rc: spec("integer", "safe"),
  rtp: spec("integer", "safe", "kbps"),
  sf: spec("token", "safe", null, null, STREAMING_FORMATS),
  sid: spec("string", "safe", null, 64),
  smrt: spec("string", "safe", null, 256),
  sn: spec("integer", "safe"),
  st: spec("token", "safe", null, null, STREAM_TYPES),
  sta: spec("token", "safe", null, null, PLAYER_STATES),
  su: spec("boolean", "safe"),
  tab: spec("number-list", "safe"),
  tb: spec("number-list", "safe", "kbps"),
  tbl: spec("number-list", "safe"),
  tpb: spec("number-list", "safe"),
  ts: spec("integer", "safe", "epoch-ms"),
  ttfb: spec("integer", "safe", "ms"),
  ttfbb: spec("integer", "safe", "ms"),
  ttlb: spec("integer", "safe", "ms"),
  url: spec("string", "url-bearing", null, 1024),
  v: spec("integer", "safe")
};

/**
 * Keys a v2 report must not contain.
 *
 * `nrr` is here rather than merely absent so that a client still emitting it is
 * told which mistake it made. The research is explicit: ignore it on the
 * collector rather than treating it as valid v2.
 */
export const CMCD_KEYS_REMOVED_IN_V2: ReadonlySet<string> = new Set(["nrr"]);

/**
 * Look up a key without inheriting `Object.prototype`.
 *
 * The `hasOwnProperty` guard is load-bearing and not defensive noise. Report
 * keys come from an untrusted client, and `CMCD_V2_KEYS["toString"]` returns a
 * FUNCTION at runtime while the index signature types it as `CmcdKeySpec`. The
 * collector would then read `.kind` off a function, get `undefined`, and fall
 * through whichever branch happens to be last.
 */
export function cmcdKeySpec(key: string): CmcdKeySpec | null {
  if (!Object.prototype.hasOwnProperty.call(CMCD_V2_KEYS, key)) return null;
  return CMCD_V2_KEYS[key] ?? null;
}

/**
 * The custom-key shape from CTA-5004-B, copied from `is_cmcd_custom_key.js`.
 *
 * Its restrictiveness is doing security work as well as spec work: the emitted
 * field name for a custom key contains the key verbatim, and this character set
 * admits no quotes, no whitespace, no newlines and no control characters. A
 * looser rule would make the field-name space injectable from the wire.
 */
const CUSTOM_KEY_SHAPE = /^[a-zA-Z0-9.-]+-[a-zA-Z0-9.-]+$/;

/**
 * The reverse-DNS prefix every custom key of ours carries.
 *
 * CTA-5004-B's own rule permits a bare `something-else`, which is a collision
 * waiting to happen the first time two vendors pick the same word. The research
 * rules for reverse-DNS, so a custom key without this prefix is not ours and is
 * not accepted — see `CmcdRejectionReason.custom_key_not_namespaced`.
 */
export const LIBERTY_CUSTOM_KEY_PREFIX = "com.liberty-";

/** Per `cml.cmcd.CMCD_CUSTOM_KEY_VALUE_MAX_LENGTH`. */
export const CMCD_CUSTOM_KEY_VALUE_MAX_LENGTH = 64;

/** Bounds the key itself, which also bounds the emitted field name. */
export const CMCD_CUSTOM_KEY_MAX_LENGTH = 64;

export function isCmcdCustomKeyShape(key: string): boolean {
  return CUSTOM_KEY_SHAPE.test(key);
}

export function isLibertyCustomKey(key: string): boolean {
  return (
    key.length <= CMCD_CUSTOM_KEY_MAX_LENGTH &&
    key.startsWith(LIBERTY_CUSTOM_KEY_PREFIX) &&
    key.length > LIBERTY_CUSTOM_KEY_PREFIX.length &&
    isCmcdCustomKeyShape(key)
  );
}

/**
 * The keys a first-party client is configured to send.
 *
 * DERIVED, never hand-written, and that is the whole design. This is what
 * `apps/web/src/components/player/telemetry.ts` puts in Shaka's `includeKeys`,
 * so the URL-bearing keys are not merely redacted on arrival — they are never
 * requested in the first place. Two independent controls over one leak, from
 * one declaration, so they cannot drift apart: adding a `url-bearing` key to
 * the registry removes it from the client allowlist in the same edit.
 *
 * Sorted so the emitted configuration is a function of the registry's CONTENT
 * rather than of its declaration order.
 *
 * IT MUST NEVER BE EMPTY, and that is a property of the CONSUMER rather than of
 * this list. shaka-player 5.2.6's `CmcdManager.toReporterConfig_` reads an empty
 * `includeKeys` as "the caller did not choose" and substitutes
 * `allKeysForVersion_(2)`, which is every request, response and event key — `url`
 * and `nor` included. So an allowlist that filtered down to nothing would not
 * send nothing, it would send everything. `playbackTelemetryConfig` refuses to
 * emit a CMCD block in that case; the emptiness check belongs there, at the
 * boundary that knows about Shaka, but the reason is recorded here because this
 * is the file an edit that could cause it would touch.
 */
export const CMCD_V2_CLIENT_SAFE_KEYS: readonly string[] = Object.entries(CMCD_V2_KEYS)
  .filter(([, keySpec]) => keySpec.sensitivity === "safe")
  .map(([key]) => key)
  .sort();

/**
 * The other half of the same partition, derived the same way.
 *
 * Exported so a test can assert the two lists PARTITION the registry rather than
 * asserting a remembered set of names — "url, nor and h are excluded" is a claim
 * about today's registry, and the claim worth pinning is that every key is in
 * exactly one of the two lists whatever the registry grows into.
 */
export const CMCD_V2_URL_BEARING_KEYS: readonly string[] = Object.entries(CMCD_V2_KEYS)
  .filter(([, keySpec]) => keySpec.sensitivity === "url-bearing")
  .map(([key]) => key)
  .sort();
