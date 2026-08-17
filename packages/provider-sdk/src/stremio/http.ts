import { checkUrl, truncate, type UrlRejectionReason } from "./url-policy";

/**
 * The only place this package touches the network (PL-0301).
 *
 * Everything here exists because a provider adapter is a piece of code that
 * blocks a viewer's playback request while it waits for a third party. The
 * failure modes it must survive are therefore not just "the addon is down":
 *
 *   - A HANGING addon. Without a deadline, one unresponsive source holds a
 *     playback request open until the platform's own timeout fires, and every
 *     other source's work is wasted. The deadline spans the WHOLE operation,
 *     redirects and body read included -- a per-request timeout is trivially
 *     defeated by three redirects that each answer just inside it.
 *
 *   - An UNBOUNDED body. `await response.text()` on a source that streams
 *     gigabytes is an out-of-memory crash of the server, triggered remotely, by
 *     a party whose only privilege is being in a config file. The body is read
 *     incrementally and abandoned the moment it crosses the cap.
 *
 *   - A REDIRECT into the private network. `fetch` follows redirects by default,
 *     so validating the configured URL and then letting the addon 302 us to
 *     169.254.169.254 would be a complete bypass of the SSRF policy. Redirects
 *     are handled manually and every hop is re-validated.
 *
 * No result here throws. A third party being broken, slow, hostile or absent is
 * an expected outcome with a reason attached, not an exception; an adapter that
 * throws on a bad response makes every caller's error handling responsible for
 * distinguishing "the addon 404'd" from "we have a bug".
 */

export type FetchLike = typeof globalThis.fetch;

export type HttpFailureReason =
  | "timeout"
  | "network_error"
  | "response_too_large"
  | "too_many_redirects"
  | "redirect_without_location"
  | "http_status"
  | "malformed_json"
  | UrlRejectionReason;

export interface HttpOptions {
  readonly fetchImpl: FetchLike;
  /** Deadline for the entire operation, including redirects and body read. */
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly maxRedirects: number;
  readonly allowLoopback: boolean;
  /** See url-policy.ts: loopback needs this AND `allowLoopback`, never either. */
  readonly localDeployment: boolean;
  readonly userAgent: string;
  readonly now: () => number;
}

export type HttpJsonResult =
  | { readonly ok: true; readonly value: unknown; readonly elapsedMs: number; readonly url: string }
  | {
      readonly ok: false;
      readonly reason: HttpFailureReason;
      readonly detail: string;
      readonly elapsedMs: number;
    };

/** Statuses that carry a `Location` we are willing to follow. */
const REDIRECT_STATUSES: readonly number[] = [301, 302, 303, 307, 308];

/**
 * Reads a body incrementally, abandoning it as soon as it exceeds `maxBytes`.
 *
 * `Content-Length` is checked first as a cheap early exit, but it is only a
 * claim -- it can be absent (chunked encoding) or a lie -- so the streaming cap
 * is the actual control and the header check is the optimisation. Getting that
 * relationship backwards is the usual way a "we check Content-Length" defence
 * turns out not to be one.
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
    // No stream to meter (some environments, and most test doubles). The text is
    // already in memory at this point, so the cap can only be reported, not
    // enforced -- which is why the streaming path above is the primary control.
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
    // Releases the socket whether we finished, gave up on the size cap, or were
    // aborted. A leaked reader keeps the connection open past the deadline the
    // whole file exists to enforce.
    await reader.cancel().catch(() => undefined);
  }

  return { ok: true, text: text + decoder.decode() };
}

/**
 * Fetches JSON with a deadline, a size cap and a manually validated redirect
 * chain. `rawUrl` must already satisfy the URL policy; it is re-checked here so
 * that this function is safe on its own terms rather than safe because of what
 * its callers happen to do.
 */
