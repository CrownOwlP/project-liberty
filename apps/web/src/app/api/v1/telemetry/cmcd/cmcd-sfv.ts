/* -------------------------------------------------------------------------
 * The `application/cmcd` body decoder (PL-0503)
 *
 * `packages/observability/src/cmcd-report.ts` takes the DECODED form of a CMCD
 * v2 event report — `{ events: [ { <key>: <value> } ] }` — and says out loud
 * that turning the wire body into that shape "belongs to the HTTP route that
 * owns the `Content-Type`, which does not exist yet". This file is that route's
 * decoder, and nothing else. It classifies no key, redacts nothing and decides
 * nothing about meaning: `cmcd-keys.ts` is the vocabulary and `cmcd-collect.ts`
 * is the interpreter, and a second opinion about either living here is exactly
 * the drift those two files are structured to prevent.
 *
 * WHAT ARRIVES, verified in the vendored SVTA library rather than transcribed
 * from prose. `third_party/cml-cmcd/cmcd_reporter.js` builds an event report as
 * `data.map(encodeCmcd).join('\n') + '\n'` and posts it with `Content-Type:
 * application/cmcd` (`cmcd_mime_type.js`). Each line is one RFC 8941 Structured
 * Field DICTIONARY, serialised by `cml_sfv.js`'s `encodeSfDict`. It is not JSON,
 * and it is not a query string.
 *
 * FOUR ENCODING FACTS THIS PARSER IS BUILT AGAINST, each read out of
 * `cml_sfv.js`:
 *
 *   1. Members are joined with `","` plus one optional space, so the separator
 *      is `,` with OWS on both sides.
 *   2. A `true` boolean is the BARE KEY — `encodeSfDict` writes the parameters
 *      and no `=` when `item.value === true`. `false` is `key=?0`. So `bs`
 *      alone and `bs=?0` are the two forms that occur; `bs=?1` never is.
 *   3. A decimal always carries a `.` (`serializeDecimal_` appends `.0` when
 *      rounding produced none), and an integer never does.
 *   4. An inner list is `(item item)` with each item's parameters appended as
 *      `;key` for a `true` value — which is how `bl=(3000;v 2000;a)` carries one
 *      number per CMCD object type.
 *
 * NOTHING HERE THROWS AT ITS BOUNDARY. `decodeCmcdEventReportBody` is total.
 * The parser below does use an internal exception to abandon a malformed line
 * without threading a failure value through nine mutually recursive functions,
 * and that exception is caught one frame above, per line. It cannot escape, and
 * its message is a fixed string: a parse error that quoted the input would put
 * an unauthenticated client's bytes into whatever the caller does with it, which
 * is the leak `CmcdRejection` refuses for the same reason.
 *
 * A MALFORMED LINE COSTS ONE EVENT, NOT THE BATCH. Same rule
 * `readCmcdEventReport` applies one level up: losing thirty real measurements to
 * one bad entry is the failure mode that makes people turn telemetry off.
 * ---------------------------------------------------------------------- */

import { CMCD_REPORT_LIMITS } from "@liberty/observability";

/**
 * Why the decoder refused something.
 *
 * A SEPARATE VOCABULARY FROM `CmcdRejectionReason`, deliberately. These are
 * facts about the WIRE ENCODING — a line that is not a dictionary, a value type
 * CMCD has no key for — and the collector's reasons are facts about the CMCD
 * VOCABULARY. Merging them would mean one enum that two packages both had to
 * agree about, and the route already reports the two stages separately so a
 * reader can tell "your body was malformed" from "your keys were".
 */
export type CmcdDecodeRefusalReason =
  /* The body as a whole. */
  | "body_empty"
  | "line_batch_truncated"
  | "line_too_long"
  | "line_unparseable"
  /* One member of an otherwise well-formed dictionary. */
  | "duplicate_key"
  | "member_parameters_discarded"
  | "byte_sequence_discarded"
  | "date_discarded"
  | "inner_list_item_unsupported";

/**
 * One reason, aggregated over the whole body.
 *
 * NO `key` FIELD, and that is not an oversight. A dictionary key on this side
 * of the boundary is unvalidated client input — the registry has not seen it
 * yet — so naming one would put unbounded attacker-controlled text into the
 * response and let a client grow this list without limit by sending a fresh
 * nonsense key each time. `cmcd-report.ts` states the same rule for the same
 * reason and populates `key` only for keys the registry recognises, which is a
 * judgement this file is deliberately not able to make.
 */
export interface CmcdDecodeRefusal {
  readonly reason: CmcdDecodeRefusalReason;
  readonly count: number;
}

