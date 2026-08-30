/**
 * Outbound egress policy for media inspection (PL-0304).
 *
 * This package exists because probing is cross-provider I/O with a different
 * security profile from a provider adapter, and the acceptance criterion states
 * the consequence plainly: the service NEVER becomes a general-purpose fetcher.
 * Four controls carry that, and all four live here.
 *
 *   1. PROTOCOLS ARE ALLOWLISTED. `https:`, plus `http:` for a loopback literal
 *      under the two-key rule below. `file:`, `data:`, `concat:` and friends are
 *      the FFmpeg SSRF-plus-arbitrary-file-read primitive the research
 *      documents; the manifest path has no FFmpeg in it, but the allowlist is
 *      stated positively so that adding the probe path later cannot widen it by
 *      omission. The list is `ALLOWED_PROTOCOLS` and the gate tests membership
 *      of it, so the documented control and the enforced one are the same
 *      object rather than two things that agree until somebody edits one.
 *
 *   2. EGRESS IS CONFINED TO AN ALLOWLIST. A host that is not named in the
 *      operator's configuration is not fetchable, whatever it resolves to. An
 *      empty allowlist therefore fetches nothing -- fail closed, so a missing
 *      configuration is an outage rather than an open proxy.
 *
 *   3. HOSTNAMES ARE RESOLVED AND PRIVATE RANGES REJECTED BEFORE THE FETCH.
 *      This is the control that `@liberty/provider-sdk`'s url-policy explicitly
 *      does NOT implement and records as an accepted residual risk: it validates
 *      the host LITERAL, so `cdn.example.test` with an A record of 10.0.0.5
 *      passes there. That acceptance is recorded under "Residual risks, open" in
 *      `docs/SECURITY.md` by the PL-0702 review and is NOT tracked by a task
 *      number; an earlier version of this file cited PL-0701 for it, which is
 *      the critical end-to-end harness and has never covered any of this. Here
 *      the control must exist, so resolution is a required dependency and every
 *      returned address is classified before a socket is opened.
 *
 *   4. THE CONNECTION IS PINNED TO AN ADDRESS THAT WAS CLASSIFIED. Resolving and
 *      then connecting by NAME would let the runtime resolve a second time, so
 *      the checked address and the connected address would be two independent
 *      answers a hostile resolver chooses separately -- DNS rebinding, against
 *      which control 3 alone is decorative. The `ok` verdict therefore carries a
 *      `PinnedTarget` rather than a bare address list -- an UNFORGEABLE one,
 *      declared and minted in this file and nowhere else, for the reasons set
 *      out under "the authorisation token" below. `pin.ts` explains what the
 *      pin binds at connect time and what it deliberately does not change.
 *
 *   5. REDIRECTS ARE REVALIDATED. Handled in `http.ts`, which calls back into
 *      `authoriseFetchTarget` for every hop -- and therefore re-pins for every
 *      hop, since each hop's pin comes out of its own authorisation. An
 *      allowlisted CDN that 302s to a cloud metadata endpoint bypasses a
 *      first-hop-only check completely.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT CONTAIN, and why that is not an
 * oversight: the address-range classifier itself. `@liberty/provider-sdk`
 * already has one -- `classifyHost` in `src/stremio/url-policy.ts` -- and it is
 * a careful piece of work (IPv4-mapped IPv6, CGNAT, TEST-NET, the exotic
 * spellings the WHATWG parser normalises). Copying it here would produce two
 * SSRF classifiers that can drift, and a drift between two SSRF controls is
 * strictly worse than the wiring cost of injecting one: the copy that is not
 * updated becomes the hole, and nothing fails when they disagree. So the
 * classifier is a REQUIRED port with no default. The composition root supplies
 * `classifyHost` from provider-sdk today, and supplies it from a shared
 * `@liberty/net-policy` package on the day that extraction happens, without this
 * package changing. There is no permissive fallback: a caller that does not
 * provide one cannot construct the dependencies.
 *
 * NO URL IN THIS FILE IS EVER REPRODUCED WHOLE IN A `detail` STRING. Manifest
 * URLs are signed; the research records that credential leakage through error
 * strings and log lines is unconditional rather than incidental. Details name
 * an origin or a hostname and nothing after it.
 */

export type HostClass = "public" | "loopback" | "private" | "unparseable";

