import { handleCreateProfile, handleListProfiles } from "./handler";

/**
 * GET /api/v1/profiles -- the account's live profiles, and which one this
 * session is acting as.
 *
 * POST /api/v1/profiles -- create one. The owner comes from the session; there
 * is no field in the request through which a caller could name an account.
 *
 * The response is a discriminated union on `outcome` with `reasons` on every
 * branch. See `contract.ts` for why that is a type-level guarantee rather than a
 * convention, and `handler.ts` for why the work is not in this file.
 *
 * Nothing else may be exported from a route module, which is the whole reason
 * this one is this short.
 */
export async function GET(request: Request): Promise<Response> {
  return handleListProfiles(request);
}

export async function POST(request: Request): Promise<Response> {
  return handleCreateProfile(request);
}
