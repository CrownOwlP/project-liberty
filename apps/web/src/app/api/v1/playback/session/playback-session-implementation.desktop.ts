import {
  playbackReason,
  playbackSessionResponseSchema,
  unavailableSession,
  type PlaybackSessionResponse
} from "./contract";

/* -------------------------------------------------------------------------
 * THE FORWARDING IMPLEMENTATION OF POST /api/v1/playback/session (PL-0501)
 *
 * The desktop target's half of the split ruled in `docs/DESKTOP_PLAYBACK.md`
 * §8. It is selected at BUILD TIME by module resolution -- the `.desktop`
 * extension in `../build-target.ts`'s resolve list -- and it REPLACES
 * `playback-session-implementation.ts` rather than sitting beside it, so a
 * desktop build contains no provider-resolution implementation at all. That
 * absence is the property §8 asks to be tested for, and
 * `../build-target.test.ts` is where it is asserted.
 *
 * THE RULING, IN ONE SENTENCE: provider resolution and any credential-bearing
 * provider call must not rely on the user-administered local sidecar as the
 * trust boundary, so the desktop build proxies these routes to an authenticated
 * backend while preserving the same application-facing route contract.
 *
 * WHAT THIS MODULE IS. A forwarder with NO POLICY IN IT. It does not resolve,
 * rank, evaluate rights, check a URL, mint a credential or decide an outcome.
 * It relays a request and relays a decision. Everything §8 lists as the
 * backend's work -- resolution, rights evaluation, ranking and URL signing --
 * happens on infrastructure we operate, where invariants 1 and 2 are
 * ENFORCEABLE rather than merely asserted, because they do not execute from
 * files the viewer can read and replace.
 *
 * WHAT IT MUST NEVER CARRY, and does not: a provider API key, a provider OAuth
 * client secret or a signing key, in any form -- build artifact, environment
 * variable, config file or cached response. There is no provider credential
 * named, read or attachable anywhere in this file, and the headers it sends are
 * an ALLOWLIST (see `IDENTITY_HEADERS`) precisely so that a later edit adding a
 * secret elsewhere in the process cannot leak into this request by accident.
 *
 * WHAT IT DOES CARRY: the authenticated caller identity the request already
 * has. The backend authenticates that identity and answers for it.
 *
 * TWO THINGS ARE DELIBERATELY NOT IMPORTED HERE.
 *
 *   - `@liberty/provider-sdk`, including `checkUrl`. Importing it would pull a
 *     provider adapter -- `createFixtureProvider` among them -- into the
 *     desktop bundle through the package's single entry point, which is exactly
 *     the exposure the ruling removes, arriving through a side door that
 *     `docs/DESKTOP_PLAYBACK.md` §7 names by hand. The transport gate still
 *     runs immediately before a URL is published: it runs in the resolving
 *     implementation, which under this target runs on the backend, and this
 *     process publishes no URL of its own.
 *   - `@liberty/media-engine`. Nothing here ranks, and §7 requires that nothing
 *     in the shell, the adapter or the router does.
 *
 * `contract.ts` is imported, and that is safe by inspection rather than by
 * assumption: its only references to those two packages are `import type`,
 * which is erased, so no value from either reaches this graph.
 * ---------------------------------------------------------------------- */

/**
 * Where the authenticated backend lives.
 *
 * READ FROM THE ENVIRONMENT, AND IT IS NOT THE SWITCH §8 FORBIDS. The forbidden
 * thing is "an environment variable, a config key or a feature flag that can
 * put resolution back on-device in a shipped desktop build". This is an
 * ADDRESS, and no value of it can put resolution back on-device, because the
 * resolver is not in this bundle: there is nothing for it to turn back on. The
 * worst a wrong value can do is point the forwarder at a backend that refuses
 * it, and the worst an absent value can do is stop playback -- both of which
 * arrive as an honest `unavailable`, never as a local resolution.
 *
 * Read at CALL time rather than at module scope, for the reason
 * `authorized-candidates.ts` gives about its own classification: a module-scope
 * read freezes the answer to whatever the process looked like when the route
 * was first loaded.
 */
const BACKEND_ORIGIN_VAR = "LIBERTY_PLAYBACK_BACKEND_ORIGIN";

