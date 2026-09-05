import type { ExternalProfileAccessReason, ProfileAccessGrantReason } from "@liberty/auth";
import type {
  ProfileCreationRefusalReason,
  ProfileRow,
  ScopeMismatch
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
 * The profile wire contract (PL-0402)
 *
 * WHY THIS LIVES HERE AND NOT IN `@liberty/contracts`, which is where
 * docs/API_CONTRACTS.md says wire schemas belong: the same reason
 * `v1/playback/session/contract.ts` records, and this file inherits both the
 * decision and the follow-up. `@liberty/contracts` is the module every other
 * lane compiles against, this task's declared surface is `apps/web`, and the
 * move is mechanical -- nothing below imports anything from this app except the
 * two shared modules under `lib/db/`, which are themselves app-local. It is
 * follow-up, not a decision to keep the contract in the route.
 *
 * WHAT A CALLER GETS. Exactly one of five outcomes, discriminated on `outcome`,
 * with a NON-EMPTY `reasons` on every one of them. The three groups added by
 * PL-0402/0403/0404 all take that shape from `playbackSessionResponseSchema`,
 * and the argument is unchanged: a refusal with no trail is unanswerable by the
 * viewer, unactionable by support and undebuggable by us, and an invariant that
 * lives in a convention is one a later refactor drops. Here it lives in the type
 * -- `reasons` is a non-empty tuple on each branch, so a branch without a trail
 * is not constructible -- and in the runtime check `handler.ts` performs on the
 * way out.
 *
 * `reasons[0]` is the PRIMARY reason, the one that decided the outcome. The rest
 * are context, and the FIRST piece of context is always which storage adapter
 * answered.
 *
 * THE DENIAL VOCABULARY IS THE EXTERNAL ONE. `@liberty/auth` distinguishes
 * `profile_not_found` from `profile_not_owned_by_account` internally, and
 * publishing that distinction would hand an authenticated caller an oracle for
 * whether a profile id exists anywhere in the product. `externalProfileAccessReason`
 * collapses the two into `profile_unavailable`, and `profileAccessReason` below
 * is typed so that only the collapsed vocabulary can reach this schema.
 * ---------------------------------------------------------------------- */

/* -------------------------------------------------------------------------
 * Requests
 * ---------------------------------------------------------------------- */

/**
 * What a client may send to create a profile.
 *
 * `.strict()`, and it is enforcement rather than decoration. Zod's default is to
 * STRIP unknown keys, so a client posting `{ displayName, userId: "someone-else" }`
 * would get a perfectly successful creation and no indication that the field it
 * believed in was discarded -- and the next person to add a field here would be
 * one keystroke from honouring it. The owner comes from the SESSION and there is
 * no field through which a caller can name one; refusing the request is how that
 * boundary becomes observable from outside.
 *
 * `displayName` is a plain `z.string()` with NO length or blankness rule. That is
 * deliberate: `resolveProfileCreation` owns those, it reports
 * `display_name_is_blank` and `display_name_too_long` as distinct reasons with
 * details naming the limit, and a schema rule here would collapse all of that
 * into `request_malformed`. The schema's job is the SHAPE; the resolver's job is
 * the rule, and there is exactly one of each.
 *
 * `avatarKey` and `maxRating` are REQUIRED AND NULLABLE rather than optional, the
 * rule this repository states for unknown facts: `null` says "this profile has
 * no avatar", an absent key says only that somebody did not think about it.
 */
export const createProfileRequestSchema = z
  .object({
    displayName: z.string(),
    avatarKey: z.string().nullable(),
    maxRating: z.string().nullable()
  })
  .strict();

export type CreateProfileRequest = z.infer<typeof createProfileRequestSchema>;

/**
 * What a client may send to choose the profile this session acts as.
 *
 * `profileId` is a plain string, and the absence of a UUID pattern here is
 * deliberate for the reason above: `isMintedProfileId` in
 * `@liberty/persistence` is the single authority on what a minted profile id
 * looks like, `loadProfileOwnership` consults it before issuing any query, and
 * an id that fails it comes back as `profile_unavailable` -- the same answer a
 * well-formed id belonging to another household gets, which is exactly the
 * non-oracle behaviour the external vocabulary exists to produce. A second
 * pattern here would be a second authority, and it would answer
 * `request_malformed` where the first answers `profile_unavailable`, which is
 * itself a small oracle.
 */
export const selectProfileRequestSchema = z.object({ profileId: z.string() }).strict();

export type SelectProfileRequest = z.infer<typeof selectProfileRequestSchema>;

/* -------------------------------------------------------------------------
 * Reasons
 * ---------------------------------------------------------------------- */

/**
 * The closed reason vocabulary for this group.
 *
 * Codes rather than sentences, for the reason `domains/failover.ts` argues at
 * length: a consumer that decides anything by matching prose turns a reworded
 * message into a behaviour change nothing can see. `detail` beside it is for
 * humans and is never parsed.
 *
 * Four of the five sections are spelled EXACTLY as the vocabularies they carry
 * -- `RequestContextReasonCode`, `ProfileCreationRefusalReason`,
 * `ExternalProfileAccessReason` and `ScopeMismatch["reason"]` -- because a
 * reason translated on the way out eventually stops matching what the code did.
 * The four widening functions below are what stop the spellings drifting.
 */
export const profilesReasonCodeSchema = z.enum([
  /* The shared preamble: storage selection, identity, session. */
  "served_by_postgres_adapter",
  "served_by_in_memory_adapter",
  "database_url_malformed",
  "storage_not_configured",
  "authentication_not_configured",
  "development_identifier_malformed",
  "unexpected_repository_failure",

  /* Request level. Nothing about a specific profile. */
  "request_malformed",
  "request_field_not_permitted",

  /* Grants. */
  "profiles_listed",
  "profile_created",
  "profile_selected",

  /* Creation refusals, decided by `@liberty/persistence`. */
  "profile_limit_reached",
  "display_name_is_blank",
  "display_name_too_long",
  "avatar_key_too_long",
  "max_rating_too_long",
  "display_name_already_used",

  /*
   * Authorization GRANTS, in `@liberty/auth`'s own vocabulary. Published because
   * invariant 4 applies to a grant exactly as much as to a denial: "which
   * decision let this through" is the question a support engineer asks second,
   * and the two grants have different preconditions -- `selectable_profile_of_account`
   * is reachable when nothing is active, `active_profile_of_session` is not.
   */
  "active_profile_of_session",
  "selectable_profile_of_account",

  /* Authorization denials, in `@liberty/auth`'s EXTERNAL vocabulary. */
  "no_active_profile_selected",
  "profile_unavailable",
  "profile_archived",
  "requested_profile_is_not_active",

  /* A scope used under a session it was not granted to. */
  "scope_not_granted_to_this_session"
]);

export type ProfilesReasonCode = z.infer<typeof profilesReasonCodeSchema>;

/**
 * Widens a shared-preamble reason into this vocabulary. The body is the
 * identity, and that is the point.
 *
 * It exists as a COMPILE-TIME LINK, the device `engineReasonCode` uses in the
 * playback contract: if `request-context.ts` gains a code, this stops assigning
 * and the build fails here, at the one place that would otherwise have to invent
 * a name for it at runtime. Without it the new code would reach a response as an
 * unlisted string, the response would fail its own schema on the way out, and a
 * correct refusal would surface to the caller as a 500.
 */
export function profilesContextReason(code: RequestContextReasonCode): ProfilesReasonCode {
  return code;
}

/** The same guard for `resolveProfileCreation` and `createProfile`. */
export function profileCreationReason(code: ProfileCreationRefusalReason): ProfilesReasonCode {
  return code;
}

/** The same guard for `externalProfileAccessReason`. */
export function profileAccessReason(code: ExternalProfileAccessReason): ProfilesReasonCode {
  return code;
}

/**
 * The same guard for a GRANT.
 *
 * Typed against `ProfileAccessGrantReason` rather than the two literals, so a
 * third grant added to `PROFILE_ACCESS_GRANT_REASONS` fails to compile here
 * instead of reaching a response as an unlisted code.
 */
export function profileGrantReason(code: ProfileAccessGrantReason): ProfilesReasonCode {
  return code;
}

/** The same guard for the scope check both profile-scoped writes run first. */
export function profileScopeReason(code: ScopeMismatch["reason"]): ProfilesReasonCode {
  return code;
}

/** One line of the trail. `detail` is `.min(1)`; `reason()` is what guarantees it. */
export const profilesReasonSchema = z
  .object({
    code: profilesReasonCodeSchema,
    detail: z.string().min(1)
  })
  .strict();

export type ProfilesReason = ReasonLine<ProfilesReasonCode>;

/** Declared once and reused by every branch, so no branch can be relaxed alone. */
const reasonsSchema = z.array(profilesReasonSchema).nonempty();

/* -------------------------------------------------------------------------
 * The published profile
 * ---------------------------------------------------------------------- */

/**
 * A profile as a client may see it.
 *
 * DELIBERATELY NOT THE ROW. `user_id` is the account identifier and is never
 * published: nothing a client does with a profile needs it, and a household's
 * account id in a response body is the kind of value that ends up in a URL, a
 * log or an analytics event.
 *
 * `archivedAt` is also absent, and for a different reason. Every profile this
 * group can return is live -- `listProfilesForAccount` filters archived rows in
 * the WHERE clause and a just-created profile cannot be archived -- so the field
 * would be `null` in every response ever produced here. A field that is
 * constantly `null` invites a client to build an archived-profile view against
 * an endpoint that will never populate it. When archiving gets an endpoint, the
 * field arrives with it.
 *
 * `avatarKey` is an opaque storage key and NOT a URL, matching the column: a URL
 * here would be a caller-supplied string rendered into an `<img src>`.
 */
export const profileViewSchema = z
  .object({
    id: z.string().min(1),
    displayName: z.string().min(1),
    avatarKey: z.string().min(1).nullable(),
    maxRating: z.string().min(1).nullable(),
    createdAt: z.string().datetime()
  })
  .strict();

export type ProfileView = z.infer<typeof profileViewSchema>;

/** The one place a stored row becomes a published profile. */
export function toProfileView(row: ProfileRow): ProfileView {
  return {
    id: row.id,
    displayName: row.displayName,
    avatarKey: row.avatarKey,
    maxRating: row.maxRating,
    createdAt: row.createdAt.toISOString()
  };
}

/* -------------------------------------------------------------------------
 * The response
 * ---------------------------------------------------------------------- */

/**
 * Five outcomes. The distinction between the last two is a REMEDY distinction
 * rather than a severity one, the same one the playback contract draws:
 *
 *   - `listed`      -- these are the account's profiles, and this is the one it
 *                      is currently acting as.
 *   - `created`     -- a profile now exists.
 *   - `selected`    -- this session is now acting as that profile.
 *   - `refused`     -- we will not. Either the request is not one we accept, the
 *                      account is at its ceiling, or the profile is not one this
 *                      session may act as. Retrying changes nothing.
 *   - `unavailable` -- we would have, and could not: no storage is configured,
 *                      no identity can be established, or the adapter threw.
 *                      Retrying later is sometimes reasonable.
 *
 * `activeProfileId` on `listed` is `null` for "signed in, nothing chosen yet",
 * which is a real and common state -- it is the profile picker -- and is exactly
 * why `LibertySession.activeProfileId` is nullable rather than optional.
 *
 * THE ORDER OF `profiles` IS PART OF THIS CONTRACT: OLDEST FIRST, by creation
 * time. The consumer is a profile picker, and a picker is muscle memory -- a
 * household aims at the tile its profile has always been on. Newest-first would
 * move every existing profile one place along the moment somebody adds one, and
 * an unordered list would let the picker reshuffle between two renders of the
 * same screen. Oldest-first is the only one of the three under which a tile
 * stays where the household left it.
 *
 * IT IS STATED HERE SO IT IS A PROMISE RATHER THAN AN AGREEMENT BETWEEN TWO
 * IMPLEMENTATIONS. Both adapters already sort on the same two keys --
 * `listProfilesForAccount` in `@liberty/persistence` issues
 * `ORDER BY created_at, id`, and the in-memory adapter's `liveProfilesOf`
 * compares `createdAt` then `id` -- but two implementations that happen to agree
 * are free to stop agreeing, and neither of them is a thing a client may read.
 * `listedProfiles` below copies the repository's array without re-sorting it, so
 * this branch publishes exactly the repository's order.
 *
 * `id` IS ONLY THE TIE-BREAK, AND IT IS AN ARBITRARY ONE. It is there because
 * `created_at` alone is not a total order, and a list without a total order may
 * come back differently on two reads that saw identical data. But a
 * profile id is a random UUID (`newProfileId` is `crypto.randomUUID`), so two
 * profiles created in the SAME instant come back in a stable but meaningless
 * order rather than in the order they were created. Nothing stored anywhere can
 * recover creation order for that case -- there is no sequence column on
 * `profile` -- so what is promised is precisely "oldest first, ties stable", not
 * "insertion order". Distinct instants are the ordinary case: `created_at` is
 * `timestamp with time zone` and each request reads the clock separately.
 */
export const profilesResponseSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("listed"),
    reasons: reasonsSchema,
    profiles: z.array(profileViewSchema),
    activeProfileId: z.string().min(1).nullable()
  }),
  z.object({
    outcome: z.literal("created"),
    reasons: reasonsSchema,
    profile: profileViewSchema
  }),
  z.object({
    outcome: z.literal("selected"),
    reasons: reasonsSchema,
    profileId: z.string().min(1)
  }),
  z.object({ outcome: z.literal("refused"), reasons: reasonsSchema }),
  z.object({ outcome: z.literal("unavailable"), reasons: reasonsSchema })
]);

