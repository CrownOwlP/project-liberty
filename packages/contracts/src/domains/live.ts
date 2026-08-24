import { z } from "zod";
import { normalizedContentIdSchema, type NormalizedContentId } from "../shared/ids";
import { contentRightsSchema, type ContentRights } from "../shared/rights";

/* -------------------------------------------------------------------------
 * Live channels and EPG (PL-0601)
 *
 * The NORMALIZATION contract over XMLTV-shaped schedule data: what a channel
 * is, what one listing is, and what a schedule for a window is. It fetches
 * nothing, embeds no channel list, and names no feed URL -- acquiring a
 * schedule from an authorized provider is PL-0602 and belongs behind
 * `@liberty/provider-sdk`. Publishing the shape first is the same discipline
 * `./search` follows: when the transport lands, both sides are already parsing
 * the same payload and cannot quietly disagree about what a schedule is.
 *
 * Imports two shared leaf vocabularies directly. The rights enum is NOT
 * restated here: a live channel's rights basis is the same three values the
 * catalog, the title surface and the playback path already gate on, and a
 * fourth spelling of it living in the live domain is exactly the defect the
 * module split was done to prevent.
 *
 * ON iptv-org/epg. That project is TOOLING for downloading and generating EPG
 * data, and its XMLTV grammar and normalisation ideas are worth reusing -- this
 * module reuses them. Its public site list is NOT an entitlement source and is
 * deliberately absent from this file. Inclusion in a third-party index is not
 * permission from anybody, so the only channels this contract can describe are
 * ones a provider is independently authorized to serve us; `rights` is
 * required and non-nullable below so that a channel with no established basis
 * cannot be constructed at all. See `docs/LIVE_TV.md` and
 * `docs/CONTENT_RIGHTS.md`.
 * ---------------------------------------------------------------------- */

/* -------------------------------------------------------------------------
 * Time.
 * ---------------------------------------------------------------------- */

/**
 * The one representation of a moment in this domain: an ISO-8601 UTC instant
 * with EXACTLY three fractional digits, e.g. `2026-08-24T19:30:00.000Z`.
 *
 * TWO decisions are stacked here and both are load-bearing.
 *
 * UTC ONLY. `.datetime()` rejects a trailing offset (`...+01:00`) as well as a
 * bare local time, so by the time a value reaches this contract the ambiguity
 * is already gone. A schedule is compared against other schedules, against the
 * window it was requested for, and against the wall clock of a viewer who may
 * be nowhere near the broadcaster; one zone-free spelling is the only way those
 * comparisons agree. Normalisation to UTC happens once, in
 * `readXmltvTimestamp`, and never again.
 *
 * EXACTLY THREE FRACTIONAL DIGITS, which the rest of this package does not
 * demand of its `generatedAt` fields and which is not fussiness. Fixing the
 * precision fixes the WIDTH at 24 characters, and at fixed width code-point
 * order IS chronological order -- which is what makes `compareEpgListings`
 * below a real total order rather than a sort that happens to work. With
 * variable precision it silently is not: `"...:00Z"` and `"...:00.5Z"` are the
 * same instant, but `.` (U+002E) sorts before `Z` (U+005A), so the shorter
 * spelling compares as LATER than an instant half a second after it. That is an
 * order-dependence defect of exactly the family this repository has now hit six
 * times, and it is cheaper to make unrepresentable than to detect.
 *
 * `Date.prototype.toISOString()` already emits precisely this form, so the
 * normaliser needs no formatting code of its own.
 */
export const epgInstantSchema = z.string().datetime({ precision: 3 });
export type EpgInstant = z.infer<typeof epgInstantSchema>;

/** Width of a valid `EpgInstant`. Stated so the fixed-width claim is testable. */
export const EPG_INSTANT_LENGTH = 24;

/**
 * XMLTV's timestamp grammar, with the offset REQUIRED.
 *
 * XMLTV writes `20260824193000 +0100`: fourteen (or twelve) digits of LOCAL
 * wall time, then a separator, then an explicit UTC offset. The offset is what
 * makes the first half mean anything, and real feeds routinely omit it.
 *
 * The pattern below makes the offset optional so that `readXmltvTimestamp` can
 * tell "you sent no offset" apart from "you sent something that is not a
 * timestamp". Those are two different remedies -- chase the provider for a
 * conformant feed, versus fix the ingest -- and a single "invalid" verdict
 * merges them.
 */
