import { handleSelectProfile } from "../handler";

/**
 * POST /api/v1/profiles/selection
 *
 * Records which profile this session is acting as, in
 * `active_profile_selection` -- a row keyed by session, so selecting on the
 * television does not move the phone, and revoking the session removes the
 * selection by cascade.
 *
 * A SEPARATE PATH RATHER THAN A FIELD ON THE PROFILE. Selection is a property of
 * this session, not of the profile, and modelling it as `PATCH /profiles/:id`
 * would make one session's choice look like an edit to a shared resource.
 *
 * Its own SEGMENT rather than a query parameter for the same reason the rest of
 * this API avoids them for state changes: the path names what is being written.
 */
export async function POST(request: Request): Promise<Response> {
  return handleSelectProfile(request);
}