/**
 * The path this route is served at, restated so the forwarded URL is the same
 * URL.
 *
 * A CONSTANT RATHER THAN THE INBOUND `request.url`'s pathname. Composing the
 * outbound URL from a value the caller influenced is the shape of mistake that
 * turns a proxy into a general-purpose one; a constant cannot be steered onto
 * another backend route. It is pinned against this module's own position in the
 * `app/` tree by `playback-session-implementation.desktop.test.ts`, so it
 * cannot silently drift from the route it claims to mirror.
 */
export const PLAYBACK_SESSION_PATH = "/api/v1/playback/session";

/**
 * The request headers the forwarder passes on. AN ALLOWLIST, NOT A COPY.
 *
 * §8: the proxy "forwards an authenticated caller identity ... the session or
 * profile identity the request already carries". These are the headers that
 * carry one in this application today: the cookie jar (where a real sign-in
 * will put its session once `@liberty/auth` is wired -- see
 * `docs/API_CONTRACTS.md`, "Identity, while there is no sign-in"), a bearer
 * `authorization` if one is ever presented, and the two development identity
 * headers that route already honours.
 *
 * AN ALLOWLIST BECAUSE THE FAILURE MODE OF A DENYLIST IS SILENT. Copying every
 * inbound header and removing the dangerous ones means the next header somebody
 * adds is forwarded by default, and the one header this build must never send
 * is one nobody has thought of yet. It also means the desktop sidecar's own
 * loopback bearer token (`docs/DESKTOP_PLAYBACK.md` §7) is not forwarded: it
 * authenticates a local process to the sidecar and means nothing to the
 * backend.
 *
 * Lower-case because `Headers.get` is case-insensitive and the outbound names
 * should be one spelling.
 */
export const IDENTITY_HEADERS: readonly string[] = [
  "cookie",
  "authorization",
  "x-liberty-development-account",
  "x-liberty-development-session"
];

/**
 * What a caller may inject. The same NAME as the resolving implementation's
 * option bag and deliberately a different shape: `handler.ts` takes this type
 * from whichever module the build selected, so the envelope in front of the
 * seam never learns that the two differ.
 *
 * Both fields exist so a test can drive this without a network and without an
 * ambient variable. Neither can change where resolution happens.
 */
export interface PlaybackSessionOptions {
  /** Injected for tests. Defaults to the platform `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /** Injected for tests. Defaults to the environment read described above. */
  readonly backendOrigin?: string | undefined;
}

/**
 * The backend origin, validated, or a named refusal.
 *
 * `https` only and no credentials in the authority -- the same two rules
 * `@liberty/provider-sdk`'s `checkUrl` and `@liberty/contracts`'
 * `licenseUrlSchema` apply to a media URL and a licence endpoint, applied here
 * by hand because that package must not enter this bundle. Parsed with `URL`
 * rather than pattern-matched, because `https:/\/evil` and other near-misses
 * are exactly what a prefix test lets through.
 *
 * Loopback is NOT carved out. The resolving implementation's carve-out exists
 * so a developer can point at a rig on their own machine; here the whole point
 * of the ruling is that the trust boundary is not on the user's machine, so a
 * backend on `127.0.0.1` would be the exposure with the address changed.
 */
function backendOrigin(
  configured: string | undefined
): { readonly ok: true; readonly url: URL } | { readonly ok: false; readonly detail: string } {
  if (configured === undefined || configured.trim() === "") {
    return { ok: false, detail: "absent" };
  }

  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    return { ok: false, detail: "is not a URL" };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, detail: "is not https" };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, detail: "carries credentials in its authority" };
  }
  return { ok: true, url: parsed };
}