export type ProfilesResponse = z.infer<typeof profilesResponseSchema>;

/**
 * The five constructors.
 *
 * Each takes the primary reason as a REQUIRED positional argument, so a branch
 * without a trail cannot be written down. That is the "enforced by the type
 * rather than by convention" half of the invariant; the schema check in
 * `handler.ts` is the other half, for values that arrive from elsewhere.
 */
export function listedProfiles(
  profiles: readonly ProfileView[],
  activeProfileId: string | null,
  primary: ProfilesReason,
  ...rest: ProfilesReason[]
): ProfilesResponse {
  return {
    outcome: "listed",
    reasons: buildTrail(primary, rest),
    /*
     * Copied, never re-sorted. The order is the repository's -- oldest first,
     * as the union's comment promises -- and a sort here would be a second
     * opinion about it that only one of the two adapters would ever be tested
     * against.
     */
    profiles: [...profiles],
    activeProfileId
  };
}

export function createdProfile(
  profile: ProfileView,
  primary: ProfilesReason,
  ...rest: ProfilesReason[]
): ProfilesResponse {
  return { outcome: "created", reasons: buildTrail(primary, rest), profile };
}

export function selectedProfile(
  profileId: string,
  primary: ProfilesReason,
  ...rest: ProfilesReason[]
): ProfilesResponse {
  return { outcome: "selected", reasons: buildTrail(primary, rest), profileId };
}

