import { playbackResolveRequestSchema } from "@liberty/contracts/domains/playback";
import { rankStreamCandidates } from "@liberty/media-engine";
import { isLocalDeployment } from "../../../deployment-environment";

/* -------------------------------------------------------------------------
 * The HTTP half of POST /api/v1/playback/resolve (PL-0702)
 *
 * WHAT THIS ROUTE IS. A ranking scaffold: the CLIENT supplies the candidate
 * list, including each candidate's `rights`, and the server answers with a full
 * playability verdict. docs/API_CONTRACTS.md has always described it that way
 * ("Current scaffold accepts candidates directly for testability"), and the
 * security review found that nothing in the CODE said so -- a sentence in a
 * document is not a control, and the route was reachable from a hosted
 * deployment exactly as it is from a developer's laptop.
 *
 * WHAT IT IS NOT, because the distinction decides how hard to fight for it. It
 * is not an SSRF hole and it is not a rights bypass in the sense that matters:
 * `StreamCandidate` carries no URI, so nothing a caller sends becomes something
 * this server fetches, and nothing it returns becomes something a player can
 * play. A verdict about a candidate nobody can address confers no rights on
 * anything real. `e2e/tests/rights-boundary.api.spec.ts` asserts precisely that
 * from outside the process.
 *
 * WHY IT IS GATED RATHER THAN DELETED. Deleting it is the better end state --
 * `POST /api/v1/playback/session` now does the job the right way round, with
 * the server resolving and the client naming -- but the deletion is not this
 * task's to make: the route is named in docs/API_CONTRACTS.md, in docs/E2E.md
 * and in three specs under `e2e/`, none of which are inside PL-0702's
 * allowedPaths. Removing the route and leaving those is how a "security fix"
 * lands as a red build that the next person reverts wholesale. So this task
 * closes the reachable defect and records the removal as a follow-up that owns
 * every file at once.
 *
 * The separation from `route.ts` is the same one `../session/handler.ts` makes
 * and for the same reason: a Next route module may export only the handlers and
 * a fixed set of segment config values, so a route file has nowhere to accept an
 * injected option and testing one means testing whatever the environment
 * happens to be. This file takes the options; `route.ts` supplies none.
 * ---------------------------------------------------------------------- */

/**
 * A ranking verdict is per-device and per-request. Nothing between here and the
 * caller has any business holding one for the next caller.
 */
const NO_STORE = { "cache-control": "no-store" };

/**
 * The largest body this scaffold will look at, in bytes. 1 MiB, matching
 * `@liberty/provider-sdk`'s `DEFAULT_MAX_RESPONSE_BYTES`, so the two boundaries
 * that read untrusted JSON agree on what "too big to be an honest request" is.
 *
 * ENFORCED FROM `content-length` ONLY, which is a claim and not a measurement --
 * it can be absent under chunked encoding and it can be a lie. The real control
 * would be a metered read, the way `provider-sdk`'s `readBounded` does it, and
 * that is deliberately not built here: this route is unreachable in production
 * (see `scaffoldIsAvailable`), so the population it defends against is a
 * developer's own mistake rather than an attacker. If it ever ships hosted, the
 * metered read lands with it, and this comment is the note saying so.
 */
export const MAX_REQUEST_BYTES = 1_048_576;

/**
 * The largest candidate list this scaffold will rank.
 *
 * `playbackResolveRequestSchema` bounds the array below -- `.min(1)` -- and not
 * above, so an unbounded array reached both Zod's per-element validation and
 * `rankStreamCandidates`, which scores every candidate against every capability
 * and then sorts. That is a remote compute amplifier: a small body of repeated
 * objects buys a large amount of server work. The cap is checked BEFORE
 * `safeParse`, because validating a hundred thousand candidates in order to
 * report that there are too many of them is the same defect wearing a schema.
 *
 * 100 rather than a tighter number because the bound only has to stop
 * amplification, not to express a product opinion: no real device profile is
 * choosing between a hundred renditions, and a caller that sends 101 has a bug
 * whatever its intent.
 */
export const MAX_CANDIDATES = 100;

