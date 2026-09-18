import {
  deniedSession,
  playbackReason,
  playbackSessionHttpStatus,
  playbackSessionResponseSchema,
  type PlaybackSessionResponse
} from "./contract";
import {
  decidePlaybackSession,
  type PlaybackSessionOptions
} from "./playback-session-implementation";

/* -------------------------------------------------------------------------
 * The HTTP half of POST /api/v1/playback/session
 *
 * Separated from `route.ts` because a Next route module may only export the
 * handlers and a fixed set of segment config values -- so a route file has
 * nowhere to accept an injected resolver, and testing one means testing it with
 * whatever the deployment happens to be configured with. This file takes the
 * options; `route.ts` is the three-line adapter that supplies none.
 *
 * IT IS ALSO THE WHOLE OF WHAT SITS IN FRONT OF THE BUILD-TARGET SEAM, and that
 * is the reason `docs/DESKTOP_PLAYBACK.md` §8's "the contract is preserved
 * exactly" is a structural claim here rather than a promise. The decision comes
 * from `./playback-session-implementation`, which is one module under the web
 * target and a different one under the desktop target (see `../build-target.ts`).
 * Everything below -- the schema re-validation, the status derivation, the
 * `no-store` header, the shape of the 500 -- runs unchanged in both builds,
 * because it is compiled from this one file either way. No client can tell the
 * two apart, and there is nothing here for one to branch on.
 * ---------------------------------------------------------------------- */

/**
 * Never cached, at any layer.
 *
 * A playback session is per-viewer, per-device and time-bounded. A shared cache
 * holding one would serve one viewer's session -- and eventually one viewer's
 * credential -- to another, which is threat 1 and threat 2 in docs/SECURITY.md
 * in a single response.
 */
const NO_STORE = { "cache-control": "no-store" };

/**
 * A decision, as the HTTP response the contract says it is.
 *
 * SPLIT OUT FROM THE HANDLER so that it is one function rather than one
 * function per target: `playback-session-implementation.desktop.test.ts` drives
 * the forwarding implementation through this exact envelope and asserts the
 * same statuses, the same bodies and the same header the web suite asserts, so
 * "the contract is identical across targets" is checked against the shipped
 * code rather than argued from the file layout.
 */
export function playbackSessionResponse(response: PlaybackSessionResponse): Response {
  /*
   * Validated against the published contract before it leaves the server, the
   * same way the catalog route is. The reason is not paranoia about our own
   * object literals: it is that `reasons` being non-empty on every branch is a
   * PRODUCT invariant, and an invariant nothing checks at runtime is one that a
   * later refactor can quietly drop. A regression surfaces here as a 500 with a
   * stable code rather than as a decision no one can explain.
   *
   * This is the one response that is not a member of the union, and that is
   * deliberate: it is not a playback decision at all, it is a statement that
   * this service produced something it is not allowed to say.
   */
  const parsed = playbackSessionResponseSchema.safeParse(response);
  if (!parsed.success) {
    return Response.json(
      { error: "playback_session_failed_validation", issues: parsed.error.issues },
      { status: 500, headers: NO_STORE }
    );
  }

  const validated: PlaybackSessionResponse = parsed.data;

  return Response.json(validated, {
    status: playbackSessionHttpStatus(validated),
    headers: NO_STORE
  });
}

/* -------------------------------------------------------------------------
 * The request body bound (PL-0707, register entry F10)
 * ---------------------------------------------------------------------- */

