/* -------------------------------------------------------------------------
 * EPG TIME: ONE STORED FORM, MANY RENDERED FORMS (Wave 132, Worker E).
 *
 * THE DEFECT CLASS REMOVED: THE AMBIGUOUS WALL CLOCK. The ordinary EPG bug is a
 * schedule stored as the local time the broadcaster wrote, which is then
 * compared against a clock in another zone, cached, and rendered somewhere else
 * again. It is wrong by a whole number of hours, it is wrong silently, and
 * around a DST transition it is wrong twice a year in a way that looks like a
 * provider outage. `docs/LIVE_TV.md` spends a section on it.
 *
 * THE RULE, AND IT IS A ONE-WAY STREET:
 *
 *   1. The OFFSET IS READ FROM THE DATA. `@liberty/contracts/domains/live`'s
 *      `readXmltvTimestamp` is the only place that happens, and it REFUSES a
 *      timestamp with no offset rather than guessing a zone. This module never
 *      sees a wire timestamp.
 *   2. Everything in between is a UTC `EpgInstant` — fixed-width, 24 characters,
 *      exactly three fractional digits — so comparison is string comparison and
 *      ordering is total.
 *   3. A ZONE IS APPLIED ONLY AT THE RENDER EDGE, and it is the VIEWER'S zone,
 *      supplied by the caller. Nothing here reads `Intl.DateTimeFormat().resolvedOptions().timeZone`
 *      on its own, because that is the zone of whichever machine executed the
 *      code — the server in a server render — and a server-zone grid is the
 *      non-determinism this whole chain exists to remove.
 *
 * A ZONE IS A PARAMETER, AND AN INVALID ONE IS A REFUSAL RATHER THAN A THROW.
 * `Intl.DateTimeFormat` throws `RangeError` on an unknown `timeZone`, and a
 * viewer preference string reaching a server render is untrusted input: one bad
 * value would otherwise turn a whole grid into a 500. `resolveViewerZone`
 * answers once, and every formatter below takes an already-resolved zone, so the
 * failure cannot be forgotten at a call site.
 *
 * DST IS NOT HANDLED HERE — IT IS HANDLED BY NOT BEING HANDLED. Offsets are read
 * from the feed and instants are stored in UTC, so a programme that crosses a
 * DST boundary is one instant range like any other; the transition only changes
 * what the WALL CLOCK of that range looks like, which is `Intl`'s job and
 * `Intl`'s zone database, not a table in this repository. `time.test.ts` pins
 * exactly that: a span across the US spring-forward reads as 01:30 → 03:15
 * local, one hour and forty-five minutes of wall clock for forty-five minutes of
 * real time, and that is the correct answer rather than a bug to be smoothed.
 * ---------------------------------------------------------------------- */
import { EPG_INSTANT_LENGTH, type EpgInstant } from "@liberty/contracts/domains/live";

/** A zone this process has confirmed `Intl` knows. Branding is by construction only. */
export type ResolvedViewerZone = { readonly timeZone: string };

export type ViewerZoneResolution =
  | { readonly ok: true; readonly zone: ResolvedViewerZone }
  | { readonly ok: false; readonly reason: "unknown_time_zone"; readonly requested: string };

/** UTC, as the fallback a caller may choose explicitly. Never chosen for them. */
export const UTC_ZONE: ResolvedViewerZone = { timeZone: "UTC" };

/**
 * Confirm a zone name against the runtime's own zone database.
 *
 * `try`/`catch` around a constructor is the only available probe —
 * `Intl.supportedValuesOf("timeZone")` exists but omits every alias (`Asia/Calcutta`,
 * `US/Eastern`) that a real viewer preference may carry, so checking against it
 * would reject working zones. The catch is narrow and converts to a named
 * refusal, which is the opposite of swallowing it.
 */
export function resolveViewerZone(requested: string): ViewerZoneResolution {
  const trimmed = requested.trim();
  if (trimmed === "") return { ok: false, reason: "unknown_time_zone", requested };
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: trimmed }).format(0);
  } catch {
    return { ok: false, reason: "unknown_time_zone", requested };
  }
  return { ok: true, zone: { timeZone: trimmed } };
}

/** Milliseconds for an instant. The only `Date` construction on the read path. */
export function instantToMillis(instant: EpgInstant): number {
  return Date.parse(instant);
}

/**
 * An instant from milliseconds, in the contract's exact spelling.
 *
 * `toISOString()` already emits three fractional digits and a `Z`, which is
 * precisely `epgInstantSchema`. The length assertion is not defensive clutter:
 * the fixed width is what makes string comparison chronological everywhere else
 * in this layer, so a runtime that ever emitted a different width must fail
 * here rather than silently break every comparison downstream.
 */