export async function fetchJson(rawUrl: string, options: HttpOptions): Promise<HttpJsonResult> {
  const startedAt = options.now();
  const elapsed = (): number => Math.max(0, Math.round(options.now() - startedAt));

  const controller = new AbortController();
  // Inferred rather than annotated: `setTimeout` is a merged DOM/Node global
  // whose return type differs between them, and pinning it to either spelling
  // breaks the build on the other.
  const timer = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs);

  const fail = (reason: HttpFailureReason, detail: string): HttpJsonResult => ({
    ok: false,
    reason,
    detail,
    elapsedMs: elapsed()
  });

  try {
    let target = rawUrl;

    for (let hop = 0; hop <= options.maxRedirects; hop++) {
      const checked = checkUrl(target, {
        allowLoopback: options.allowLoopback,
        localDeployment: options.localDeployment
      });
      if (!checked.ok) {
        return fail(
          checked.reason,
          hop === 0 ? checked.detail : `redirect hop ${hop}: ${checked.detail}`
        );
      }
      const current = checked.url.toString();

      let response: Response;
      try {
        response = await options.fetchImpl(current, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          /*
           * No cookies, no client certificates, no ambient credentials of any
           * kind. An addon is an unrelated third party; if a request to one
           * carried our credentials, the addon's URL would be a CSRF-shaped
           * hole into whatever origin those credentials belong to.
           */
          credentials: "omit",
          headers: {
            accept: "application/json",
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
        // Resolved against the URL that issued it, so a relative redirect cannot
        // be misread as a bare hostname, then re-validated on the next pass.
        const resolved = checkUrl(
          location,
          { allowLoopback: options.allowLoopback, localDeployment: options.localDeployment },
          current
        );
        if (!resolved.ok) {
          return fail(resolved.reason, `redirect target rejected: ${resolved.detail}`);
        }
        target = resolved.url.toString();
        continue;
      }

      if (response.status < 200 || response.status >= 300) {
        return fail("http_status", `addon responded ${response.status}`);
      }

      let body: Awaited<ReturnType<typeof readBounded>>;
      try {
        body = await readBounded(response, options.maxResponseBytes);
      } catch (error) {
        // An abort lands here as a stream error. Reported as the timeout it is,
        // rather than as a generic network fault that would send whoever reads
        // the log looking for a broken addon instead of a slow one.
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

      try {
        return { ok: true, value: JSON.parse(body.text) as unknown, elapsedMs: elapsed(), url: current };
      } catch (error) {
        return fail("malformed_json", `response was not JSON: ${describeError(error)}`);
      }
    }

    return fail(
      "too_many_redirects",
      `exceeded ${options.maxRedirects} redirects starting at ${describeOrigin(rawUrl)}`
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A URL named by its ORIGIN, for a message that is not a place to keep one.
 *
 * `rawUrl` is the operator's configured endpoint today, so it carries no
 * addon-supplied token -- but that is a property of who happens to call
 * `fetchJson`, not of `fetchJson`, and this file is the boundary at which a URL
 * stops being ours. Path, query and fragment are dropped: where a redirect chain
 * STARTED identifies it well enough to debug, and a signed path is precisely the
 * kind of thing logs must not accumulate. Mirrors what `mapping.ts` already does
 * to a refused stream's target.
 */
function describeOrigin(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    return "(unparseable url)";
  }
}

/**
 * The shape of a platform error code, and the reason one is safe to repeat: it
 * is a short screaming-snake token from a vocabulary the runtime owns, so
 * nothing a peer wrote can be smuggled through it wearing that shape.
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
 * The message used to be surfaced verbatim, and a message is written by whoever
 * threw: some `fetch` implementations put the target URL in theirs, and
 * `JSON.parse` puts in a slice of the document it choked on -- which here is a
 * third party's response body. Neither can carry an addon-supplied secret
 * through the call sites that exist today, but that is a fact about the call
 * sites rather than about this function, and it is inconsistent with the
 * sanitising every other reason string in this package does.
 *
 * What is kept is the name plus, when the runtime supplies one, a system error
 * code (`ECONNREFUSED`, `ENOTFOUND`, `UND_ERR_SOCKET`) -- the part of a network
 * failure anybody actually reads. What is lost is `JSON.parse`'s byte offset;
 * the reason already says the response was not JSON, and an offset is worth less
 * than not copying an addon's payload into our logs to find it.
 */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return `a non-Error ${typeof error} was thrown`;
  // Capped even though every error reaching here is constructed by the runtime:
  // `name` is a writable property, so its length is not ours to assume.
  const name = truncate(error.name, 40);
  const code = errorCode(error);
  return code === undefined ? name : `${name} (${code})`;
}