export const XMLTV_TIMESTAMP_PATTERN =
  /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\s+([+-])(\d{2})(\d{2}))?$/;

/**
 * Why the reasons are a closed vocabulary rather than an error message.
 *
 * The same argument `./failover` makes for `playbackFailureKind`: an ingest
 * that decides what to do by matching provider-authored free text is one
 * reword away from silently changing behaviour. Three kinds, three remedies:
 *
 *   - `missing_offset` -- a syntactically fine XMLTV timestamp with no UTC
 *     offset. THE FEED is wrong and the entry is dropped. See below for why
 *     nothing is inferred.
 *   - `malformed_timestamp` -- not XMLTV timestamp syntax at all, or an offset
 *     outside the range any real zone uses. The INGEST or the source format is
 *     wrong.
 *   - `impossible_calendar_date` -- correct syntax naming a date that does not
 *     exist (month 13, 30 February, and the two-digit-year trap noted below).
 *     The feed is generating dates rather than reporting them.
 */
export const XMLTV_TIMESTAMP_REFUSALS = [
  "missing_offset",
  "malformed_timestamp",
  "impossible_calendar_date"
] as const;
export type XmltvTimestampRefusal = (typeof XMLTV_TIMESTAMP_REFUSALS)[number];

/**
 * The result of reading one XMLTV timestamp. A REFUSAL is a normal outcome.
 *
 * Returned rather than thrown because a single unparseable timestamp in a
 * twelve-hour grid must cost that one listing, not the ingest -- and because a
 * caller that has to catch to find out is a caller that will eventually catch
 * and continue with a fabricated value.
 */
export type XmltvTimestampReading =
  | { readonly ok: true; readonly instant: EpgInstant }
  | { readonly ok: false; readonly refusal: XmltvTimestampRefusal };

/** Beyond this no real zone exists; `+1400` (Kiritimati) is the true maximum. */
const MAX_OFFSET_MINUTES = 14 * 60;

/**
 * Read one XMLTV timestamp into a UTC instant, or refuse it with a reason.
 *
 * WHY AN OFFSET-LESS TIMESTAMP IS REFUSED RATHER THAN LOCALISED.
 *
 * `20260824193000` names a wall clock and nothing else. Interpreting it
 * requires a zone, and every available source of one is a guess:
 *
 *   - the SERVER's zone -- the worst option, and the usual one. It makes the
 *     normalised schedule a function of which machine ran the ingest, so the
 *     same feed produces different UTC instants in CI, in a container and on a
 *     developer's laptop. That is non-determinism injected at the boundary, and
 *     it is invisible until two of them disagree in production.
 *   - the VIEWER's zone -- shifts the broadcaster's grid by the viewer's
 *     travel, so a programme changes time when the user gets on a plane.
 *   - the CHANNEL's country -- not a fact this contract has (see
 *     `liveChannelSchema.countryCode`, which is itself nullable), not unique
 *     for countries spanning several zones, and not the same thing as the
 *     zone the FEED was written in.
 *
 * All three are inference, and the rule this codebase runs on is that an
 * unstated fact stays unstated. A guessed offset is worse than a dropped
 * listing in the specific way that matters: it is wrong by a whole number of
 * hours, it is wrong silently, and around a DST transition it is wrong twice a
 * year in a way that looks like a provider outage. A dropped listing leaves a
 * visible hole in the grid, and a hole is a bug report.
 *
 * Note the two-digit-year trap: `Date.UTC(99, ...)` means 1999, not year 99, so
 * a four-digit `0099` would parse into a plausible-looking instant with no
 * error anywhere. The round-trip check below is what catches it, and it catches
 * every rolled-over field (month 13, 30 February) by the same mechanism rather
 * than by a table of month lengths.
 */
