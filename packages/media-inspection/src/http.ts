import { authoriseFetchTarget, truncate, type EgressDependencies, type EgressPolicy, type EgressRejectionReason } from "./egress";
import type { PinnedFetch } from "./pin";

/**
 * The only place this package touches the network (PL-0304).
 *
 * It fetches ONE document, of bounded size, within one deadline, over a redirect
 * chain in which every hop is revalidated. It is not a client, it has no
 * general-purpose surface, and nothing in it is reusable as one. That is the
 * point: the acceptance criterion says the service never becomes a
 * general-purpose fetcher, and the way a service becomes one is by growing a
 * helper that is nearly one.
 *
 * The failure modes it must survive, each with the reason it is here:
 *
 *   - A HANGING PUBLISHER. The deadline spans the WHOLE operation -- every
 *     redirect and the body read -- because a per-request timeout is trivially
 *     defeated by three redirects that each answer just inside it.
 *
 *   - AN UNBOUNDED BODY. `await response.text()` against a source that streams
 *     gigabytes is a remotely triggered out-of-memory crash. The cap matters
 *     doubly here: the research's specific warning about `@xmldom/xmldom` is to
 *     size-limit the body BEFORE parsing, because an XML parser's memory cost is
 *     a multiple of its input's and the input is attacker-chosen. The body is
 *     read incrementally and abandoned the moment it crosses the cap, so an
 *     oversized document is never parsed and never fully buffered.
 *
 *   - A REDIRECT OUT OF THE ALLOWLIST. `fetch` follows redirects by default, so
 *     validating the first URL and then letting a publisher 302 us to
 *     169.254.169.254 would be a complete bypass. Redirects are manual and every
 *     hop goes back through `authoriseFetchTarget` -- allowlist, host class and
 *     a fresh resolution included.
 *
 *   - A NAME THAT ANSWERS DIFFERENTLY THE SECOND TIME. This file used to hand a
 *     HOSTNAME to a `fetch`-shaped port, which meant the runtime resolved the
 *     name again at connect time and the address that had been classified was
 *     never the address that was reached. The transport port now takes the
 *     `PinnedTarget` the authorisation produced, so the addresses travel with
 *     the URL and a transport that ignores them does not type-check. Per hop:
 *     each pass through the loop re-authorises and therefore re-pins, so hop
 *     N+1 is never connected on hop N's addresses. See `pin.ts`.
 *
 * NOTHING HERE THROWS, and nothing here reproduces a URL. A manifest URL is
 * signed; the research records that credential leakage through error strings is
 * unconditional rather than incidental, and this file is the boundary at which a
 * URL stops being ours. Details name an origin at most.
 */

export type ManifestFetchFailure =
  | "timeout"
  | "network_error"
  | "response_too_large"
  | "too_many_redirects"
  | "redirect_without_location"
  | "http_status"
  | EgressRejectionReason;

export interface ManifestFetchOptions {
  readonly egress: EgressPolicy;
  /** Deadline for the entire operation, including redirects and the body read. */
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly maxRedirects: number;
  readonly userAgent: string;
}

export interface ManifestFetchDependencies extends EgressDependencies {
  /**
   * The transport. NOT `typeof fetch`: it takes the pinned target rather than a
   * URL, because a transport handed only a URL has no way to learn which
   * addresses were authorised and must resolve the name itself -- which is the
   * second resolution this whole design exists to remove. `node/pinned-fetch.ts`
   * is the implementation for a Node deployment.
   */
  readonly fetchImpl: PinnedFetch;
  readonly now: () => number;
}

export type ManifestFetchResult =
  | {
      readonly ok: true;
      readonly text: string;
      /** The URL the body actually came from. Relative URIs resolve against it. */
      readonly finalUrl: string;
      readonly elapsedMs: number;
    }
  | {
      readonly ok: false;
      readonly reason: ManifestFetchFailure;
      readonly detail: string;
      readonly elapsedMs: number;
    };

/** Statuses that carry a `Location` we are willing to follow. */
const REDIRECT_STATUSES: readonly number[] = [301, 302, 303, 307, 308];

/**
 * Reads a body incrementally, abandoning it as soon as it exceeds `maxBytes`.
 *
 * `Content-Length` is checked first as a cheap early exit, but it is only a
 * CLAIM -- absent under chunked encoding, and a lie whenever the publisher wants
 * it to be -- so the streaming cap is the actual control and the header check is
 * the optimisation. Getting that relationship backwards is the usual way a "we
 * check Content-Length" defence turns out not to be one.
 */
async function readBounded(
  response: Response,
  maxBytes: number
): Promise<{ ok: true; text: string } | { ok: false; detail: string }> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const size = Number(declared);
    if (Number.isFinite(size) && size > maxBytes) {
      return { ok: false, detail: `content-length ${size} exceeds the ${maxBytes} byte cap` };
    }
  }

  const body = response.body;
  if (!body) {
    // No stream to meter -- some environments, and most test doubles. The text
    // is already in memory here, so the cap can only be reported rather than
    // enforced, which is why the streaming path above is the primary control.
    const text = await response.text();
    const size = new TextEncoder().encode(text).length;
    return size > maxBytes
      ? { ok: false, detail: `body of ${size} bytes exceeds the ${maxBytes} byte cap` }
      : { ok: true, text };
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";

  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value = chunk.value;
      if (!value) continue;
      received += value.byteLength;
      if (received > maxBytes) {
        return { ok: false, detail: `body exceeded the ${maxBytes} byte cap` };
      }
      // `stream: true`, so a multi-byte character split across two chunks is not
      // decoded into two replacement characters.
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    // Releases the socket whether we finished, gave up on the cap, or were
    // aborted. A leaked reader keeps the connection open past the deadline this
    // file exists to enforce.
    await reader.cancel().catch(() => undefined);
  }

  return { ok: true, text: text + decoder.decode() };
}

