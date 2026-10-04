import { externalProfileAccessReason, type ProfileAccessDecision } from "@liberty/auth";
import {
  NO_MEDIA_PREFERENCES,
  mediaPreferencesReason
} from "@liberty/contracts/domains/preferences";

import type { NonEmptyReasons } from "../../../../../lib/db/reason-trail";
import {
  contextRefusalIsClientFault,
  describeThrown,
  readJsonBody,
  resolveActiveProfileScope,
  resolveRequestContext,
  type LibertyRequestContext,
  type RequestContextOptions,
  type RequestContextReasonCode
} from "../../../../../lib/db/request-context";
import {
  forgottenPreferences,
  preferencesAccessReason,
  preferencesBodyReason,
  preferencesContextReason,
  preferencesGrantReason,
  preferencesHttpStatus,
  preferencesReason,
  preferencesResponseSchema,
  putPreferencesRequestSchema,
  readPreferences,
  refusedPreferences,
  unavailablePreferences,
  writtenPreferences,
  type PreferencesReason,
  type PreferencesResponse
} from "./contract";

/* -------------------------------------------------------------------------
 * GET / PUT / DELETE /api/v1/profiles/preferences (PL-0723)
 *
 * ==========================================================================
 * THE PROFILE IS THE SESSION'S ACTIVE ONE AND IS NEVER IN THE REQUEST
 * ==========================================================================
 *
 * There is no profile id in the path, in the query or in the body, and that is
 * the security design rather than an abbreviation. `resolveActiveProfileScope`
 * reads the active profile from the session, loads its ownership and puts it
 * through `authorizeProfileAccess`; the `ProfileScope` that comes back is the
 * only thing the repository will accept, and it cannot be constructed by a
 * caller. A route that took a profile id would have to decide whether the
 * caller may use it, and that decision would be a second copy of one
 * `@liberty/auth` already makes.
 *
 * `mediaPreferencesSchema`'s strictness is the other half: a body carrying a
 * `profileId` is refused as malformed rather than having the field ignored,
 * because an ignored field is how a caller comes to believe it set something.
 *
 * ==========================================================================
 * THREE VERBS, AND DELETE IS NOT A SYNONYM FOR PUT-WITH-EMPTY-LISTS
 * ==========================================================================
 *
 * `PUT` with empty lists stores "this viewer prefers no particular language".
 * `DELETE` stores nothing and removes the row: "this viewer has not chosen".
 * Those are different answers and the player treats them differently, so they
 * need different verbs. Collapsing them would take away the ability to express
 * the first.
 * ---------------------------------------------------------------------- */

function respond(response: PreferencesResponse): Response {
  /*
   * PARSED ON THE WAY OUT, like every other route here. The schema is the
   * contract; a response that does not satisfy it is a bug this process should
   * discover rather than one a client should.
   */
  const body = preferencesResponseSchema.parse(response);
  return Response.json(body, { status: preferencesHttpStatus(body) });
}

/** The adapter line every response carries, so a reader knows what served it. */
function adapterLine(context: LibertyRequestContext): PreferencesReason {
  return preferencesReason(preferencesContextReason(context.adapter.code), context.adapter.detail);
}

/** The grant that authorised this request, or the denial that stopped it. */
function grantLine(decision: ProfileAccessDecision<"active_profile_of_session">): PreferencesReason {
  return decision.allowed
    ? preferencesReason(
        preferencesGrantReason(decision.reason),
        "the requested profile is the one this session selected, and this account owns it"
      )
    : preferencesReason(
        /*
         * `externalProfileAccessReason` NARROWS THE INTERNAL DENIAL before it
         * is published. The internal vocabulary distinguishes a profile that
         * does not exist from one owned by another household, and telling a
         * caller which is an oracle for whose profile ids exist.
         */
        preferencesAccessReason(externalProfileAccessReason(decision.reason)),
        "this session may not act on that profile"
      );
}

function fromContextRefusal(
  reasons: NonEmptyReasons<RequestContextReasonCode>
): PreferencesResponse {
  const [head, ...tail] = reasons;
  const primary = preferencesReason(preferencesContextReason(head.code), head.detail);
  const rest = tail.map((line) =>
    preferencesReason(preferencesContextReason(line.code), line.detail)
  );
  /*
   * A CLIENT FAULT IS A REFUSAL AND EVERYTHING ELSE IS UNAVAILABLE, the same
   * split every other profile-scoped route makes. A deployment with no store
   * and no identity system has not been misused; it has not been finished.
   */
  return contextRefusalIsClientFault(head.code)
    ? refusedPreferences(primary, ...rest)
    : unavailablePreferences(primary, ...rest);
}

