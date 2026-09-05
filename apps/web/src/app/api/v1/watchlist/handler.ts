import {
  externalProfileAccessReason,
  type ProfileAccessDecision,
  type ProfileAccessGrant
} from "@liberty/auth";
import type {
  ListLimitRejection,
  WatchlistEntryRow,
  WatchlistFailure,
  WatchlistMutation,
  WatchlistMutationOutcome
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
  listedWatchlist,
  mutatedWatchlist,
  refusedWatchlist,
  resolveRequestedLimit,
  toWatchlistEntryView,
  unavailableWatchlist,
  watchlistAccessReason,
  watchlistContextReason,
  watchlistFailureReason,
  watchlistGrantReason,
  watchlistHttpStatus,
  watchlistLimitReason,
  watchlistMutationRequestSchema,
  watchlistOutcomeReason,
  watchlistReason,
  watchlistRejectionReason,
  watchlistResponseSchema,
  type WatchlistReason,
  type WatchlistReasonCode,
  type WatchlistResponse
} from "./contract";

/* -------------------------------------------------------------------------
 * The HTTP half of the watchlist endpoints (PL-0404)
 *
 * Separated from the route modules for the reason `v1/playback/session/handler.ts`
 * gives, and `contentId` arrives as an argument for the reason
 * `v1/progress/handler.ts` gives.
 *
 * NOTHING HERE DECIDES WHAT A MUTATION MEANT. `resolveWatchlistMutation` owns
 * the four outcomes and is the only place they are named, so this file cannot
 * invent a fifth spelling of "nothing happened". What it adds is the sentence a
 * human reads and the status a client branches on.
 * ---------------------------------------------------------------------- */

/**
 * Never cached, at any layer.
 *
 * A watchlist is per-profile. A shared cache holding one would show one
 * household's list to another, which is the confidentiality boundary the whole
 * profile model exists to establish -- and a stale one would show a viewer a
 * title they just removed.
 */
const NO_STORE = { "cache-control": "no-store" };

function adapterLine(context: LibertyRequestContext): WatchlistReason {
  return watchlistReason(watchlistContextReason(context.adapter.code), context.adapter.detail);
}

/** The grant that authorised this request, or the denial that stopped it. */
function grantLine(decision: ProfileAccessDecision<"active_profile_of_session">): WatchlistReason {
  return decision.allowed
    ? watchlistReason(
        watchlistGrantReason(decision.reason),
        "the requested profile is the one this session selected, and this account owns it"
      )
    : watchlistReason(
        watchlistAccessReason(externalProfileAccessReason(decision.reason)),
        "this session may not act on that profile"
      );
}

function fromContextRefusal(
  reasons: NonEmptyReasons<RequestContextReasonCode>
): WatchlistResponse {
  const [head, ...tail] = reasons;
  const primary = watchlistReason(watchlistContextReason(head.code), head.detail);
  const rest = tail.map((line) => watchlistReason(watchlistContextReason(line.code), line.detail));
  return contextRefusalIsClientFault(head.code)
    ? refusedWatchlist(primary, ...rest)
    : unavailableWatchlist(primary, ...rest);
}

/**
 * `listWatchlist` answers rows or a limit refusal, and the two are told apart by
 * shape.
 *
 * A user-defined guard rather than an inline `Array.isArray`, because
 * `Array.isArray` narrows a `readonly T[]` union member to `any[]` and loses the
 * element type. Inside the predicate the check is an ordinary boolean, so the
 * quirk cannot reach the caller.
 */
function isListLimitRejection(
  result: readonly WatchlistEntryRow[] | ListLimitRejection
): result is ListLimitRejection {
  return !Array.isArray(result);
}

/**
 * A mutation answers a resolution or a boundary refusal.
 *
 * `WatchlistMutationResolution` discriminates on `accepted` and `WatchlistFailure`
 * on `ok`, so neither carries the other's key. A predicate rather than an inline
 * `in` test: `in` narrowing on the true branch produces an intersection rather
 * than the failure type, and reading `.detail` off that does not compile.
 */
function isWatchlistFailure(result: WatchlistMutation): result is WatchlistFailure {
  return "ok" in result;
}

/**
 * What a mutation did, in a sentence.
 *
 * A total `switch` with no `default`, so a fifth outcome added to
 * `WATCHLIST_MUTATION_OUTCOMES` fails to compile here rather than reaching a
 * client with an empty detail.
 */
function explainOutcome(outcome: WatchlistMutationOutcome): string {
  switch (outcome) {
    case "added":
      return "the title was put on this profile's list";
    case "already_present":
      return "the title was already on this profile's list; addedAt was not moved, so the list was not reordered";
    case "removed":
      return "the title was taken off this profile's list";
    case "not_present":
      return "the title was not on this profile's list; removing something absent is a success, not a failure";
  }
}

function respond(response: WatchlistResponse): Response {
  const parsed = watchlistResponseSchema.safeParse(response);
  if (!parsed.success) {
    return Response.json(
      { error: "watchlist_response_failed_validation", issues: parsed.error.issues },
      { status: 500, headers: NO_STORE }
    );
  }
  const validated: WatchlistResponse = parsed.data;
  return Response.json(validated, {
    status: watchlistHttpStatus(validated),
    headers: NO_STORE
  });
}

