/* -------------------------------------------------------------------------
 * The server-side CMCD collection boundary (PL-0503)
 *
 * A validated CMCD v2 event report goes in; structured, redacted `LogEvent`s
 * come out. That is the whole job. There is no storage, no batching, no
 * transport and no OpenTelemetry SDK here — `docs/RESEARCH_PLAYBACK.md` rules
 * that CMCD converts to OTel at the SERVER boundary, and this is the server
 * boundary, but the conversion it performs is into this package's own flat
 * scalar record. Attaching an OTel logs exporter is then a wiring change with
 * nothing left to decide, because `LogField` is already the attribute shape.
 *
 * THE FOUR THINGS THIS FILE IS RESPONSIBLE FOR GETTING RIGHT
 *
 * 1. NO URL EVER REACHES A SINK. Enforced structurally, not by discipline: a
 *    key contributes a field only if `cmcd-keys.ts` classified it, and every
 *    string that a classified key can contribute goes through `safeString`,
 *    which has no branch that returns the raw value for a `url-bearing` key.
 *    A string under ANY key that merely looks like a URL is redacted too, so
 *    the guarantee does not depend on the classification being complete.
 *
 * 2. UNITS ARE IN THE NAME OR THEY ARE NOT CLAIMED. Shaka reports seconds and
 *    CMCD is milliseconds; the single conversion between them lives in
 *    `apps/web/src/components/player/playback-stats.ts` and there is
 *    deliberately no second one here. What this file does instead is REFUSE
 *    seconds: CTA-5004-B types `msd`, `ltc`, `ttfb` and their siblings as
 *    integers, so a start delay of `1.5` is a client that forgot to multiply,
 *    and it is rejected rather than recorded as a millisecond and a half.
 *
 * 3. AN UNAVAILABLE NUMBER IS `null`, NEVER `0`. `NaN` is how the player side
 *    says "not available" and it survives arithmetic, comparison and
 *    `JSON.stringify` without ever failing — a dropped-frame count of `NaN`
 *    becomes a dropped-frame count of zero somewhere downstream, and zero is a
 *    claim. Every numeric branch that refuses a value writes `null` in its
 *    place.
 *
 * 4. THE RESULT DOES NOT DEPEND ON INPUT ORDER. Six order-dependence defects in
 *    this repository so far. Keys are read in sorted order, object-type list
 *    slots are emitted in the specification's order, fields are emitted in
 *    sorted order, rejections are aggregated and sorted, and events are sorted
 *    by their own `ts` with a canonical tiebreak — so a batch that is retried,
 *    merged or reordered in flight collects to the identical result. The single
 *    exception is `maxEvents` truncation, which is arrival-ordered because the
 *    alternative is doing unbounded work before deciding what to discard.
 * ---------------------------------------------------------------------- */

import {
  CMCD_CUSTOM_KEY_VALUE_MAX_LENGTH,
  CMCD_KEYS_REMOVED_IN_V2,
  CMCD_OBJECT_TYPES,
  cmcdKeySpec,
  isCmcdCustomKeyShape,
  isCmcdObjectType,
  isLibertyCustomKey,
  type CmcdKeySpec,
  type CmcdUnit
} from "./cmcd-keys";
import {
  CMCD_REPORT_LIMITS,
  drainRejections,
  mergeRejections,
  readCmcdEventReport,
  readRecord,
  tallyRejection,
  type CmcdEventRecord,
  type CmcdRejection,
  type RejectionTally
} from "./cmcd-report";
import type { LogEvent, LogField, LogLevel } from "./log-event";
import { looksLikeUrl, redactUrl } from "./redaction";

/**
 * What a report says happened, in OUR vocabulary rather than CMCD's tokens.
 *
 * PL-0503's acceptance names startup, rebuffer, quality switch and failure, and
 * these are those four plus the classes the remaining subscribed CMCD events
 * fall into. This is a routing label DERIVED from `e` and `sta` — it invents no
 * metric name and replaces no key; every CMCD key still travels under its own
 * name in `fields`.
 */
export type CmcdEventClass =
  | "startup"
  | "rebuffer"
  | "bitrate_change"
  | "error"
  | "state_change"
  | "response"
  | "interval"
  | "other";

