import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { isIP, type LookupFunction, type Socket } from "node:net";
import { bareAddress, createPinnedLookup, type PinnedFetch, type PinnedTarget } from "../pin";

/**
 * `PinnedFetch` for a Node deployment (PL-0304).
 *
 * THE ONLY MODULE IN THIS PACKAGE THAT IMPORTS A RUNTIME. Everything else is a
 * port, and this is the plug for one of them. It is deliberately not re-exported
 * from `src/index.ts`: importing the package's public surface must not drag
 * `node:https` in, and a composition root should have to say which runtime it is
 * composing for.
 *
 * WHY NOT `fetch`. The requirement is that the socket opens to an address
 * `authoriseFetchTarget` already classified, and the WHATWG `fetch` API exposes
 * no hook for that -- no `lookup`, no connector, no socket. Undici's dispatcher
 * has one, but `undici` is not a dependency of this repository (the lockfile
 * carries `undici-types`, which is `@types/node`'s type-only companion and ships
 * no runtime) and Node publishes no `node:undici` builtin, so there is no
 * dispatcher to construct without adding a package. `node:http`/`node:https`
 * accept a `lookup` on the request and on the agent, and Node forwards it to
 * `net.Socket.connect`. That is the hook, it needs nothing installed, and it is
 * the reason this file exists rather than a two-line wrapper around `fetch`.
 *
 * WHY REPLACING THE RESOLVER PRESERVES TLS -- the property the reviewer of this
 * task asked to see, stated precisely. `hostname` in the request options is the
 * publisher's NAME, unchanged. Node computes the `Host` header from it, derives
 * SNI from it, and `tls.checkServerIdentity` validates the presented certificate
 * against it. None of those three reads an address, so none of them observes the
 * pin at all: the handshake is byte-for-byte the handshake an unpinned request
 * would have performed. Contrast the alternative that was rejected -- putting
 * the IP in the URL and setting a `Host:` header -- where SNI becomes an IP, the
 * certificate is validated against an IP, and every ordinary certificate fails,
 * which in practice gets "fixed" by disabling `rejectUnauthorized` and trades a
 * rebinding window for unauthenticated TLS.
 *
 * WHAT THIS IS NOT, and must not become: a client. It performs one request, does
 * not follow redirects, sends no body, attaches no credential, keeps no
 * connection, and returns a `Response` for `http.ts` to meter. The deadline, the
 * size cap and the redirect policy all live in `http.ts` and none of them is
 * duplicated here -- a second copy of a limit is a second number to keep in
 * agreement, and the copy nobody updates is the one that decides.
 */

/**
 * Statuses the Fetch standard defines as null-body. `new Response(body, ...)`
 * throws for these rather than ignoring the body, so a publisher answering 304
 * with bytes attached would otherwise turn into a thrown TypeError reported as a
 * network fault.
 */
const NULL_BODY_STATUSES: readonly number[] = [204, 205, 304];

/**
 * Names an error by a code the way `http.ts` expects to read one: a short
 * screaming-snake token from a vocabulary we own, never anything a publisher
 * chose. `describeError` in `http.ts` reports `name` and `code` and discards the
 * message, so nothing here needs to be -- or should be -- descriptive of a URL.
 */
function transportError(name: string, code: string, message: string): Error {
  const error = new Error(message) as Error & { code: string };
  error.name = name;
  error.code = code;
  return error;
}

/**
 * Wraps the response as a web stream WITH BACKPRESSURE.
 *
 * `Readable.toWeb` would do this in one line and is deliberately not used: its
 * declared type comes from `node:stream/web` while `Response` wants the global
 * `ReadableStream` from the DOM lib this repository also compiles against, and
 * reconciling the two costs a cast that would hide a real mismatch if either
 * ever changed. Fifteen lines of the documented adapter pattern is the cheaper
 * honesty.
 *
 * THE PAUSE IS NOT AN OPTIMISATION. `http.ts` abandons a body the moment it
 * crosses the size cap by cancelling the reader; without backpressure the socket
 * would keep filling the controller's queue in the meantime, so a publisher
 * streaming gigabytes would still be buffering them in memory after we decided
 * to stop reading. That is the remotely-triggered out-of-memory the cap exists
 * to prevent, reintroduced one layer down.
 */