/**
 * The injected host classifier. See the file header.
 *
 * The four values are exactly `HostClass` in
 * `@liberty/provider-sdk/src/stremio/url-policy.ts`, so that module's exported
 * `classifyHost` satisfies this type verbatim with no adapter. That is
 * intentional and the vocabulary must not be "improved" here without changing
 * it there first.
 */
export type HostClassifier = (hostname: string) => HostClass;

/**
 * Resolves a hostname to the addresses a connection would actually use.
 *
 * A port rather than a `node:dns` import so that this package stays runtime
 * agnostic and its tests never touch a resolver. The composition root supplies
 * `dns.promises.lookup(hostname, { all: true, verbatim: true })` mapped to
 * `address` strings.
 *
 * THIS IS THE ONLY RESOLUTION THAT HAPPENS. It used to be the first of two: the
 * answers were classified here and then thrown away, and the runtime resolved
 * the name again when it opened the socket. A publisher who controls the
 * authoritative resolver chooses both answers independently, so every check
 * could pass on 93.184.216.34 and the connection still land on
 * 169.254.169.254 -- classic DNS rebinding, and it made the private-range
 * rejection below decorative rather than a control. The answers now leave here
 * inside a `PinnedTarget` and the transport is required to connect to one of
 * them; see `pin.ts` for the mechanism and for what was rejected.
 */
export type HostResolver = (hostname: string) => Promise<readonly string[]>;

/**
 * The schemes the static gate admits. Stated positively, so a later addition is
 * an edit rather than an omission -- and CONSULTED by `checkUrlStatically`
 * rather than mirrored by it, so editing this array is what changes the control.
 * A hardcoded comparison sitting beside a documented constant is two controls
 * that drift, and the one nobody thinks to edit is the one that decides.
 *
 * `http:` IS ON THE LIST BECAUSE THE CODE ADMITS IT, not because plaintext is
 * acceptable. A `http:` URL gets past this gate and is then constrained by the
 * loopback rule further down, which refuses it for anything that is not a
 * loopback literal on a local deployment. Listing `https:` alone would have
 * described the aspiration rather than the behaviour, and a list that permits
 * less than the code does is worse than no list: it teaches a reviewer that the
 * two need not match. The consequence of writing it honestly is that deleting
 * the loopback rule turns this entry into plaintext-to-anywhere, which is then
 * wrong HERE, in one obvious place, rather than subtly nowhere.
 *
 * Entries are compared against `URL.protocol`, which always carries its trailing
 * colon. An entry written without one can never match, and would silently
 * withdraw a scheme rather than fail.
 */
export const ALLOWED_PROTOCOLS: readonly string[] = ["https:", "http:"];

/**
 * Rejection reasons carry a `url_` or `dns_` prefix so that they can be placed
 * in a candidate's reason trail verbatim, matching the convention url-policy
 * established. A reason that is rewritten on the way out eventually stops
 * matching what the code did.
 */
export type EgressRejectionReason =
  | "url_unparseable"
  | "url_scheme_not_allowed"
  | "url_credentials_present"
  | "url_host_missing"
  | "url_host_unparseable"
  | "url_host_private_literal"
  | "url_host_not_on_egress_allowlist"
  | "url_plaintext_http_not_loopback"
  | "url_loopback_not_permitted"
  | "url_loopback_not_local_deployment"
  | "dns_resolution_failed"
  | "dns_resolved_no_addresses"
  | "dns_resolved_private_address";

export interface EgressPolicy {
  /**
   * Hostnames this service may open a connection to.
   *
   * An entry is either an exact hostname (`cdn.example.test`) or a leading-dot
   * suffix (`.cdn.example.test`) that matches subdomains and NOT the bare name.
   * The leading dot is mandatory for suffix matching because a bare
   * `endsWith("example.test")` also matches `evil-example.test`, which is the
   * single most common way an allowlist turns out not to be one.
   */
  readonly allowedHosts: readonly string[];
  /**
   * Whether this SOURCE may address the machine Liberty runs on. Necessary for
   * loopback, never sufficient -- see `localDeployment`. Mirrors url-policy's
   * two-key rule deliberately: the same threat exists here, and two subsystems
   * with different rules about loopback is how one of them becomes the way in.
   */
  readonly allowLoopback: boolean;
  /**
   * Whether this INSTANCE is a local or development deployment. A property of
   * the running process, not of any configuration file a source can edit. On a
   * hosted instance 127.0.0.1 is Liberty's own admin surface, so a source
   * claiming to be local must not be able to reach it by saying so.
   */
  readonly localDeployment: boolean;
}