export interface CmcdCollectionInput {
  /** The decoded report body. Validated here; never trusted. */
  readonly payload: unknown;
  /**
   * Epoch milliseconds, supplied by the caller.
   *
   * An explicit input rather than a `Date.now()` inside, so that this function
   * is a pure mapping and a property test can assert that permuting a report
   * produces an identical whole result. A clock read in here would make that
   * assertion impossible to write and the difference invisible.
   */
  readonly receivedAtMs: number;
  /** Correlation id from the request, or `null` when there is none. */
  readonly requestId: string | null;
}

export interface CmcdCollectionResult {
  /** False only for a structurally malformed report; see `readCmcdEventReport`. */
  readonly ok: boolean;
  readonly logs: readonly LogEvent[];
  readonly rejections: readonly CmcdRejection[];
}

const CMCD_FIELD_PREFIX = "cmcd.";
const CUSTOM_FIELD_PREFIX = "cmcd.custom.";
const RECEIVED_AT_FIELD = "telemetry.receivedAtEpochMs";
const REJECTED_KEYS_FIELD = "telemetry.rejectedKeys";
const REJECT_REASONS_FIELD = "telemetry.rejectReasons";
const TIMESTAMP_FIELD = "cmcd.tsEpochMs";

/**
 * Convert a report into structured records.
 *
 * Never throws. Never reads a clock. Never reaches a network or a disk.
 */
export function collectCmcdEventReport(input: CmcdCollectionInput): CmcdCollectionResult {
  const read = readCmcdEventReport(input.payload);
  if (!read.ok) return { ok: false, logs: [], rejections: read.rejections };

  const collected = read.events.map((event) => normaliseEvent(event, input));
  const ordered = [...collected].sort(compareCollected);

  return {
    ok: true,
    logs: ordered.map((entry) => entry.log),
    rejections: mergeRejections(read.rejections, ...collected.map((entry) => entry.rejections))
  };
}

/* --------------------------------------------------------------------- */

interface CollectedEvent {
  /** `ts` if the event stated one, otherwise sorts last. */
  readonly sortKey: number;
  /** The whole record, serialised in canonical order, as the sort tiebreak. */
  readonly canonical: string;
  readonly log: LogEvent;
  readonly rejections: readonly CmcdRejection[];
}

/**
 * A total order over collected events.
 *
 * By `ts` first because that is what the events mean, then by the canonical
 * serialisation so that two events sharing a timestamp — which retries and
 * clock granularity both produce — still order the same way every time. Events
 * with no `ts` sort last as a block rather than being interleaved by accident.
 */
function compareCollected(left: CollectedEvent, right: CollectedEvent): number {
  if (left.sortKey !== right.sortKey) return left.sortKey < right.sortKey ? -1 : 1;
  if (left.canonical === right.canonical) return 0;
  return left.canonical < right.canonical ? -1 : 1;
}

function normaliseEvent(event: CmcdEventRecord, input: CmcdCollectionInput): CollectedEvent {
  const tally: RejectionTally = new Map();
  const fields = new Map<string, LogField>();

  // Sorted BEFORE the `maxKeysPerEvent` cut, so which keys survive a
  // pathologically wide event is a function of the key set rather than of the
  // order a decoder walked the dictionary in.
  const keys = Object.keys(event).sort();

  let read = 0;
  for (const key of keys) {
    if (read >= CMCD_REPORT_LIMITS.maxKeysPerEvent) {
      tallyRejection(tally, "too_many_keys", null);
      continue;
    }
    read += 1;
    readKey(key, event[key], fields, tally);
  }

  const rejections = drainRejections(tally);
  const rejectedKeys = rejections.reduce((total, rejection) => total + rejection.count, 0);

  fields.set(RECEIVED_AT_FIELD, input.receivedAtMs);
  fields.set(REJECTED_KEYS_FIELD, rejectedKeys);
  if (rejections.length > 0) {
    // Deduplicated and already sorted by `drainRejections`, so this string is a
    // function of the reason SET rather than of how often each one fired.
    fields.set(REJECT_REASONS_FIELD, [...new Set(rejections.map((r) => r.reason))].join(","));
  }

  const entries: [string, LogField][] = [...fields.keys()]
    .sort()
    .map((name): [string, LogField] => [name, fields.get(name) ?? null]);

  const record: Record<string, LogField> = {};
  for (const [name, value] of entries) record[name] = value;

  const classification = classify(event);
  const level: LogLevel = classification === "error" ? "error" : "info";
  const base: LogEvent = { level, event: `playback.cmcd.${classification}`, fields: record };

  const timestamp = record[TIMESTAMP_FIELD];

  return {
    sortKey: typeof timestamp === "number" ? timestamp : Number.POSITIVE_INFINITY,
    canonical: JSON.stringify(entries),
    log: input.requestId === null ? base : { ...base, requestId: input.requestId },
    rejections
  };
}

