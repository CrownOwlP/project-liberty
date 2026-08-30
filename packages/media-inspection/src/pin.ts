/**
 * The bind between "an address we authorised" and "the address a socket opens"
 * (PL-0304).
 *
 * WHAT THIS EXISTS TO CLOSE. `authoriseFetchTarget` resolves a hostname and
 * refuses every answer that is not public. Until this module existed the result
 * of that work was discarded: `http.ts` handed the HOSTNAME to a `fetch`-shaped
 * port and the networking stack resolved the name a second time. The address
 * that was checked and the address that was connected to were therefore two
 * independent answers to the same question, and a publisher who controls the
 * authoritative resolver chooses both -- 93.184.216.34 for our query and
 * 169.254.169.254 for the connect. That is DNS rebinding, and it defeats
 * resolve-then-check entirely while leaving every check visibly passing. The
 * whole of the private-range rejection in `egress.ts` was decorative against it.
 *
 * THE MECHANISM: REPLACE THE RESOLVER, NOT THE HOST. A `PinnedTarget` carries
 * the URL with its hostname intact plus the exact address set that was
 * authorised, and the transport is required to resolve that hostname to nothing
 * else. `createPinnedLookup` is that resolver -- a `lookup` function of the shape
 * `net.connect` accepts, answering from a fixed list instead of from DNS.
 *
 * WHY THAT SHAPE AND NOT THE OBVIOUS ONE. The obvious fix is to rewrite the URL
 * to the validated IP and set a `Host:` header. It is also wrong twice over:
 * TLS then presents SNI for an IP and validates the certificate against an IP,
 * so either the handshake fails against every ordinary certificate or somebody
 * "fixes" it by weakening `checkServerIdentity` -- trading a rebinding window
 * for unauthenticated TLS, which is a strictly worse defect. Virtual hosting
 * breaks in the same motion. Replacing the resolver has neither problem BECAUSE
 * NOTHING ABOUT THE HOSTNAME CHANGES: the connect options still carry the name,
 * so the `Host` header, the SNI extension, the certificate identity check and
 * the connection-pool key are all computed from exactly what they were computed
 * from before. There is no TLS semantics to "preserve" here; there is no TLS
 * change at all. Only the name-to-address step is substituted.
 *
 * WHAT WAS REJECTED, and why each is not merely a style preference:
 *
 *   - AN UNDICI DISPATCHER (`new Agent({ connect: { lookup } })`) passed to
 *     `fetch` as `init.dispatcher`. This is the mechanism the previous comment
 *     in `egress.ts` promised, and it is unavailable: `undici` is not a
 *     dependency of this repository -- only `undici-types`, which is
 *     `@types/node`'s type-only companion and ships no runtime -- and Node
 *     exposes no `node:undici` builtin, so there is no dispatcher to construct
 *     without adding a package. Adding one to close this is a dependency
 *     decision, not an implementation detail, so it is not taken here.
 *
 *   - INJECTING A PINNING TRANSPORT AT THE OLD `fetchImpl` SEAM, unchanged. This
 *     was the recorded plan and it cannot work, which is the actual defect this
 *     module fixes. A transport that receives only a URL has no way to learn
 *     which addresses were authorised, so it must resolve the name ITSELF -- and
 *     then it is pinning to a THIRD resolution, not to the one that was checked.
 *     The seam was the wrong shape to carry the fix, so the seam changed: the
 *     addresses travel with the target, and a transport that ignores them cannot
 *     type-check.
 *
 * NOTHING HERE CLASSIFIES AN ADDRESS. This module enforces "connect only to what
 * was authorised"; `egress.ts` decides what may be authorised. Re-running the
 * private-range judgement here would put a second copy of an SSRF control in the
 * repository, and the copy nobody updates is the hole -- the same reasoning that
 * keeps `classifyHost` an injected port rather than a local reimplementation.
 *
 * WHERE `PinnedTarget` WENT, and why it is not declared here any more. It used
 * to be, as a plain structural record of three public fields under a comment
 * claiming that only `authoriseFetchTarget` could produce one. That claim was
 * not enforced by anything: an object literal with those three fields WAS a
 * `PinnedTarget`, and `nodePinnedFetch` would consume it and connect to an
 * address no classifier had seen. The type now carries a brand that only
 * `egress.ts` can write, so it has to be declared where the brand is; this
 * module imports it, along with the predicate that says whether a given target
 * was really issued. That import is also why `bareAddress` moved the other way:
 * one module has to depend on the other and it must not be both.
 */

