import { externalProfileAccessReason, type ProfileAccessDecision } from "@liberty/auth";
import type {
  PlaybackProgressRow,
  ProgressRepositoryFailure,
  ProgressWriteNote,
  ProgressWriteRejection,
  ProgressWriteResolution
} from "@liberty/persistence";
import {
  requestIssueTrail,
  type NonEmptyReasons
} from "../../../../lib/db/reason-trail";
import {
  contextRefusalIsClientFault,
  describeThrown,
  readJsonBody,
  resolveActiveProfileScope,
  resolveRequestContext,
  type LibertyRequestContext,
  type RequestContextOptions,
  type RequestContextReasonCode
} from "../../../../lib/db/request-context";
import {
  issuedWriterLease,
  progressAccessReason,
  progressAcceptanceReason,
  progressContextReason,
  progressFailureReason,
  progressGrantReason,
  progressHttpStatus,
  progressNoteReason,
  progressReason,
  progressRejectionReason,
  progressResponseSchema,
  progressWriteRequestSchema,
  readProgressResult,
  refusedProgress,
  storedProgressView,
  toProgressView,
  unavailableProgress,
  writerLeaseRequestSchema,
  writtenProgress,
  type ProgressReason,
  type ProgressReasonCode,
  type ProgressResponse
} from "./contract";

/* -------------------------------------------------------------------------
 * The HTTP half of the progress endpoints (PL-0403)
 *
 * Separated from the route modules for the reason `v1/playback/session/handler.ts`
 * gives: a Next route module may export only the handlers, so it has nowhere to
 * accept an injected repository, and a route that cannot be given one can only
 * be tested against whatever storage the process resolved.
 *
 * `contentId` arrives as an ARGUMENT rather than being read from the request
 * URL, because the route module is what owns the dynamic segment and awaiting
 * `params` inside a testable function would mean every test constructing a
 * promise-shaped context object for no gain.
 *
 * NOTHING HERE DECIDES A CONFLICT. Whether a write wins is
 * `resolveProgressWrite`'s, reached through the repository; this file turns its
 * verdict into a status and a sentence. That split is why the verdict is
 * testable without PostgreSQL and why there is exactly one implementation of the
 * writer-epoch rule.
 * ---------------------------------------------------------------------- */

/**
 * Never cached, at any layer.
 *
 * A resume point is per-profile and changes on a heartbeat. A shared cache
 * holding one would serve one household's viewing position to another and would
 * make the freshest data in the product the stalest.
 */
const NO_STORE = { "cache-control": "no-store" };

function adapterLine(context: LibertyRequestContext): ProgressReason {
  return progressReason(progressContextReason(context.adapter.code), context.adapter.detail);
}

/** The grant that authorised this request, as a trail line. */
function grantLine(decision: ProfileAccessDecision<"active_profile_of_session">): ProgressReason {
  return decision.allowed
    ? progressReason(
        progressGrantReason(decision.reason),
        "the requested profile is the one this session selected, and this account owns it"
      )
    : progressReason(
        progressAccessReason(externalProfileAccessReason(decision.reason)),
        "this session may not act on that profile"
      );
}

function fromContextRefusal(
  reasons: NonEmptyReasons<RequestContextReasonCode>
): ProgressResponse {
  const [head, ...tail] = reasons;
  const primary = progressReason(progressContextReason(head.code), head.detail);
  const rest = tail.map((line) => progressReason(progressContextReason(line.code), line.detail));
  return contextRefusalIsClientFault(head.code)
    ? refusedProgress(primary, ...rest)
    : unavailableProgress(primary, ...rest);
}

/**
 * `readProgress` answers a ROW or a boundary refusal, and neither carries a
 * discriminant the other lacks.
 *
 * A user-defined guard rather than an inline `"ok" in result`, because `in`
 * narrowing on the TRUE branch produces an intersection with
 * `Record<"ok", unknown>` rather than the failure type, and reading `.detail`
 * off that is a compile error that reads as though the failure type were wrong.
 * A predicate states the answer once, where the claim it makes is checkable:
 * `PlaybackProgressRow` is derived from the table and has no `ok` column.
 */
function isRepositoryFailure(
  result: PlaybackProgressRow | ProgressRepositoryFailure
): result is ProgressRepositoryFailure {
  return "ok" in result;
}

/**
 * The same distinction on the write path.
 *
 * `ProgressWriteResolution` discriminates on `accepted` and the failure on `ok`,
 * so neither carries the other's key. A predicate rather than an inline `in`
 * test, for the reason above.
 */
function isWriteFailure(
  result: ProgressWriteResolution | ProgressRepositoryFailure
): result is ProgressRepositoryFailure {
  return "ok" in result;
}

/**
 * A boundary refusal from the repository, as a response.
 *
 * `instant_not_representable` is routed to `unavailable` and everything else to
 * `refused`, and the split is not cosmetic. That reason means the instant the
 * SERVER was going to stamp the row with names no moment -- it is
 * `context.now()`, and there is no field through which a client could influence
 * it. Reporting our own broken clock as the caller's malformed request would
 * send a developer to fix a body that was correct.
 */
