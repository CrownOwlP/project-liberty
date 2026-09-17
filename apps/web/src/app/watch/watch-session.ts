import { normalizedContentIdSchema } from "@liberty/contracts/shared/ids";
import type { PlaybackCapabilities } from "@liberty/contracts/domains/playback";
import type { FailoverPolicy } from "@liberty/contracts/domains/failover";
import {
  checkPlaybackSource,
  describeSourceRejection,
  type PlaybackSource
} from "../../components/player/playback-source";
import type { PlaybackCandidate, PlaybackSession } from "../../components/player/playback-session";
import { handlePlaybackSessionRequest } from "../api/v1/playback/session/handler";
import {
  playbackSessionResponseSchema,
  type PlaybackSessionCandidate,
  type PlaybackSessionReason,
  type PlaybackSessionResponse
} from "../api/v1/playback/session/contract";

/* -------------------------------------------------------------------------
 * Where the watch route gets a session — and what it will never accept
 *
 * WRITTEN BY PL-0501 (round 45), INSIDE PL-0502's DECLARED SURFACE, AND THAT IS
 * DELIBERATE RATHER THAN A TRESPASS. PL-0502 is BACKLOG and unowned; PL-0501's
 * `surfaceWidenedOnReview` record adds `apps/web/src/app/watch/**` to this
 * task's write surface for one reason, quoted from `gpt-architect`'s
 * CHANGES_REQUESTED at 27d3a03:
 *
 *   "The PL-0901 ruling is a security/trust-boundary property, not merely an
 *    /api directory naming rule. Desktop builds must not execute
 *    provider-resolution logic or hold provider credentials through the watch
 *    path either. Move the watch page onto the playback-session API /
 *    target-selected route contract so desktop uses the authenticated backend
 *    path."
 *
 * So PL-0502 inherits a watch route that already consumes PL-0501's contract.
 * What is left for it is the part this change did NOT do: the client boundary,
 * the resume point (PL-0403), and whatever the player surface still wants that
 * the wire contract does not yet carry. Nothing here is a decision PL-0502 is
 * expected to keep if it has a better one — it is a trust-boundary repair, not
 * a design claim over that task's lane.
 *
 * THE CLIENT SUPPLIES A CONTENT ID AND NOTHING ELSE. There is no code path here
 * or in the route that turns a query parameter, a header or a request body into
 * a media URL, and there must never be one: a player that plays a URL the page
 * chose is an open proxy for arbitrary media, and it relocates product invariant
 * 1 into whatever code sets the attribute. `playback-source.ts` states the same
 * boundary one layer down.
 *
 * WHAT THIS FILE USED TO DO, AND WHY IT COULD NOT STAY.
 *
 * Until this round it imported `resolveAuthorizedCandidates` directly and ran
 * the rights gate, `rankStreamCandidates` and `checkUrl` IN THE PAGE. Round 44
 * recorded that as a ledger entry in `../api/v1/playback/build-target.test.ts`
 * and argued that `docs/DESKTOP_PLAYBACK.md` §8's ruling names
 * `/api/v1/playback/*`, so a clean API surface satisfied it. The reviewer
 * rejected that reading, and the rejection is the correct one: §8's ruling is
 * about WHERE PROVIDER RESOLUTION EXECUTES, not about which directory a file
 * sits in. A desktop build whose `/watch/<id>` page resolved providers
 * on-device would hold provider configuration, run the rights gate and mint
 * URLs on a machine its user administers — the exact arrangement §8 refuses —
 * while the route next door proved a property about itself.
 *
 * HOW IT IS DONE: THE ROUTE CONTRACT, IN PROCESS, THROUGH THE SAME SEAM.
 *
 * `handlePlaybackSessionRequest` is the HTTP half of
 * `POST /api/v1/playback/session`. It is the module that sits IN FRONT of the
 * build-target seam, and it obtains its decision from
 * `./playback-session-implementation`, which resolves to the on-device resolver
 * under the web target and to the forwarder under the desktop target (see
 * `../api/v1/playback/build-target.ts`). Calling it here therefore means:
 *
 *   - on the WEB target, exactly the work this file used to do, performed once,
 *     by the code the API already publishes, with one reason vocabulary;
 *   - on the DESKTOP target, a forwarded request to the authenticated backend.
 *     No provider SDK, no media engine, no rights gate and no `checkUrl` is
 *     compiled into this page's graph at all — which is the property the
 *     reviewer asked to see proven, and `build-target.test.ts` now proves it
 *     with an EMPTY offender ledger.
 *
 * WHY IN PROCESS RATHER THAN AN HTTP FETCH TO OUR OWN ORIGIN. A server
 * component has no absolute base URL it can trust — it would have to be
 * constructed from a `Host` header, which is caller-influenced — and the hop
 * would cost a second connection, a second serialisation and a second set of
 * failure modes, to arrive at the same answer. The trust-boundary property does
 * not depend on the transport: it depends on WHICH MODULE IS COMPILED IN behind
 * the seam, and an in-process call crosses the same seam a fetch would.
 *
 * WHY NOT IMPORT `decidePlaybackSession` DIRECTLY, WHICH IS ONE LAYER CLOSER.
 * Because `handler.ts` is where the contract is enforced — the response is
 * re-validated against `playbackSessionResponseSchema`, the status is derived
 * from the outcome, and `no-store` is set. A caller that skipped it would be a
 * second consumer of the decision with its own idea of what a decision means,
 * and the reason `contract.ts` gives for re-validating on the way out applies to
 * this reader as much as to a browser.
 *
 * WHAT IS STILL DECIDED HERE, AND IT IS NOT A SECOND OPINION ABOUT RIGHTS.
 * Exactly two things: the device capability profile this page is willing to
 * claim (below), and `checkPlaybackSource` as a CLIENT-PREDICTIVE backstop —
 * see `toPlaybackCandidates`. Neither ranks, neither evaluates rights and
 * neither can admit a candidate the session refused.
 * ---------------------------------------------------------------------- */

