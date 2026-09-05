import { normalizedContentIdSchema } from "@liberty/contracts/shared/ids";
import type { PlaybackCapabilities, StreamCandidate } from "@liberty/contracts/domains/playback";
import type { FailoverPolicy } from "@liberty/contracts/domains/failover";
import { DEFAULT_FAILOVER_POLICY, rankStreamCandidates } from "@liberty/media-engine";
import { checkUrl } from "@liberty/provider-sdk";
import {
  checkPlaybackSource,
  describeSourceRejection,
  type PlaybackSource
} from "../../components/player/playback-source";
import type { PlaybackCandidate, PlaybackSession } from "../../components/player/playback-session";
import { isLocalDeployment } from "../api/deployment-environment";
import {
  resolveAuthorizedCandidates,
  type AuthorizedCandidate,
  type AuthorizedCandidateResolution,
  type AuthorizedCandidateResolver
} from "../api/v1/playback/session/authorized-candidates";

/* -------------------------------------------------------------------------
 * Where the watch route gets a session — and what it will never accept
 *
 * THE CLIENT SUPPLIES A CONTENT ID AND NOTHING ELSE. There is no code path here
 * or in the route that turns a query parameter, a header or a request body into
 * a media URL, and there must never be one: a player that plays a URL the page
 * chose is an open proxy for arbitrary media, and it relocates product invariant
 * 1 into whatever code sets the attribute. `playback-source.ts` states the same
 * boundary one layer down.
 *
 * THIS FILE USED TO CARRY ITS OWN FIXTURES, AND THAT IS THE DEFECT PL-0301
 * FOUND. A `fixtureCandidates()` lived here declaring `rights: "owned"` over
 * files nothing had ever opened, stating invented `h264`/`aac`/`720`/`1080` and
 * fabricated bitrates and health scores, composing URLs by string
 * concatenation, and — the part that made it a rights incident rather than an
 * untidy stub — running under NO ENVIRONMENT GUARD AT ALL. `[contentId]/page.tsx`
 * calls `loadPlaybackSession(contentId)` with the default source, so a
 * production `next start` rendered `/watch/<id>` with a player aimed at
 * fabricated `owned` candidates. `docs/E2E.md` recorded this as intended
 * ("the watch page does not share that switch"), which is how a second copy of
 * a rights-asserting fixture set survives a review of the first one.
 *
 * THE FIXTURES ARE NOW THE SESSION API'S, IMPORTED RATHER THAN RESTATED.
 * `v1/playback/session/authorized-candidates.ts` is the one fixture provider:
 * one environment allowlist, one structured `RightsBasis`, one set of `null`
 * media facts, one `URL`-composed origin. A guarded-and-corrected copy here
 * would have satisfied every bullet of the fix and left the ARRANGEMENT that
 * produced the bug intact — two adapters asserting rights over the same
 * imaginary media, correct today by coincidence.
 *
 * AND THE FIXTURE BASIS IS NOW UNCONSTRUCTABLE ON A BUILD THAT SHIPS, which is
 * what closes the version of this defect that a comment cannot. `fixtureProvider`
 * takes a `NonDeploymentEnvironment` — a value only
 * `app/api/deployment-environment.ts` can mint, and only for a `NODE_ENV` on its
 * allowlist — so a future route that wanted its own fixtures could not build the
 * `owned` declaration without first handling the `null` that a deployment gets.
 * The previous gate was a condition inside the resolver, and a condition is
 * exactly what the deleted duplicate did not have.
 *
 * WHY THE IMPORT IS SOUND ACROSS `app/api/**`. Next treats a file under `app/`
 * as a route only when it is named `page`, `route`, `layout`, `template`,
 * `default`, `loading`, `error`, `not-found` or `global-error`; everything else
 * is an ordinary colocated module. `authorized-candidates.ts` is one of those,
 * no `route.ts` is imported and no HTTP request is made, so this is a server
 * component depending on a server capability in the only direction that makes
 * sense. The alternative — the page fetching its own API over HTTP — would need
 * an absolute base URL, a second network hop and a request context it does not
 * have, to arrive at the same in-process answer.
 *
 * The coupling it creates is deliberate and is an IMPROVEMENT on the coupling
 * it replaces: the two files were already required to agree, and did so via a
 * shared `LIBERTY_FIXTURE_MEDIA_ORIGIN` and a comment asking the next reader to
 * keep them in step. A drift in that arrangement reaches a viewer; a drift in
 * this one fails to compile.
 *
 * WHAT IS DELIBERATELY *NOT* DONE HERE. This route still runs its own
 * `rankStreamCandidates` and builds its own `PlaybackSession` rather than
 * calling `issuePlaybackSession`, so the DECISION is still implemented twice.
 * That is a real remaining duplication and it is left on purpose:
 * `issuePlaybackSession` publishes PL-0501's WIRE contract, PL-0501 is still
 * unreviewed, and binding a second consumer to an unapproved contract is the
 * same "two answers" mistake in a new direction. Collapsing the two is
 * PL-0502's declared surface (`apps/web/src/app/watch/**` plus
 * `components/player/**`, dependency PL-0501); PL-0301's job was the fixture
 * adapter, and what a fixture adapter must not do is assert rights twice.
 *
 * No API route is added here. `apps/web/src/app/api/v1/playback/**` belongs to
 * PL-0501 and inventing a second endpoint for the session would give the
 * platform two answers to "what is a playback session".
 * ---------------------------------------------------------------------- */