export interface EgressDependencies {
  readonly classifyHost: HostClassifier;
  readonly resolveHost: HostResolver;
}

export type StaticUrlVerdict =
  | { readonly ok: true; readonly url: URL; readonly hostClass: HostClass }
  | { readonly ok: false; readonly reason: EgressRejectionReason; readonly detail: string };

/* -------------------------------------------------------------------------
 * THE AUTHORISATION TOKEN.
 *
 * `PinnedTarget` and the brand that makes it unforgeable live HERE, beside
 * `authoriseFetchTarget`, and that placement IS the control rather than a
 * filing decision.
 *
 * WHAT WAS WRONG BEFORE. This interface used to be declared in `pin.ts` as a
 * plain structural record of three public fields, under a comment asserting
 * that only `authoriseFetchTarget` could build one. The assertion was false and
 * the review of PL-0304 rejected it on exactly that ground. Any TypeScript
 * caller -- including one outside this package, since the barrel re-exports the
 * type and the `./node/*` subpath exports the transport -- could write
 *
 *     { url: "https://allowed-name.example/x", hostname: "allowed-name.example",
 *       addresses: ["169.254.169.254"] }
 *
 * hand it to `nodePinnedFetch`, and open a socket to an address that no
 * classifier had ever seen. The transport's whole reason to exist is that the
 * address it connects to was checked; a target it will accept from anybody
 * makes the type a label rather than a guarantee. The package's own real-socket
 * tests were doing precisely this, which is how a security claim came to be
 * contradicted by the suite that was supposed to prove it.
 *
 * TWO MECHANISMS, because they close different holes:
 *
 *   1. A BRAND THAT CANNOT BE WRITTEN DOWN. `authorisedByEgress` is a
 *      module-private `unique symbol`. It is not exported, so no other
 *      module -- in this package or outside it -- can name the key, and an
 *      object literal that omits it is not a `PinnedTarget`. Fabrication stops
 *      being something a reviewer has to notice and becomes something the
 *      compiler refuses. There is no exported constructor to reach for either:
 *      `pinFor` is private to this file and its only two callers are the `ok`
 *      returns of `authoriseFetchTarget`, so "the authorisation path is the only
 *      thing that mints a pin" is now the literal shape of the program instead
 *      of a promise made in prose.
 *
 *   2. A REGISTRY OF THE PINS THIS FILE ACTUALLY ISSUED. A brand alone is a
 *      COMPILE-TIME control, and two things get past a compile-time control at
 *      runtime: an explicit `as unknown as PinnedTarget`, and a spread --
 *      `{ ...realPin, addresses: ["169.254.169.254"] }` copies the brand along
 *      with everything else and type-checks. Both yield a pin the classifier
 *      never approved, which is the original defect wearing a cast. So every
 *      minted pin is recorded in a `WeakSet` that only this module can add to,
 *      and `createPinnedLookup` -- the one function every transport must go
 *      through to turn a pin into a socket decision -- refuses a target that is
 *      not in it. A `WeakSet` rather than a `Set` because a registry of targets
 *      must not keep them alive; and the key is object IDENTITY, which is
 *      exactly the thing a copy does not have.
 *
 * Each minted pin is also FROZEN, addresses included. `readonly` is erased at
 * runtime, so without this a caller holding a genuine pin could simply push an
 * address onto it, or reassign `url`, between authorisation and connect --
 * a rebinding window opened from inside the process rather than from DNS.
 *
 * WHAT THIS DOES NOT CLAIM. Code inside this file could still mint something
 * wrong, and a composition root can still supply a `resolveHost` that lies.
 * Neither is fabrication: the first is this module being wrong about its own
 * job, and the second is the injected port working as designed -- the resolver
 * is a declared dependency and its answers are classified before they become a
 * pin. What is now impossible is reaching a transport with an address set that
 * never went through the checks in this file.
 *
 * ONE COMPILER CAVEAT, recorded so it is not rediscovered as a bug: an
 * unexported symbol in an exported interface is an error under `--declaration`
 * (TS4033), because the emitted `.d.ts` could not name the key. This package
 * emits nothing -- `build`, `lint` and `typecheck` are all `tsc --noEmit`, and
 * `package.json` points `types` at the sources -- so the situation does not
 * arise. Turning declaration emit on would mean exporting the symbol as a type
 * only (`export type AuthorisedByEgress = typeof authorisedByEgress`), which
 * keeps it unwritable, rather than exporting the value.
 * ---------------------------------------------------------------------- */