export interface ResolveScaffoldOptions {
  /**
   * Whether the scaffold answers at all. Injected so the guard is testable
   * without mutating the process environment -- a test that writes `NODE_ENV`
   * is a test that changes how everything else in the same worker behaves.
   *
   * Absent, it is derived from `NODE_ENV` at the PROCESS boundary, by the same
   * classification that keeps the fixture provider out of a hosted deployment.
   * It is not a request field: a caller must never be able to name the
   * environment it would like to be treated as.
   *
   * "The same switch" is now literally the same CALL rather than a second copy
   * of the same expression. It was `NODE_ENV !== "production"` here and in the
   * session API, which agreed by coincidence and admitted every value that is
   * not that one string -- so `staging` or an unset variable exposed a route
   * that RANKS CALLER-SUPPLIED CANDIDATES on a deployment nobody meant to be a
   * development one. That was corrected once by sharing the ALLOWLIST and
   * restating the `.includes` test here; it is corrected again by consuming
   * `isLocalDeployment`, so `app/api/deployment-environment.ts` is the only
   * place the allowlist is written and the only place it is tested.
   */
  readonly available?: boolean | undefined;
}

function scaffoldIsAvailable(options: ResolveScaffoldOptions): boolean {
  return options.available ?? isLocalDeployment();
}

/**
 * A body that is not JSON is a MALFORMED REQUEST, not a server fault.
 *
 * This was the defect: `await request.json()` sat outside any try, so a
 * non-JSON body threw out of the route and became a 500 with no reason trail --
 * the exact failure `../session/handler.ts` was written to avoid, in the route
 * beside it. `null` is not a valid request body either, so it reaches the same
 * schema and produces the same 400 any other malformed body produces.
 */
async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/**
 * How many candidates the body CLAIMS, without trusting the claim's shape.
 *
 * `null` means "not an array", which is not this function's refusal to make --
 * the schema reports that, with a path and a message a caller can act on.
 */
function candidateCount(body: unknown): number | null {
  if (typeof body !== "object" || body === null) return null;
  const candidates = (body as { readonly candidates?: unknown }).candidates;
  return Array.isArray(candidates) ? candidates.length : null;
}

export async function handlePlaybackResolveRequest(
  request: Request,
  options: ResolveScaffoldOptions = {}
): Promise<Response> {
  /*
   * FIRST, before the body is read at all. A route that is not supposed to
   * exist here must not spend memory deciding that, and 404 rather than 403 is
   * the honest answer: in a hosted deployment this endpoint is not a resource
   * the caller lacks permission for, it is a resource that is not part of the
   * deployment.
   */
  if (!scaffoldIsAvailable(options)) {
    return Response.json(
      {
        error: "route_not_available",
        detail:
          "the playback resolve scaffold accepts client-supplied candidates and is not part of a " +
          "hosted deployment; use POST /api/v1/playback/session, where the server resolves"
      },
      { status: 404, headers: NO_STORE }
    );
  }

  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const size = Number(declared);
    if (Number.isFinite(size) && size > MAX_REQUEST_BYTES) {
      return Response.json(
        {
          error: "request_too_large",
          detail: `content-length ${size} exceeds the ${MAX_REQUEST_BYTES} byte cap`
        },
        { status: 413, headers: NO_STORE }
      );
    }
  }

  const body = await readJsonBody(request);

  const count = candidateCount(body);
  if (count !== null && count > MAX_CANDIDATES) {
    return Response.json(
      {
        error: "too_many_candidates",
        detail: `${count} candidates exceeds the ${MAX_CANDIDATES} the scaffold will rank`
      },
      { status: 413, headers: NO_STORE }
    );
  }

  const parsed = playbackResolveRequestSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "invalid_request", issues: parsed.error.issues },
      { status: 400, headers: NO_STORE }
    );
  }

  const decision = rankStreamCandidates(parsed.data.candidates, parsed.data.capabilities);

  if (!decision.selected) {
    return Response.json(
      { error: "no_playable_candidate", detail: decision.reason },
      { status: 422, headers: NO_STORE }
    );
  }

  return Response.json(decision, { headers: NO_STORE });
}