import { bareAddress, isAuthorisedTarget, type PinnedTarget } from "./egress";

/**
 * Re-exported so a transport can name the type it is handed without reaching
 * past this module into the policy layer for it. Only the TYPE travels; there is
 * no constructor to re-export, which is the point.
 */
export type { PinnedTarget };

/**
 * Everything this package asks a transport to do, and nothing else.
 *
 * DELIBERATELY NOT `RequestInit`. A pinned transport that accepted the whole
 * `fetch` vocabulary would accept `body`, `credentials`, `redirect: "follow"`
 * and `cache` -- options it must either implement or silently ignore, and
 * silently ignoring `redirect: "follow"` is how a manual-redirect SSRF control
 * turns into a following one. Three fields is the entire requirement, so three
 * fields is the entire type, and widening it is an edit somebody reviews.
 *
 * The properties that are absent are absent ON PURPOSE and are part of the
 * contract:
 *
 *   - NO BODY, and the method is fixed. This is a manifest read.
 *   - NO REDIRECT FOLLOWING, ever. `http.ts` revalidates every hop against the
 *     egress policy; a transport that followed a `Location` itself would skip
 *     that and the pin with it.
 *   - NO AMBIENT CREDENTIALS: no cookies, no client certificate, no stored
 *     authentication of any kind. A publisher is an unrelated third party, and a
 *     request that carried our credentials would make its URL a CSRF-shaped hole
 *     into whatever origin those credentials belong to. Whatever authorises this
 *     fetch is already inside the URL the rights decision named.
 */
export interface PinnedRequestInit {
  readonly method: "GET";
  readonly headers: Readonly<Record<string, string>>;
  /** The whole-operation deadline from `http.ts`, including the body read. */
  readonly signal: AbortSignal;
}

/**
 * The transport port.
 *
 * Returns a `Response` rather than a bespoke shape so that the bounded streaming
 * read in `http.ts` runs against the same object in production as under test,
 * and so a test double can be a real `Response`.
 */
export type PinnedFetch = (target: PinnedTarget, init: PinnedRequestInit) => Promise<Response>;

/* -------------------------------------------------------------------------
 * The lookup itself.
 *
 * The types below are declared structurally rather than imported from
 * `node:net`, so this module stays free of any runtime-specific import and its
 * tests need no socket. They are written to match `net.LookupFunction` exactly;
 * the assignment that proves it is in `node/pinned-fetch.ts`, which annotates
 * the result of `createPinnedLookup` as `LookupFunction`. If the two ever
 * diverge, that annotation fails to compile -- at the one place the mismatch
 * would matter -- rather than here, where nothing would notice.
 * ---------------------------------------------------------------------- */

/** One answer, in the shape `lookup` returns under `all: true`. */
export interface PinnedLookupAddress {
  address: string;
  family: number;
}

/** The subset of `dns.LookupOptions` a socket layer actually passes. */
export interface PinnedLookupOptions {
  readonly family?: number | string | undefined;
  readonly all?: boolean | undefined;
  readonly hints?: number | undefined;
  readonly verbatim?: boolean | undefined;
}

export type PinnedLookupCallback = (
  error: (Error & { readonly code?: string | undefined }) | null,
  address: string | PinnedLookupAddress[],
  family?: number
) => void;

export type PinnedLookup = (
  hostname: string,
  options: PinnedLookupOptions,
  callback: PinnedLookupCallback
) => void;

/** Case folding plus bracket stripping, so the two spellings of a host compare equal. */
function normaliseHost(hostname: string): string {
  return bareAddress(hostname.trim()).toLowerCase();
}

/**
 * 4 or 6, decided by the only thing that distinguishes the two textual forms.
 *
 * An IPv4-mapped address (`::ffff:10.0.0.5`) contains a colon and is reported as
 * family 6, which is correct: that is how a socket layer would treat it. Whether
 * it is SAFE is not this function's question -- `classifyHost` already refused it
 * upstream if it names a private range, and re-deciding here would be the second
 * SSRF classifier this package exists not to have.
 */
function addressFamily(address: string): number {
  return address.includes(":") ? 6 : 4;
}

/** `dns.LookupOptions.family` accepts a number or a spelling. Absent means "either". */
function requestedFamily(family: number | string | undefined): number {
  if (family === 4 || family === 6) return family;
  if (family === "IPv4") return 4;
  if (family === "IPv6") return 6;
  return 0;
}