/**
 * Where candidates come from, what one looks like, and what a resolver may say.
 *
 * RE-EXPORTED, NOT REDECLARED. This route used to define its own
 * `AuthorizedCandidate` whose source was a bare `PlaybackSource` — no
 * `allowLoopback`, no nullable `mimeType` — which meant the page and the
 * session API had two vocabularies for the same thing and the page's was
 * missing the field the SSRF gate needs. Naming them here keeps the import site
 * readable without creating a second definition that can drift.
 *
 * THE FOUR-OUTCOME RESOLUTION IS THE POINT, and it is the session API's own
 * type rather than a page-shaped approximation of it. The seam used to be
 * `candidates | null`, with a throw for everything else, which could express
 * "unknown title" and "the provider exploded" and nothing in between — so
 * `not-configured`, the answer a HOSTED DEPLOYMENT MUST GIVE, had nowhere to
 * come from. Putting it in the type means the compiler, not a comment, is what
 * requires this route to have an answer for a deployment that may not serve
 * fixtures; any future resolver inherits the same obligation.
 *
 * It stays INJECTABLE so this loader's failure paths are testable, and so a real
 * provider registry replaces the fixtures without this route changing.
 */
export type {
  AuthorizedCandidate,
  AuthorizedCandidateResolution,
  AuthorizedCandidateResolver
};

/**
 * Every outcome the route can render, as a branch rather than as an error.
 *
 * `not-configured` is separate from both of its neighbours on purpose. It is
 * what a hosted deployment answers, it is permanent until an OPERATOR acts, and
 * folding it into `error` would tell a viewer to retry something no waiting can
 * fix while folding it into `denied` would blame this title's rights for an
 * empty provider registry.
 */
export type WatchSessionResult =
  | { readonly status: "ok"; readonly session: PlaybackSession; readonly policy: FailoverPolicy }
  | { readonly status: "not-found"; readonly contentId: string }
  | { readonly status: "not-configured"; readonly contentId: string }
  | { readonly status: "denied"; readonly contentId: string; readonly reasons: readonly string[] }
  | { readonly status: "error"; readonly reason: string };

/**
 * A conservative device profile.
 *
 * The server does not know what the browser can decode — capability negotiation
 * is part of PL-0501's session REQUEST, and this page does not make one. Stating
 * a narrow profile means candidates exercise the eligibility path rather than
 * trivially passing it, and it fails in the safe direction: a candidate wrongly
 * excluded here costs a fallback, while one wrongly included costs a decode
 * failure the viewer watches happen.
 *
 * Note what this profile no longer does. While the fixtures claimed `h264`/`aac`
 * they matched it exactly, so every fixture passed eligibility BECAUSE the
 * invented values were ones every device accepts, and the session was labelled
 * `verified` for a file nobody had opened. The fixtures now state `null` for all
 * four media facts, so they pass as ATTEMPTABLE and rank as `unverified`, which
 * is the true statement and the path a real adapter actually produces.
 */