/**
 * Strips the brackets a URL parser puts around an IPv6 literal.
 *
 * The brackets belong to the URL grammar, not to the address. A socket layer
 * given `[::1]` does not recognise it as an IP literal and tries to RESOLVE it,
 * which is both a failure and -- worse -- a name lookup we did not intend to
 * perform.
 *
 * It lives in this file rather than in `pin.ts`, where it used to, so that the
 * dependency between the two modules points ONE WAY. `pin.ts` has to ask this
 * module whether a target was authorised; if this module also had to ask
 * `pin.ts` for a string helper, the two would import each other at runtime. A
 * cycle would work today and is a trap tomorrow, and the helper is the cheaper
 * thing to move.
 */
export function bareAddress(address: string): string {
  return address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
}

/**
 * The brand. Deliberately not exported -- see "the authorisation token" above.
 *
 * A real symbol rather than a `declare const` phantom, so that minting needs no
 * `as` cast anywhere: the property genuinely exists on the object, which means
 * the one place a `PinnedTarget` comes into being is an ordinary object literal
 * that the compiler checks like any other.
 */
const authorisedByEgress = Symbol("liberty.media-inspection.authorised-target");

/**
 * A URL, and the only addresses a socket for it may be opened to.
 *
 * ISSUED ONLY BY `authoriseFetchTarget`. A value of this type in hand is
 * evidence that the addresses inside it went through the protocol allowlist,
 * the egress allowlist, the loopback keys and the private-range rejection --
 * not because a comment says so, but because the brand below cannot be named
 * outside this file and the registry rejects anything this file did not issue.
 */
export interface PinnedTarget {
  /**
   * The URL to request, HOSTNAME INTACT. Not an address. The `Host` header, SNI
   * and certificate identity all derive from this, so substituting an IP here is
   * exactly the defect `pin.ts` rejects.
   */
  readonly url: string;
  /**
   * The hostname as the URL parser produced it, so an IPv6 literal is still
   * bracketed (`[::1]`). Kept in the parser's spelling because that is what a
   * transport building request options from the same URL will see, and the
   * lookup compares the two.
   */
  readonly hostname: string;
  /**
   * Every address that was authorised, in resolver order, WITHOUT brackets --
   * the spelling a socket layer expects. Never empty, and not by convention:
   * `pinFor` takes a non-empty tuple, so a pin with no addresses is not a state
   * this package can construct.
   */
  readonly addresses: readonly string[];
  /** The brand. Unwritable outside this module; see the section above. */
  readonly [authorisedByEgress]: true;
}

/**
 * The pins this module has issued, by identity.
 *
 * Weak so that holding the registry never holds a target alive. Nothing removes
 * an entry: a pin stays valid for as long as somebody still has it, which is
 * correct -- expiry is the deadline's job in `http.ts`, and a pin that stopped
 * working halfway through a redirect chain would be a new failure mode for no
 * gain.
 */
const issuedPins = new WeakSet<PinnedTarget>();

/**
 * Whether this exact object came out of `authoriseFetchTarget`.
 *
 * The parameter is typed `PinnedTarget` rather than `unknown` on purpose: a
 * caller that has not at least satisfied the brand cannot get this far, so the
 * only inputs worth asking about are the ones that got past the compiler --
 * a cast, or a copy of a real pin. Both answer `false`.
 */
export function isAuthorisedTarget(target: PinnedTarget): boolean {
  return issuedPins.has(target);
}

/**
 * The `ok` branch carries a `PinnedTarget` rather than a plain address list, and
 * that is the whole point of the type.
 *
 * A caller that received `{ url, addresses }` would have to assemble the two
 * into something a transport could use, and "assembled them wrongly" -- passed
 * the URL without the addresses, passed the previous hop's addresses, passed
 * none -- would be expressible and would compile. Here it is not: the pin is the
 * product, this function is the only thing that builds one, and a transport
 * cannot be called without it.
 */
