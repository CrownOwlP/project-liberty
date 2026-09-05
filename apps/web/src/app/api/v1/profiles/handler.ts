import { authorizeProfileSelection, externalProfileAccessReason } from "@liberty/auth";
import {
  requestIssueTrail,
  type NonEmptyReasons
} from "../../../../lib/db/reason-trail";
import {
  contextRefusalIsClientFault,
  describeThrown,
  readJsonBody,
  resolveRequestContext,
  type LibertyRequestContext,
  type RequestContextOptions,
  type RequestContextReasonCode
} from "../../../../lib/db/request-context";
import {
  createProfileRequestSchema,
  createdProfile,
  listedProfiles,
  profileAccessReason,
  profileCreationReason,
  profileGrantReason,
  profileScopeReason,
  profilesContextReason,
  profilesHttpStatus,
  profilesReason,
  profilesResponseSchema,
  refusedProfiles,
  selectProfileRequestSchema,
  selectedProfile,
  toProfileView,
  unavailableProfiles,
  type ProfilesReason,
  type ProfilesReasonCode,
  type ProfilesResponse
} from "./contract";

/* -------------------------------------------------------------------------
 * The HTTP half of the profile endpoints (PL-0402)
 *
 * Separated from the route modules because a Next route module may export only
 * the handlers and a fixed set of segment config values -- so a route file has
 * nowhere to accept an injected repository, and testing one would mean testing
 * it against whatever storage the process happens to have resolved. These
 * functions take `RequestContextOptions`; the route modules are the two- and
 * three-line adapters that supply none.
 *
 * THREE ENDPOINTS, ONE RESPONSE UNION. `listed`, `created` and `selected` are
 * branches of `profilesResponseSchema` rather than three separate contracts,
 * because all three share the whole refusal surface -- storage, identity,
 * authorization -- and three schemas would be three places for that surface to
 * drift.
 * ---------------------------------------------------------------------- */

/**
 * Never cached, at any layer.
 *
 * A profile list is a household's roster and the active selection is
 * per-session. A shared cache holding either would serve one household's
 * profiles to another, which is the confidentiality boundary this whole task
 * exists to establish rather than a performance question.
 */
const NO_STORE = { "cache-control": "no-store" };

/** Which adapter answered, as a line of THIS group's trail. */
function adapterLine(context: LibertyRequestContext): ProfilesReason {
  return profilesReason(profilesContextReason(context.adapter.code), context.adapter.detail);
}

/**
 * Turns the shared preamble's refusal into this group's response.
 *
 * The remedy distinction is `contextRefusalIsClientFault`'s to make, not this
 * function's: a malformed development header is the caller's to fix (`refused`,
 * 400) and an unconfigured database is not (`unavailable`, 503). Deciding it
 * here would be a second classification of one question.
 */
function fromContextRefusal(
  reasons: NonEmptyReasons<RequestContextReasonCode>
): ProfilesResponse {
  const [head, ...tail] = reasons;
  const primary = profilesReason(profilesContextReason(head.code), head.detail);
  const rest = tail.map((line) =>
    profilesReason(profilesContextReason(line.code), line.detail)
  );
  return contextRefusalIsClientFault(head.code)
    ? refusedProfiles(primary, ...rest)
    : unavailableProfiles(primary, ...rest);
}

/**
 * Validates the response against the published contract before it leaves the
 * server.
 *
 * The reason is not paranoia about our own object literals: `reasons` being
 * non-empty on every branch is a product invariant, and an invariant nothing
 * checks at runtime is one a later refactor can quietly drop. A regression
 * surfaces here as a 500 with a stable code rather than as a decision nobody can
 * explain.
 *
 * That 500 is the one response in this group that is not a member of the union,
 * and that is deliberate: it is not a decision about profiles at all, it is a
 * statement that this service produced something it is not allowed to say.
 */
function respond(response: ProfilesResponse): Response {
  const parsed = profilesResponseSchema.safeParse(response);
  if (!parsed.success) {
    return Response.json(
      { error: "profiles_response_failed_validation", issues: parsed.error.issues },
      { status: 500, headers: NO_STORE }
    );
  }
  const validated: ProfilesResponse = parsed.data;
  return Response.json(validated, {
    status: profilesHttpStatus(validated),
    headers: NO_STORE
  });
}

/** GET /api/v1/profiles */
export async function handleListProfiles(
  request: Request,
  options: RequestContextOptions = {}
): Promise<Response> {
  const resolved = await resolveRequestContext(request, options);
  if (!resolved.ok) return respond(fromContextRefusal(resolved.reasons));
  const { context } = resolved;

  try {
    const rows = await context.repository.listProfilesForAccount(context.session);
    return respond(
      listedProfiles(
        rows.map(toProfileView),
        /*
         * From the session, which read `active_profile_selection`. `null` means
         * "signed in, nothing chosen" -- the profile picker's own state, and the
         * reason this field is nullable rather than optional.
         */
        context.session.activeProfileId,
        profilesReason(
          "profiles_listed",
          `${String(rows.length)} live profile(s) for this account; archived profiles are not listed`
        ),
        adapterLine(context)
      )
    );
  } catch (error) {
    return respond(
      unavailableProfiles(
        profilesReason("unexpected_repository_failure", describeThrown(error)),
        adapterLine(context)
      )
    );
  }
}