export function readXmltvTimestamp(raw: string): XmltvTimestampReading {
  const match = XMLTV_TIMESTAMP_PATTERN.exec(raw.trim());
  if (match === null) return { ok: false, refusal: "malformed_timestamp" };

  const year = match[1];
  const month = match[2];
  const day = match[3];
  const hour = match[4];
  const minute = match[5];
  const second = match[6];
  const offsetSign = match[7];
  const offsetHours = match[8];
  const offsetMinutes = match[9];

  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined
  ) {
    // Unreachable while the pattern's first five groups are non-optional.
    // Written as a refusal rather than a throw so that editing the pattern can
    // never turn an ingest into a crash.
    return { ok: false, refusal: "malformed_timestamp" };
  }

  if (offsetSign === undefined || offsetHours === undefined || offsetMinutes === undefined) {
    return { ok: false, refusal: "missing_offset" };
  }

  const offsetMinutePart = Number(offsetMinutes);
  if (offsetMinutePart > 59) return { ok: false, refusal: "malformed_timestamp" };

  const magnitude = Number(offsetHours) * 60 + offsetMinutePart;
  if (magnitude > MAX_OFFSET_MINUTES) return { ok: false, refusal: "malformed_timestamp" };

  const offsetTotalMinutes = (offsetSign === "-" ? -1 : 1) * magnitude;
  // XMLTV allows the seconds to be omitted, and omitted seconds genuinely mean
  // zero here rather than unknown: the grammar has no place to put a
  // sub-minute value, so there is no fact being withheld.
  const seconds = second === undefined ? 0 : Number(second);

  const statedAsUtcMillis = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    seconds
  );
  if (Number.isNaN(statedAsUtcMillis)) return { ok: false, refusal: "impossible_calendar_date" };

  // Read the components back out and compare. Anything `Date.UTC` normalised on
  // our behalf -- a rolled-over month, a 31st that does not exist, a
  // two-digit year mapped into the 1900s -- differs here and is refused.
  const restated = new Date(statedAsUtcMillis);
  const roundTrips =
    restated.getUTCFullYear() === Number(year) &&
    restated.getUTCMonth() === Number(month) - 1 &&
    restated.getUTCDate() === Number(day) &&
    restated.getUTCHours() === Number(hour) &&
    restated.getUTCMinutes() === Number(minute) &&
    restated.getUTCSeconds() === seconds;
  if (!roundTrips) return { ok: false, refusal: "impossible_calendar_date" };

  const instant = new Date(statedAsUtcMillis - offsetTotalMinutes * 60_000).toISOString();
  return { ok: true, instant };
}

/* -------------------------------------------------------------------------
 * Channels. The rights-bearing unit of this domain.
 * ---------------------------------------------------------------------- */

/**
 * A live channel we are authorized to carry.
 *
 * `rights` is REQUIRED and NON-NULLABLE, unlike `./title`'s
 * `titleRightsBasisSchema`, and the difference is deliberate. A title detail is
 * reachable by direct id for anything the metadata layer knows about, including
 * a work nobody has cleared, so it must be able to say "no basis declared". A
 * channel is not reachable that way: it exists in this system only because a
 * provider is authorized to deliver it, so a channel with no basis is not an
 * unknown channel, it is a channel we must not have. Making the field
 * non-nullable means that state has no representation.
 *
 * `providerId` sits beside `rights` because a rights basis is not a property of
 * a broadcast in the abstract -- it is a property of the arrangement with the
 * party delivering it. The same channel from two providers is two records with
 * two independently established bases, and collapsing them would let one
 * provider's licence speak for another's feed.
 *
 * `sourceChannelId` is the id the feed uses (XMLTV `<channel id=...>`), kept
 * separate from `id` rather than reused as it. Ours is a
 * `normalizedContentId`, which is constrained precisely because it is
 * interpolated into routes; a provider-native id carrying a dot, a slash or
 * mixed case -- and XMLTV ids look like `BBCOne.uk` -- would produce a URL that
 * is not the one anything links to. The source id stays so the join back to the
 * feed's own `<programme channel=...>` attribute is exact.
 *
 * NO STREAM FIELD, of any kind. A channel says a broadcast exists and states
 * the basis on which we may carry it. Turning that into something playable
 * means producing a `StreamCandidate` through an authorized provider adapter,
 * which is PL-0602's job and lives behind `@liberty/provider-sdk` -- the same
 * separation `./catalog` keeps, for the same reason.
 *
 * NO TIME ZONE FIELD, and its absence is a decision rather than an omission. A
 * channel-level zone would be the obvious place to reach for when
 * `readXmltvTimestamp` refuses an offset-less timestamp, and reaching for it is
 * the exact inference that function refuses to make.
 *
 * `.strict()` throughout this module: zod's default is to STRIP an unknown key,
 * so without it a channel arriving with a `streamUrl` would parse cleanly and
 * lose the field silently, and an unexpected key is evidence about the feed
 * that the ingest should see rather than discard.
 */