/**
 * The path the session route is served at.
 *
 * A CONSTANT, and deliberately not imported from either implementation of the
 * seam. Importing it from `playback-session-implementation.desktop.ts` would
 * pull the forwarder into the web build's graph, and importing it from the
 * resolving half would pull the resolver into the desktop build's graph —
 * either way this file would defeat the split it exists to honour. It is
 * restated instead, and `watch-session.test.ts` pins it against the route
 * module's own position in the `app/` tree so it cannot drift.
 */
export const PLAYBACK_SESSION_ROUTE = "/api/v1/playback/session";

/**
 * The origin the synthesised request carries.
 *
 * THE HANDLER NEVER READS IT, and neither implementation behind the seam
 * composes an outbound URL from it: the resolving half reads only the body, and
 * the forwarder builds its target from `PLAYBACK_SESSION_PATH` against the
 * configured backend origin, for the stated reason that composing an outbound
 * URL from a value a caller influenced is how a proxy becomes a general-purpose
 * one. `Request` requires an absolute URL, so one is supplied that names this
 * process rather than anything reachable.
 */
const IN_PROCESS_ORIGIN = "http://localhost";

/**
 * Every outcome the route can render, as a branch rather than as an error.
 *
 * UNCHANGED FROM THE VERSION THIS FILE USED TO PRODUCE LOCALLY, on purpose:
 * `[contentId]/page.tsx` renders five panels and the reviewer's correction is
 * about where the decision is taken, not about what a viewer sees. The mapping
 * from the wire union onto these five is in `watchResultFor` below, and it is
 * the only place the two vocabularies meet.
 *
 * `not-configured` stays separate from both of its neighbours. It is what a
 * hosted deployment answers, it is permanent until an OPERATOR acts, and folding
 * it into `error` would tell a viewer to retry something no waiting can fix while
 * folding it into `denied` would blame this title's rights for an empty provider
 * registry.
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
 * is part of the session REQUEST, and this page makes one on the viewer's
 * behalf without having asked the device anything. Stating a narrow profile
 * means candidates exercise the eligibility path rather than trivially passing
 * it, and it fails in the safe direction: a candidate wrongly excluded here
 * costs a fallback, while one wrongly included costs a decode failure the viewer
 * watches happen.
 *
 * IT IS THE SAME PROFILE THIS FILE ALREADY USED, carried across unchanged so
 * that moving the decision behind the API is not also a silent change to what
 * gets ranked. `docs/DESKTOP_PLAYBACK.md` §4 says a desktop client should
 * eventually report the UNION of both engines' capability sets; that is
 * PL-0502's and the `PlayerAdapter`'s work, and inventing a union here — from a
 * page that cannot see either adapter — would be a capability claim nobody
 * measured.
 */
