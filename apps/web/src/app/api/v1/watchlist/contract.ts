import type { ExternalProfileAccessReason, ProfileAccessGrantReason } from "@liberty/auth";
import { normalizedContentIdSchema } from "@liberty/contracts/shared/ids";
import type {
  ListLimitRejection,
  WatchlistEntryRow,
  WatchlistFailure,
  WatchlistMutationOutcome,
  WatchlistMutationRejection
} from "@liberty/persistence";
import { z } from "zod";
import {
  reason,
  trail,
  type NonEmptyReasons,
  type ReasonLine
} from "../../../../lib/db/reason-trail";
import type { RequestContextReasonCode } from "../../../../lib/db/request-context";

/* -------------------------------------------------------------------------
 * The watchlist wire contract (PL-0404)
 *
 * WHY THIS LIVES HERE rather than in `@liberty/contracts`: the same reason
 * `v1/playback/session/contract.ts` records, and the same follow-up.
 *
 * ADD AND REMOVE ARE IDEMPOTENT, AND THE STATUS CODES SAY SO. Adding a title
 * already on the list is a 200 with `already_present`, and removing one that is
 * not on it is a 200 with `not_present`. Neither is an error: the client is a
 * button on a remote control behind an unreliable network, and a retried request
 * must converge rather than fail. `changed` is what tells a caller whether this
 * particular request did anything, and it is correlated with the reason in the
 * type rather than left as a free boolean.
 *
 * THE CONFLICT RULE IS NOT DECIDED HERE AND NOT DECIDED BY THE CLIENT. An add
 * racing a remove from two devices is settled by server arrival order, argued in
 * `watchlist-mutation.ts` -- including the one case it knowingly gets wrong (an
 * intent formed offline and delivered late) and why the fix for that belongs to
 * the client's offline queue rather than to this table. There is deliberately no
 * epoch, no sequence number and no client timestamp in the request below,
 * because a watchlist tap is one deliberate action rather than an autonomous
 * emitter, and charging it a lease round trip would double the latency of the
 * most trivial interaction in the product.
 * ---------------------------------------------------------------------- */

/* -------------------------------------------------------------------------
 * Requests
 * ---------------------------------------------------------------------- */

/**
 * The body of an add or a remove: nothing.
 *
 * The whole request is in the method and the path, which is why this schema has
 * no fields -- and why it is `.strict()` anyway. An empty non-strict object
 * accepts and silently discards every key a client sends, so a client that
 * believed it could also send `addedAt` or `profileId` would get a successful
 * mutation and no indication that the field was dropped. Refusing tells it.
 *
 * An absent body parses as `{}`; see `readJsonBody`.
 */
export const watchlistMutationRequestSchema = z.object({}).strict();

export type WatchlistMutationRequest = z.infer<typeof watchlistMutationRequestSchema>;

/**
 * How many entries one page of the list may hold when the caller does not say.
 *
 * A NUMBER CHOSEN HERE, ON PURPOSE. `listWatchlist` requires a `limit` and
 * `parseListLimit` deliberately imposes no ceiling, because "the call site owns
 * the page size and a cap belongs there, with a reason". This is that call site
 * and this is that reason: a watchlist is a list a household curates by hand, so
 * fifty is comfortably more than any real one and far below any number at which
 * a single response becomes expensive.
 */
export const DEFAULT_WATCHLIST_PAGE_SIZE = 50;

/**
 * The largest page a caller may ask for.
 *
 * The ceiling exists so that `?limit=1000000` is a refusal rather than a query.
 * `parseListLimit` will accept any non-negative safe integer -- correctly, since
 * it is a representability check and not a product decision -- so without a bound
 * here an authenticated caller could ask for an unbounded scan of its own list.
 * Four times the default, so a client paging deliberately is never fighting it.
 */
export const MAX_WATCHLIST_PAGE_SIZE = 200;

export type RequestedLimit =
  | { readonly ok: true; readonly limit: number }
  | { readonly ok: false; readonly detail: string };

/**
 * Turns `?limit=` into the number `listWatchlist` requires.
 *
 * ONLY THE CEILING IS DECIDED HERE. Whether a value is a usable limit at all --
 * `NaN`, a fraction, a negative, 2^53 -- is `parseListLimit`'s, and this
 * function deliberately hands those through unchanged so that
 * `limit_not_representable` has exactly one emitter. A second check here would
 * be a second wording of one refusal, and the one a test exercised would not be
 * the one that ran.
 *
 * An empty `?limit=` becomes `NaN` rather than `0`. `Number("")` is `0`, which
 * would silently turn "the caller stated a limit and it was blank" into "the
 * caller asked for no rows" -- a guess, where the rule for this repository is
 * that unknown is refused rather than defaulted.
 */