const CONSERVATIVE_CAPABILITIES: PlaybackCapabilities = {
  maxHeight: 1080,
  supportedVideoCodecs: ["h264"],
  supportedAudioCodecs: ["aac"],
  preferredAudioLanguages: ["en"]
};

/**
 * Turn a ranking into the ordered candidate list the player walks.
 *
 * The ranking's order is preserved exactly. Re-sorting here would create a
 * second opinion about preference that could disagree with the one the decision
 * already published, and then the reason trail would explain a choice nobody
 * made.
 *
 * TWO TRANSPORT GATES RUN, IN THIS ORDER, AND BOTH ARE LOAD-BEARING.
 *
 *   1. `checkUrl` from `@liberty/provider-sdk` — the same outbound URL policy
 *      `issue-session.ts` runs immediately before it publishes a URI. This is
 *      the gate this route did not have. `checkPlaybackSource` accepts ANY
 *      `https:` URL, so `https://user:pass@evil.test/`, `https://169.254.169.254/…`,
 *      `https://10.0.0.5/…` and `https://rig.internal/…` all passed it, and a
 *      typo in `LIBERTY_FIXTURE_MEDIA_ORIGIN` was enough to publish any of them
 *      to a browser. `checkUrl` refuses each with a named reason, and it needs
 *      the source's `allowLoopback` and the deployment's own answer — which is
 *      the second reason the page could not have done this with its old
 *      candidate type.
 *
 *   2. `checkPlaybackSource` — kept, and deliberately not replaced. It is what
 *      `playback-controller.ts` runs on the CLIENT before handing a source to
 *      Shaka, unconditionally and out of this file's reach. Its loopback carve-
 *      out is narrower than `checkUrl`'s (`localhost`, `127.0.0.1`, `[::1]`
 *      only, so `http://127.0.0.2:8096` or `http://rig.localhost` pass the
 *      policy and fail here), so a candidate that skipped it would be published
 *      as playable and then die in the controller as `source-rejected` with
 *      nothing in the server's reason trail to explain it. Running it here makes
 *      this page's trail PREDICTIVE of what the client will do.
 *
 * The URL handed to gate 2 and to the player is `checkUrl`'s PARSED form, so
 * what ships is byte-for-byte what the policy accepted — the same reason
 * `issue-session.ts` publishes `check.url.toString()` rather than the raw
 * string. Closing the asymmetry by never handing the weaker checker an
 * unvalidated URL is available from inside this file; widening
 * `checkPlaybackSource` itself is not, and is written up separately.
 */
function toPlaybackCandidates(
  ranked: readonly { readonly candidate: StreamCandidate }[],
  authorized: readonly AuthorizedCandidate[],
  localDeployment: boolean,
  reasons: string[]
): PlaybackCandidate[] {
  const sources = new Map(authorized.map((entry) => [entry.candidate.id, entry.source]));
  const playable: PlaybackCandidate[] = [];

  for (const entry of ranked) {
    const id = entry.candidate.id;
    const source = sources.get(id);
    if (source === undefined) {
      /* Reachable only if the ranking returned an id it was not given, which
       * would be a defect rather than a data problem — so it is reported rather
       * than skipped in silence. */
      reasons.push(`${id}: ranked but no authorized source was issued for it`);
      continue;
    }

    const policy = checkUrl(source.uri, { allowLoopback: source.allowLoopback, localDeployment });
    if (!policy.ok) {
      /* The policy's own reason code, verbatim. `url-policy.ts` gives these the
       * `url_` prefix expressly so they can be surfaced without translation, and
       * a reason that gets rewritten on the way out is one that eventually stops
       * matching what the code did. */
      reasons.push(`${id}: ${policy.reason} — ${policy.detail}`);
      continue;
    }

    /* An empty `Content-Type` has told us nothing, which is what `undefined`
     * means to `PlaybackSource`. Passing `""` through would make Shaka issue a
     * HEAD request to guess rather than reading a value it was given. */
    const mimeType = source.mimeType === null || source.mimeType.trim() === "" ? undefined : source.mimeType;
    const checked: PlaybackSource = { uri: policy.url.toString(), mimeType };

    const backstop = checkPlaybackSource(checked);
    if (!backstop.ok) {
      reasons.push(`${id}: ${describeSourceRejection(backstop.reason)}`);
      continue;
    }

    playable.push({ id, providerId: entry.candidate.providerId, source: checked });
  }

  return playable;
}