/**
 * The largest request body this route will read, in bytes. 16 KiB.
 *
 * NOT A ROUND NUMBER PICKED FOR COMFORT. It is derived from the largest body
 * `playbackSessionRequestSchema` can legitimately accept, because that schema is
 * `.strict()` at both levels and therefore has a computable worst case:
 *
 *   - the JSON scaffolding of `{"contentId":…,"capabilities":{…}}`   ~40 B
 *   - `contentId` -- `normalizedContentIdSchema`, lower-case and
 *     hyphen-separated; no id in this system approaches this          256 B
 *   - `maxHeight`, `maxAudioChannels` -- integers                       ~40 B
 *   - `supportedVideoCodecs` -- the WHOLE `videoCodecSchema` enum       ~30 B
 *   - `supportedAudioCodecs` -- the WHOLE `audioCodecSchema` enum       ~30 B
 *   - `preferredAudioLanguages` -- the only open-ended field. A BCP-47
 *     tag is at most 35 characters in practice, so 38 B quoted and
 *     comma-separated; a hundred of them, which no real device profile
 *     comes close to listing, is                                     3,800 B
 *
 * That is ~4.2 KiB for a request already far beyond anything a device sends.
 * 16 KiB is roughly four times it, so the bound cannot plausibly refuse an
 * honest caller, and it is also the figure Node already applies to the OTHER
 * half of a request (`--max-http-header-size` defaults to 16 KiB) -- so the two
 * halves of a request to this route are bounded at the same order of magnitude
 * rather than one of them being 64x the other.
 *
 * DELIBERATELY TWO ORDERS OF MAGNITUDE BELOW the resolve scaffold's
 * `MAX_REQUEST_BYTES` of 1 MiB. That is not an inconsistency to be tidied away:
 * that route accepts a client-supplied CANDIDATE ARRAY whose size is genuinely
 * caller-determined, and this one accepts two fields of fixed shape. A bound
 * should be the size of the thing it bounds.
 *
 * IT DOES NOT SUBSTITUTE FOR THE PER-FIELD BOUND in PL-0708
 * (`streamCandidateSchema` in `@liberty/contracts`), and PL-0708 does not
 * substitute for this. This caps the envelope; that caps one field inside it. A
 * body comfortably under 16 KiB can still carry a single 15 KiB id, and a body
 * of a million well-formed small fields is stopped only here.
 */
export const MAX_REQUEST_BODY_BYTES = 16 * 1024;

/**
 * A refusal carries its OWN code rather than borrowing the caller's.
 *
 * The two ways this read can fail are not the same event and must not be
 * reported as one. "You sent more than we will read" is
 * `request_body_too_large`; "the stream broke before we had it" is
 * `request_malformed`, which is the answer the resolving implementation has
 * always given a body it could not read. Collapsing them would repeat, in the
 * other direction, the mistake this task exists to avoid: register entry F10
 * rejected reusing `request_malformed` for a size refusal because it would
 * report a size event as a shape event, and a size code on a broken socket is
 * the same lie with the operands swapped.
 */
type BoundedRequest =
  | { readonly ok: true; readonly request: Request }
  | {
      readonly ok: false;
      readonly code: "request_body_too_large" | "request_malformed";
      readonly detail: string;
    };

/**
 * Reads at most `maxBytes` of the request body and hands back a Request that
 * replays exactly those bytes, or a refusal.
 *
 * WHY A METERED READ AND NOT A `content-length` CHECK. The resolve scaffold
 * beside this route checks the header and says so in its own comment: a
 * declared length "is a claim and not a measurement -- it can be absent under
 * chunked encoding and it can be a lie". Both cases are ordinary, not exotic:
 * `Transfer-Encoding: chunked` carries no `content-length` at all, and a header
 * is trivially forged by anything that is not a browser. A route that trusted
 * the header would have a bound an attacker opts into. So:
 *
 *   1. The header is consulted FIRST, and only ever to refuse EARLIER. A caller
 *      that honestly declares 40 MB is turned away without a single byte being
 *      read off the socket. A caller that declares nothing, or declares a lie,
 *      is not thereby admitted -- it just does not get refused this cheaply.
 *   2. The bytes are then METERED as they arrive, and the read stops the moment
 *      the running total EXCEEDS the bound. This is the actual control. Peak
 *      memory is the bound plus at most one chunk, whatever the header said and
 *      whatever the sender goes on to send, and a sender streaming an endless
 *      body is cut off rather than followed.
 *   3. The reader is cancelled on every exit, including the refusal, so the
 *      refused connection is not left open holding the rest of a body nobody
 *      will read.
 *
 * A `null` body -- no stream to meter, which is where some test doubles land --
 * is passed through: there is nothing buffered here to bound, and the schema
 * below answers a bodyless POST as the malformed request it is.
 */