export function resolveRequestedLimit(raw: string | null): RequestedLimit {
  if (raw === null) return { ok: true, limit: DEFAULT_WATCHLIST_PAGE_SIZE };

  const limit = raw.trim() === "" ? Number.NaN : Number(raw);
  if (Number.isSafeInteger(limit) && limit > MAX_WATCHLIST_PAGE_SIZE) {
    return {
      ok: false,
      detail: `limit ${String(limit)} exceeds the maximum page of ${String(MAX_WATCHLIST_PAGE_SIZE)}`
    };
  }
  return { ok: true, limit };
}

/* -------------------------------------------------------------------------
 * Reasons
 * ---------------------------------------------------------------------- */

export const watchlistReasonCodeSchema = z.enum([
  /* The shared preamble: storage selection, identity, session. */
  "served_by_postgres_adapter",
  "served_by_in_memory_adapter",
  "database_url_malformed",
  "storage_not_configured",
  "authentication_not_configured",
  "development_identifier_malformed",
  "unexpected_repository_failure",

  /* Request level. */
  "request_malformed",
  "request_field_not_permitted",
  "limit_exceeds_page_maximum",

  /* Grants. */
  "watchlist_listed",

  /* Authorization, in `@liberty/auth`'s own and EXTERNAL vocabularies. */
  "active_profile_of_session",
  "selectable_profile_of_account",
  "no_active_profile_selected",
  "profile_unavailable",
  "profile_archived",
  "requested_profile_is_not_active",

  /* Boundary refusals from the repository. */
  "not_a_normalized_content_id",
  "limit_not_representable",
  "instant_not_representable",

  /* The four mutation outcomes (`WATCHLIST_MUTATION_OUTCOMES`). */
  "added",
  "already_present",
  "removed",
  "not_present"
]);

export type WatchlistReasonCode = z.infer<typeof watchlistReasonCodeSchema>;

/** Compile-time link to the shared preamble's vocabulary. The body is the identity. */
export function watchlistContextReason(code: RequestContextReasonCode): WatchlistReasonCode {
  return code;
}

/**
 * Compile-time link to the four mutation outcomes.
 *
 * `WATCHLIST_MUTATION_OUTCOMES` is exported by `@liberty/persistence` precisely
 * so the set is CLOSED: a fifth outcome fails to compile here rather than
 * reaching a client as an unlisted code.
 */
export function watchlistOutcomeReason(code: WatchlistMutationOutcome): WatchlistReasonCode {
  return code;
}

/** Compile-time link to `resolveWatchlistMutation`'s refusal. */
export function watchlistRejectionReason(code: WatchlistMutationRejection): WatchlistReasonCode {
  return code;
}

/** Compile-time link to the repository's boundary refusal. */
export function watchlistFailureReason(code: WatchlistFailure["reason"]): WatchlistReasonCode {
  return code;
}

/** Compile-time link to `parseListLimit`'s refusal. */
export function watchlistLimitReason(code: ListLimitRejection["reason"]): WatchlistReasonCode {
  return code;
}

/** Compile-time link to `externalProfileAccessReason`. Never the internal vocabulary. */
export function watchlistAccessReason(code: ExternalProfileAccessReason): WatchlistReasonCode {
  return code;
}

/** Compile-time link to an authorization grant. */
export function watchlistGrantReason(code: ProfileAccessGrantReason): WatchlistReasonCode {
  return code;
}

export const watchlistReasonSchema = z
  .object({ code: watchlistReasonCodeSchema, detail: z.string().min(1) })
  .strict();

export type WatchlistReason = ReasonLine<WatchlistReasonCode>;

const reasonsSchema = z.array(watchlistReasonSchema).nonempty();

export function watchlistReason(code: WatchlistReasonCode, detail: string): WatchlistReason {
  return reason(code, detail);
}

/* -------------------------------------------------------------------------
 * The published entry
 * ---------------------------------------------------------------------- */

/**
 * An entry as it appears in a LIST.
 *
 * `profileId` is not published: the client knows which profile it selected, and
 * repeating a profile identifier on every row of every list is the kind of value
 * that ends up in a log by accident.
 *
 * `addedAt` is when the title went on the list, and it is the list's ORDER. It is
 * non-nullable here because a stored row always has one -- the column is
 * `NOT NULL`.
 */
export const watchlistEntryViewSchema = z
  .object({
    contentId: normalizedContentIdSchema,
    addedAt: z.string().datetime()
  })
  .strict();

export type WatchlistEntryView = z.infer<typeof watchlistEntryViewSchema>;

/**
 * An entry as it appears after a MUTATION, where `addedAt` may be unknown.
 *
 * Derived from the list shape rather than written again, so the two cannot
 * disagree about anything but the one field that genuinely differs.
 *
 * `addedAt: null` means "this title is on the list and this response did not read
 * when it was added". It is a real state: the PostgreSQL adapter's
 * `ON CONFLICT DO NOTHING ... RETURNING` proves a row existed without returning
 * it, and substituting the instant of the write that conflicted would fabricate a
 * first-added time wrong by however long the entry has really been there -- and
 * that value is the list's sort key. The in-memory adapter reads the map first
 * and so reports the real value. Both are honest; a client must handle `null`.
 */