/** POST /api/v1/profiles */
export async function handleCreateProfile(
  request: Request,
  options: RequestContextOptions = {}
): Promise<Response> {
  const resolved = await resolveRequestContext(request, options);
  if (!resolved.ok) return respond(fromContextRefusal(resolved.reasons));
  const { context } = resolved;

  const parsed = createProfileRequestSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) {
    /*
     * The type argument is stated rather than inferred. `Code` appears in two
     * properties of one object, so inference would have to pick a common
     * supertype of two unrelated string literals; naming the group's vocabulary
     * makes the result the union the response schema expects, at every call site
     * that does this.
     */
    const [head, ...tail] = requestIssueTrail<ProfilesReasonCode>(
      parsed.error.issues,
      { malformed: "request_malformed", fieldNotPermitted: "request_field_not_permitted" },
      "the request did not match the profile creation contract"
    );
    return respond(refusedProfiles(head, ...tail, adapterLine(context)));
  }

  try {
    const creation = await context.repository.createProfile({
      /*
       * The owner comes from the SESSION. There is no field in the request
       * schema through which a caller could name one, and `createProfile` reads
       * `input.session.account.userId` rather than anything from the body --
       * two independent reasons one account cannot create a profile inside
       * another's household.
       */
      session: context.session,
      displayName: parsed.data.displayName,
      avatarKey: parsed.data.avatarKey,
      maxRating: parsed.data.maxRating,
      /* Explicit instant: nothing in `@liberty/persistence` reads a clock. */
      instant: context.now()
    });

    if (!creation.ok) {
      return respond(
        refusedProfiles(
          profilesReason(profileCreationReason(creation.reason), creation.detail),
          adapterLine(context)
        )
      );
    }

    return respond(
      createdProfile(
        toProfileView(creation.profile),
        profilesReason(
          "profile_created",
          `profile ${creation.profile.id} created; it is not selected until this session selects it`
        ),
        adapterLine(context)
      )
    );
  } catch (error) {
    return respond(
      unavailableProfiles(
        profilesReason("unexpected_repository_failure", describeThrown(error)),
        adapterLine(context)
      )
    );
  }
}

/**
 * POST /api/v1/profiles/selection
 *
 * THE ONE ENDPOINT IN THE PRODUCT WHERE A CLIENT NAMES A PROFILE, and that is
 * legitimate: choosing is what the picker does, and `authorizeProfileSelection`
 * exists precisely because selection cannot require the profile to already be
 * active without making selection impossible. Every OTHER profile-scoped route
 * reads the active profile from `active_profile_selection`, which is server-side
 * state written only by this call.
 */
export async function handleSelectProfile(
  request: Request,
  options: RequestContextOptions = {}
): Promise<Response> {
  const resolved = await resolveRequestContext(request, options);
  if (!resolved.ok) return respond(fromContextRefusal(resolved.reasons));
  const { context } = resolved;

  const parsed = selectProfileRequestSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) {
    const [head, ...tail] = requestIssueTrail<ProfilesReasonCode>(
      parsed.error.issues,
      { malformed: "request_malformed", fieldNotPermitted: "request_field_not_permitted" },
      "the request did not match the profile selection contract"
    );
    return respond(refusedProfiles(head, ...tail, adapterLine(context)));
  }

  try {
    const ownership = await context.repository.loadProfileOwnership(parsed.data.profileId);
    const decision = authorizeProfileSelection({ session: context.session, ownership });

    if (!decision.allowed) {
      return respond(
        refusedProfiles(
          profilesReason(
            /*
             * Through `externalProfileAccessReason`, never raw. The internal
             * vocabulary distinguishes "no such profile" from "not yours", and
             * publishing that distinction would hand an authenticated caller an
             * oracle for whether a profile id exists anywhere in the product.
             */
            profileAccessReason(externalProfileAccessReason(decision.reason)),
            "this session may not act as that profile"
          ),
          adapterLine(context)
        )
      );
    }

    const selection = await context.repository.selectActiveProfile({
      session: context.session,
      /* The scope is the DECISION's, never fabricated here. */
      scope: decision.scope,
      instant: context.now()
    });

    if (!selection.ok) {
      return respond(
        refusedProfiles(
          profilesReason(profileScopeReason(selection.reason), selection.detail),
          adapterLine(context)
        )
      );
    }

    return respond(
      selectedProfile(
        selection.profileId,
        profilesReason(
          "profile_selected",
          `this session is now acting as profile ${selection.profileId}`
        ),
        profilesReason(
          profileGrantReason(decision.reason),
          "the profile is owned by this account and is live, so this session may select it"
        ),
        adapterLine(context)
      )
    );
  } catch (error) {
    return respond(
      unavailableProfiles(
        profilesReason("unexpected_repository_failure", describeThrown(error)),
        adapterLine(context)
      )
    );
  }
}
