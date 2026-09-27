import { handleSessionRequest, type SessionEndpointDependencies } from "./session-endpoint";

/* -------------------------------------------------------------------------
 * What this service serves, and what it refuses (PW-0401)
 *
 * ONE PRODUCT ROUTE. `docs/DESKTOP_PLAYBACK.md` section 8 is a rule about a
 * handful of routes and not about the application: everything else continues to
 * run in the sidecar exactly as section 2 describes. So this service answers
 * `POST /api/v1/playback/session` and nothing else, and the absence is the
 * design rather than a stage of it -- a backend that also answered the catalog,
 * the profiles and the watchlist would be a second deployment of the
 * application, which is the rewrite the preservation constraint forbids.
 *
 * SEPARATED FROM `server.ts` SO IT IS TESTABLE WITHOUT A SOCKET. Routing is a
 * function from a `Request` to a `Response`; binding a port is not. Keeping
 * them apart is what lets every branch below -- including the two refusals --
 * be asserted without listening on anything, which is the same split
 * `apps/web`'s route modules make between `route.ts` and `handler.ts`.
 * ---------------------------------------------------------------------- */

export const SESSION_PATH = "/api/v1/playback/session";

/**
 * A liveness endpoint, and deliberately a dull one.
 *
 * `__`-prefixed so it cannot collide with a product route, and it answers a
 * literal. IT REPORTS NO CONFIGURATION: not the identity store's state, not
 * whether a provider is wired, not the transport. An unauthenticated endpoint
 * that described this service's configuration would be a reconnaissance surface
 * whose entire benefit is saving an operator one look at a log.
 */
export const HEALTH_PATH = "/__health";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}

/**
 * Route one request.
 *
 * A METHOD THAT IS NOT THE ROUTE'S IS 405, AND AN UNKNOWN PATH IS 404 --
 * checked in that order, so `GET /api/v1/playback/session` is told the method
 * is wrong rather than that the route does not exist. Both bodies are literals
 * naming only what the caller already knew, and NEITHER IS AUTHENTICATED: a 404
 * that required a session would tell an unauthenticated caller nothing useful
 * and would cost an identity-store read per stray probe.
 *
 * NO REQUEST IS ROUTED BY ANYTHING BUT ITS METHOD AND ITS PATH. There is no
 * header, query parameter or body field that selects a different behaviour, and
 * in particular there is nothing a caller can send that changes where
 * resolution happens -- the property `docs/DESKTOP_PLAYBACK.md` section 8 rules
 * about the desktop build, restated on this side of the boundary.
 */
export async function routeRequest(
  request: Request,
  dependencies: SessionEndpointDependencies = {}
): Promise<Response> {
  const path = new URL(request.url).pathname;

  if (path === SESSION_PATH) {
    if (request.method !== "POST") {
      return json({ error: "method_not_allowed", detail: `${SESSION_PATH} accepts POST` }, 405);
    }
    return handleSessionRequest(request, dependencies);
  }

  if (path === HEALTH_PATH) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ error: "method_not_allowed", detail: `${HEALTH_PATH} accepts GET` }, 405);
    }
    return json({ ok: true }, 200);
  }

  return json({ error: "not_found", detail: "this backend serves one route" }, 404);
}