function lookupError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

/**
 * A resolver that answers from the authorised address set and from nothing else.
 *
 * Handed to a socket layer as its `lookup`, so the name-to-address step of
 * connecting is served by this instead of by DNS. Every other part of the
 * connection -- host, Host header, SNI, certificate identity -- is untouched.
 *
 * THIS IS THE CHOKE POINT, and the refusal below is why it is worth naming as
 * one. Any transport, on any runtime, has to come through here to turn a pin
 * into a socket decision -- that is the only way the addresses become a
 * `lookup`. So the check that the target was genuinely ISSUED belongs here
 * rather than in one runtime's transport, where a second transport would simply
 * not have it.
 *
 * THREE REFUSALS, each closing a specific way a pin stops being one:
 *
 *   1. A TARGET `authoriseFetchTarget` NEVER ISSUED IS REFUSED OUTRIGHT. The
 *      brand on `PinnedTarget` already stops a caller from WRITING one, but a
 *      brand is a compile-time control and two things survive into runtime: an
 *      `as unknown as PinnedTarget` cast, and a spread of a real pin with the
 *      addresses swapped, which copies the brand and type-checks. Both produce
 *      exactly the object the review of PL-0304 refused to let the transport
 *      accept -- an allowlisted hostname pinned to `169.254.169.254` -- so
 *      identity is checked against the registry `egress.ts` keeps, and a copy
 *      fails because a copy is not the same object.
 *
 *      This replaces an earlier refusal of an EMPTY address set. That guard is
 *      not weakened, it is relocated to where the state can no longer be
 *      constructed: `pinFor` takes a non-empty tuple, so an issued pin always
 *      carries at least one address, and an unissued one never gets past the
 *      line below whatever it carries. A guard no input can reach is a claim no
 *      test can check, and the check that replaced it is strictly stronger.
 *
 *   2. A HOSTNAME THAT IS NOT THE PINNED ONE IS REFUSED, not answered. A socket
 *      layer asks for the host it was told to connect to, so a different name
 *      means the request options and the pin disagree -- a redirect hop wired to
 *      the previous hop's pin, or a transport reusing an agent across hosts.
 *      Answering it would hand hop N's addresses to hop N+1's hostname, which is
 *      a bypass wearing the shape of a working pin.
 *
 *   3. A FAMILY REQUEST THAT MATCHES NOTHING IS REFUSED rather than widened.
 *      Returning an IPv6 answer to a resolver asking for IPv4 would be answering
 *      a question nobody asked; returning nothing at all is the honest failure.
 *
 * The callback is deferred by a microtask. A socket layer's lookup is DNS in
 * every other deployment and is therefore asynchronous everywhere it is
 * exercised; answering synchronously would put this code on a path Node's
 * connect logic is never run on in practice, for no benefit. Deferring costs a
 * tick and keeps the substitution behaviourally identical to the thing it
 * substitutes.
 */
export function createPinnedLookup(target: PinnedTarget): PinnedLookup {
  // Refusal 1, and it is first because everything after it reads fields off an
  // object whose provenance would otherwise be unknown. Thrown rather than
  // returned as a failing lookup: an always-failing lookup looks like an outage,
  // and this is not an outage, it is a caller handing us a target that no
  // authorisation produced.
  if (!isAuthorisedTarget(target)) {
    throw new TypeError("a pinned lookup requires a target issued by authoriseFetchTarget");
  }

  const pinnedHost = normaliseHost(target.hostname);
  const pinned = target.addresses.map((address) => bareAddress(address.trim()));

  return (hostname, options, callback) => {
    const answer = (): void => {
      if (normaliseHost(hostname) !== pinnedHost) {
        // Named without the address set, which is ours and not worth printing,
        // and without any URL. `http.ts` reports an error by name and code only.
        callback(lookupError("ENOTFOUND", "host does not match the authorised target"), []);
        return;
      }

      const wanted = requestedFamily(options.family);
      const matching = wanted === 0 ? pinned : pinned.filter((a) => addressFamily(a) === wanted);
      const first = matching[0];

      if (first === undefined) {
        callback(lookupError("ENOTFOUND", "no authorised address in the requested family"), []);
        return;
      }

      if (options.all === true) {
        callback(
          null,
          matching.map((address) => ({ address, family: addressFamily(address) }))
        );
        return;
      }

      callback(null, first, addressFamily(first));
    };

    queueMicrotask(answer);
  };
}