export function millisToInstant(millis: number): EpgInstant | null {
  if (!Number.isFinite(millis)) return null;
  const date = new Date(millis);
  const iso = date.toISOString();
  return iso.length === EPG_INSTANT_LENGTH ? iso : null;
}

/** The parts of a wall clock, in a zone. Numbers, so callers do not re-parse strings. */
export interface ZonedParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

const PART_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function partFormatter(zone: ResolvedViewerZone): Intl.DateTimeFormat {
  const cached = PART_FORMATTERS.get(zone.timeZone);
  if (cached !== undefined) return cached;
  /*
   * `en-GB` and `hourCycle: "h23"` are pinned rather than left to the default
   * locale. A formatter whose locale came from the environment would make the
   * PARTS — not just their presentation — depend on the machine: `hour12`
   * locales produce `"12"` for midnight, and a caller comparing hour numbers
   * would then be comparing different things on two runners.
   */
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  PART_FORMATTERS.set(zone.timeZone, formatter);
  return formatter;
}

/** The wall clock an instant shows in a zone. */
export function zonedParts(instant: EpgInstant, zone: ResolvedViewerZone): ZonedParts | null {
  const millis = instantToMillis(instant);
  if (!Number.isFinite(millis)) return null;
  const parts = partFormatter(zone).formatToParts(new Date(millis));
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type);
    return found === undefined ? Number.NaN : Number(found.value);
  };
  const result: ZonedParts = {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    /* `h23` still spells midnight `24` in some ICU versions; folded, not trusted. */
    hour: read("hour") % 24,
    minute: read("minute"),
    second: read("second")
  };
  return Object.values(result).some((value) => Number.isNaN(value)) ? null : result;
}

/**
 * The viewer's calendar day for an instant, as `YYYY-MM-DD`.
 *
 * THE KEY THE MIDNIGHT-CROSSING CASE TURNS ON. A grid is grouped by day, and
 * "which day" is a question about the VIEWER's calendar, not UTC's: a 23:30
 * local broadcast is tonight's listing even when its UTC instant is tomorrow's
 * date. Computing this from the instant's own characters — which is what
 * `instant.slice(0, 10)` does and what every first version of this function does
 * — puts late-evening programmes on the wrong day for every viewer east or west
 * of UTC, and does it only after 00:00 UTC, so it looks intermittent.
 */
export function zonedDayKey(instant: EpgInstant, zone: ResolvedViewerZone): string | null {
  const parts = zonedParts(instant, zone);
  if (parts === null) return null;
  const pad = (value: number, width: number): string => String(value).padStart(width, "0");
  return `${pad(parts.year, 4)}-${pad(parts.month, 2)}-${pad(parts.day, 2)}`;
}

/** Whether a span lands on two different viewer days. */
export function crossesLocalMidnight(
  startsAt: EpgInstant,
  endsAt: EpgInstant,
  zone: ResolvedViewerZone
): boolean | null {
  const start = zonedDayKey(startsAt, zone);
  const end = zonedDayKey(endsAt, zone);
  if (start === null || end === null) return null;
  return start !== end;
}

/** `HH:MM` in the viewer's zone. The grid's primary label. */
export function formatZonedClock(instant: EpgInstant, zone: ResolvedViewerZone): string | null {
  const parts = zonedParts(instant, zone);
  if (parts === null) return null;
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

/**
 * The zone's UTC offset in minutes at an instant.
 *
 * Derived from the formatted wall clock rather than from a table, so the answer
 * comes from the runtime's own zone database and changes with it. This is what
 * makes a DST transition observable in a test as a CHANGE IN THIS NUMBER across
 * two instants an hour apart, instead of as a hard-coded expectation about a
 * date somebody will have to maintain when a legislature moves a transition.
 */
export function zoneOffsetMinutesAt(instant: EpgInstant, zone: ResolvedViewerZone): number | null {
  const parts = zonedParts(instant, zone);
  const millis = instantToMillis(instant);
  if (parts === null || !Number.isFinite(millis)) return null;
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  /* Seconds granularity is enough: no zone has a sub-minute offset since 1900. */
  return Math.round((asUtc - Math.floor(millis / 1000) * 1000) / 60_000);
}

/**
 * A span's length in whole minutes, from the instants and nothing else.
 *
 * Real elapsed time, NOT wall-clock difference — which is why a DST-crossing
 * programme reports 45 minutes while its local labels move by an hour and
 * three-quarters. Both numbers are true; this is the one a progress bar needs.
 */
export function spanMinutes(startsAt: EpgInstant, endsAt: EpgInstant): number | null {
  const start = instantToMillis(startsAt);
  const end = instantToMillis(endsAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.round((end - start) / 60_000);
}
