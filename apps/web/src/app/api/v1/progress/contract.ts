import type { ExternalProfileAccessReason, ProfileAccessGrantReason } from "@liberty/auth";
import { normalizedContentIdSchema } from "@liberty/contracts/shared/ids";
import type {
  PlaybackProgressRow,
  ProgressRepositoryFailure,
  ProgressWriteAcceptance,
  ProgressWriteNote,
  ProgressWriteRejection,
  StoredProgress
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
 * The progress wire contract (PL-0403)
 *
 * WHY THIS LIVES HERE rather than in `@liberty/contracts`: the same reason
 * `v1/playback/session/contract.ts` and `v1/profiles/contract.ts` record, and
 * the same follow-up.
 *
 * THERE IS NO FIELD HERE THROUGH WHICH A CLIENT CAN ASSERT A TIME, AND THERE
 * MUST NEVER BE ONE. `writer-epoch.ts` opens by rejecting "latest client
 * timestamp wins" -- a device an hour fast wins every argument forever, a device
 * an hour slow can never write again -- and it asserts the absence of such a
 * field with a test, because a field added "just for diagnostics" is how the
 * rejected design comes back. `ProgressWriteRequest` below has no timestamp, no
 * `updatedAt`, and nowhere to put one; the instant a row is stamped with comes
 * from the server.
 *
 * NOR IS THERE ONE THROUGH WHICH A CLIENT NAMES A PROFILE. Progress is scoped to
 * the profile this session SELECTED, read from `active_profile_selection`. A
 * client-chosen profile would make every authorization comparison a comparison
 * against a value the client picked.
 *
 * WHAT A CLIENT MAY ASSERT is the lease it was issued -- `{ epoch, writerId }`,
 * both server-minted -- and a sequence number within it. That is the whole
 * authority surface, and it works precisely because the server is comparing
 * values it issued against values it issued.
 * ---------------------------------------------------------------------- */

/* -------------------------------------------------------------------------
 * Requests
 * ---------------------------------------------------------------------- */

/**
 * Ask for the right to write progress for a title on this device.
 *
 * `writerId` identifies the DEVICE, not the viewer, and the client chooses it.
 * That is safe and is the point: it is one half of a pair whose other half --
 * the epoch -- only the server can issue, so guessing "the current epoch is
 * probably 7" earns a `writer_id_mismatch` rather than a successful clobber.
 *
 * `.strict()`, so a client that believed it could also send a position, a
 * timestamp or a profile id is TOLD the field is not accepted rather than having
 * it silently stripped.
 */
export const writerLeaseRequestSchema = z.object({ writerId: z.string().min(1) }).strict();

export type WriterLeaseRequest = z.infer<typeof writerLeaseRequestSchema>;

/**
 * Record a position.
 *
 * `.strict()` at BOTH levels -- the outer object and `lease` -- because a nested
 * object left open is the half of the boundary people forget, and it is the half
 * a smuggled field would most plausibly hide in.
 *
 * `epoch` and `writeSeq` are bounded by the schema because their SHAPE is a wire
 * question: a fractional or negative counter is not a value this protocol has,
 * and refusing it here keeps `resolveProgressWrite` reasoning about ordering
 * rather than about representability. `epoch` allows 0, which is "never leased"
 * and earns the resolver's `epoch_not_issued`.
 *
 * `positionSeconds` is deliberately NOT bounded here, and the asymmetry is the
 * point: `resolveProgressWrite` owns it, reports `position_not_representable`
 * and `position_beyond_runtime` as distinct reasons, and a schema rule would
 * collapse both into `request_malformed`. The schema owns shape; the resolver
 * owns the rule.
 *
 * `runtimeSeconds` is REQUIRED AND NULLABLE. `null` means "this client does not
 * know the runtime", which is a different statement from an absent key, and the
 * resolver acts on the difference: a null runtime must not overwrite a known one
 * (`retained_known_runtime`).
 */
export const progressWriteRequestSchema = z
  .object({
    lease: z
      .object({
        epoch: z.number().int().nonnegative(),
        writerId: z.string().min(1)
      })
      .strict(),
    writeSeq: z.number().int().nonnegative(),
    positionSeconds: z.number(),
    runtimeSeconds: z.number().nullable()
  })
  .strict();

export type ProgressWriteRequest = z.infer<typeof progressWriteRequestSchema>;

/* -------------------------------------------------------------------------
 * Reasons
 * ---------------------------------------------------------------------- */

/**
 * The closed reason vocabulary for this group.
 *
 * The rejection, note and acceptance sections are spelled EXACTLY as
 * `@liberty/persistence`'s own `ProgressWriteRejection`, `ProgressWriteNote` and
 * `ProgressWriteAcceptance`, because a reason translated on the way out
 * eventually stops matching what the code did. The widening functions below are
 * what stop the spellings drifting.
 *
 * THE NOTES ARE PUBLISHED AS REASONS, and that is deliberate rather than
 * incidental. `retained_known_runtime` and `position_moved_backwards` are things
 * the write did that did not change the verdict, and `writer-epoch.ts` states
 * why they exist at all: a grant that quietly discarded information is as hard to
 * debug as an unexplained denial. A client that cannot see
 * `retained_known_runtime` will conclude the server ignored its runtime.
 */
export const progressReasonCodeSchema = z.enum([
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

  /* Grants. */
  "progress_read",
  "progress_absent",
  "writer_lease_issued",
  "progress_written",

  /* Authorization, in `@liberty/auth`'s own and EXTERNAL vocabularies. */
  "active_profile_of_session",
  "selectable_profile_of_account",
  "no_active_profile_selected",
  "profile_unavailable",
  "profile_archived",
  "requested_profile_is_not_active",

  /* Boundary refusals from the repository. */
  "not_a_normalized_content_id",

  /* The writer-epoch verdict (`ProgressWriteRejection` and its acceptance). */
  "instant_not_representable",
  "no_writer_lease",
  "epoch_not_issued",
  "superseded_by_newer_writer",
  "writer_id_mismatch",
  "stale_write_within_writer",
  "position_not_representable",
  "position_beyond_runtime",
  "current_writer",

  /* Things the accepted write did (`ProgressWriteNote`). */
  "retained_known_runtime",
  "runtime_restated",
  "position_moved_backwards",
  "position_first_reported"
]);

export type ProgressReasonCode = z.infer<typeof progressReasonCodeSchema>;

/** Compile-time link to the shared preamble's vocabulary. The body is the identity. */
export function progressContextReason(code: RequestContextReasonCode): ProgressReasonCode {
  return code;
}

/** Compile-time link to `resolveProgressWrite`'s refusals. */
export function progressRejectionReason(code: ProgressWriteRejection): ProgressReasonCode {
  return code;
}

/** Compile-time link to its acceptance. */
export function progressAcceptanceReason(code: ProgressWriteAcceptance): ProgressReasonCode {
  return code;
}

/** Compile-time link to its notes. */
export function progressNoteReason(code: ProgressWriteNote): ProgressReasonCode {
  return code;
}

/** Compile-time link to the repository's boundary refusals. */
export function progressFailureReason(code: ProgressRepositoryFailure["reason"]): ProgressReasonCode {
  return code;
}

/** Compile-time link to `externalProfileAccessReason`. Never the internal vocabulary. */
export function progressAccessReason(code: ExternalProfileAccessReason): ProgressReasonCode {
  return code;
}

/** Compile-time link to an authorization grant. */
export function progressGrantReason(code: ProfileAccessGrantReason): ProgressReasonCode {
  return code;
}

export const progressReasonSchema = z
  .object({ code: progressReasonCodeSchema, detail: z.string().min(1) })
  .strict();

export type ProgressReason = ReasonLine<ProgressReasonCode>;

const reasonsSchema = z.array(progressReasonSchema).nonempty();

export function progressReason(code: ProgressReasonCode, detail: string): ProgressReason {
  return reason(code, detail);
}

/* -------------------------------------------------------------------------
 * The published row
 * ---------------------------------------------------------------------- */

/**
 * A progress row as a client may see it.
 *
 * `profileId` is NOT published. The client already knows which profile it
 * selected, and echoing the id back into every heartbeat response would put a
 * profile identifier into request logs at the highest request rate in the
 * product.
 *
 * `positionSeconds` is nullable and `null` IS NOT ZERO. A row created by a lease
 * has no position: the title has been claimed for writing and nothing has been
 * watched. A client reading `null` as `0` would resume a title at the beginning
 * that the viewer had never started, and would show it as "continue watching" at
 * 0:00.
 *
 * `runtimeSeconds` is nullable for the neighbouring reason PL-0205 establishes:
 * an absent duration must not be inferred, and a zero here would make every
 * title look complete.
 *
 * The lease fields are published because the client needs them to write: it
 * echoes `writerEpoch`/`writerId` back and increments `writeSeq`. They are not a
 * credential -- holding them lets a device write progress for a profile it is
 * ALREADY authorized for, and nothing else.
 */
export const progressViewSchema = z
  .object({
    contentId: normalizedContentIdSchema,
    positionSeconds: z.number().int().nonnegative().nullable(),
    runtimeSeconds: z.number().int().positive().nullable(),
    writerEpoch: z.number().int().positive(),
    writerId: z.string().min(1),
    writeSeq: z.number().int().nonnegative(),
    updatedAt: z.string().datetime()
  })
  .strict();

export type ProgressView = z.infer<typeof progressViewSchema>;

/** A stored row, published. */
export function toProgressView(row: PlaybackProgressRow): ProgressView {
  return {
    contentId: row.contentId,
    positionSeconds: row.positionSeconds,
    runtimeSeconds: row.runtimeSeconds,
    writerEpoch: row.writerEpoch,
    writerId: row.writerId,
    writeSeq: row.writeSeq,
    updatedAt: row.updatedAt.toISOString()
  };
}

/**
 * The resolver's post-write state, published.
 *
 * Built from `StoredProgress` rather than by re-reading the row, because the
 * resolver's `next` IS what was written and a second read could legitimately
 * return a newer row -- which would mean answering this request with somebody
 * else's write. `contentId` is supplied separately because `StoredProgress` does
 * not carry one: it is the shape the pure resolver reasons about, and a content
 * id is not a term in any of its comparisons.
 *
 * `updatedAt` is carried through verbatim rather than re-formatted.
 * `representableInstant` already guarantees it is the canonical `toISOString()`
 * spelling, and re-parsing it here would be a second opportunity to produce a
 * different one.
 */
export function storedProgressView(contentId: string, stored: StoredProgress): ProgressView {
  return {
    contentId,
    positionSeconds: stored.positionSeconds,
    runtimeSeconds: stored.runtimeSeconds,
    writerEpoch: stored.writerEpoch,
    writerId: stored.writerId,
    writeSeq: stored.writeSeq,
    updatedAt: stored.updatedAt
  };
}

/** A lease, published. Both halves are server-issued. */
export const writerLeaseViewSchema = z
  .object({ epoch: z.number().int().positive(), writerId: z.string().min(1) })
  .strict();

export type WriterLeaseView = z.infer<typeof writerLeaseViewSchema>;

/* -------------------------------------------------------------------------
 * The response
 * ---------------------------------------------------------------------- */

/**
 * Five outcomes.
 *
 *   - `read`        -- here is the resume point, or `null` for "this profile has
 *                      no row for this title". `null` is an ANSWER, not a
 *                      failure: a title nobody has started is the ordinary case
 *                      and a 404 would make every client treat it as an error.
 *   - `leased`      -- this device may now write, at this epoch.
 *   - `written`     -- the position was recorded. `progress` is the row as it now
 *                      stands, and the trail carries the notes.
 *   - `refused`     -- we will not. The request is malformed, the profile is not
 *                      one this session may act as, or this device lost the
 *                      lease. Retrying an identical request changes nothing --
 *                      but taking a new lease is a legitimate next step, and the
 *                      reason code is what tells the client which case it is in.
 *   - `unavailable` -- we would have, and could not.
 */
export const progressResponseSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("read"),
    reasons: reasonsSchema,
    progress: progressViewSchema.nullable()
  }),
  z.object({
    outcome: z.literal("leased"),
    reasons: reasonsSchema,
    lease: writerLeaseViewSchema
  }),
  z.object({
    outcome: z.literal("written"),
    reasons: reasonsSchema,
    progress: progressViewSchema
  }),
  z.object({ outcome: z.literal("refused"), reasons: reasonsSchema }),
  z.object({ outcome: z.literal("unavailable"), reasons: reasonsSchema })
]);