function bodyStream(response: IncomingMessage): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    // Annotated rather than inferred: the contextual parameter is a union with
    // the byte-stream controller, and `enqueue` has a different signature on
    // each. Naming the one this source actually gets is clearer than relying on
    // a union call resolving.
    start(controller: ReadableStreamDefaultController<Uint8Array>) {
      response.on("data", (chunk: Buffer) => {
        // Copied rather than enqueued by reference: the chunk belongs to the
        // socket read path, and a queued view of a buffer somebody else may
        // reuse shows up as corrupted manifest text rather than as an error.
        controller.enqueue(new Uint8Array(chunk));
        // One chunk in flight. Attaching a `data` listener puts the message in
        // flowing mode, so without this the socket would keep filling the
        // controller's queue after `http.ts` has decided to abandon the body --
        // which is exactly the remotely-triggered out-of-memory the size cap
        // exists to prevent, reintroduced one layer down.
        response.pause();
      });
      // `close` and `error` are guarded because the controller is dead once the
      // reader cancels, and calling into a dead controller throws. The throw
      // would happen inside an EventEmitter handler, where there is nobody to
      // catch it and the process ends -- a publisher's oversized body must not
      // be able to do that.
      response.on("end", () => {
        try {
          controller.close();
        } catch {
          /* already cancelled or errored */
        }
      });
      response.on("error", (error: Error) => {
        try {
          controller.error(error);
        } catch {
          /* already cancelled or errored */
        }
      });
    },
    pull() {
      response.resume();
    },
    cancel() {
      // The reader gave up -- over the cap, past the deadline, or the caller
      // aborted. Destroying the message closes the socket instead of leaving a
      // publisher streaming into a queue nobody reads.
      response.destroy();
    }
  });
}