/**
 * The identity question this process can answer WITHOUT asking a provider, and
 * the only one the route is allowed to answer with a 404.
 *
 * Every id in the system is lower-case and hyphen-separated, so a string that is
 * not normalized cannot name anything and never needs a lookup to be refused.
 * Exported because `[contentId]/page.tsx` has to ask it ABOVE the Suspense
 * boundary that hides the provider round-trip: a status line is sent before the
 * first byte of the body, so an existence decision taken inside the boundary is
 * a decision taken after the 200 has already shipped. `loadPlaybackSession`
 * still asks it too — a caller reaching the loader directly must get the same
 * refusal, and the page's gate is a routing concern rather than this module's
 * guarantee.
 *
 * WHAT IT DELIBERATELY DOES NOT ANSWER is whether a well-formed id names a real
 * work. That is the catalog's question, and there is no catalog behind this
 * resolver; `AuthorizedCandidateResolution` carries a `not-found` outcome so a
 * provider registry can answer it one day. When something finally does, THIS
 * function is where the lookup belongs — not the branch in the page that
 * currently renders it — because only this side of the boundary can still set a
 * status. `[contentId]/page.tsx` states the same obligation from its end.
 */
export function isWatchableContentId(contentId: string): boolean {
  return normalizedContentIdSchema.safeParse(contentId).success;
}

/**
 * The loader the watch route uses.
 *
 * Never throws. Every outcome is a branch the route can render, because they
 * have different remedies and a reader told to "try again in a moment" about a
 * title that will never exist — or about a deployment with no provider
 * configured — will keep trying.
 *
 * `requestId` is generated HERE and is not read from anything the client sent,
 * for the reason `ResolverContext` states: a client-chosen correlation id
 * forwarded to a third party is a client-chosen value in somebody else's logs.
 */
