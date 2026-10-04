import type { ExternalProfileAccessReason, ProfileAccessGrantReason } from "@liberty/auth";
import {
  mediaPreferencesSchema,
  type MediaPreferencesReasonCode,
  type MediaPreferences
} from "@liberty/contracts/domains/preferences";
import { z } from "zod";

import { trail, type NonEmptyReasons, type ReasonLine } from "../../../../../lib/db/reason-trail";
import type { RequestContextReasonCode } from "../../../../../lib/db/request-context";

/* -------------------------------------------------------------------------
 * The wire shape for one profile's media preferences (PL-0723)
 *
 * ==========================================================================
 * THE BODY SHAPE IS IMPORTED, NOT RESTATED
 * ==========================================================================
 *
 * `mediaPreferencesSchema` in `@liberty/contracts` is the single definition of
 * what a valid preference is: the language-tag pattern, the list bound, the
 * no-duplicates rule, the strictness. This module adds the ENVELOPE -- outcome,
 * reason trail, status -- and nothing about the values. A second copy of the
 * validation here would be a second thing to keep in step with the storage
 * layer, and the one that drifted would be the one nobody noticed.
 *
 * ==========================================================================
 * `stored` IS ON THE WIRE, AND THAT IS THE POINT
 * ==========================================================================
 *
 * A response says both what the preferences ARE and whether anybody has
 * CHOSEN them. The settings screen needs the second: a profile that has never
 * been configured and a profile whose viewer deliberately cleared both lists
 * have identical values and must not be shown identically -- one is "we have
 * not asked you yet" and the other is "you told us not to prefer anything".
 * Dropping the flag at the boundary would destroy, for every client at once,
 * a distinction the schema goes to the trouble of storing.
 * ---------------------------------------------------------------------- */

/** The request body for a write. Exactly the contract's shape, strict. */
export const putPreferencesRequestSchema = mediaPreferencesSchema;

export const preferencesReasonCodeSchema = z.enum([
  /* --- the shared preamble's vocabulary, carried verbatim ---------------
   * LISTED RATHER THAN MAPPED ONTO SOMETHING SHORTER, which is what every
   * other profile-scoped route in this application does. The mapping
   * functions below are then the IDENTITY, and that is the point: a new
   * member of `RequestContextReasonCode` fails to compile here instead of
   * reaching a client as an unlisted code or being swallowed by a default
   * branch. */
  "served_by_postgres_adapter",
  "served_by_in_memory_adapter",
  "database_url_malformed",
  "storage_not_configured",
  "authentication_not_configured",
  "not_authenticated",
  "development_identifier_malformed",
  "unexpected_repository_failure",
  /* --- profile access, from `externalProfileAccessReason` --------------- */
  "active_profile_of_session",
  "selectable_profile_of_account",
  "no_active_profile_selected",
  "profile_unavailable",
  "profile_archived",
  "requested_profile_is_not_active",
  /* --- the body, from `mediaPreferencesReason` -------------------------- */
  "preferences_malformed",
  "language_tag_unusable",
  "too_many_languages",
  "language_listed_twice",
  /* --- what happened ---------------------------------------------------- */
  "preferences_read",
  "preferences_written",
  "preferences_forgotten"
]);

export type PreferencesReasonCode = z.infer<typeof preferencesReasonCodeSchema>;

/** Compile-time link to the shared preamble's vocabulary. The body is the identity. */
export function preferencesContextReason(code: RequestContextReasonCode): PreferencesReasonCode {
  return code;
}

/** Compile-time link to `externalProfileAccessReason`. Never the internal vocabulary. */
export function preferencesAccessReason(code: ExternalProfileAccessReason): PreferencesReasonCode {
  return code;
}

/** Compile-time link to an authorization grant. */
export function preferencesGrantReason(code: ProfileAccessGrantReason): PreferencesReasonCode {
  return code;
}

/**
 * Compile-time link to the contract's own body classification.
 *
 * The identity again, and deliberately: `mediaPreferencesReason` already
 * decided which of the four body refusals applies, and re-deciding it here
 * would be a second classifier free to disagree with the first.
 */
export function preferencesBodyReason(code: MediaPreferencesReasonCode): PreferencesReasonCode {
  return code;
}

export const preferencesReasonSchema = z
  .object({ code: preferencesReasonCodeSchema, detail: z.string().min(1) })
  .strict();