export const CONSERVATIVE_CAPABILITIES: PlaybackCapabilities = {
  maxHeight: 1080,
  supportedVideoCodecs: ["h264"],
  supportedAudioCodecs: ["aac"],
  preferredAudioLanguages: ["en"]
};

/**
 * What this loader needs from the incoming request, and nothing else.
 *
 * ONLY HEADERS, AND THEY ARE FORWARDED RATHER THAN READ. §8 says the desktop
 * proxy "forwards an authenticated caller identity — the session or profile
 * identity the request already carries". Under the desktop target this page's
 * session request is the one that has to carry it, so the page hands its own
 * inbound headers down and the forwarder's own ALLOWLIST
 * (`IDENTITY_HEADERS`) decides which of them leave the machine. Nothing in this
 * file inspects a header, branches on one, or can be steered by one: the value
 * is copied into the synthesised `Request` and never looked at.
 *
 * Optional because the unit suite constructs no request context, and because a
 * caller that has none must get the same decision a caller with an empty header
 * set gets rather than a different code path.
 */
export interface WatchSessionRequestContext {
  readonly headers?: Headers;
}

/**
 * The seam the unit suite injects at.
 *
 * `(Request) => Promise<Response>` is the ROUTE's own shape, so a test drives
 * this loader with the same thing a browser would get and cannot accidentally
 * be handed a richer object than the wire carries. The default is the real
 * handler, which is what makes the production path the tested path.
 */
export type PlaybackSessionIssuer = (request: Request) => Promise<Response>;

/**
 * One wire reason as one line of the panel's trail.
 *
 * The CODE is always present and always first, because it is the closed
 * vocabulary a support engineer greps for; `detail` follows it for humans.
 * `candidateId` leads when there is one, matching the `"<id>: <why>"` shape this
 * page's trail already had, so a screenshot from before and after this change
 * reads the same way.
 */
export function describeReason(reason: PlaybackSessionReason): string {
  const body = `${reason.code} — ${reason.detail}`;
  return reason.candidateId === null ? body : `${reason.candidateId}: ${body}`;
}

/**
 * Turn the session's candidates into the ordered list the player walks.
 *
 * THE ORDER IS THE SESSION'S. Re-sorting here would create a second opinion
 * about preference that could disagree with the one the decision already
 * published, and then the reason trail would explain a choice nobody made.
 *
 * ONE GATE RUNS HERE, AND IT IS NOT A RIGHTS CHECK. `checkUrl` — the outbound
 * transport policy — ran on the server that issued this session, immediately
 * before it published each URI, and under the desktop target it ran on the
 * backend. Running it again here would require `@liberty/provider-sdk` in this
 * graph, which is precisely what the desktop build must not contain, and it
 * would be a second opinion about a decision already taken.
 *
 * What still runs is `checkPlaybackSource`, and it is kept for the reason it was
 * always kept: it is what `playback-controller.ts` runs on the CLIENT before
 * handing a source to Shaka, unconditionally and out of this file's reach. Its
 * loopback carve-out is NARROWER than `checkUrl`'s (`localhost`, `127.0.0.1`,
 * `[::1]` only, so `http://127.0.0.2:8096` or `http://rig.localhost` pass the
 * server's policy and fail here), so a candidate that skipped it would be
 * rendered as playable and then die in the controller as `source-rejected` with
 * nothing in this page's trail to explain it. Running it here makes the panel
 * PREDICTIVE of what the client will do. It can only ever REMOVE a candidate the
 * session already authorized; there is no branch below through which it can add
 * one.
 */