function fromRepositoryFailure(
  context: LibertyRequestContext,
  grant: ProgressReason,
  failure: ProgressRepositoryFailure
): ProgressResponse {
  const line = progressReason(progressFailureReason(failure.reason), failure.detail);
  return failure.reason === "instant_not_representable"
    ? unavailableProgress(line, grant, adapterLine(context))
    : refusedProgress(line, grant, adapterLine(context));
}

/**
 * Why a write lost, in a sentence.
 *
 * A total `switch` with no `default`, so a ninth rejection added to
 * `ProgressWriteRejection` fails to compile here rather than reaching a client
 * as an empty detail. The resolver returns a CODE and a check trail and no prose
 * -- deliberately, since prose in a pure decision module is prose that has to be
 * translated -- so the sentence is written at the boundary that publishes it.
 *
 * THE PER-CHECK TRAIL IS NOT PUBLISHED. `resolution.trail` records every check
 * that ran and whether it passed, and it is reconstructible from the reason
 * alone: `PROGRESS_WRITE_CHECK_ORDER` is exported, the checks run in that order,
 * and the reported reason is the first one that failed. Publishing it would
 * multiply the size of a heartbeat response by the length of a list the client
 * already has.
 */
function explainRejection(rejection: ProgressWriteRejection): string {
  switch (rejection) {
    case "instant_not_representable":
      return "the server's own stamp for this write named no moment; this is a fault here, not in the request";
    case "no_writer_lease":
      return "no lease has been issued for this title on this profile; ask for one before writing";
    case "epoch_not_issued":
      return "the epoch claimed is higher than any this server issued for this title";
    case "superseded_by_newer_writer":
      return "another device took over playback of this title; this lease is no longer current";
    case "writer_id_mismatch":
      return "the epoch is current but was issued to a different writer";
    case "stale_write_within_writer":
      return "this write's sequence number is not ahead of the last one recorded for this lease";
    case "position_not_representable":
      return "positionSeconds must be a whole, non-negative number of seconds";
    case "position_beyond_runtime":
      return "positionSeconds is past the end of the runtime this write states";
  }
}

/**
 * What an accepted write did that did not change the verdict, in a sentence.
 *
 * Published for the reason `writer-epoch.ts` gives for producing the notes at
 * all: a grant that quietly discarded information is as hard to debug as an
 * unexplained denial. A client that sent `runtimeSeconds: null` and cannot see
 * `retained_known_runtime` will conclude the server dropped its runtime.
 */
function explainNote(note: ProgressWriteNote): string {
  switch (note) {
    case "retained_known_runtime":
      return "this write stated no runtime, so the runtime already recorded was kept";
    case "runtime_restated":
      return "this write stated a different runtime, and its value was stored";
    case "position_moved_backwards":
      return "the accepted position is behind the stored one; a rewind is legitimate and is not refused";
    case "position_first_reported":
      return "the stored row had no position at all; this is the first write to report one";
  }
}

function respond(response: ProgressResponse): Response {
  const parsed = progressResponseSchema.safeParse(response);
  if (!parsed.success) {
    return Response.json(
      { error: "progress_response_failed_validation", issues: parsed.error.issues },
      { status: 500, headers: NO_STORE }
    );
  }
  const validated: ProgressResponse = parsed.data;
  return Response.json(validated, {
    status: progressHttpStatus(validated),
    headers: NO_STORE
  });
}

/** GET /api/v1/progress/{contentId} */
export async function handleReadProgress(
  request: Request,
  contentId: string,
  options: RequestContextOptions = {}
): Promise<Response> {
  const resolved = await resolveRequestContext(request, options);
  if (!resolved.ok) return respond(fromContextRefusal(resolved.reasons));
  const { context } = resolved;

  try {
    const decision = await resolveActiveProfileScope(context);
    if (!decision.allowed) return respond(refusedProgress(grantLine(decision), adapterLine(context)));

    const result = await context.repository.readProgress({ scope: decision.scope, contentId });

    /*
     * `null` is an ANSWER: this profile has no row for this title. Checked before
     * the failure guard because `null` is not an object and `in` would throw on
     * it.
     */
    if (result === null) {
      return respond(
        readProgressResult(
          null,
          progressReason(
            "progress_absent",
            `this profile has no progress row for ${contentId}; nothing has been watched and nothing has been leased`
          ),
          grantLine(decision),
          adapterLine(context)
        )
      );
    }

    if (isRepositoryFailure(result)) {
      return respond(fromRepositoryFailure(context, grantLine(decision), result));
    }

    return respond(
      readProgressResult(
        toProgressView(result),
        progressReason(
          "progress_read",
          `the resume point recorded for ${result.contentId} on this profile`
        ),
        grantLine(decision),
        adapterLine(context)
      )
    );
  } catch (error) {
    return respond(
      unavailableProgress(
        progressReason("unexpected_repository_failure", describeThrown(error)),
        adapterLine(context)
      )
    );
  }
}