export const liveChannelSchema = z
  .object({
    id: normalizedContentIdSchema,
    providerId: z.string().min(1),
    sourceChannelId: z.string().min(1),
    displayName: z.string().min(1),
    rights: contentRightsSchema,
    /**
     * ISO-3166-1 alpha-2, upper case. `null` = the feed did not state a
     * country, which is not the same as an international channel and must not
     * be turned into one.
     */
    countryCode: z
      .string()
      .regex(/^[A-Z]{2}$/, "must be an upper-case ISO-3166-1 alpha-2 code")
      .nullable(),
    /**
     * `null` = not reported. `[]` = reported, and empty. The same distinction
     * `./title`'s technical metadata draws: collapsing them turns "we do not
     * know what language this channel broadcasts in" into "it broadcasts in
     * none", and one of those is a rendering decision the UI can make.
     */
    languages: z.array(z.string().min(2)).nullable(),
    categories: z.array(z.string().min(1)).nullable(),
    logoUrl: z.string().url().nullable()
  })
  .strict();
export type LiveChannel = z.infer<typeof liveChannelSchema>;

/* -------------------------------------------------------------------------
 * Listings. Description only -- never entitlement.
 * ---------------------------------------------------------------------- */

/**
 * Keys that would let a listing look playable on its own.
 *
 * Enumerated as data so the guard below is a compile error rather than a review
 * note. `providerId` is on the list even though it is innocuous-looking: it is
 * the field a future refactor would add to "make the listing self-contained",
 * and a listing that names both a provider and a title is one join away from
 * being treated as a candidate.
 */
export const PLAYABILITY_BEARING_KEYS = [
  "rights",
  "entitlement",
  "isPlayable",
  "streamUrl",
  "playbackUrl",
  "url",
  "candidates",
  "providerId"
] as const;
export type PlayabilityBearingKey = (typeof PLAYABILITY_BEARING_KEYS)[number];

/** `true` when `Shape` has none of `PLAYABILITY_BEARING_KEYS`, else `never`. */
type CarriesNoPlayability<Shape> = [Extract<keyof Shape, PlayabilityBearingKey>] extends [never]
  ? true
  : never;

/**
 * One entry in a channel's schedule. XMLTV `<programme>`, normalised.
 *
 * A LISTING IS NOT AN ENTITLEMENT, and this contract makes that structural
 * instead of asserting it in a comment. The listing has no rights field, no
 * provider, no URL and no playable flag: the only thing it says about
 * availability is which channel it belongs to. To learn whether anything here
 * may be played you must present the CHANNEL, via `rightsBasisForListing`, and
 * the channel's basis is the only answer that exists.
 *
 * That direction is the whole design. An EPG is the largest, cheapest,
 * least-verified body of metadata in the system -- a public grid describes
 * thousands of broadcasts nobody has cleared, and a schedule is routinely
 * fetched for channels we do not carry. If a listing could carry its own rights
 * then every one of those rows would be an assertion about playability sourced
 * from a listings feed, which is precisely what `docs/CONTENT_RIGHTS.md`
 * forbids. Rights travel with the channel because the channel is the thing an
 * authorization was actually established for.
 *
 * UNKNOWN STAYS UNKNOWN. Every descriptive field below is required and
 * nullable, for the reasons `./playback` sets out at length for the media
 * facts. EPG feeds omit constantly -- no end time, no category, no episode
 * number -- and each omission is a fact about the feed. `.optional()` would
 * make "we do not know" indistinguishable from "nobody sent it", and a default
 * would fabricate.
 */