export type ProgressResponse = z.infer<typeof progressResponseSchema>;

function buildTrail(
  primary: ProgressReason,
  rest: readonly ProgressReason[]
): NonEmptyReasons<ProgressReasonCode> {
  return trail(primary, rest);
}

export function readProgressResult(
  progress: ProgressView | null,
  primary: ProgressReason,
  ...rest: ProgressReason[]
): ProgressResponse {
  return { outcome: "read", reasons: buildTrail(primary, rest), progress };
}

export function issuedWriterLease(
  lease: WriterLeaseView,
  primary: ProgressReason,
  ...rest: ProgressReason[]
): ProgressResponse {
  return { outcome: "leased", reasons: buildTrail(primary, rest), lease };
}

export function writtenProgress(
  progress: ProgressView,
  primary: ProgressReason,
  ...rest: ProgressReason[]
): ProgressResponse {
  return { outcome: "written", reasons: buildTrail(primary, rest), progress };
}

export function refusedProgress(
  primary: ProgressReason,
  ...rest: ProgressReason[]
): ProgressResponse {
  return { outcome: "refused", reasons: buildTrail(primary, rest) };
}

export function unavailableProgress(
  primary: ProgressReason,
  ...rest: ProgressReason[]
): ProgressResponse {
  return { outcome: "unavailable", reasons: buildTrail(primary, rest) };
}

