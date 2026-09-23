import { resolveAuthInstance } from "../../../../lib/session/auth-instance";

/* -------------------------------------------------------------------------
 * The authentication endpoints (PW-0403)
 *
 * `/api/auth/*` -- sign-up, sign-in, sign-out, session, verification and
 * password reset, all served by the reviewed Better Auth instance.
 *
 * WHY `/api/auth` AND NOT `/api/v1/auth`. `libertyAuthConfigSchema.baseUrl` is
 * what the library builds cookie paths and callback URLs from, and Better Auth
 * mounts itself at `${baseUrl}/api/auth` by default. A route at a different
 * path would serve requests the library did not expect to receive and issue
 * cookies scoped to a path the browser will not send them back on -- a failure
 * that looks like "sign-in does nothing" rather than like a misconfiguration.
 * PW-0403's surface originally reserved `/api/v1/auth`, which was a guess made
 * before the config was read; it was corrected deliberately and the reason is in
 * a `task.definition_changed` event.
 *
 * THESE ARE NOT `/api/v1` ROUTES AND ARE DELIBERATELY OUTSIDE THAT VERSIONED
 * SURFACE. `docs/API_CONTRACTS.md` describes Liberty's own wire contracts, each
 * with a discriminated-union body and a closed reason vocabulary. This group has
 * none of that: its shapes are the vendor's, and versioning them as ours would
 * promise a stability we do not control.
 *
 * NO VENDOR INTEGRATION IS IMPORTED HERE. `better-auth/next-js` exists and would
 * work, but the instance already exposes `handler: (Request) => Promise<Response>`
 * -- the Web standard shape Next's App Router hands us and expects back -- so
 * forwarding is three lines and `better-auth` stays imported in exactly one file
 * in this repository, which is the property `packages/auth` exists to have.
 *
 * ONLY GET AND POST ARE EXPORTED. Better Auth's own Next adapter also exports
 * PATCH, PUT and DELETE, and this instance's configured surface uses none of
 * them: `ENABLED_AUTH_CAPABILITIES` is email/password, verification, reset and
 * database sessions. Exporting a method no endpoint answers turns a 405 into a
 * 404 from the library, which is a worse error, and it leaves a verb available
 * for whatever a future plugin might mount without anyone deciding to expose it.
 * ---------------------------------------------------------------------- */

/**
 * Rendered per request, never prerendered.
 *
 * Everything here reads or writes a session cookie. A cached auth response is
 * one household's session served to another, which is the most serious cache
 * mistake this application could make, so it is stated rather than inferred
 * from the fact that the handler happens to read headers.
 */
export const dynamic = "force-dynamic";

/**
 * The instance, or an honest 503.
 *
 * A deployment with no `LIBERTY_AUTH_SECRET`, no PostgreSQL, or invalid
 * configuration has no auth instance, and `resolveAuthInstance` reports that as
 * a value rather than throwing. Answering 503 with the reason is the truthful
 * response: the endpoint exists, the service behind it is not configured, and
 * retrying later is reasonable if an operator is fixing it. A 404 would say
 * this deployment has no authentication at all, and a 500 would say something
 * broke.
 *
 * `Cache-Control: no-store` on the refusal as well as on the success, because a
 * cached 503 outlives the fix.
 */
async function forward(request: Request): Promise<Response> {
  const resolution = resolveAuthInstance();
  if (!resolution.ok) {
    return new Response(JSON.stringify({ error: resolution.detail }), {
      status: 503,
      headers: { "content-type": "application/json", "cache-control": "no-store" }
    });
  }
  return resolution.auth.handler(request);
}

export async function GET(request: Request): Promise<Response> {
  return forward(request);
}

export async function POST(request: Request): Promise<Response> {
  return forward(request);
}