/**
 * Which of the four acceptance events this is.
 *
 * Read off the CMCD event type `e` first and refined by the player state `sta`,
 * because `e` says what the client chose to report and `sta` says what the
 * player was doing. The `e === null` branch is not defensive: `sta` is a
 * request-mode key too, so a report can carry a meaningful state without an
 * event type, and dropping those into `other` would lose rebuffers.
 *
 * `ec` promotes to `error` on its own. A client that reports error codes
 * without setting `e` has still had an error, and PL-0503's acceptance asks for
 * failures to be observable rather than for clients to be well behaved.
 */
function classify(event: CmcdEventRecord): CmcdEventClass {
  const eventType = readString(event["e"]);
  const state = readString(event["sta"]);
  const errorCodes = event["ec"];
  const hasErrorCodes = Array.isArray(errorCodes) && errorCodes.length > 0;

  if (eventType === "e" || hasErrorCodes) return "error";
  if (eventType === "bc") return "bitrate_change";

  if (eventType === "ps" || eventType === null) {
    if (state === "s") return "startup";
    if (state === "r") return "rebuffer";
    if (eventType === "ps") return "state_change";
  }

  if (eventType === "rr") return "response";
  if (eventType === "t") return "interval";
  return "other";
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** `ms` becomes `Ms`. Exhaustive, so a new unit is a compile error rather than a silent bare name. */
function unitSuffix(unit: CmcdUnit): string {
  switch (unit) {
    case "ms":
      return "Ms";
    case "epoch-ms":
      return "EpochMs";
    case "kbps":
      return "Kbps";
    case null:
      return "";
  }
}

function fieldName(key: string, unit: CmcdUnit): string {
  return `${CMCD_FIELD_PREFIX}${key}${unitSuffix(unit)}`;
}

/**
 * THE ONLY PATH from a registry key's string value into an emitted field.
 *
 * There is no branch here that returns `value` for a `url-bearing` key, and
 * adding one is the entire leak. The `looksLikeUrl` arm covers the other half:
 * a key the registry believes is safe can still be handed a signed URL by a
 * client, and `cid` and `cmsdd` are both plausible places for that to happen by
 * accident. Redacting a string that merely resembles a URL costs a diagnostic
 * we did not need; not redacting one costs a signed manifest URL in a log.
 */
function safeString(
  value: string,
  key: string,
  keySpec: CmcdKeySpec,
  tally: RejectionTally
): string {
  if (keySpec.sensitivity === "url-bearing" || looksLikeUrl(value)) return redactUrl(value);

  const limit = keySpec.maxLength ?? CMCD_REPORT_LIMITS.maxStringLength;
  if (value.length <= limit) return value;
  tallyRejection(tally, "too_long", key);
  return value.slice(0, limit);
}

function readKey(
  key: string,
  raw: unknown,
  fields: Map<string, LogField>,
  tally: RejectionTally
): void {
  // Checked before the registry, because the vendored SVTA table still lists
  // `nrr` for v1 and a v2 report carrying it is stating something the version
  // it claims to speak has no meaning for.
  if (CMCD_KEYS_REMOVED_IN_V2.has(key)) {
    tallyRejection(tally, "removed_in_v2", key);
    return;
  }

  const keySpec = cmcdKeySpec(key);
  if (keySpec === null) {
    readUnregisteredKey(key, raw, fields, tally);
    return;
  }

  const name = fieldName(key, keySpec.unit);

  // An absent value is not a rejection. The client had nothing to say, which is
  // the ordinary case for most of a forty-key vocabulary on any given event.
  if (raw === null || raw === undefined) return;

  switch (keySpec.kind) {
    case "integer":
      readNumeric(name, key, raw, true, fields, tally);
      return;
    case "number":
      readNumeric(name, key, raw, false, fields, tally);
      return;
    case "boolean":
      if (typeof raw !== "boolean") {
        tallyRejection(tally, "wrong_type", key);
        fields.set(name, null);
        return;
      }
      fields.set(name, raw);
      return;
    case "string":
      if (typeof raw !== "string") {
        tallyRejection(tally, "wrong_type", key);
        fields.set(name, null);
        return;
      }
      fields.set(name, safeString(raw, key, keySpec, tally));
      return;
    case "token":
      readToken(name, key, raw, keySpec, fields, tally);
      return;
    case "string-list":
      readStringList(name, key, raw, keySpec, fields, tally);
      return;
    case "number-list":
      readNumberList(name, key, raw, fields, tally);
      return;
  }
}

/**
 * A key with no registry entry: ours, someone else's, or noise.
 *
 * The key name is never tallied. It is attacker-controlled string data, so
 * naming it would put unbounded input into a log line AND let a client grow the
 * rejection list without limit by sending a fresh nonsense key each time.
 */
function readUnregisteredKey(
  key: string,
  raw: unknown,
  fields: Map<string, LogField>,
  tally: RejectionTally
): void {
  if (!isCmcdCustomKeyShape(key)) {
    tallyRejection(tally, "unknown_key", null);
    return;
  }
  if (!isLibertyCustomKey(key)) {
    // CTA-5004-B would accept a bare `something-else`; the research rules for a
    // reverse-DNS prefix precisely so that two vendors picking the same word
    // cannot silently overwrite each other's metric.
    tallyRejection(tally, "custom_key_not_namespaced", null);
    return;
  }

  if (raw === null || raw === undefined) return;

  // Safe to interpolate: the custom-key shape admits only alphanumerics, dots
  // and hyphens, so the field-name space is not injectable from the wire.
  const name = `${CUSTOM_FIELD_PREFIX}${key}`;

  if (typeof raw === "boolean") {
    fields.set(name, raw);
    return;
  }
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) {
      tallyRejection(tally, "not_finite", null);
      fields.set(name, null);
      return;
    }
    fields.set(name, raw);
    return;
  }
  if (typeof raw !== "string") {
    tallyRejection(tally, "wrong_type", null);
    fields.set(name, null);
    return;
  }

  fields.set(
    name,
    looksLikeUrl(raw) ? redactUrl(raw) : raw.slice(0, CMCD_CUSTOM_KEY_VALUE_MAX_LENGTH)
  );
}