/**
 * Decides a playback session by asking the authenticated backend for one.
 *
 * NEVER THROWS, for the reason `issue-session.ts` never throws: every path a
 * caller can reach returns a well-formed member of the response union with
 * reasons, because an endpoint whose failure mode is a stack trace is an
 * endpoint with no reason trail, which is what invariant 4 exists to prevent.
 *
 * THE OFFLINE CASE IS AN HONEST `unavailable`, which §8 requires by name: "an
 * offline or degraded-network desktop cannot resolve at all -- the failure has
 * to be surfaced as an honest unavailable outcome rather than as an empty
 * candidate list". `provider_unavailable` is the existing code for "we would
 * have, and could not, and retrying later is sometimes reasonable", and it
 * needed no addition to the closed vocabulary.
 *
 * NOTHING IS RELAYED THAT THIS PROCESS COULD NOT PARSE. The backend's body is
 * validated against `playbackSessionResponseSchema` here, before it becomes
 * this route's answer, and a body that is not a member of the union becomes
 * `unavailable` rather than being passed through. A forwarder that echoed bytes
 * it had not understood would be a hole in the contract the ruling says is
 * preserved exactly -- and the 500 `playback_session_failed_validation` is the
 * resolving implementation's self-check on ITS OWN output, which stays with it
 * rather than being simulated here about somebody else's.
 *
 * THE BACKEND'S HTTP STATUS IS NOT READ, and that is deliberate rather than an
 * omission. `handler.ts` derives the status from the decision with
 * `playbackSessionHttpStatus`, exactly as it does under the other target, so
 * the wire status and the outcome cannot disagree and cannot differ between
 * builds. A backend that answered 200 with a `denied` body would still produce
 * a 403 here, which is the same answer the resolving implementation produces
 * for the same decision.
 */
export async function decidePlaybackSession(
  request: Request,
  options: PlaybackSessionOptions = {}
): Promise<PlaybackSessionResponse> {
  const configured = options.backendOrigin ?? process.env[BACKEND_ORIGIN_VAR];
  const origin = backendOrigin(configured);
  if (!origin.ok) {
    /*
     * ABSENT AND REFUSED ARE DIFFERENT REMEDIES, and the split mirrors
     * `authorized-candidates.ts`: `provider_not_configured` means nothing is
     * configured, which is an operator's "configure a backend"; a configured
     * origin this build refused is a misconfiguration whose named reason is the
     * only useful thing to publish. Neither one falls back to resolving
     * locally, because there is nothing here to fall back to.
     */
    return origin.detail === "absent"
      ? unavailableSession(
          playbackReason(
            "provider_not_configured",
            "no authenticated playback backend is configured for this build"
          )
        )
      : unavailableSession(
          playbackReason(
            "provider_unavailable",
            `the configured playback backend origin ${origin.detail}`
          )
        );
  }

  const target = new URL(PLAYBACK_SESSION_PATH, origin.url);

  const headers = new Headers({ "content-type": "application/json" });
  for (const name of IDENTITY_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }

  let body: string;
  try {
    /*
     * The bytes as given. Not parsed and not re-serialised: deciding what the
     * request said is the resolving implementation's job, and a forwarder that
     * normalised the body would answer a malformed request twice, here and
     * there, from two pieces of code that can disagree. A body this process
     * cannot even read as text is answered the same way a dead network is --
     * `text()` on a stream that failed is the same class of event.
     */
    body = await request.text();
  } catch {
    return unavailableSession(
      playbackReason("provider_unavailable", "the request body could not be read for forwarding")
    );
  }

  const call = options.fetch ?? globalThis.fetch;

  let response: Response;
  try {
    response = await call(target, {
      method: "POST",
      headers,
      body,
      /* A playback session is per-viewer and time-bounded; a cached one is
       * threat 1 and threat 2 of docs/SECURITY.md in a single response. The
       * envelope sends `no-store` outbound for the same reason. */
      cache: "no-store",
      /*
       * A redirect is NOT followed. Following one would re-send the caller's
       * identity headers to whatever origin the redirect named, which is a
       * credential-forwarding decision this forwarder has no business taking,
       * and the contract has no redirect in it to honour.
       */
      redirect: "error"
    });
  } catch {
    /* The thrown value is not echoed, for the reason `issue-session.ts` gives:
     * a network exception's text is whatever a library felt like saying, up to
     * and including an internal hostname or a URL with a token in it. */
    return unavailableSession(
      playbackReason(
        "provider_unavailable",
        "the authenticated playback backend could not be reached"
      )
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return unavailableSession(
      playbackReason(
        "provider_unavailable",
        "the authenticated playback backend did not answer with JSON"
      )
    );
  }

  const parsed = playbackSessionResponseSchema.safeParse(payload);
  if (!parsed.success) {
    return unavailableSession(
      playbackReason(
        "provider_unavailable",
        "the authenticated playback backend answered outside the playback session contract"
      )
    );
  }

  return parsed.data;
}