export const mutatedWatchlistEntrySchema = watchlistEntryViewSchema.extend({
  addedAt: z.string().datetime().nullable()
});

export type MutatedWatchlistEntry = z.infer<typeof mutatedWatchlistEntrySchema>;

/** A stored row, published. */
export function toWatchlistEntryView(row: WatchlistEntryRow): WatchlistEntryView {
  return { contentId: row.contentId, addedAt: row.addedAt.toISOString() };
}

/* -------------------------------------------------------------------------
 * The response
 * ---------------------------------------------------------------------- */

/**
 * Four outcomes.
 *
 *   - `listed`      -- this profile's watchlist, most recently added first, with
 *                      the page size that was applied. An empty `entries` is a
 *                      real answer meaning "nothing on the list", never a
 *                      failure.
 *   - `mutated`     -- the request was applied, or was already true. `changed`
 *                      distinguishes those, and `reasons[0]` names which of the
 *                      four outcomes it was.
 *   - `refused`     -- we will not: the request is malformed, the page asked for
 *                      is too large, or the profile is not one this session may
 *                      act as.
 *   - `unavailable` -- we would have, and could not.
 *
 * `limit` is echoed on `listed` so that a caller which sent none can tell what
 * was applied without hard-coding this module's default -- and so that a short
 * page is distinguishable from the end of the list.
 */
export const watchlistResponseSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("listed"),
    reasons: reasonsSchema,
    entries: z.array(watchlistEntryViewSchema),
    limit: z.number().int().nonnegative()
  }),
  z.object({
    outcome: z.literal("mutated"),
    reasons: reasonsSchema,
    changed: z.boolean(),
    /** `null` means the title is not on the list now, which is what a remove leaves. */
    entry: mutatedWatchlistEntrySchema.nullable()
  }),
  z.object({ outcome: z.literal("refused"), reasons: reasonsSchema }),
  z.object({ outcome: z.literal("unavailable"), reasons: reasonsSchema })
]);

export type WatchlistResponse = z.infer<typeof watchlistResponseSchema>;

function buildTrail(
  primary: WatchlistReason,
  rest: readonly WatchlistReason[]
): NonEmptyReasons<WatchlistReasonCode> {
  return trail(primary, rest);
}

export function listedWatchlist(
  entries: readonly WatchlistEntryView[],
  limit: number,
  primary: WatchlistReason,
  ...rest: WatchlistReason[]
): WatchlistResponse {
  return {
    outcome: "listed",
    reasons: buildTrail(primary, rest),
    entries: [...entries],
    limit
  };
}

export function mutatedWatchlist(
  changed: boolean,
  entry: MutatedWatchlistEntry | null,
  primary: WatchlistReason,
  ...rest: WatchlistReason[]
): WatchlistResponse {
  return { outcome: "mutated", reasons: buildTrail(primary, rest), changed, entry };
}

export function refusedWatchlist(
  primary: WatchlistReason,
  ...rest: WatchlistReason[]
): WatchlistResponse {
  return { outcome: "refused", reasons: buildTrail(primary, rest) };
}

export function unavailableWatchlist(
  primary: WatchlistReason,
  ...rest: WatchlistReason[]
): WatchlistResponse {
  return { outcome: "unavailable", reasons: buildTrail(primary, rest) };
}

/* -------------------------------------------------------------------------
 * Status
 * ---------------------------------------------------------------------- */

/** Refusals the caller fixes by sending something different. */
const CLIENT_INPUT_REFUSALS: readonly WatchlistReasonCode[] = [
  "request_malformed",
  "request_field_not_permitted",
  "development_identifier_malformed",
  "limit_exceeds_page_maximum",
  "limit_not_representable",
  "not_a_normalized_content_id"
];

/**
 * The HTTP status for a decision.
 *
 * `mutated` is always 200, including `already_present` and `not_present`. A 404
 * for removing something absent would make a retried remove -- the ordinary
 * outcome of a flaky network behind a remote control -- look like a failure, and
 * a 409 for a double tap would make the most forgiving interaction in the product
 * the least.
 *
 * No 201 for `added`, unlike `POST /profiles`. Membership of a set is not a
 * resource with a location, and `PUT` on a path that already names the entry has
 * nowhere new to point a client.
 */
export function watchlistHttpStatus(response: WatchlistResponse): number {
  switch (response.outcome) {
    case "listed":
    case "mutated":
      return 200;
    case "unavailable":
      return 503;
    case "refused": {
      const primary = response.reasons[0].code;
      if (CLIENT_INPUT_REFUSALS.includes(primary)) return 400;
      /*
       * Everything else reaching `refused` is an authorization denial, 403 for
       * all of them including `profile_unavailable` -- a 404 there would restore
       * the enumeration oracle `externalProfileAccessReason` exists to remove.
       */
      return 403;
    }
  }
}