/* -------------------------------------------------------------------------
 * Status
 * ---------------------------------------------------------------------- */

/** Refusals the caller fixes by sending something different. */
const CLIENT_INPUT_REFUSALS: readonly ProgressReasonCode[] = [
  "request_malformed",
  "request_field_not_permitted",
  "development_identifier_malformed",
  "not_a_normalized_content_id",
  "position_not_representable",
  "position_beyond_runtime"
];

/**
 * Refusals about WHO holds the write.
 *
 * 409 rather than 403: the caller is authorized for this profile and its request
 * is well-formed; what it has lost is the lease. The remedy is to take a new one,
 * which is a different action from "you may not touch this profile" and belongs
 * behind a different status. `no_writer_lease` is included because it is the same
 * remedy reached from the other end -- there is no lease to have lost yet.
 */
const WRITE_CONFLICT_REFUSALS: readonly ProgressReasonCode[] = [
  "no_writer_lease",
  "epoch_not_issued",
  "superseded_by_newer_writer",
  "writer_id_mismatch",
  "stale_write_within_writer"
];

/**
 * The HTTP status for a decision.
 *
 * Derived from the response rather than chosen at each return site, so the wire
 * status and the outcome cannot disagree.
 *
 * `read` with `progress: null` is a 200. It is a true and complete answer -- "no
 * row for this profile and title" -- and a 404 would make the most common state
 * in the product, a title nobody has started, look like an error to every
 * client's fetch wrapper.
 */
export function progressHttpStatus(response: ProgressResponse): number {
  switch (response.outcome) {
    case "read":
    case "leased":
    case "written":
      return 200;
    case "unavailable":
      return 503;
    case "refused": {
      const primary = response.reasons[0].code;
      if (CLIENT_INPUT_REFUSALS.includes(primary)) return 400;
      if (WRITE_CONFLICT_REFUSALS.includes(primary)) return 409;
      /*
       * Everything else reaching `refused` is an authorization denial, 403 for
       * all of them including `profile_unavailable` -- a 404 there would restore
       * the enumeration oracle `externalProfileAccessReason` exists to remove.
       */
      return 403;
    }
  }
}