export interface CmcdDecodeResult {
  /** Decoded dictionaries, in arrival order. Never longer than `maxEvents`. */
  readonly events: readonly Readonly<Record<string, unknown>>[];
  /** Aggregated and sorted by reason, so a retried body decodes identically. */
  readonly refusals: readonly CmcdDecodeRefusal[];
}

/**
 * Bounds this file owns, beside the ones `CMCD_REPORT_LIMITS` already states.
 *
 * `maxBodyBytes` is enforced by the route, not here, because it is an HTTP fact
 * (`content-length`) rather than a parsing one — but it is stated here so the
 * three numbers that bound a hostile body are readable together.
 *
 *   - `maxBodyBytes` — 64 KiB. A ten-event batch of forty short keys is a few
 *     kilobytes; this leaves an order of magnitude of headroom and still bounds
 *     what one unauthenticated POST can make the server hold.
 *   - `maxLineChars` — one event. Every CTA-5004-B string bound is 1024 or
 *     less and the vocabulary is under fifty keys, so 8 KiB is generous for a
 *     legitimate line and short enough that parsing one is trivially bounded.
 *   - `maxInnerListItems` — 32, deliberately ABOVE the collector's
 *     `maxListItems` (16) and `maxStringListItems` (8). The collector truncates
 *     an over-long list and TALLIES it; failing the whole line here instead
 *     would convert its precise, per-key refusal into a lost event, so the
 *     parser's cap exists only to bound work and lets the collector make the
 *     judgement.
 *   - `maxParameters` — an inner-list item carries one object-type parameter,
 *     and nothing in CMCD carries more; 8 bounds a pathological one.
 */
export const CMCD_SFV_LIMITS = {
  maxBodyBytes: 65_536,
  maxLineChars: 8_192,
  maxInnerListItems: 32,
  maxParameters: 8
} as const;

/* --------------------------------------------------------------------- */

/**
 * Character classes, as RFC 8941 defines them.
 *
 * THE KEY CLASSES ARE A DELIBERATE SUPERSET of RFC 8941 §3.1.2, which permits
 * lowercase only. CTA-5004-B's custom-key shape permits uppercase, so a client
 * may legitimately believe `com.liberty-avsVideoHole` is a key; refusing the
 * whole dictionary for it would discard every other measurement in that event
 * over a key `cmcd-keys.ts` would have rejected on its own with a precise
 * reason. Nothing first-party depends on the tolerance — `cml_sfv.js`'s
 * `serializeKey_` tests `/^[a-z*][a-z0-9\-_.*]*$/` and throws on uppercase, so
 * Shaka cannot emit one.
 *
 * `_` is absent from `KEY_START` because RFC 8941 says so, and that has a
 * useful consequence here: `__proto__` is not a parseable key. The decoded
 * record is built with a null prototype anyway, so neither control depends on
 * the other.
 */