async function readBoundedRequest(request: Request, maxBytes: number): Promise<BoundedRequest> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const size = Number(declared);
    if (Number.isFinite(size) && size > maxBytes) {
      return {
        ok: false,
        code: "request_body_too_large",
        detail: `content-length ${size} exceeds the ${maxBytes} byte cap`
      };
    }
  }

  const body = request.body;
  if (body === null) return { ok: true, request };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value = chunk.value;
      if (value === undefined) continue;
      received += value.byteLength;
      if (received > maxBytes) {
        return {
          ok: false,
          code: "request_body_too_large",
          detail: `the request body exceeds the ${maxBytes} byte cap`
        };
      }
      chunks.push(value);
    }
  } catch {
    /*
     * A stream that failed mid-read. NOT a size event: `request_malformed` is
     * the answer the resolving implementation has always given a body it could
     * not read -- a client-side fault, not a server one -- and now the same
     * answer under BOTH build targets, because it is decided once, here, in
     * front of the seam. The desktop forwarder used to call this
     * `provider_unavailable`, which blamed a backend that had not been asked
     * anything yet.
     */
    return { ok: false, code: "request_malformed", detail: "the request body could not be read" };
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  /*
   * Replayed as a new Request rather than handed on as bytes, so that the seam
   * keeps the shape `(Request, options)` that `docs/DESKTOP_PLAYBACK.md` §8
   * depends on: the forwarding implementation still gets the headers it
   * allowlists and still forwards the bytes it was given, unparsed. Method, URL
   * and headers are carried over; only the already-consumed stream is replaced
   * by the bytes that came out of it.
   */
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return {
    ok: true,
    request: new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: bytes
    })
  };
}

/**
 * The size gate, as the envelope applies it: a Request safe to decide on, or the
 * refusal to send instead.
 *
 * SPLIT OUT AND EXPORTED for the reason `playbackSessionResponse` above is:
 * `playback-session-implementation.desktop.test.ts` is the only suite that can
 * exercise the forwarding implementation, and it composes it with the pieces of
 * this envelope by hand because a vitest run resolves the web implementation.
 * Without a named gate, "the desktop target gets the cap too" would be an
 * argument about file layout rather than something a test can drive.
 *
 * Both callers get the identical function, because there is only one.
 */
export async function boundRequestBody(
  request: Request
): Promise<
  | { readonly ok: true; readonly request: Request }
  | { readonly ok: false; readonly response: Response }
> {
  const bounded = await readBoundedRequest(request, MAX_REQUEST_BODY_BYTES);
  if (bounded.ok) return { ok: true, request: bounded.request };

  return {
    ok: false,
    response: playbackSessionResponse(deniedSession(playbackReason(bounded.code, bounded.detail)))
  };
}

export async function handlePlaybackSessionRequest(
  request: Request,
  options: PlaybackSessionOptions = {}
): Promise<Response> {
  /*
   * BEFORE THE DECISION, AND THEREFORE BEFORE THE BODY IS BUFFERED. A cap
   * applied after `request.json()` has already returned bounds nothing: the
   * memory it was meant to protect has been spent by the time it is checked.
   *
   * IT IS HERE AND NOT IN EITHER IMPLEMENTATION because this file is the whole
   * of what sits in front of the build-target seam (see the header comment). One
   * cap written once is one cap both builds get; a cap written in
   * `playback-session-implementation.ts` would have left the desktop target's
   * `request.text()` exactly as unbounded as the web target was, which is the
   * asymmetry register entry F10 in docs/SECURITY_REVIEW_PROVIDER_URL.md is
   * about in the first place. The refusal short-circuits `decidePlaybackSession`
   * entirely, so neither implementation -- neither the resolver nor the
   * forwarder -- is handed an oversized body to spend memory on.
   */
  const bounded = await boundRequestBody(request);
  if (!bounded.ok) return bounded.response;

  return playbackSessionResponse(await decidePlaybackSession(bounded.request, options));
}