export type FetchTargetVerdict =
  | { readonly ok: true; readonly url: URL; readonly hostClass: HostClass; readonly pin: PinnedTarget }
  | { readonly ok: false; readonly reason: EgressRejectionReason; readonly detail: string };

/** Keeps a hostile URL from turning an error message into a wall. */
export function truncate(value: string, max = 120): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*(?=:)/i;

/**
 * Describes a string that did not parse WITHOUT reproducing it.
 *
 * The scheme is the one part that is safe to name -- RFC 3986 bounds its
 * charset -- and it is what distinguishes "somebody configured a relative path"
 * from "the manifest offered a `data:` URI". The character count stands in for
 * the rest, so an empty field and a mangled signed URL are still tellable apart
 * without either being copied into a log. Same reasoning, same shape, as
 * url-policy's `describeUnparseable`.
 */
function describeUnparseable(raw: string): string {
  const scheme = SCHEME_PATTERN.exec(raw)?.[0];
  const named = scheme === undefined ? "(no scheme)" : `scheme ${truncate(scheme, 16)}:`;
  return `${named}, ${raw.length} characters`;
}

/**
 * Matches a hostname against the allowlist.
 *
 * Case folded on both sides. Entries are trimmed and empty entries skipped, so a
 * trailing comma in a configuration file cannot become an entry that matches the
 * empty suffix.
 */
export function hostOnAllowlist(hostname: string, allowedHosts: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  for (const raw of allowedHosts) {
    const entry = raw.trim().toLowerCase();
    if (entry === "" || entry === ".") continue;
    if (entry.startsWith(".")) {
      if (host.endsWith(entry)) return true;
      continue;
    }
    if (host === entry) return true;
  }
  return false;
}

/**
 * True for a host the URL parser produced as an IP literal.
 *
 * Used ONLY to decide whether a DNS round trip is meaningful, never to decide
 * whether an address is safe -- that judgement stays with the injected
 * classifier. `new URL()` normalises every exotic IPv4 spelling (decimal, octal,
 * hex) into a dotted quad and brackets every IPv6 literal, so these two shapes
 * are exhaustive for a hostname that came out of the parser.
 */
function isIpLiteral(hostname: string): boolean {
  return hostname.startsWith("[") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
}

/**
 * Classifies an address a resolver returned.
 *
 * THE BRACKETS ARE LOAD-BEARING. `classifyHost` is written for URL hostnames,
 * where `new URL()` has already wrapped every IPv6 literal in brackets, and it
 * dispatches on that leading `[`. A bare `fe80::1` handed to it falls through
 * every IPv4 branch and every name branch and comes back "public" -- link-local
 * addresses would pass the private-range check. A resolver returns bare
 * addresses, so they are bracketed here before the classifier ever sees them.
 * A zone id (`fe80::1%eth0`) is rejected upstream of us by the classifier
 * itself, which refuses to interpret one; that is the correct failure direction.
 */
function classifyResolvedAddress(address: string, classifyHost: HostClassifier): HostClass {
  const literal = address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;
  return classifyHost(literal);
}

/**
 * Everything that can be decided without a network round trip.
 *
 * Split out from the full gate because it is the only check available for a
 * URL we are NOT about to fetch -- a variant playlist URI read out of a master
 * playlist. See `types.ts` on why such a URI is reported with a verdict that
 * explicitly demands revalidation rather than being treated as cleared.
 *
 * `base` resolves a relative reference (a variant URI, a `Location:` header)
 * against the URL that produced it, so it goes through exactly the same checks
 * as an absolute one. Validating only the first URL of a chain is the classic
 * way an SSRF filter is bypassed.
 */
