import type { AccountIdentity, LibertySession, ProfileAccessDecision } from "@liberty/auth";
import { authorizeProfileAccess } from "@liberty/auth";
import {
  resolveRequestAccount,
  type RequestAccountRefusalReason
} from "../session/account";
import { resolveRepository, type RepositoryRefusalReason } from "./index";
import { reason, trail, type NonEmptyReasons, type ReasonLine } from "./reason-trail";
import type { LibertyRepository, RepositoryAdapterId } from "./repository";

/* -------------------------------------------------------------------------
 * The part of every profile/progress/watchlist request that is the same
 *
 * Three things have to happen before any of these routes can do its own work,
 * and all three can fail in ways the caller has to be told about:
 *
 *   1. pick the storage adapter (`lib/db/index.ts`);
 *   2. establish who is asking (`lib/session/account.ts`);
 *   3. build the `LibertySession` every authorization decision is made against,
 *      which requires a read of `active_profile_selection` and therefore
 *      requires (1) and (2) to have succeeded.
 *
 * Written once here rather than three times, because the failure vocabulary is
 * the interesting part and three copies of it would be three chances to answer
 * "no storage" with a different code, or a different status, on different
 * routes.
 *
 * THE ADAPTER LINE IS ATTACHED TO EVERY OUTCOME, success or failure, as soon as
 * it is known. A response that cannot say whether it was answered by PostgreSQL
 * or by a process-local map is a response nobody can debug -- and specifically,
 * an empty watchlist because the development store restarted is indistinguishable
 * from an empty watchlist because the viewer never added anything.
 * ---------------------------------------------------------------------- */

/**
 * The reason codes this module can produce.
 *
 * Every route group's own vocabulary is a superset of this list, and the
 * widening functions in each `contract.ts` are what enforce that: they are
 * identity functions whose only job is to fail to compile if a code here is
 * missing there.
 */
export const REQUEST_CONTEXT_REASON_CODES = [
  /* Which adapter answered. Present on success; never on its own. */
  "served_by_postgres_adapter",
  "served_by_in_memory_adapter",

  /* Storage could not be selected. `lib/db/index.ts` decides these. */
  "database_url_malformed",
  "storage_not_configured",

  /* Nobody could be identified. `lib/session/account.ts` decides these. */
  "authentication_not_configured",
  "development_identifier_malformed",

  /**
   * The adapter threw. Distinct from every refusal above because those are
   * decisions and this is the absence of one -- the operator's remedy is to look
   * at the database, not at the configuration.
   */
  "unexpected_repository_failure"
] as const;

export type RequestContextReasonCode = (typeof REQUEST_CONTEXT_REASON_CODES)[number];

/**
 * Widens a storage refusal into this vocabulary. The body is the identity.
 *
 * It exists as a COMPILE-TIME LINK, the same device `engineReasonCode` is in the
 * playback contract: if `lib/db/index.ts` gains a third refusal reason, this
 * stops assigning and the build fails here, at the one place that would
 * otherwise have to invent a name for it at runtime.
 */
export function repositoryRefusalCode(value: RepositoryRefusalReason): RequestContextReasonCode {
  return value;
}

/** The same guard for `lib/session/account.ts`. */
export function accountRefusalCode(value: RequestAccountRefusalReason): RequestContextReasonCode {
  return value;
}

/**
 * The trail line naming the adapter.
 *
 * A total `switch` with no `default`, so a third adapter id fails to compile
 * here rather than falling through to a catch-all that would report the new
 * adapter as one of the two that exist today.
 */
function adapterReasonCode(adapterId: RepositoryAdapterId): RequestContextReasonCode {
  switch (adapterId) {
    case "postgres":
      return "served_by_postgres_adapter";
    case "in_memory":
      return "served_by_in_memory_adapter";
  }
}

/**
 * Renders a thrown value for a trail WITHOUT publishing its message.
 *
 * A driver exception can carry a host, a port, a database name and -- depending
 * on the driver and the failure -- fragments of the connection string. None of
 * that belongs in a response body. The constructor name is enough to tell a
 * timeout from a syntax error, and server-side logging of the full error is the
 * observability lane's, not a response's.
 */
export function describeThrown(error: unknown): string {
  const kind = error instanceof Error ? error.name : typeof error;
  return `the storage adapter threw ${kind}; the message is deliberately not published, because a driver error can carry connection details`;
}

/**
 * Everything a route needs, once the shared preamble has succeeded.
 *
 * `now` is injected rather than read, because nothing in `@liberty/persistence`
 * calls `new Date()` on its own behalf and every write takes an explicit
 * instant. A handler that read the clock itself would be untestable for exactly
 * the reason the package avoids it.
 */
export interface LibertyRequestContext {
  readonly repository: LibertyRepository;
  readonly session: LibertySession;
  readonly now: () => Date;
  /** Which adapter answered. Belongs on every trail this request produces. */
  readonly adapter: ReasonLine<RequestContextReasonCode>;
}

export type RequestContextResolution =
  | { readonly ok: true; readonly context: LibertyRequestContext }
  | { readonly ok: false; readonly reasons: NonEmptyReasons<RequestContextReasonCode> };

/**
 * What a handler may inject.
 *
 * The same shape `IssueSessionOptions` uses and for the same reason: a Next
 * route module may export only the handlers, so it has nowhere to accept a
 * dependency, and a handler that cannot be given one can only be tested against
 * whatever the deployment happens to be configured with.
 */
export interface RequestContextOptions {
  readonly repository?: LibertyRepository;
  readonly account?: AccountIdentity;
  readonly now?: () => Date;
}