const DIGIT = /[0-9]/;
const KEY_START = /[A-Za-z*]/;
const KEY_CHAR = /[A-Za-z0-9_.*-]/;
const TOKEN_START = /[A-Za-z*]/;
const TOKEN_CHAR = /[A-Za-z0-9!#$%&'*+\-.^_`|~:/]/;
const BASE64_CHAR = /[A-Za-z0-9+/=]/;
/** Printable ASCII. RFC 8941 strings admit no control character and no DEL. */
const STRING_CHAR = /[\x20-\x7E]/;

/** RFC 8941 §3.3.1: an integer is at most 15 digits. */
const MAX_INTEGER_DIGITS = 15;
/** §3.3.2: a decimal is at most 16 characters, at most 3 of them fractional. */
const MAX_DECIMAL_CHARS = 16;
const MAX_DECIMAL_FRACTION_DIGITS = 3;

type RefusalTally = Map<CmcdDecodeRefusalReason, number>;

function tally(refusals: RefusalTally, reason: CmcdDecodeRefusalReason): void {
  refusals.set(reason, (refusals.get(reason) ?? 0) + 1);
}

/**
 * Freeze a tally into a canonically ordered list.
 *
 * Sorted by reason, by code point, matching every other comparator in this
 * repository. Map iteration order is insertion order, which is input order,
 * which is exactly the dependency a decoder must not have: a batch that is
 * retried or re-merged has to decode to the identical result.
 */
function drain(refusals: RefusalTally): readonly CmcdDecodeRefusal[] {
  return [...refusals.entries()]
    .map(([reason, count]): CmcdDecodeRefusal => ({ reason, count }))
    .sort((left, right) => (left.reason === right.reason ? 0 : left.reason < right.reason ? -1 : 1));
}

/**
 * The internal abandon signal. See the file header: it never crosses
 * `decodeCmcdEventReportBody`, and it never carries any of the input.
 */
class SfvParseError extends Error {}

function abandon(what: string): never {
  throw new SfvParseError(what);
}

interface Cursor {
  readonly text: string;
  index: number;
}

/**
 * The character at the cursor, or `""` at the end of input.
 *
 * `charAt` rather than indexing, so that "past the end" is a value every
 * character class rejects rather than an `undefined` every caller has to
 * narrow. Under `noUncheckedIndexedAccess` the indexed form would put a
 * `| undefined` into nine call sites for no gain.
 */
function peek(cursor: Cursor): string {
  return cursor.text.charAt(cursor.index);
}

function take(cursor: Cursor): string {
  const character = cursor.text.charAt(cursor.index);
  cursor.index += 1;
  return character;
}

function skipOptionalWhitespace(cursor: Cursor): void {
  while (peek(cursor) === " " || peek(cursor) === "\t") cursor.index += 1;
}

function skipSpaces(cursor: Cursor): void {
  while (peek(cursor) === " ") cursor.index += 1;
}

/**
 * A bare item, or the fact that one was recognised and thrown away.
 *
 * `discarded` is not a failure: a byte sequence and a Date are both perfectly
 * well-formed structured-field values that no CMCD key has a meaning for. They
 * are parsed so the cursor stays in sync — abandoning the line over one would
 * lose the other thirty keys — and then dropped with a stated reason instead of
 * being coerced into a number or a string, which is where a unit or an encoding
 * would be invented.
 */
type BareItem =
  | { readonly kind: "value"; readonly value: string | number | boolean }
  | { readonly kind: "discarded" };

interface Parameter {
  readonly name: string;
  readonly value: BareItem;
}

interface Item {
  readonly bare: BareItem;
  readonly parameters: readonly Parameter[];
}

/** RFC 8941 §4.2.4. A leading `-`, then digits, then at most one `.`. */
function parseNumber(cursor: Cursor): number {
  let sign = 1;
  if (peek(cursor) === "-") {
    take(cursor);
    sign = -1;
  }
  if (!DIGIT.test(peek(cursor))) abandon("a number must have at least one digit");

  let text = "";
  let isDecimal = false;
  for (;;) {
    const character = peek(cursor);
    if (DIGIT.test(character)) {
      text += take(cursor);
    } else if (character === "." && !isDecimal) {
      if (text.length > 12) abandon("a decimal has at most twelve integer digits");
      text += take(cursor);
      isDecimal = true;
    } else {
      break;
    }
    if (!isDecimal && text.length > MAX_INTEGER_DIGITS) abandon("integer too long");
    if (isDecimal && text.length > MAX_DECIMAL_CHARS) abandon("decimal too long");
  }

  if (isDecimal) {
    const point = text.indexOf(".");
    const fractionDigits = text.length - point - 1;
    if (fractionDigits === 0) abandon("a decimal must not end in a decimal point");
    if (fractionDigits > MAX_DECIMAL_FRACTION_DIGITS) abandon("too many fractional digits");
  }

  const parsed = Number(text);
  // The grammar above admits only digits and one interior point, so this cannot
  // fire for any accepted string. It is here because `Number` is the boundary
  // where a `NaN` would enter, and a `NaN` reaching the collector is the exact
  // value `cmcd-collect.ts` exists to keep out of a field.
  if (!Number.isFinite(parsed)) abandon("number is not finite");
  return sign * parsed;
}

/** RFC 8941 §4.2.5. Only `\\` and `\"` are valid escapes. */
function parseString(cursor: Cursor): string {
  take(cursor);
  let out = "";
  for (;;) {
    const character = take(cursor);
    if (character === "") abandon("unterminated string");
    if (character === "\\") {
      const escaped = take(cursor);
      if (escaped !== "\\" && escaped !== '"') abandon("invalid string escape");
      out += escaped;
      continue;
    }
    if (character === '"') return out;
    if (!STRING_CHAR.test(character)) abandon("control character in string");
    out += character;
  }
}

/** RFC 8941 §4.2.6. */
function parseToken(cursor: Cursor): string {
  let out = take(cursor);
  while (TOKEN_CHAR.test(peek(cursor))) out += take(cursor);
  return out;
}

/**
 * RFC 8941 §4.2.7. Parsed for its delimiters and discarded.
 *
 * The base64 is never decoded. No CMCD v2 key is a byte sequence, so decoding
 * one would allocate an arbitrary buffer out of an unauthenticated body in
 * order to produce a value that has nowhere to go.
 */
function parseByteSequence(cursor: Cursor, refusals: RefusalTally): BareItem {
  take(cursor);
  while (BASE64_CHAR.test(peek(cursor))) cursor.index += 1;
  if (take(cursor) !== ":") abandon("unterminated byte sequence");
  tally(refusals, "byte_sequence_discarded");
  return { kind: "discarded" };
}

/**
 * RFC 9651 §4.2.9's Date, parsed and discarded.
 *
 * `cml_sfv.js` can serialise one (`serializeDate_` writes `@<seconds>`), and no
 * key in `cmcd-keys.ts` is a Date. Its unit is SECONDS since the epoch while
 * CMCD's one wall-clock key, `ts`, is epoch MILLISECONDS — so turning `@x` into
 * the number `x` would hand the collector a timestamp a thousand times too
 * small under a key typed to accept it. Discarded with a reason instead.
 */
function parseDate(cursor: Cursor, refusals: RefusalTally): BareItem {
  take(cursor);
  parseNumber(cursor);
  tally(refusals, "date_discarded");
  return { kind: "discarded" };
}

/** RFC 8941 §4.2.3.1. */
function parseBareItem(cursor: Cursor, refusals: RefusalTally): BareItem {
  const character = peek(cursor);
  if (character === "-" || DIGIT.test(character)) {
    return { kind: "value", value: parseNumber(cursor) };
  }
  if (character === '"') return { kind: "value", value: parseString(cursor) };
  if (character === ":") return parseByteSequence(cursor, refusals);
  if (character === "@") return parseDate(cursor, refusals);
  if (character === "?") {
    take(cursor);
    const flag = take(cursor);
    if (flag === "1") return { kind: "value", value: true };
    if (flag === "0") return { kind: "value", value: false };
    return abandon("a boolean is ?0 or ?1");
  }
  if (TOKEN_START.test(character)) return { kind: "value", value: parseToken(cursor) };
  return abandon("not a bare item");
}

/** RFC 8941 §4.2.3.2. A parameter with no `=` has the value `true`. */
function parseParameters(cursor: Cursor, refusals: RefusalTally): readonly Parameter[] {
  const parameters: Parameter[] = [];
  while (peek(cursor) === ";") {
    take(cursor);
    skipSpaces(cursor);
    if (!KEY_START.test(peek(cursor))) abandon("a parameter needs a key");
    const name = parseKey(cursor);
    let value: BareItem = { kind: "value", value: true };
    if (peek(cursor) === "=") {
      take(cursor);
      value = parseBareItem(cursor, refusals);
    }
    parameters.push({ name, value });
    if (parameters.length > CMCD_SFV_LIMITS.maxParameters) abandon("too many parameters");
  }
  return parameters;
}

/** RFC 8941 §4.2.1.3. */
function parseKey(cursor: Cursor): string {
  if (!KEY_START.test(peek(cursor))) abandon("a key must start with a letter or an asterisk");
  let out = "";
  while (KEY_CHAR.test(peek(cursor))) out += take(cursor);
  return out;
}

/** RFC 8941 §4.2.1.2. Items are separated by one or more spaces. */
function parseInnerList(cursor: Cursor, refusals: RefusalTally): readonly Item[] {
  take(cursor);
  const items: Item[] = [];
  for (;;) {
    skipSpaces(cursor);
    if (peek(cursor) === ")") {
      take(cursor);
      return items;
    }
    if (peek(cursor) === "") abandon("unterminated inner list");
    if (items.length >= CMCD_SFV_LIMITS.maxInnerListItems) abandon("inner list too long");

    const bare = parseBareItem(cursor, refusals);
    const parameters = parseParameters(cursor, refusals);
    items.push({ bare, parameters });

    const next = peek(cursor);
    if (next !== " " && next !== ")") abandon("inner list items are separated by a space");
  }
}

/**
 * One inner-list item, in the shape `readNumberList` reads.
 *
 * `cmcd-collect.ts` accepts either a bare value or `{ value, objectType }`, and
 * this is the only place that decides which. The `objectType` string is passed
 * through UNVALIDATED on purpose: `isCmcdObjectType` is the collector's, and it
 * already refuses an unrecognised one with `unknown_token`. Screening it here
 * as well would be a second opinion about the CMCD object-type vocabulary, held
 * in a file that has no business having one.
 *
 * An item with anything other than zero parameters or one `true` parameter is
 * refused rather than flattened onto the unqualified slot, because flattening
 * would make two qualified values collide there and the collector would report
 * `duplicate_list_slot` — a true statement about the wrong thing.
 */
function innerListItemValue(item: Item, refusals: RefusalTally): unknown {
  const bare = item.bare;
  if (bare.kind === "discarded") return undefined;

  if (item.parameters.length === 0) return bare.value;

  const parameter = item.parameters[0];
  if (
    item.parameters.length === 1 &&
    parameter !== undefined &&
    parameter.value.kind === "value" &&
    parameter.value.value === true
  ) {
    return { value: bare.value, objectType: parameter.name };
  }

  tally(refusals, "inner_list_item_unsupported");
  return undefined;
}

/**
 * RFC 8941 §4.2.2, with one deliberate deviation, stated here because it is a
 * deviation from a specification and not a reading of one.
 *
 * THE RFC SAYS THE LAST INSTANCE OF A REPEATED KEY WINS. This keeps the FIRST
 * and counts the collision. "The last one wins" is an order dependence wearing a
 * different hat — the same judgement `readNumberList` makes when it refuses a
 * second value for an object-type slot — and a dictionary carrying one key twice
 * is malformed input under either rule, so the rule that produces the same
 * record for the same bytes is the one to have.
 */
function parseDictionary(line: string, refusals: RefusalTally): Readonly<Record<string, unknown>> {
  const cursor: Cursor = { text: line, index: 0 };
  // A null prototype, so that a key spelled like something on `Object.prototype`
  // is an ordinary own property and cannot be an assignment to a setter.
  const record = Object.create(null) as Record<string, unknown>;

  skipOptionalWhitespace(cursor);

  while (cursor.index < cursor.text.length) {
    const key = parseKey(cursor);

    let value: unknown;
    if (peek(cursor) === "=") {
      take(cursor);
      if (peek(cursor) === "(") {
        const items = parseInnerList(cursor, refusals);
        if (parseParameters(cursor, refusals).length > 0) {
          tally(refusals, "member_parameters_discarded");
        }
        const list: unknown[] = [];
        for (const item of items) {
          const itemValue = innerListItemValue(item, refusals);
          if (itemValue !== undefined) list.push(itemValue);
        }
        value = list;
      } else {
        const bare = parseBareItem(cursor, refusals);
        if (parseParameters(cursor, refusals).length > 0) {
          tally(refusals, "member_parameters_discarded");
        }
        value = bare.kind === "value" ? bare.value : undefined;
      }
    } else {
      // A member with no `=` is the boolean `true`. See the file header: this
      // is the form `encodeSfDict` emits for every true flag, so it is the
      // common case rather than an edge one.
      if (parseParameters(cursor, refusals).length > 0) {
        tally(refusals, "member_parameters_discarded");
      }
      value = true;
    }

    if (Object.prototype.hasOwnProperty.call(record, key)) {
      tally(refusals, "duplicate_key");
    } else if (value !== undefined) {
      record[key] = value;
    }

    skipOptionalWhitespace(cursor);
    if (cursor.index >= cursor.text.length) return record;
    if (take(cursor) !== ",") abandon("dictionary members are separated by a comma");
    skipOptionalWhitespace(cursor);
    if (cursor.index >= cursor.text.length) abandon("a dictionary must not end in a comma");
  }

  return record;
}

/**
 * Decode an `application/cmcd` event-report body.
 *
 * TOTAL. Never throws, never reads a clock, never touches a network or a disk,
 * and returns the identical result for identical bytes.
 */
export function decodeCmcdEventReportBody(body: string): CmcdDecodeResult {
  const refusals: RefusalTally = new Map();
  const events: Readonly<Record<string, unknown>>[] = [];

  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;

    if (events.length >= CMCD_REPORT_LIMITS.maxEvents) {
      // Counted rather than broken out of, so the count reports the true size
      // of the overflow instead of the fact that there was one.
      tally(refusals, "line_batch_truncated");
      continue;
    }
    if (line.length > CMCD_SFV_LIMITS.maxLineChars) {
      tally(refusals, "line_too_long");
      continue;
    }

    try {
      events.push(parseDictionary(line, refusals));
    } catch {
      /*
       * Every reachable failure in here is an `SfvParseError`. The catch is
       * unconditional anyway: this function is called from an unauthenticated
       * HTTP boundary, where a rethrown anything is a 500 that a malformed body
       * chose, and there is no failure mode of a parse this small that a
       * refusal is the wrong answer to.
       */
      tally(refusals, "line_unparseable");
    }
  }

  if (events.length === 0 && refusals.size === 0) tally(refusals, "body_empty");

  return { events, refusals: drain(refusals) };
}