export async function loadPlaybackSession(
  contentId: string,
  resolve: AuthorizedCandidateResolver = resolveAuthorizedCandidates
): Promise<WatchSessionResult> {
  /*
   * Checked before the resolver is consulted. An id that is not normalized cannot
   * name anything — every id in the system is lower-case and hyphen-separated —
   * so this is not-found rather than an error, and doing it first keeps raw URL
   * path input from reaching the provider boundary at all.
   */
  if (!isWatchableContentId(contentId)) {
    return { status: "not-found", contentId };
  }

  let resolution: AuthorizedCandidateResolution;
  try {
    resolution = await resolve(contentId, { requestId: crypto.randomUUID() });
  } catch (cause) {
    return { status: "error", reason: cause instanceof Error ? cause.message : "candidate source failed" };
  }

  if (resolution.status === "not-found") return { status: "not-found", contentId };

  /*
   * THE BRANCH A HOSTED DEPLOYMENT TAKES, and the whole user-visible point of
   * this change. `resolveAuthorizedCandidates` answers `not-configured` whenever
   * `NonDeploymentEnvironment.classify()` returns `null` — which is every
   * `NODE_ENV` outside `NON_DEPLOYMENT_ENVIRONMENTS` — so `next start` now
   * renders an explanation instead of a player pointed at fabricated `owned`
   * fixtures.
   *
   * Its own status rather than `error` or `denied`, matching the session API's
   * argument for the same four-way split: `error` invites a retry that can never
   * succeed, and `denied` would report an operator's unfinished configuration as
   * a decision about this title's rights, which is a false statement about the
   * title and hides the real remedy.
   *
   * WHY THIS IS NOT MOVED BEHIND AN IDENTITY LOOKUP. The first reading of the
   * E2E 404 failure was that this branch answers before anything asks whether
   * the title exists, and that the ordering is therefore wrong. The ordering
   * that is available to this process is already right, and the rest is not
   * available at all:
   *
   *   - an id that is not NORMALIZED is refused at the top of this function,
   *     before the resolver is consulted, so it is `not-found` in every
   *     environment. That is the identity question this process can decide;
   *   - a WELL-FORMED id that names nothing is the identity question it cannot.
   *     Identity belongs to the catalog, and there is no catalog behind this
   *     resolver. `AuthorizedCandidateResolution` carries a `not-found` outcome
   *     precisely so a provider registry can answer it, and nothing produces one
   *     yet. Answering `not-found` from a deployment with an empty registry
   *     would assert that a title does not exist on the strength of having no
   *     providers — the same shape of unfounded claim as the fabricated `owned`
   *     fixtures this route was repaired to stop publishing, pointed the other
   *     way.
   *
   * And the failing assertion is not about this ordering in the first place. It
   * asks for an HTTP 404, and `notFound()` does not reach the wire as a status
   * on this route under ANY branch — see `[contentId]/page.tsx` for the
   * mechanism and the evidence. Reordering here would have produced the same
   * 200 with a different panel behind it.
   *
   * THE REAL REMAINING GAP, recorded rather than closed. Under a `development`
   * build the fixture provider manufactures three `owned` candidates for ANY
   * normalized id, so `/watch/no-such-title` mounts a player for a work nothing
   * in the catalog defines. Teaching the fixture provider to answer
   * `not-found` for ids it does not define needs a catalog lookup inside the
   * session API, which `authorized-candidates.ts` argues against by name
   * ("inventing an answer here would put provider configuration inside an HTTP
   * route"). It is a provider-registry task, not a repair made in passing to
   * move an E2E status.
   */
  if (resolution.status === "not-configured") return { status: "not-configured", contentId };

  if (resolution.status === "provider-unavailable") {
    /* The detail the resolver CHOSE to publish, which is safe by construction —
     * unlike a thrown value, whose text is whatever a library felt like saying. */
    return { status: "error", reason: resolution.detail };
  }

  const authorized = resolution.candidates;
  if (authorized.length === 0) {
    /*
     * `error`, not `denied`. A resolver that answered `resolved` with nothing in
     * it made no decision about this title; calling that a denial would report
     * an outage as a rights or capability refusal.
     */
    return { status: "error", reason: `no provider offered a stream for ${contentId}` };
  }

  const decision = rankStreamCandidates(
    authorized.map((entry) => entry.candidate),
    CONSERVATIVE_CAPABILITIES
  );

  /*
   * The rights and eligibility gate. `rankStreamCandidates` refuses any rights
   * value outside its allowlist before scoring anything, so a denial here is the
   * real invariant-1 answer rather than a check this file performs.
   */
  if (decision.selected === null) {
    return {
      status: "denied",
      contentId,
      reasons: [
        decision.reason,
        ...decision.rejected.map((entry) => `${entry.candidateId}: ${entry.reason}`)
      ]
    };
  }

  const reasons: string[] = [decision.reason, ...decision.ranked.map((entry) => `${entry.candidate.id}: ${entry.reason}`)];
  const candidates = toPlaybackCandidates(decision.ranked, authorized, isLocalDeployment(), reasons);

  if (candidates.length === 0) {
    return { status: "denied", contentId, reasons };
  }

  return {
    status: "ok",
    session: {
      contentId,
      candidates,
      /*
       * `null` rather than `0`, and the difference is not cosmetic: `null` means
       * "engine default", which for VOD is the beginning and for live is the
       * live edge. Resume-from-progress is PL-0403's, and it will set this.
       */
      startAtSeconds: null,
      reasons
    },
    policy: DEFAULT_FAILOVER_POLICY
  };
}