export function refusedProfiles(
  primary: ProfilesReason,
  ...rest: ProfilesReason[]
): ProfilesResponse {
  return { outcome: "refused", reasons: buildTrail(primary, rest) };
}

export function unavailableProfiles(
  primary: ProfilesReason,
  ...rest: ProfilesReason[]
): ProfilesResponse {
  return { outcome: "unavailable", reasons: buildTrail(primary, rest) };
}

/** Local name for the shared helper, so the constructors above read as one thing. */
function buildTrail(
  primary: ProfilesReason,
  rest: readonly ProfilesReason[]
): NonEmptyReasons<ProfilesReasonCode> {
  return trail(primary, rest);
}

/** Re-exported so a caller building a reason does not also have to find `reason`. */
export function profilesReason(code: ProfilesReasonCode, detail: string): ProfilesReason {
  return reason(code, detail);
}

/* -------------------------------------------------------------------------
 * Status
 * ---------------------------------------------------------------------- */

/**
 * Refusals that are the CALLER's malformed input rather than a decision about a
 * profile.
 *
 * Kept apart because the status codes mean different things downstream: a 400
 * tells a client to fix its request and tells a dashboard nothing about
 * authorization, while a 403 is an authorization signal.
 */
const CLIENT_INPUT_REFUSALS: readonly ProfilesReasonCode[] = [
  "request_malformed",
  "request_field_not_permitted",
  "development_identifier_malformed",
  "display_name_is_blank",
  "display_name_too_long",
  "avatar_key_too_long",
  "max_rating_too_long"
];