export const epgListingSchema = z
  .object({
    /**
     * A stable, normalised identity the adapter mints.
     *
     * XMLTV gives a `<programme>` no id at all, which is why this field is
     * REQUIRED rather than nullable: without an identity a schedule cannot be
     * deduplicated, cannot be diffed against the next refresh, and -- see
     * `compareEpgListings` -- has no total order, so its sort is only as stable
     * as the order the feed happened to arrive in. Minting it is a normalisation
     * cost paid once at the boundary. `epgScheduleSchema` requires the ids
     * within a schedule to be distinct, which is the condition that makes the
     * comparator total.
     */
    id: normalizedContentIdSchema,
    /** The channel this describes. The ONLY route to a rights basis. */
    channelId: normalizedContentIdSchema,
    startsAt: epgInstantSchema,
    /**
     * `null` = the feed stated no end time, and it is NOT to be inferred from
     * the next listing's start.
     *
     * That inference is the classic EPG normaliser bug and it fails twice over.
     * It fabricates a fact -- the gap to the next entry is only the duration if
     * the grid is gapless, and grids have gaps, off-air blocks and overlapping
     * regional variants. And it makes the parsed value depend on the ORDER the
     * entries were processed in, so the same feed normalises differently
     * depending on how it was chunked. A listing with no end time renders as a
     * listing with no end time.
     */
    endsAt: epgInstantSchema.nullable(),
    title: z.string().min(1),
    /** XMLTV `<sub-title>`: the episode's own title. `null` = not stated. */
    episodeTitle: z.string().min(1).nullable(),
    description: z.string().min(1).nullable(),
    /** `null` = uncategorised by the feed. `[]` = the feed sent an empty set. */
    categories: z.array(z.string().min(1)).nullable(),
    seasonNumber: z.number().int().positive().nullable(),
    episodeNumber: z.number().int().positive().nullable(),
    /**
     * XMLTV writes `<new/>` and `<previously-shown/>` as PRESENCE. Absence is
     * not `false` -- most feeds never emit either element for any programme, so
     * reading absence as "this is a repeat" (or as "this is new") would label
     * an entire grid from a fact nobody stated. Tri-state, and the UI decides
     * what to render for the third state.
     */
    isNew: z.boolean().nullable(),
    isPreviouslyShown: z.boolean().nullable()
  })
  .strict();
export type EpgListing = z.infer<typeof epgListingSchema>;

/**
 * Compile-time proof that a listing cannot carry playability.
 *
 * `.strict()` above rejects an unexpected key at RUNTIME, which handles a feed.
 * This handles US: the day somebody adds `rights` to the schema to make a
 * screen easier to build, `keyof EpgListing` overlaps
 * `PLAYABILITY_BEARING_KEYS`, this alias resolves to `never`, and `true` stops
 * assigning to it. The build fails at the line where the rule is written down,
 * next to the reasoning, rather than in a review that might not happen.
 *
 * Exported rather than left as a local so it is not dead code, and so a test
 * can assert the runtime value exists.
 */
export const EPG_LISTING_CARRIES_NO_PLAYABILITY: CarriesNoPlayability<EpgListing> = true;

/**
 * The rights basis under which a listing may be considered for playback, or a
 * refusal.
 *
 * The signature is the point: there is no `rightsBasisForListing(listing)`,
 * because there is no answer to that question. A caller must hold the channel,
 * and the channel is the thing whose authorization was established.
 *
 * A mismatched pair returns a REFUSAL rather than `null`-as-rights, so that
 * "this listing belongs to a channel you did not give me" cannot be read as
 * "this listing has no rights" and quietly funnel into an unavailable-content
 * branch. It is a programming error at the call site and it says so.
 */
export type ListingRightsBasis =
  | { readonly basis: ContentRights; readonly channelId: NormalizedContentId }
  | { readonly basis: null; readonly refusal: "listing_belongs_to_another_channel" };

export function rightsBasisForListing(channel: LiveChannel, listing: EpgListing): ListingRightsBasis {
  if (listing.channelId !== channel.id) {
    return { basis: null, refusal: "listing_belongs_to_another_channel" };
  }
  return { basis: channel.rights, channelId: channel.id };
}

/* -------------------------------------------------------------------------
 * Schedules and ordering.
 * ---------------------------------------------------------------------- */

/**
 * The interval a schedule was requested for.
 *
 * Both bounds are required and non-nullable: unlike a listing's end time this
 * is not a fact a feed withheld, it is a parameter WE chose, and a request
 * whose window we cannot state is a request we cannot cache, page or compare
 * against a later refresh.
 *
 * The `<` comparison is valid only because `epgInstantSchema` fixes the width;
 * see its note.
 */
export const epgWindowSchema = z
  .object({
    startsAt: epgInstantSchema,
    endsAt: epgInstantSchema
  })
  .strict()
  .refine((window) => window.startsAt < window.endsAt, {
    message: "a window must end after it starts",
    path: ["endsAt"]
  });
export type EpgWindow = z.infer<typeof epgWindowSchema>;