/**
 * `requireInteger` is the seconds guard.
 *
 * CTA-5004-B types every scalar time key as an INTEGER of milliseconds. A
 * client that hands us Shaka's `timeToFirstFrame` without multiplying sends
 * `msd: 1.5`, and the difference between rejecting that and recording it is the
 * difference between a missing measurement and a start-delay dashboard that
 * reads one and a half milliseconds. `null` is written rather than the value,
 * because the number is not available and zero would be a lie.
 */
function readNumeric(
  name: string,
  key: string,
  raw: unknown,
  requireInteger: boolean,
  fields: Map<string, LogField>,
  tally: RejectionTally
): void {
  if (typeof raw !== "number") {
    tallyRejection(tally, "wrong_type", key);
    fields.set(name, null);
    return;
  }
  // `NaN` and both infinities. `Number.isFinite` rather than a comparison,
  // because every comparison against `NaN` is false and the guard would pass.
  if (!Number.isFinite(raw)) {
    tallyRejection(tally, "not_finite", key);
    fields.set(name, null);
    return;
  }
  if (requireInteger && !Number.isInteger(raw)) {
    tallyRejection(tally, "not_an_integer", key);
    fields.set(name, null);
    return;
  }
  fields.set(name, raw);
}

function readToken(
  name: string,
  key: string,
  raw: unknown,
  keySpec: CmcdKeySpec,
  fields: Map<string, LogField>,
  tally: RejectionTally
): void {
  if (typeof raw !== "string") {
    tallyRejection(tally, "wrong_type", key);
    fields.set(name, null);
    return;
  }
  // A token outside the closed vocabulary is dropped rather than passed
  // through: these five keys are the ones `classify` routes on, and an
  // unrecognised `sta` that reached the output would look like a state.
  if (keySpec.tokens !== null && !keySpec.tokens.includes(raw)) {
    tallyRejection(tally, "unknown_token", key);
    fields.set(name, null);
    return;
  }
  fields.set(name, raw);
}