export function checkUrlStatically(
  raw: string,
  policy: EgressPolicy,
  classifyHost: HostClassifier,
  base?: string
): StaticUrlVerdict {
  let url: URL;
  try {
    url = base === undefined ? new URL(raw) : new URL(raw, base);
  } catch {
    return {
      ok: false,
      reason: "url_unparseable",
      detail: `not a usable URL: ${describeUnparseable(raw)}`
    };
  }

  if (!ALLOWED_PROTOCOLS.includes(url.protocol)) {
    return {
      ok: false,
      reason: "url_scheme_not_allowed",
      detail: `scheme ${truncate(url.protocol, 16)} is not on the protocol allowlist`
    };
  }

  // `https://cdn.example.test@evil.test/` has a host of `evil.test`. Userinfo is
  // the oldest way to make a URL read as one origin to a human and resolve as
  // another, and a reviewer approving an allowlist entry is exactly the human in
  // question.
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "url_credentials_present", detail: "URL carries embedded credentials" };
  }

  if (url.hostname === "") {
    return { ok: false, reason: "url_host_missing", detail: "URL has no host" };
  }

  const hostClass = classifyHost(url.hostname);

  if (hostClass === "unparseable") {
    return {
      ok: false,
      reason: "url_host_unparseable",
      detail: `host ${truncate(url.hostname, 64)} is neither a valid name nor a valid address`
    };
  }

  // Unconditional, including when loopback is permitted. Allowing an operator's
  // own machine is a statement about THAT machine, never about their LAN or
  // their VPC.
  if (hostClass === "private") {
    return {
      ok: false,
      reason: "url_host_private_literal",
      detail: `host ${truncate(url.hostname, 64)} is in a private, link-local or reserved range`
    };
  }

  // The allowlist is checked before the loopback keys so that the reason names
  // the thing an operator can act on: "not on the allowlist" is a configuration
  // gap, and it is the answer for the overwhelming majority of refusals.
  if (!hostOnAllowlist(url.hostname, policy.allowedHosts)) {
    return {
      ok: false,
      reason: "url_host_not_on_egress_allowlist",
      detail: `host ${truncate(url.hostname, 64)} is not on the egress allowlist`
    };
  }

  if (hostClass === "loopback") {
    if (!policy.allowLoopback) {
      return {
        ok: false,
        reason: "url_loopback_not_permitted",
        detail: `host ${truncate(url.hostname, 64)} is loopback and this source is not configured as local`
      };
    }
    if (!policy.localDeployment) {
      return {
        ok: false,
        reason: "url_loopback_not_local_deployment",
        detail:
          `host ${truncate(url.hostname, 64)} is loopback and this instance is not a local deployment; ` +
          "a source opt-in alone never makes this machine reachable"
      };
    }
    return { ok: true, url, hostClass };
  }

  // THE GATE THAT PAYS FOR `http:` BEING ON `ALLOWED_PROTOCOLS`. A literal here
  // rather than a list, deliberately: this is not a second allowlist, it is the
  // one rule that makes admitting plaintext at all defensible, and the two are
  // documented as a pair on the constant. Loopback has already returned above,
  // so everything reaching this line is a remote host.
  if (url.protocol === "http:") {
    return {
      ok: false,
      reason: "url_plaintext_http_not_loopback",
      detail: `plaintext http is only permitted for a loopback literal, not ${truncate(url.hostname, 64)}`
    };
  }

  return { ok: true, url, hostClass };
}

/**
 * The full gate. Everything `checkUrlStatically` decides, plus resolution.
 *
 * Called for the manifest URL and again for every redirect hop, before any
 * socket is opened. EVERY resolved address must classify as permitted, not just
 * the first: a name with one public A record and one 10/8 A record is a
 * round-robin into the private network, and checking `addresses[0]` would let it
 * through on roughly half of all attempts, which is the worst possible failure
 * mode because it looks like flakiness rather than a hole.
 *
 * The addresses that survive leave here as a `PinnedTarget`, and that is what a
 * transport is given. Nothing downstream resolves the name again, so the set
 * judged here is the set a socket can reach -- which is what makes the judgement
 * above a control rather than a description of one moment in DNS.
 */