export const nodePinnedFetch: PinnedFetch = (target, init) =>
  new Promise<Response>((resolve, reject) => {
    const url = new URL(target.url);
    const secure = url.protocol === "https:";

    if (!secure && url.protocol !== "http:") {
      // Unreachable through `authoriseFetchTarget`, which admits two schemes.
      // Kept because this function is exported and a caller could reach it with
      // anything, and "silently treated an unknown scheme as http" is the sort
      // of default that turns an allowlist into a suggestion.
      reject(transportError("UnsupportedScheme", "ERR_SCHEME", "scheme is not http or https"));
      return;
    }

    // Throws on an empty address set. Inside the executor on purpose, so it
    // becomes a rejected promise that `http.ts` reports as a network error
    // rather than an exception thrown at a caller that documents that it never
    // throws.
    const lookup: LookupFunction = createPinnedLookup(target);

    /*
     * A FRESH AGENT PER REQUEST, keep-alive off.
     *
     * Two reasons, both about the pin rather than about performance. Node merges
     * agent options OVER request options, so an agent carrying the lookup cannot
     * be overridden by anything the request says -- the pin wins the merge. And
     * a pooled socket outlives the authorisation that created it: with a shared
     * keep-alive agent, hop 2 of a redirect chain could be served on a
     * connection opened for hop 1, which is a connection this hop's
     * authorisation never approved. A per-request agent makes socket reuse
     * across authorisations impossible rather than merely unlikely.
     */
    const agent = secure
      ? new HttpsAgent({ keepAlive: false, maxSockets: 1, lookup })
      : new HttpAgent({ keepAlive: false, maxSockets: 1, lookup });

    // Node wants the address without the URL grammar's brackets; `isIP` does not
    // recognise `[::1]` and the host would be sent to the resolver instead of
    // being connected to directly.
    const host = bareAddress(url.hostname);
    const literal = isIP(host) !== 0;

    const common = {
      hostname: host,
      port: url.port === "" ? (secure ? 443 : 80) : Number(url.port),
      // Query included: a manifest URL is signed and the signature lives here.
      path: `${url.pathname}${url.search}`,
      method: init.method,
      headers: { ...init.headers },
      // Belt and braces with the agent. Both are the same function, so there is
      // no behaviour to disagree about -- but a future refactor that drops the
      // agent must not silently drop the pin with it.
      lookup,
      agent
    };

    /*
     * `rejectUnauthorized` is EXPLICIT, not defaulted. It defaults to true, but
     * `NODE_TLS_REJECT_UNAUTHORIZED=0` changes that default process-wide, and an
     * operator who set it while debugging something unrelated would silently
     * disable certificate validation on the one boundary in this repository that
     * fetches third-party infrastructure. Stating it here overrides the
     * environment variable rather than inheriting it.
     *
     * `servername` is the hostname, and is set only when the host IS a hostname:
     * the SNI extension carries names, an IP literal in it is a protocol error,
     * and Node's own default omits it for a literal. Set explicitly rather than
     * left to that default so the invariant the file header claims -- "the
     * certificate is checked against the publisher's name" -- is visible at the
     * line that establishes it and survives a refactor that changes how
     * `hostname` is computed.
     *
     * Written as two whole option objects rather than one with a conditional
     * spread: a spread of `cond ? {} : { servername }` is an optional property
     * under `exactOptionalPropertyTypes` and reads as though omitting it were a
     * separate case from setting it. It is not -- there are two request shapes,
     * and this says so.
     */
    const request = secure
      ? literal
        ? httpsRequest({ ...common, rejectUnauthorized: true })
        : httpsRequest({ ...common, rejectUnauthorized: true, servername: url.hostname })
      : httpRequest(common);

    let settled = false;
    let socket: Socket | null = null;

    const abort = (): void => {
      request.destroy(transportError("AbortError", "ABORT_ERR", "the deadline elapsed"));
    };

    const release = (): void => {
      init.signal.removeEventListener("abort", abort);
      // Safe while a response is streaming: with `keepAlive: false` the in-flight
      // socket is not in the agent's free pool, so this closes idle sockets only.
      agent.destroy();

      /*
       * Which is exactly why the socket is closed here, by hand.
       *
       * The line above is true, and read the other way round it is a leak: the
       * one socket `agent.destroy()` cannot close is the IN-FLIGHT one, and that
       * is precisely the socket an abandoned request leaves behind. A request
       * aborted at its deadline, or failed mid-handshake, returned to its caller
       * while its connection stayed open, and the connection then died on the
       * runtime's schedule instead of ours.
       *
       * A leak in production, and the reason this package's runtime suite could
       * not gate a commit: the delayed close emitted `ECONNRESET` after the test
       * runner had torn its module context down, where nothing could hold a
       * listener for it. The reviewer refused to accept "all assertions passed,
       * process exited non-zero" as a security gate and was right to -- the
       * runtime-integration proof is the whole difference between this fix and
       * the design it replaces, so it has to be a proof that runs green.
       *
       * `destroy()` is idempotent and harmless on an already-closed socket. On
       * the response path `release` runs on `close`, by which time the body is
       * finished, so this never truncates a body anyone is still reading.
       */
      socket?.destroy();
    };

    if (init.signal.aborted) {
      release();
      reject(transportError("AbortError", "ABORT_ERR", "already past the deadline"));
      return;
    }
    init.signal.addEventListener("abort", abort, { once: true });

    request.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      release();
      // Passed through unwrapped so the runtime's own `code` (`ECONNREFUSED`,
      // `ENOTFOUND`, `CERT_HAS_EXPIRED`) reaches `describeError`. That code is
      // the part anybody reading a reason trail actually uses.
      reject(error);
    });

    /*
     * A listener on the SOCKET too, for the same reason there is one on the
     * message: an `error` with no listener is an uncaught exception, and an
     * uncaught exception ends the process.
     *
     * The listener on the request above is not sufficient. `http.ClientRequest`
     * forwards a socket error only while it still owns the outcome -- once this
     * promise has settled, or once `release()` has called `agent.destroy()`, a
     * socket that is still mid-handshake can emit `ECONNRESET` with nothing
     * attached to it. That is reachable from outside: a publisher that accepts
     * the connection, reads the ClientHello and then resets produces exactly
     * this, which is a remote party deciding when our process exits.
     *
     * Deliberately swallowing rather than rejecting. By the time this can fire,
     * the outcome has already been decided by the request's own `error` or
     * `response` handler, and `settled` guards both; a second rejection would be
     * ignored anyway. The only job here is to make the emit harmless.
     */
    request.on("socket", (assigned: Socket) => {
      // Captured so `release()` can close it: see the note there for why
      // `agent.destroy()` is not enough.
      socket = assigned;
      assigned.on("error", () => undefined);
    });

    request.on("response", (response: IncomingMessage) => {
      if (settled) return;
      settled = true;

      /*
       * A listener on the MESSAGE, unconditionally and first.
       *
       * `bodyStream` adds its own, which forwards the error to the reader -- but
       * the 204 branch and the invalid-status branch below never build a stream,
       * so on those paths the message would have no `error` listener at all. An
       * unhandled `error` on a stream is an uncaught exception, which ends the
       * process, and a publisher who resets the connection after a 204 would be
       * able to trigger it. Two listeners on the streaming path is not a
       * conflict: both run, and only one of them is load bearing.
       */
      response.on("error", () => undefined);

      const status = response.statusCode ?? 0;
      if (status < 200 || status > 599) {
        // `Response` accepts 200..599 and throws a RangeError outside it. A
        // hostile server can put any three digits on the status line, so this is
        // reachable, and a thrown RangeError here would surface as an
        // uninformative network fault.
        response.destroy();
        release();
        reject(
          transportError("InvalidStatus", "ERR_HTTP_STATUS", "status outside the 200-599 range")
        );
        return;
      }

      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const entry of value) headers.append(name, entry);
        } else {
          headers.append(name, value);
        }
      }

      const nullBody = NULL_BODY_STATUSES.includes(status);
      if (nullBody) response.resume();

      // `statusText` is deliberately not carried over. The reason phrase is
      // publisher-chosen text, `Response` validates it and throws on a phrase
      // outside the grammar, and nothing in this package reads it -- so copying
      // it would add a failure mode in exchange for nothing.
      const body = nullBody ? null : bodyStream(response);

      // Cleanup hangs off the message rather than firing here: the agent must
      // outlive the body, and `close` fires whether the body was read to the end,
      // cancelled over the cap, or destroyed by the deadline.
      response.on("close", release);

      resolve(new Response(body, { status, headers }));
    });

    request.end();
  });

/**
 * Re-exported for a composition root that wants to name the type it is
 * satisfying without importing the runtime-agnostic barrel as well.
 */
export type { PinnedTarget };