/**
 * Refusals about the STATE the account is already in, rather than the request.
 *
 * 409 rather than 400: the request is well-formed and would have been accepted a
 * moment ago or against a different account. Telling a household at its ceiling
 * that its request is malformed sends somebody to correct a form that was never
 * the problem.
 */
const STATE_CONFLICT_REFUSALS: readonly ProfilesReasonCode[] = [
  "profile_limit_reached",
  "display_name_already_used"
];

/**
 * The HTTP status for a decision.
 *
 * Derived from the response rather than chosen at each return site, so the wire
 * status and the outcome cannot disagree. Reads `reasons[0]`, which the
 * non-empty tuple makes safe without a guard.
 *
 * `created` answers 201 and the other two grants answer 200. 201 is the honest
 * status for the one call in this group that brings a resource into existence,
 * and a client that distinguishes "created" from "already fine" gets that
 * distinction for free.
 */
export function profilesHttpStatus(response: ProfilesResponse): number {
  switch (response.outcome) {
    case "created":
      return 201;
    case "listed":
    case "selected":
      return 200;
    case "unavailable":
      /*
       * Always 503, never 500: none of the conditions that reach this branch is
       * a fault in handling THIS request, and all of them are things an operator
       * can act on. A 500 would tell a client the server broke.
       */
      return 503;
    case "refused": {
      const primary = response.reasons[0].code;
      if (CLIENT_INPUT_REFUSALS.includes(primary)) return 400;
      if (STATE_CONFLICT_REFUSALS.includes(primary)) return 409;
      /*
       * Everything else that reaches `refused` is an authorization denial, and
       * 403 is deliberate for all of them INCLUDING `profile_unavailable`. A 404
       * there would restore exactly the oracle `externalProfileAccessReason`
       * collapsed the reason codes to remove: the status would tell a caller
       * whether a profile id exists.
       */
      return 403;
    }
  }
}