/**
 * The shape of a platform error code, and why one is safe to repeat: it is a
 * short screaming-snake token from a vocabulary the runtime owns, so nothing a
 * publisher wrote can be smuggled through wearing that shape.
 */
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,31}$/;

function errorCode(error: Error): string | undefined {
  // `code` is not on the `Error` type; it is a Node/undici convention, and it
  // sits either on the error or on the `cause` undici wraps around it.
  for (const candidate of [error, error.cause]) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const code = (candidate as { readonly code?: unknown }).code;
    if (typeof code === "string" && ERROR_CODE_PATTERN.test(code)) return code;
  }
  return undefined;
}

/**
 * An error named by its TYPE, never by its message.
 *
 * Some `fetch` implementations put the target URL in the message. Here that URL
 * is a signed manifest URL, so the message is a credential. What is kept is the
 * error's name plus, when the runtime supplies one, a system error code
 * (`ECONNREFUSED`, `ENOTFOUND`, `UND_ERR_SOCKET`) -- the part anybody actually
 * reads.
 */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return `a non-Error ${typeof error} was thrown`;
  // Capped even though every error reaching here is constructed by the runtime:
  // `name` is a writable property, so its length is not ours to assume.
  const name = truncate(error.name, 40);
  const code = errorCode(error);
  return code === undefined ? name : `${name} (${code})`;
}

export async function fetchManifestText(
  rawUrl: string,
  options: ManifestFetchOptions,
  deps: ManifestFetchDependencies
): Promise<ManifestFetchResult> {
  const startedAt = deps.now();
  const elapsed = (): number => Math.max(0, Math.round(deps.now() - startedAt));

  const controller = new AbortController();
  // Inferred rather than annotated: `setTimeout` is a merged DOM/Node global
  // whose return type differs between them, and pinning it to either spelling
  // breaks the build on the other.
  const timer = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs);

  const fail = (reason: ManifestFetchFailure, detail: string): ManifestFetchResult => ({
    ok: false,
    reason,
    detail,
    elapsedMs: elapsed()
  });

  try {
    let target = rawUrl;
    let base: string | undefined;

    for (let hop = 0; hop <= options.maxRedirects; hop++) {
      const authorised = await authoriseFetchTarget(target, options.egress, deps, base);
      if (!authorised.ok) {
        return fail(
          authorised.reason,
          hop === 0 ? authorised.detail : `redirect hop ${hop}: ${authorised.detail}`
        );
      }
      // The pin, not the URL string, is what the transport is given. `current`
      // is the same URL and is kept for the reason trail, the redirect base and
      // `finalUrl` -- all of which are text, none of which opens a socket.
      const current = authorised.pin.url;

      let response: Response;
      try {
        /*
         * `redirect`, `credentials` and `body` are absent because
         * `PinnedRequestInit` has no such fields: a transport that never follows
         * a redirect, never attaches an ambient credential and never sends a
         * body cannot be asked to do any of those by forgetting an option. The
         * reasoning that used to sit on `credentials: "omit"` is on the type,
         * where it constrains every implementation rather than this one call.
         */
        response = await deps.fetchImpl(authorised.pin, {
          method: "GET",
          signal: controller.signal,
          headers: {
            accept: "application/vnd.apple.mpegurl, application/dash+xml;q=0.9, */*;q=0.1",
            "user-agent": options.userAgent
          }
        });
      } catch (error) {
        return controller.signal.aborted
          ? fail("timeout", `no response within ${options.timeoutMs}ms`)
          : fail("network_error", describeError(error));
      }

      if (REDIRECT_STATUSES.includes(response.status)) {
        const location = response.headers.get("location");
        if (location === null || location.trim() === "") {
          return fail("redirect_without_location", `status ${response.status} with no location header`);
        }
        // The next pass revalidates it in full -- allowlist, host class and a
        // fresh resolution -- with `base` set so a relative `Location` resolves
        // against the hop that issued it rather than being misread as a bare
        // hostname.
        target = location;
        base = current;
        continue;
      }

      if (response.status < 200 || response.status >= 300) {
        return fail("http_status", `publisher responded ${response.status}`);
      }

      let body: Awaited<ReturnType<typeof readBounded>>;
      try {
        body = await readBounded(response, options.maxResponseBytes);
      } catch (error) {
        // An abort lands here as a stream error. Reported as the timeout it is,
        // rather than as a generic network fault that would send whoever reads
        // the trail looking for a broken publisher instead of a slow one.
        return controller.signal.aborted
          ? fail("timeout", `body not received within ${options.timeoutMs}ms`)
          : fail("network_error", `body read failed: ${describeError(error)}`);
      }

      if (controller.signal.aborted) {
        return fail("timeout", `body not received within ${options.timeoutMs}ms`);
      }
      if (!body.ok) {
        return fail("response_too_large", body.detail);
      }

      return { ok: true, text: body.text, finalUrl: current, elapsedMs: elapsed() };
    }

    return fail("too_many_redirects", `exceeded ${options.maxRedirects} redirects`);
  } finally {
    clearTimeout(timer);
  }
}