/** GET /api/v1/watchlist?limit= */
export async function handleListWatchlist(
  request: Request,
  options: RequestContextOptions = {}
): Promise<Response> {
  const resolved = await resolveRequestContext(request, options);
  if (!resolved.ok) return respond(fromContextRefusal(resolved.reasons));
  const { context } = resolved;

  const requested = resolveRequestedLimit(new URL(request.url).searchParams.get("limit"));
  if (!requested.ok) {
    return respond(
      refusedWatchlist(
        watchlistReason("limit_exceeds_page_maximum", requested.detail),
        adapterLine(context)
      )
    );
  }

  try {
    const decision = await resolveActiveProfileScope(context);
    if (!decision.allowed) {
      return respond(refusedWatchlist(grantLine(decision), adapterLine(context)));
    }

    const result = await context.repository.listWatchlist({
      scope: decision.scope,
      limit: requested.limit
    });

    if (isListLimitRejection(result)) {
      return respond(
        refusedWatchlist(
          watchlistReason(watchlistLimitReason(result.reason), result.detail),
          grantLine(decision),
          adapterLine(context)
        )
      );
    }

    return respond(
      listedWatchlist(
        result.map(toWatchlistEntryView),
        requested.limit,
        watchlistReason(
          "watchlist_listed",
          `${String(result.length)} entr(y|ies) on this profile's list, most recently added first, at a page of ${String(requested.limit)}`
        ),
        grantLine(decision),
        adapterLine(context)
      )
    );
  } catch (error) {
    return respond(
      unavailableWatchlist(
        watchlistReason("unexpected_repository_failure", describeThrown(error)),
        adapterLine(context)
      )
    );
  }
}

/**
 * The half of add and remove that is identical.
 *
 * `mutate` receives the authorized scope and performs exactly one repository
 * call. Written this way rather than as two copies because everything except
 * that one call -- the preamble, the body check, the outcome mapping, the status
 * -- is the same, and two copies would be two places for the idempotence rules
 * to stop agreeing.
 */
async function handleWatchlistMutation(
  request: Request,
  contentId: string,
  options: RequestContextOptions,
  fallbackDetail: string,
  mutate: (
    context: LibertyRequestContext,
    grant: ProfileAccessGrant<"active_profile_of_session">
  ) => Promise<WatchlistMutation>
): Promise<Response> {
  const resolved = await resolveRequestContext(request, options);
  if (!resolved.ok) return respond(fromContextRefusal(resolved.reasons));
  const { context } = resolved;

  const parsed = watchlistMutationRequestSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) {
    const [head, ...tail] = requestIssueTrail<WatchlistReasonCode>(
      parsed.error.issues,
      { malformed: "request_malformed", fieldNotPermitted: "request_field_not_permitted" },
      fallbackDetail
    );
    return respond(refusedWatchlist(head, ...tail, adapterLine(context)));
  }

  try {
    const decision = await resolveActiveProfileScope(context);
    if (!decision.allowed) {
      return respond(refusedWatchlist(grantLine(decision), adapterLine(context)));
    }

    const result = await mutate(context, decision);

    if (isWatchlistFailure(result)) {
      return respond(
        refusedWatchlist(
          watchlistReason(watchlistFailureReason(result.reason), result.detail),
          grantLine(decision),
          adapterLine(context)
        )
      );
    }

    if (!result.accepted) {
      /*
       * `instant_not_representable` only. It means the instant the SERVER was
       * going to stamp `added_at` with names no moment -- `context.now()`, which
       * no client can influence -- so it is `unavailable` rather than `refused`:
       * reporting our own broken clock as a malformed request would send a
       * developer to fix a body that was correct.
       */
      return respond(
        unavailableWatchlist(
          watchlistReason(watchlistRejectionReason(result.reason), result.detail),
          grantLine(decision),
          adapterLine(context)
        )
      );
    }

    return respond(
      mutatedWatchlist(
        result.changed,
        /*
         * `contentId` comes from the path and is a NORMALIZED id by the time this
         * runs: the repository calls `parseContentId` first and returns
         * `not_a_normalized_content_id` otherwise, so an accepted mutation cannot
         * carry an id the response schema would reject.
         */
        result.next === null ? null : { contentId, addedAt: result.next.addedAt },
        watchlistReason(watchlistOutcomeReason(result.reason), explainOutcome(result.reason)),
        grantLine(decision),
        adapterLine(context)
      )
    );
  } catch (error) {
    return respond(
      unavailableWatchlist(
        watchlistReason("unexpected_repository_failure", describeThrown(error)),
        adapterLine(context)
      )
    );
  }
}

/** PUT /api/v1/watchlist/{contentId} */
export async function handleAddToWatchlist(
  request: Request,
  contentId: string,
  options: RequestContextOptions = {}
): Promise<Response> {
  return handleWatchlistMutation(
    request,
    contentId,
    options,
    "the request body must be empty or an empty JSON object",
    async (context, grant) =>
      context.repository.addToWatchlist({
        scope: grant.scope,
        contentId,
        /* Explicit instant: nothing in `@liberty/persistence` reads a clock. */
        instant: context.now()
      })
  );
}

/** DELETE /api/v1/watchlist/{contentId} */
export async function handleRemoveFromWatchlist(
  request: Request,
  contentId: string,
  options: RequestContextOptions = {}
): Promise<Response> {
  return handleWatchlistMutation(
    request,
    contentId,
    options,
    "the request body must be empty or an empty JSON object",
    async (context, grant) =>
      /*
       * No instant. `removeFromWatchlist` takes none, and `WatchlistMutationIntent`
       * carries one on `add` and not on `remove` deliberately: a parameter that is
       * accepted and unused is one somebody eventually populates and expects to
       * matter, which is how `removed_at` becomes a client-supplied clock.
       */
      context.repository.removeFromWatchlist({ scope: grant.scope, contentId })
  );
}