/**
 * A channel's listings over a window.
 *
 * `listings` may be `[]`, and that is a real answer meaning "nothing is
 * scheduled here", distinct from a failed fetch. `./search` makes the same
 * point about empty result sets; a failure is never an empty body.
 *
 * Two cross-entry invariants are enforced rather than documented:
 *
 *   - every listing names THIS channel. A schedule that can mix channels is a
 *     schedule whose entries can be read against the wrong channel's rights,
 *     which is the one mistake `rightsBasisForListing` exists to prevent -- and
 *     a refinement here is stronger than hoping every call site pairs correctly.
 *   - listing ids are DISTINCT. This is what makes `compareEpgListings` total,
 *     and therefore what makes a sorted schedule a function of its contents
 *     rather than of its arrival order.
 *
 * Deliberately NOT enforced: that listings fall inside the window. A programme
 * that starts before the window and runs into it is the first row of every
 * grid, and clipping or rejecting it would either fabricate a start time or
 * lose the entry a viewer is currently watching.
 *
 * Deliberately NOT enforced: that listings do not overlap. Simulcasts,
 * corrected re-issues and regional opt-outs all produce genuine overlap, and a
 * contract that rejects them would push adapters into silently dropping one
 * side.
 */
export const epgScheduleSchema = z
  .object({
    channelId: normalizedContentIdSchema,
    window: epgWindowSchema,
    listings: z.array(epgListingSchema),
    generatedAt: epgInstantSchema
  })
  .strict()
  .superRefine((schedule, ctx) => {
    const seen = new Set<string>();
    schedule.listings.forEach((listing, index) => {
      if (listing.channelId !== schedule.channelId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "a listing must name the schedule's own channel",
          path: ["listings", index, "channelId"]
        });
      }
      if (seen.has(listing.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "listing ids must be distinct within a schedule",
          path: ["listings", index, "id"]
        });
      }
      seen.add(listing.id);
    });
  });
export type EpgSchedule = z.infer<typeof epgScheduleSchema>;

/**
 * The TOTAL order over listings, and the only ordering this contract implies.
 *
 * Three keys, each a strict tiebreak on the last:
 *
 *   1. `startsAt`, by code point -- which is chronological, because
 *      `epgInstantSchema` fixes the width. Not `Date.parse` and not
 *      `localeCompare`: the first re-derives a number that the string already
 *      determines, and the second is locale-dependent, which would make the
 *      order a function of the machine's environment.
 *   2. `endsAt`, with `null` sorting LAST. The null placement is arbitrary and
 *      therefore has to be STATED -- an unstated one is a coin flip that each
 *      implementation makes separately. Last, because a listing with no known
 *      end is the least specific claim about the slot.
 *   3. `id`, by code point. This is the key that makes the order total, and it
 *      is only total because `epgScheduleSchema` requires ids to be distinct.
 *      Without it two simulcast entries sharing a start and an end are
 *      incomparable, `Array.prototype.sort`'s tie handling decides between
 *      them, and the result is a function of input order -- which is the defect
 *      class this repository has now hit six times.
 *
 * Total order plus distinct ids means `sortEpgListings` is invariant under
 * permutation of its input: any two orderings of the same listings sort to the
 * same array, element for element.
 */
export function compareEpgListings(left: EpgListing, right: EpgListing): number {
  if (left.startsAt !== right.startsAt) return left.startsAt < right.startsAt ? -1 : 1;

  if (left.endsAt !== right.endsAt) {
    if (left.endsAt === null) return 1;
    if (right.endsAt === null) return -1;
    return left.endsAt < right.endsAt ? -1 : 1;
  }

  if (left.id !== right.id) return left.id < right.id ? -1 : 1;
  return 0;
}

/**
 * Listings in schedule order. Non-mutating, because a caller handing over a
 * parsed response should not find it reordered underneath them.
 */
export function sortEpgListings(listings: readonly EpgListing[]): EpgListing[] {
  return [...listings].sort(compareEpgListings);
}

/**
 * A schedule whose listings are in the contract's order.
 *
 * Provided so the ordering is applied in ONE place. A grid that sorts in the
 * component, an API route that sorts in the handler and a cache that stores
 * unsorted are three implementations of the same rule, and they will disagree
 * about `null` end times first.
 */
export function sortEpgSchedule(schedule: EpgSchedule): EpgSchedule {
  return { ...schedule, listings: sortEpgListings(schedule.listings) };
}
