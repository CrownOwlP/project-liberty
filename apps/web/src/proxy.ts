/* -------------------------------------------------------------------------
 * The listener boundary, applied (PW-0101).
 *
 * Next 16.3.1 discovers this file at `(?:src/)?proxy` — `PROXY_LOCATION_REGEXP`
 * in `next/dist/lib/constants.js`, checked against the installed package rather
 * than read from a changelog. It runs in front of every matched request, which
 * is the only place a listener-wide rule can be enforced once instead of in
 * every handler.
 *
 * THIN ON PURPOSE. Every decision is made by the pure functions in
 * `lib/sidecar/policy.ts`, which have tests; this file reads the environment,
 * reads the headers, and applies the answer. A policy written inline here would
 * be a policy that can only be tested by starting a server.
 * ---------------------------------------------------------------------- */
import { NextResponse, type NextRequest } from "next/server";

import {
  SIDECAR_TOKEN_HEADER,
  authorizeRequest,
  contentSecurityPolicy,
  isSidecarMode,
  readSidecarEnvironment
} from "./lib/sidecar/policy";

/**
 * Read once per process, not per request.
 *
 * The environment cannot change under a running server, and re-reading it on
 * every request would make the guard's cost scale with traffic for no gain.
 */
const ENVIRONMENT = readSidecarEnvironment(process.env);

/**
 * Where the application may load media and talk to a backend.
 *
 * Read from the same variables the rest of the application already uses, so the
 * CSP cannot disagree with what the app actually does. An unset value contributes
 * nothing rather than a wildcard: a CSP that falls open is a CSP-shaped comment.
 */
function allowedOrigins(names: readonly string[]): string[] {
  const origins: string[] = [];
  for (const name of names) {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === "") continue;
    try {
      origins.push(new URL(raw).origin);
    } catch {
      /* A malformed value is dropped rather than inserted verbatim. A CSP
       * directive with a junk token is ignored by the browser wholesale on some
       * engines, which would silently widen the policy. */
    }
  }
  return [...new Set(origins)];
}

const MEDIA_ORIGIN_VARS = ["LIBERTY_FIXTURE_MEDIA_ORIGIN"];
const CONNECT_ORIGIN_VARS = ["LIBERTY_PLAYBACK_BACKEND_ORIGIN"];

export function proxy(request: NextRequest): NextResponse {
  const decision = authorizeRequest(ENVIRONMENT, {
    presentedToken: request.headers.get(SIDECAR_TOKEN_HEADER),
    host: request.headers.get("host")
  });

  if (!decision.ok) {
    /*
     * 403 with no body and no detail. The refusal reason is deliberately absent
     * from the response: `authorizeRequest` returns one code for every failure
     * so the wire cannot be used as an oracle, and repeating even that code here
     * would tell a caller it had reached the guard rather than the application.
     */
    return new NextResponse(null, {
      status: 403,
      headers: { "cache-control": "no-store" }
    });
  }

  const response = NextResponse.next();

  /*
   * THE CSP IS EMITTED IN SIDECAR MODE ONLY.
   *
   * On a hosted deployment the platform's own headers are the right place for
   * it and this application must not fight them. Under a sidecar there is no
   * platform: Tauri's CSP injection stops applying once the frontend is a URL
   * (docs/DESKTOP_PLAYBACK.md §2), and this is what replaces it.
   */
  if (isSidecarMode(ENVIRONMENT)) {
    /* `crypto.randomUUID` is available in the Next runtime this file executes
     * in. A nonce per response, never reused, because a reused nonce is an
     * allowlist entry. */
    const nonce = crypto.randomUUID().replaceAll("-", "");
    response.headers.set(
      "content-security-policy",
      contentSecurityPolicy({
        nonce,
        mediaOrigins: allowedOrigins(MEDIA_ORIGIN_VARS),
        connectOrigins: allowedOrigins(CONNECT_ORIGIN_VARS)
      })
    );
    response.headers.set("x-content-type-options", "nosniff");
    response.headers.set("referrer-policy", "no-referrer");
    /* A local listener has no legitimate cross-origin caller. */
    response.headers.set("cross-origin-resource-policy", "same-origin");
  }

  return response;
}

/**
 * Everything except Next's own static output.
 *
 * `_next/static` is excluded because it is immutable build output with no
 * authority attached, and running the guard over every chunk would make the
 * token a prerequisite for the browser to load the page that presents it.
 * `_next/image` and the app's own routes are NOT excluded.
 */
export const config = {
  matcher: ["/((?!_next/static|favicon\\.ico).*)"]
};