/** GET /api/v1/profiles/preferences */
export async function handleReadPreferences(
  request: Request,
  options: RequestContextOptions = {}
): Promise<Response> {
  const resolved = await resolveRequestContext(request, options);
  if (!resolved.ok) return respond(fromContextRefusal(resolved.reasons));
  const { context } = resolved;

  try {
    const decision = await resolveActiveProfileScope(context);
    if (!decision.allowed) {
      return respond(
        refusedPreferences(grantLine(decision), adapterLine(context))
      );
    }

    const stored = await context.repository.readMediaPreferences({ scope: decision.scope });
    return respond(
      readPreferences(
        stored.stored,
        stored.preferences,
        preferencesReason(
          "preferences_read",
          /*
           * THE DETAIL SAYS WHICH OF THE TWO ANSWERS THIS IS, because the
           * values alone cannot: a profile that has chosen nothing and one
           * that chose empty lists look identical in every field.
           */
          stored.stored
            ? "this profile has stored preferences"
            : "this profile has chosen nothing; the neutral value is returned and nothing is stored"
        ),
        grantLine(decision),
        adapterLine(context)
      )
    );
  } catch (error) {
    return respond(
      unavailablePreferences(
        preferencesReason("unexpected_repository_failure", describeThrown(error)),
        adapterLine(context)
      )
    );
  }
}

/** PUT /api/v1/profiles/preferences */
export async function handleWritePreferences(
  request: Request,
  options: RequestContextOptions = {}
): Promise<Response> {
  const resolved = await resolveRequestContext(request, options);
  if (!resolved.ok) return respond(fromContextRefusal(resolved.reasons));
  const { context } = resolved;

  /*
   * THE BODY IS PARSED BEFORE THE PROFILE IS AUTHORIZED, and that order is
   * deliberate in the opposite direction from the repository's. Nothing here
   * touches storage, so there is no work being done on behalf of an
   * unauthorized caller; what a 400 before a 403 avoids is telling a signed-in
   * viewer their profile is fine when their body is not, or making them fix a
   * profile problem to discover a typo. The route still cannot ACT without a
   * scope, which is the property that matters.
   */
  const body = await readJsonBody(request);
  const parsed = putPreferencesRequestSchema.safeParse(body);
  if (!parsed.success) {
    const code = mediaPreferencesReason(parsed.error);
    return respond(
      refusedPreferences(
        preferencesReason(
          preferencesBodyReason(code),
          /*
           * THE ZOD MESSAGE, NOT THE VALUE. A viewer's rejected language tag
           * is a string they typed; echoing it into a reason trail that is
           * logged would put caller-chosen content where every other detail
           * is one this application wrote.
           */
          parsed.error.issues[0]?.message ?? "the preferences body did not satisfy the contract"
        ),
        adapterLine(context)
      )
    );
  }

  try {
    const decision = await resolveActiveProfileScope(context);
    if (!decision.allowed) {
      return respond(
        refusedPreferences(grantLine(decision), adapterLine(context))
      );
    }

    const written = await context.repository.writeMediaPreferences({
      scope: decision.scope,
      preferences: parsed.data,
      instant: new Date()
    });

    return respond(
      writtenPreferences(
        written.preferences,
        preferencesReason(
          "preferences_written",
          `${String(written.preferences.preferredAudioLanguages.length)} audio and ` +
            `${String(written.preferences.preferredSubtitleLanguages.length)} subtitle ` +
            "language(s) stored for this profile"
        ),
        grantLine(decision),
        adapterLine(context)
      )
    );
  } catch (error) {
    return respond(
      unavailablePreferences(
        preferencesReason("unexpected_repository_failure", describeThrown(error)),
        adapterLine(context)
      )
    );
  }
}

/** DELETE /api/v1/profiles/preferences */
export async function handleForgetPreferences(
  request: Request,
  options: RequestContextOptions = {}
): Promise<Response> {
  const resolved = await resolveRequestContext(request, options);
  if (!resolved.ok) return respond(fromContextRefusal(resolved.reasons));
  const { context } = resolved;

  try {
    const decision = await resolveActiveProfileScope(context);
    if (!decision.allowed) {
      return respond(
        refusedPreferences(grantLine(decision), adapterLine(context))
      );
    }

    await context.repository.forgetMediaPreferences({ scope: decision.scope });
    return respond(
      forgottenPreferences(
        /*
         * The neutral value, because that is now what a read would return.
         * Echoing what was deleted would describe a state that no longer
         * exists, and a client refreshing its form from this response would
         * repopulate the fields the viewer just cleared.
         */
        NO_MEDIA_PREFERENCES,
        preferencesReason(
          "preferences_forgotten",
          "this profile has no stored preferences; it is back to having chosen nothing"
        ),
        grantLine(decision),
        adapterLine(context)
      )
    );
  } catch (error) {
    return respond(
      unavailablePreferences(
        preferencesReason("unexpected_repository_failure", describeThrown(error)),
        adapterLine(context)
      )
    );
  }
}