/**
 * POST /api/v1/progress/{contentId}/lease
 *
 * The endpoint that makes every other progress write possible: a write with no
 * lease is refused with `no_writer_lease`, by design, so that ordering comes
 * from a counter the SERVER allocated rather than from a clock the client
 * controls.
 */
export async function handleIssueWriterLease(
  request: Request,
  contentId: string,
  options: RequestContextOptions = {}
): Promise<Response> {
  const resolved = await resolveRequestContext(request, options);
  if (!resolved.ok) return respond(fromContextRefusal(resolved.reasons));
  const { context } = resolved;

  const parsed = writerLeaseRequestSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) {
    const [head, ...tail] = requestIssueTrail<ProgressReasonCode>(
      parsed.error.issues,
      { malformed: "request_malformed", fieldNotPermitted: "request_field_not_permitted" },
      "the request did not match the writer lease contract"
    );
    return respond(refusedProgress(head, ...tail, adapterLine(context)));
  }

  try {
    const decision = await resolveActiveProfileScope(context);
    if (!decision.allowed) return respond(refusedProgress(grantLine(decision), adapterLine(context)));

    const lease = await context.repository.issueWriterLease({
      scope: decision.scope,
      contentId,
      writerId: parsed.data.writerId,
      /* Explicit instant: nothing in `@liberty/persistence` reads a clock. */
      instant: context.now()
    });

    if (!lease.ok) return respond(fromRepositoryFailure(context, grantLine(decision), lease));

    return respond(
      issuedWriterLease(
        { epoch: lease.epoch, writerId: lease.writerId },
        progressReason(
          "writer_lease_issued",
          `writer ${lease.writerId} holds epoch ${String(lease.epoch)} for ${contentId}; echo both on every write and increment writeSeq`
        ),
        grantLine(decision),
        adapterLine(context)
      )
    );
  } catch (error) {
    return respond(
      unavailableProgress(
        progressReason("unexpected_repository_failure", describeThrown(error)),
        adapterLine(context)
      )
    );
  }
}

/** PUT /api/v1/progress/{contentId} */
export async function handleWriteProgress(
  request: Request,
  contentId: string,
  options: RequestContextOptions = {}
): Promise<Response> {
  const resolved = await resolveRequestContext(request, options);
  if (!resolved.ok) return respond(fromContextRefusal(resolved.reasons));
  const { context } = resolved;

  const parsed = progressWriteRequestSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) {
    const [head, ...tail] = requestIssueTrail<ProgressReasonCode>(
      parsed.error.issues,
      { malformed: "request_malformed", fieldNotPermitted: "request_field_not_permitted" },
      "the request did not match the progress write contract"
    );
    return respond(refusedProgress(head, ...tail, adapterLine(context)));
  }

  try {
    const decision = await resolveActiveProfileScope(context);
    if (!decision.allowed) return respond(refusedProgress(grantLine(decision), adapterLine(context)));

    const result = await context.repository.writeProgress({
      scope: decision.scope,
      contentId,
      /*
       * Handed to the repository exactly as parsed. There is no field here the
       * server rewrites and none the client can add: `progressWriteRequestSchema`
       * is `.strict()` at both levels, and `ProgressWrite` has nowhere to put a
       * client timestamp.
       */
      write: {
        lease: parsed.data.lease,
        writeSeq: parsed.data.writeSeq,
        positionSeconds: parsed.data.positionSeconds,
        runtimeSeconds: parsed.data.runtimeSeconds
      },
      instant: context.now()
    });

    if (isWriteFailure(result)) {
      return respond(fromRepositoryFailure(context, grantLine(decision), result));
    }

    if (!result.accepted) {
      const line = progressReason(
        progressRejectionReason(result.reason),
        explainRejection(result.reason)
      );
      /*
       * The one rejection that is OURS rather than the caller's; see
       * `fromRepositoryFailure` for the same split on the same reason code.
       */
      return respond(
        result.reason === "instant_not_representable"
          ? unavailableProgress(line, grantLine(decision), adapterLine(context))
          : refusedProgress(line, grantLine(decision), adapterLine(context))
      );
    }

    const notes = result.notes.map((note) =>
      progressReason(progressNoteReason(note), explainNote(note))
    );

    return respond(
      writtenProgress(
        /*
         * `contentId` is the path segment, and it is a NORMALIZED id by the time
         * this line runs: the repository calls `parseContentId` first and returns
         * `not_a_normalized_content_id` if it is not, so an accepted write cannot
         * carry an id the response schema would reject.
         */
        storedProgressView(contentId, result.next),
        progressReason(
          "progress_written",
          `position ${String(result.next.positionSeconds)}s recorded for ${contentId} at writeSeq ${String(result.next.writeSeq)}`
        ),
        progressReason(
          progressAcceptanceReason(result.reason),
          "this device holds the current lease for this title"
        ),
        ...notes,
        grantLine(decision),
        adapterLine(context)
      )
    );
  } catch (error) {
    return respond(
      unavailableProgress(
        progressReason("unexpected_repository_failure", describeThrown(error)),
        adapterLine(context)
      )
    );
  }
}