/**
 * Whether a context refusal is the CALLER's to fix, or the service's.
 *
 * The three route groups all publish a discriminated union whose `refused`
 * branch means "change what you asked for" and whose `unavailable` branch means
 * "we would have, and could not" -- the same remedy distinction
 * `playbackSessionResponseSchema` draws, for the same reason: a caller told "try
 * again later" about its own malformed header will keep trying, and one told
 * "fix your request" about an unconfigured database will not.
 *
 * A total `switch` with no `default`, so a code added to this union has to be
 * classified here rather than silently becoming somebody's fault. The two
 * adapter codes answer `false` and are listed rather than omitted: they never
 * reach a refusal at all -- they appear only on a trail that also carries a
 * decision -- and a `default` would make the next code added to the union quietly
 * inherit whichever answer happened to be there.
 */
export function contextRefusalIsClientFault(code: RequestContextReasonCode): boolean {
  switch (code) {
    /* The developer's own typo in a development header, not the operator's problem. */
    case "development_identifier_malformed":
      return true;
    case "served_by_postgres_adapter":
    case "served_by_in_memory_adapter":
    case "database_url_malformed":
    case "storage_not_configured":
    case "authentication_not_configured":
    case "unexpected_repository_failure":
      return false;
  }
}

/**
 * A request body, as `unknown`, with a body that is not JSON treated as a
 * MALFORMED REQUEST rather than a server fault.
 *
 * `request.json()` throws on one, and letting that propagate turns the most
 * trivial client bug into a 500 with no reason trail -- the exact failure shape
 * product invariant 4 exists to forbid. `handler.ts` in `v1/playback/session`
 * makes the same argument and keeps its own copy; this one is shared across the
 * three groups in PL-0402/0403/0404 because three private copies are three
 * chances for one of them to let the throw escape.
 *
 * `null` is not a valid body for any schema here, so a non-JSON body reaches the
 * same `.strict()` object schema every other malformed body does and produces
 * the same well-formed refusal. Nothing inspects `content-type`: the schema is
 * what decides, and a correct body sent with a wrong header is still correct.
 *
 * AN ABSENT BODY IS `{}`, not `null`. `PUT /watchlist/:contentId` and
 * `DELETE /watchlist/:contentId` carry their whole request in the path, so the
 * ordinary client sends no body at all; treating that as `null` would refuse
 * every one of them against a schema whose entire content is "no unknown keys".
 */
export async function readJsonBody(request: Request): Promise<unknown> {
  const raw = await request.text().catch(() => "");
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Resolve storage, identity and session for one request.
 *
 * Storage is resolved FIRST so that an identity failure can still report which
 * adapter would have answered. The reverse order would leave the most common
 * development failure -- a malformed development header -- with no adapter line
 * at all.
 */
export async function resolveRequestContext(
  request: Request,
  options: RequestContextOptions = {}
): Promise<RequestContextResolution> {
  const injectedRepository = options.repository;

  let repository: LibertyRepository;
  let adapterDetail: string;
  if (injectedRepository === undefined) {
    const resolved = resolveRepository();
    if (!resolved.ok) {
      return {
        ok: false,
        reasons: trail(reason(repositoryRefusalCode(resolved.reason), resolved.detail), [])
      };
    }
    repository = resolved.repository;
    adapterDetail = resolved.detail;
  } else {
    repository = injectedRepository;
    adapterDetail = "repository supplied by the caller";
  }

  const adapter = reason(adapterReasonCode(repository.adapterId), adapterDetail);

  const injectedAccount = options.account;
  const identity =
    injectedAccount === undefined
      ? resolveRequestAccount(request)
      : { ok: true as const, account: injectedAccount, detail: "account supplied by the caller" };
  if (!identity.ok) {
    return {
      ok: false,
      reasons: trail(reason(accountRefusalCode(identity.reason), identity.detail), [adapter])
    };
  }

  try {
    /*
     * `activeProfileId` comes from `active_profile_selection` and from nowhere
     * else. There is no parameter on this path through which a caller could
     * supply one, which is the absence `resolveLibertySession` exists to
     * maintain: a client-chosen active profile would make every authorization
     * comparison a comparison against a value the client picked.
     */
    const session = await repository.resolveSession(identity.account);
    return {
      ok: true,
      context: {
        repository,
        session,
        now: options.now ?? (() => new Date()),
        adapter
      }
    };
  } catch (error) {
    return {
      ok: false,
      reasons: trail(reason("unexpected_repository_failure", describeThrown(error)), [adapter])
    };
  }
}

/**
 * The authorization decision for "act as the profile this session selected".
 *
 * THE ROUTE NEVER NAMES A PROFILE, and that is the whole design. The requested
 * profile is `session.activeProfileId`, which was written by
 * `selectActiveProfile` and is server-side state; a header or body field through
 * which a client could name one would make `authorizeProfileAccess` compare a
 * requested profile against a value the client chose, which is precisely the
 * arrangement `resolveLibertySession` exists to prevent.
 *
 * `?? ""` is unreachable as a value. `authorizeProfileAccess` tests
 * `session.activeProfileId === null` as its FIRST check and returns
 * `no_active_profile_selected` before `requestedProfileId` is read, so the empty
 * string is never compared against anything. It is written this way rather than
 * as a hand-built denial because the decision -- including its trail and its
 * check order -- belongs to `@liberty/auth`, and a second construction of it
 * here would be a second thing to keep in step.
 */
export async function resolveActiveProfileScope(
  context: LibertyRequestContext
): Promise<ProfileAccessDecision<"active_profile_of_session">> {
  const active = context.session.activeProfileId;
  const ownership = active === null ? null : await context.repository.loadProfileOwnership(active);
  return authorizeProfileAccess({
    session: context.session,
    requestedProfileId: active ?? "",
    ownership
  });
}