/**
 * `ec` and `nor`, joined into one scalar.
 *
 * Joined rather than indexed (`cmcd.ec.0`, `cmcd.ec.1`) because an index is a
 * position and positions are the thing this file refuses to let matter — and
 * because `LogField` is scalar by design, so an array would have to be
 * flattened by whoever attaches the exporter, in a place with no access to the
 * redaction rule.
 */
function readStringList(
  name: string,
  key: string,
  raw: unknown,
  keySpec: CmcdKeySpec,
  fields: Map<string, LogField>,
  tally: RejectionTally
): void {
  if (!Array.isArray(raw)) {
    tallyRejection(tally, "wrong_type", key);
    fields.set(name, null);
    return;
  }

  const items: string[] = [];
  for (const item of raw) {
    if (items.length >= CMCD_REPORT_LIMITS.maxStringListItems) {
      tallyRejection(tally, "list_truncated", key);
      break;
    }
    if (typeof item !== "string") {
      tallyRejection(tally, "wrong_type", key);
      continue;
    }
    items.push(safeString(item, key, keySpec, tally));
  }

  fields.set(name, items.join(","));
}

/**
 * A v2 inner list: one number per object type, plus at most one unqualified.
 *
 * `bl=(3000;v 2000;a)` becomes `cmcd.blMs.v` and `cmcd.blMs.a`. The unqualified
 * member keeps the bare name. Emission follows `CMCD_OBJECT_TYPES`, never
 * arrival order, so the same measurement always produces the same record — and
 * a second value for a slot is refused rather than overwriting the first, since
 * "the last one wins" is exactly an order dependence wearing a different hat.
 *
 * NOTE what is not checked: inner-list numbers are not required to be integers
 * even where the unit is milliseconds, because CTA-5004-B does not type them
 * that way. The seconds guard in `readNumeric` therefore covers `msd`, `ltc`,
 * `ttfb` and the other scalars but not `bl`, `bsd` or `bsda`.
 */
function readNumberList(
  name: string,
  key: string,
  raw: unknown,
  fields: Map<string, LogField>,
  tally: RejectionTally
): void {
  if (!Array.isArray(raw)) {
    tallyRejection(tally, "wrong_type", key);
    fields.set(name, null);
    return;
  }

  const slots = new Map<string, LogField>();
  let seen = 0;

  for (const item of raw) {
    if (seen >= CMCD_REPORT_LIMITS.maxListItems) {
      tallyRejection(tally, "list_truncated", key);
      break;
    }
    seen += 1;

    let objectType = "";
    let value: unknown = item;

    const wrapped = readRecord(item);
    if (wrapped !== null) {
      value = wrapped["value"];
      const stated = wrapped["objectType"];
      if (typeof stated !== "string" || !isCmcdObjectType(stated)) {
        tallyRejection(tally, "unknown_token", key);
        continue;
      }
      objectType = stated;
    }

    if (slots.has(objectType)) {
      tallyRejection(tally, "duplicate_list_slot", key);
      continue;
    }
    if (typeof value !== "number") {
      tallyRejection(tally, "wrong_type", key);
      slots.set(objectType, null);
      continue;
    }
    if (!Number.isFinite(value)) {
      tallyRejection(tally, "not_finite", key);
      slots.set(objectType, null);
      continue;
    }
    slots.set(objectType, value);
  }

  if (slots.has("")) fields.set(name, slots.get("") ?? null);
  for (const objectType of CMCD_OBJECT_TYPES) {
    if (!slots.has(objectType)) continue;
    fields.set(`${name}.${objectType}`, slots.get(objectType) ?? null);
  }
}