export type PreferencesReason = ReasonLine<PreferencesReasonCode>;

/** Local, like every other route's: the array shape, not a shared constant. */
const reasonsSchema = z.array(preferencesReasonSchema).nonempty();

export function preferencesReason(
  code: PreferencesReasonCode,
  detail: string
): PreferencesReason {
  return { code, detail };
}

export const preferencesResponseSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("read"),
    reasons: reasonsSchema,
    /** Whether anybody has chosen. See the header; this is not decoration. */
    stored: z.boolean(),
    preferences: mediaPreferencesSchema
  }),
  z.object({
    outcome: z.literal("written"),
    reasons: reasonsSchema,
    stored: z.literal(true),
    preferences: mediaPreferencesSchema
  }),
  z.object({
    outcome: z.literal("forgotten"),
    reasons: reasonsSchema,
    /** After forgetting there is nothing stored, by construction. */
    stored: z.literal(false),
    preferences: mediaPreferencesSchema
  }),
  z.object({ outcome: z.literal("refused"), reasons: reasonsSchema }),
  z.object({ outcome: z.literal("unavailable"), reasons: reasonsSchema })
]);

export type PreferencesResponse = z.infer<typeof preferencesResponseSchema>;

function buildTrail(
  primary: PreferencesReason,
  rest: readonly PreferencesReason[]
): NonEmptyReasons<PreferencesReasonCode> {
  return trail(primary, rest);
}

export function readPreferences(
  stored: boolean,
  preferences: MediaPreferences,
  primary: PreferencesReason,
  ...rest: PreferencesReason[]
): PreferencesResponse {
  return { outcome: "read", reasons: buildTrail(primary, rest), stored, preferences };
}

export function writtenPreferences(
  preferences: MediaPreferences,
  primary: PreferencesReason,
  ...rest: PreferencesReason[]
): PreferencesResponse {
  return { outcome: "written", reasons: buildTrail(primary, rest), stored: true, preferences };
}

export function forgottenPreferences(
  preferences: MediaPreferences,
  primary: PreferencesReason,
  ...rest: PreferencesReason[]
): PreferencesResponse {
  return { outcome: "forgotten", reasons: buildTrail(primary, rest), stored: false, preferences };
}

export function refusedPreferences(
  primary: PreferencesReason,
  ...rest: PreferencesReason[]
): PreferencesResponse {
  return { outcome: "refused", reasons: buildTrail(primary, rest) };
}

export function unavailablePreferences(
  primary: PreferencesReason,
  ...rest: PreferencesReason[]
): PreferencesResponse {
  return { outcome: "unavailable", reasons: buildTrail(primary, rest) };
}

/** Refusals the caller fixes by sending something different. */
const CLIENT_INPUT_REFUSALS: readonly PreferencesReasonCode[] = [
  "preferences_malformed",
  "language_tag_unusable",
  "too_many_languages",
  "language_listed_twice",
  "development_identifier_malformed"
];

/**
 * The HTTP status for a decision.
 *
 * 401 IS TESTED BEFORE EVERYTHING ELSE, the same order every other
 * profile-scoped route in this application uses. A viewer who is not signed in
 * must be told to sign in; telling them their request was malformed, or that a
 * profile was not found, would both be true-ish and useless -- and the second
 * would leak that the route got as far as looking.
 *
 * `storage_not_configured` and `authentication_not_configured` are 503 rather
 * than 500: the deployment is not wrong, it is not finished, and an operator
 * reading 503 looks at configuration while one reading 500 looks for a bug.
 */
export function preferencesHttpStatus(response: PreferencesResponse): number {
  switch (response.outcome) {
    case "read":
    case "written":
    case "forgotten":
      return 200;
    case "unavailable":
      return 503;
    case "refused": {
      const primary = response.reasons[0].code;
      if (primary === "not_authenticated") return 401;
      if (CLIENT_INPUT_REFUSALS.includes(primary)) return 400;
      /*
       * EVERY REMAINING PROFILE REFUSAL IS 403 AND NONE IS 404, deliberately.
       * `profile_not_found` and `profile_not_yours` are different facts to us
       * and must not be different statuses to a caller: a 404 for one and a
       * 403 for the other is an oracle that tells an attacker which profile
       * ids exist in somebody else's household.
       */
      return 403;
    }
  }
}
