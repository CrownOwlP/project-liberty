/* -------------------------------------------------------------------------
 * The first browser-side caller of this application's own API (PW-0303).
 *
 * THAT IS NOT AN EXAGGERATION AND IT IS WHY THIS MODULE IS SEPARATE FROM THE
 * COMPONENTS THAT USE IT. Before this task `apps/web` contained no `fetch` of
 * `/api/v1/...` anywhere on the client: every screen is a server component that
 * calls a `lib/` loader directly. A profile picker cannot be that, because
 * selecting a profile is a write the viewer performs and the result has to reach
 * the screen they are looking at. So a transport appears here for the first
 * time, and the rules it establishes are the ones every later client feature
 * will copy.
 *
 * RULE 1 -- EVERY RESPONSE IS PARSED, AND AN UNPARSEABLE ONE IS NOT COERCED.
 * `profilesResponseSchema` is the published contract; a body that does not
 * satisfy it is reported as `unreadable` and rendered as a failure. The
 * alternative -- casting the JSON to `ProfilesResponse` -- would make a
 * half-deployed API look like an empty household, which is the single worst
 * thing a profile picker can show.
 *
 * RULE 2 -- NO PROFILE ID IS EVER SENT TO SCOPE A READ. `listProfiles` sends no
 * body and no query. The one place an id crosses the wire is
 * `selectProfile`, to `POST /api/v1/profiles/selection`, which is the route that
 * exists to be told one and which re-derives ownership server-side. PL-0405
 * recorded a forgeable-scope defect and this module is where it would come back:
 * a `?profileId=` on a read would be a client-held scope, and there is none.
 *
 * RULE 3 -- `fetch` IS AN ARGUMENT. Every function takes the implementation it
 * calls, defaulting to the global. That is not ceremony: it is what lets the
 * whole transport be tested with no network, no jsdom and no mock framework, and
 * it is the same structural-dependency style `web-player-adapter.ts` uses for
 * its media element.
 *
 * RULE 4 -- NO RETRIES AND NO CACHE. `cache: "no-store"` because a profile list
 * that a browser served from cache after a selection is precisely the "another
 * profile's rows still on screen" state this task must not produce. No retry,
 * because the five outcomes already distinguish "retrying changes nothing" from
 * "retrying later is sometimes reasonable" and a retry loop here would answer
 * that question on the viewer's behalf.
 * ---------------------------------------------------------------------- */
import {
  profilesResponseSchema,
  type CreateProfileRequest,
  type ProfilesResponse
} from "../../app/api/v1/profiles/contract";

export const PROFILES_ENDPOINT = "/api/v1/profiles";
export const PROFILE_SELECTION_ENDPOINT = "/api/v1/profiles/selection";

/**
 * What a call to this module produced.
 *
 * THREE OUTCOMES, AND THE SPLIT IS A REMEDY SPLIT, exactly as the wire contract's
 * own five are:
 *
 *   - `answered`   -- the API replied and the reply is a `ProfilesResponse`. Any
 *                     of the five wire outcomes, including the refusals. This is
 *                     a SUCCESS of the transport even when the outcome is
 *                     `refused`, because the server said so and the trail is
 *                     real.
 *   - `unreachable` -- `fetch` itself rejected. Offline, DNS, the sidecar not up
 *                     yet. Nothing was served, so there is no trail to show and
 *                     none is invented.
 *   - `unreadable` -- something was served and it is not this contract. A 500
 *                     HTML error page, a proxy's interception, a version skew.
 *                     Distinct from `unreachable` because the remedy is
 *                     different and because reporting "you are offline" to
 *                     somebody whose server is returning HTML sends them to
 *                     check their wifi.
 *
 * An HTTP status is NOT one of the axes. The handler answers `refused` with 4xx
 * and `unavailable` with 5xx while putting the same union in the body, so status
 * carries no information the body does not, and branching on it here would be a
 * second vocabulary that can disagree with the first.
 */
export type ProfilesCallResult =
  | { readonly kind: "answered"; readonly response: ProfilesResponse; readonly status: number }
  | { readonly kind: "unreachable"; readonly detail: string }
  | { readonly kind: "unreadable"; readonly detail: string };

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function defaultFetch(): FetchLike {
  return (input, init) => fetch(input, init);
}

/**
 * The one place a `Response` becomes a `ProfilesCallResult`.
 *
 * Shared by all three calls so no call site can be relaxed on its own -- the
 * same argument `reasonsSchema` makes for being declared once in the contract.
 */