export async function authoriseFetchTarget(
  raw: string,
  policy: EgressPolicy,
  deps: EgressDependencies,
  base?: string
): Promise<FetchTargetVerdict> {
  const statically = checkUrlStatically(raw, policy, deps.classifyHost, base);
  if (!statically.ok) return statically;

  const { url, hostClass } = statically;

  // An IP literal has nothing to resolve; the classifier has already judged the
  // address itself. Sending it to a resolver would either echo it back or fail,
  // and a failure there would refuse a target that is provably fine.
  //
  // The literal is UNBRACKETED into the pin -- by `pinFor`, which does that for
  // every address it is given. `url.hostname` for an IPv6 literal is `[::1]`,
  // and a socket layer handed that does not recognise it as an address: it tries
  // to RESOLVE the bracketed string, which is both a failure and a name lookup
  // this branch exists to avoid. The URL keeps its brackets; only the address
  // list drops them.
  if (isIpLiteral(url.hostname)) {
    return { ok: true, url, hostClass, pin: pinFor(url, [url.hostname]) };
  }

  let addresses: readonly string[];
  try {
    addresses = await deps.resolveHost(url.hostname);
  } catch {
    // The resolver's error is not reported. Some resolvers put the queried name
    // and the server address in the message, and a refusal reason is not a place
    // to accumulate either.
    return {
      ok: false,
      reason: "dns_resolution_failed",
      detail: `host ${truncate(url.hostname, 64)} could not be resolved`
    };
  }

  // Destructured rather than length-checked, because the two are the same test
  // and only this spelling PROVES it to the compiler: `first` being defined is
  // what makes `[first, ...rest]` a `[string, ...string[]]`, which is the only
  // thing `pinFor` accepts. A pin over an empty address set therefore stops
  // being a state that has to be guarded against downstream and becomes one that
  // cannot be built. `noUncheckedIndexedAccess` is what makes the check honest.
  const [first, ...rest] = addresses;
  if (first === undefined) {
    return {
      ok: false,
      reason: "dns_resolved_no_addresses",
      detail: `host ${truncate(url.hostname, 64)} resolved to no addresses`
    };
  }

  for (const address of addresses) {
    const addressClass = classifyResolvedAddress(address, deps.classifyHost);
    if (addressClass === "public") continue;
    // Loopback survives only when the NAME was already permitted as loopback by
    // the static gate. A public name that resolves to 127.0.0.1 is the rebinding
    // shape, not an operator's local library, and it is refused here.
    if (addressClass === "loopback" && hostClass === "loopback") continue;
    return {
      ok: false,
      reason: "dns_resolved_private_address",
      detail:
        `host ${truncate(url.hostname, 64)} resolves to an address in a ` +
        `${addressClass} range`
    };
  }

  return { ok: true, url, hostClass, pin: pinFor(url, [first, ...rest]) };
}

/**
 * Builds the pin, and is the ONLY thing in this program that does.
 *
 * Private on purpose, and now enforceably so: the brand it writes cannot be
 * named outside this file, so there is no second implementation of this
 * function to be written anywhere -- not in a sibling module, not in a test, not
 * in a consuming package. Reached only from the two `ok` returns above, both of
 * which are downstream of every check in this file.
 *
 * THE PARAMETER IS A NON-EMPTY TUPLE, and that is load bearing. An empty address
 * set used to be caught at the far end, in `createPinnedLookup`, because a pin
 * that authorises nothing is indistinguishable from a pin that authorises
 * EVERYTHING to whoever "fixes" the resulting always-failing lookup. Catching it
 * there meant carrying a guard for a state the type permitted; requiring
 * `[string, ...string[]]` here means the state does not exist. The caller's own
 * `dns_resolved_no_addresses` refusal is what proves it -- written as a
 * destructure precisely so that the proof is the same expression as the check --
 * and the guard at the far end had nothing left to catch and is gone.
 *
 * `bareAddress` is applied to resolver answers too, not only to literals. The
 * `HostResolver` contract says bare addresses and the composition root supplies
 * them, but a resolver is an injected port and a bracketed answer from one would
 * otherwise become a hostname the socket layer tries to look up -- turning a pin
 * into a second resolution, which is the failure this whole mechanism exists to
 * prevent. Normalising costs nothing and removes the possibility.
 *
 * FROZEN, and the address array with it. `readonly` is a compile-time claim that
 * survives into no JavaScript at all, so without this a holder of a genuine pin
 * could push `169.254.169.254` onto `addresses`, or reassign `url`, in the
 * window between authorisation and connect -- and `nodePinnedFetch` reads both
 * of them after it has been handed the target. That is the rebinding window
 * reopened from inside the process, which would be an odd thing to leave open in
 * the module that exists to close it from outside.
 */
function pinFor(url: URL, addresses: readonly [string, ...string[]]): PinnedTarget {
  const pin: PinnedTarget = Object.freeze({
    [authorisedByEgress]: true as const,
    url: url.toString(),
    hostname: url.hostname,
    addresses: Object.freeze(addresses.map(bareAddress))
  });
  issuedPins.add(pin);
  return pin;
}