function toPlaybackCandidates(
  candidates: readonly PlaybackSessionCandidate[],
  reasons: string[]
): PlaybackCandidate[] {
  const playable: PlaybackCandidate[] = [];

  for (const candidate of candidates) {
    /* An empty `Content-Type` has told us nothing, which is what `undefined`
     * means to `PlaybackSource`. Passing `""` through would make Shaka issue a
     * HEAD request to guess rather than reading a value it was given. */
    const mimeType =
      candidate.mimeType === null || candidate.mimeType.trim() === "" ? undefined : candidate.mimeType;
    const source: PlaybackSource = { uri: candidate.uri, mimeType };

    const backstop = checkPlaybackSource(source);
    if (!backstop.ok) {
      reasons.push(`${candidate.id}: ${describeSourceRejection(backstop.reason)}`);
      continue;
    }

    playable.push({ id: candidate.id, providerId: candidate.providerId, source });
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
 * IT IS NOW ALSO A PRE-FILTER IN FRONT OF THE API CALL rather than only in front
 * of a resolver, and it stays for the same reason: raw URL path input should not
 * reach the trust boundary at all. The route would refuse it anyway —
 * `playbackSessionRequestSchema` uses the same `normalizedContentIdSchema` — so
 * this is a duplicated refusal on purpose, and the duplication is safe because
 * both sides read the one schema.
 *
 * WHAT IT DELIBERATELY DOES NOT ANSWER is whether a well-formed id names a real
 * work. That is the catalog's question, and the session route carries a
 * `content_not_found` reason so a provider registry can answer it one day. When
 * something finally does, THIS function is where the lookup belongs — not the
 * branch in the page that currently renders it — because only this side of the
 * boundary can still set a status. `[contentId]/page.tsx` states the same
 * obligation from its end.
 */
export function isWatchableContentId(contentId: string): boolean {
  return normalizedContentIdSchema.safeParse(contentId).success;
}

/**
 * The wire decision, as the branch this route renders.
 *
 * EXPORTED AND PURE, so the mapping can be asserted over every reason code in
 * the vocabulary without a request, a resolver or a network. It is the only
 * place the two vocabularies meet, and the mapping is by REMEDY rather than by
 * severity — the same argument `contract.ts` makes for why the wire union has
 * three branches instead of a boolean:
 *
 *   - `granted`     -> `ok`, or `denied` when nothing survives the client-side
 *                      backstop, because a player handed an empty list goes
 *                      straight to `fatal` with `no_candidates` — a true
 *                      statement made by the layer that does not know why.
 *   - `denied`      -> `denied`. Retrying changes nothing.
 *   - `unavailable` -> three different panels, because "we would have and could
 *                      not" has three different remedies:
 *                        `content_not_found`       -> `not-found`   (nothing to fix)
 *                        `provider_not_configured` -> `not-configured` (operator's)
 *                        anything else             -> `error`       (retryable)
 *
 * The last split is the one that matters most and is the one this page has
 * always made: telling a viewer to "try again in a moment" about a deployment
 * with no provider wired in produces a retry loop no waiting resolves, and
 * `provider_not_configured` is exactly the code the session route publishes for
 * it under both build targets — the resolving half when the fixture environment
 * is not constructible, the forwarder when no backend origin is configured.
 */
export function watchResultFor(
  contentId: string,
  response: PlaybackSessionResponse
): WatchSessionResult {
  const reasons = response.reasons.map(describeReason);

  if (response.outcome === "denied") {
    return { status: "denied", contentId, reasons };
  }

  if (response.outcome === "unavailable") {
    switch (response.reasons[0].code) {
      case "content_not_found":
        return { status: "not-found", contentId };
      case "provider_not_configured":
        return { status: "not-configured", contentId };
      default:
        /* The panel shows one sentence, so the PRIMARY reason is what it shows.
         * The rest of the trail is not discarded — `denied` carries all of it —
         * but an `error` panel that listed every candidate rejection would bury
         * the one line that names the remedy. */
        return { status: "error", reason: reasons[0] ?? response.reasons[0].code };
    }
  }

  const candidates = toPlaybackCandidates(response.session.candidates, reasons);
  if (candidates.length === 0) {
    return { status: "denied", contentId, reasons };
  }

  return {
    status: "ok",
    session: {
      contentId: response.session.contentId,
      candidates,
      /*
       * THE SESSION'S OWN RESUME POINT, not `null` restated. `issue-session.ts`
       * writes `null` unconditionally today and `null` still means "engine
       * default" — the beginning for VOD, the live edge for live. Reading it
       * from the response rather than hardcoding it means the day PL-0403 joins
       * progress to session issuance, this page honours it without an edit.
       */
      startAtSeconds: response.session.startAtSeconds,
      reasons
    },
    /*
     * PUBLISHED BY THE SESSION, not imported from the engine. The attempt budget
     * is a product decision the contract carries expressly so a client does not
     * hold its own copy — and a copy here would also drag
     * `@liberty/media-engine` into the desktop build's graph for the sake of one
     * constant, which is the whole exposure this change removes.
     */
    policy: response.session.failoverPolicy
  };
}

/**
 * The loader the watch route uses.
 *
 * NEVER THROWS. Every outcome is a branch the route can render, because they
 * have different remedies and a reader told to "try again in a moment" about a
 * title that will never exist — or about a deployment with no provider
 * configured — will keep trying.
 *
 * NO `requestId` IS GENERATED HERE ANY MORE. It used to be, because this file
 * called a provider resolver and `ResolverContext` requires one that a client
 * did not choose. The resolver is now behind the route, which mints its own on
 * the side of the boundary that talks to a provider — and under the desktop
 * target that side is the backend. A correlation id invented here would name a
 * process that no longer performs the call.
 */
export async function loadPlaybackSession(
  contentId: string,
  context: WatchSessionRequestContext = {},
  issue: PlaybackSessionIssuer = handlePlaybackSessionRequest
): Promise<WatchSessionResult> {
  /*
   * Checked before the route is called. An id that is not normalized cannot
   * name anything, so this is not-found rather than an error, and doing it here
   * keeps raw URL path input from reaching the trust boundary at all.
   */
  if (!isWatchableContentId(contentId)) {
    return { status: "not-found", contentId };
  }

  const headers = new Headers(context.headers);
  headers.set("content-type", "application/json");

  const request = new Request(new URL(PLAYBACK_SESSION_ROUTE, IN_PROCESS_ORIGIN), {
    method: "POST",
    headers,
    body: JSON.stringify({ contentId, capabilities: CONSERVATIVE_CAPABILITIES })
  });

  let payload: unknown;
  try {
    payload = await (await issue(request)).json();
  } catch (cause) {
    /*
     * Reachable only if the route itself failed to produce a body — which the
     * handler is written never to do, since even its own self-check failure is
     * a JSON 500. It is caught rather than allowed to propagate because a page
     * whose failure mode is a stack trace is a page with no reason trail, which
     * is what invariant 4 exists to prevent.
     */
    return {
      status: "error",
      reason: cause instanceof Error ? cause.message : "the playback session route did not answer"
    };
  }

  /*
   * PARSED, NOT CAST. `handler.ts` already validated this body against the same
   * schema on the way out, so under the web target this can only fail if the two
   * disagree; under the DESKTOP target the body originated at a backend, was
   * validated by the forwarder, and re-validating costs nothing next to the
   * network hop that produced it. A reader that trusted the shape because "our
   * own code made it" is the reader that turns a contract regression into a
   * render crash.
   *
   * The 500 the handler emits for its own self-check failure is deliberately NOT
   * a member of the union, so it lands here and becomes an honest `error` panel
   * rather than being mistaken for a decision.
   */
  const parsed = playbackSessionResponseSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      status: "error",
      reason: "the playback session route answered outside the playback session contract"
    };
  }

  return watchResultFor(contentId, parsed.data);
}