async function readProfilesResponse(response: Response): Promise<ProfilesCallResult> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    /*
     * The parse error itself is DISCARDED, not reported. `response.json()`
     * rejects with a message quoting the first offending bytes, and those bytes
     * are an unexpected payload -- putting them on the screen is how a proxy's
     * error page becomes content in this application's DOM. The status and the
     * URL are ours and are enough to tell the two remedies apart.
     */
    return {
      kind: "unreadable",
      detail: `the response to ${response.url === "" ? "this request" : response.url} was not JSON (HTTP ${String(response.status)})`
    };
  }

  const parsed = profilesResponseSchema.safeParse(body);
  if (!parsed.success) {
    /*
     * The ISSUE PATHS, never the body. A body that failed this schema is by
     * definition not something we know the shape of, and echoing it into the
     * DOM is how an unexpected payload becomes stored content on a page.
     */
    const where = parsed.error.issues
      .map((issue) => (issue.path.length === 0 ? "(root)" : issue.path.join(".")))
      .slice(0, 5)
      .join(", ");
    return {
      kind: "unreadable",
      detail: `the response did not match the profiles contract (HTTP ${String(response.status)}); unexpected at ${where}`
    };
  }

  return { kind: "answered", response: parsed.data, status: response.status };
}

/**
 * `fetch` rejects for network-layer failures only, and `cause` may be anything.
 *
 * `String(cause)` rather than `cause.message`, because a thrown non-Error has no
 * message and the optional chain would put "undefined" on the screen.
 */
function unreachable(cause: unknown): ProfilesCallResult {
  return { kind: "unreachable", detail: `the request did not reach the service: ${String(cause)}` };
}

const JSON_HEADERS: Readonly<Record<string, string>> = { "content-type": "application/json" };

/**
 * GET /api/v1/profiles -- the account's profiles and which one is active.
 *
 * No body, no query, no id. See rule 2.
 */
export async function listProfiles(fetchImpl: FetchLike = defaultFetch()): Promise<ProfilesCallResult> {
  let response: Response;
  try {
    response = await fetchImpl(PROFILES_ENDPOINT, {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" }
    });
  } catch (cause) {
    return unreachable(cause);
  }
  return readProfilesResponse(response);
}

/**
 * POST /api/v1/profiles -- create one.
 *
 * The request carries no account field, because the contract has none: the owner
 * comes from the session and `createProfileRequestSchema` is `.strict()`, so a
 * caller that tried to name one would be refused as malformed. Nothing here
 * validates `displayName`; `resolveProfileCreation` owns blankness and length and
 * reports them as distinct reasons, and a check here would collapse both into a
 * client-side message the server never said.
 */
export async function createProfile(
  request: CreateProfileRequest,
  fetchImpl: FetchLike = defaultFetch()
): Promise<ProfilesCallResult> {
  let response: Response;
  try {
    response = await fetchImpl(PROFILES_ENDPOINT, {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: { ...JSON_HEADERS, accept: "application/json" },
      body: JSON.stringify(request)
    });
  } catch (cause) {
    return unreachable(cause);
  }
  return readProfilesResponse(response);
}

/**
 * POST /api/v1/profiles/selection -- act as this profile from now on.
 *
 * THE ONLY FUNCTION IN THIS MODULE THAT SENDS AN ID, and it sends it to the one
 * route whose purpose is to receive one. The server checks ownership against the
 * session and answers `profile_unavailable` for an id belonging to another
 * household -- the same answer a malformed id gets -- so nothing the caller can
 * put here is a scope.
 */
export async function selectProfile(
  profileId: string,
  fetchImpl: FetchLike = defaultFetch()
): Promise<ProfilesCallResult> {
  let response: Response;
  try {
    response = await fetchImpl(PROFILE_SELECTION_ENDPOINT, {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: { ...JSON_HEADERS, accept: "application/json" },
      body: JSON.stringify({ profileId })
    });
  } catch (cause) {
    return unreachable(cause);
  }
  return readProfilesResponse(response);
}

/**
 * Every reason detail in a result, for the screen to render.
 *
 * The DETAILS rather than the codes: the codes are a closed machine vocabulary
 * and `served_by_in_memory_adapter` is not a sentence. `detail` is `.min(1)` in
 * the schema, so none of these is empty.
 */
export function reasonDetails(result: ProfilesCallResult): readonly string[] {
  if (result.kind !== "answered") return [result.detail];
  return result.response.reasons.map((line) => line.detail);
}
