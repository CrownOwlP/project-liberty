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
 *      does NOT implement and records as residual risk PL-0701: it validates the
 *      host LITERAL, so `cdn.example.test` with an A record of 10.0.0.5 passes
 *      there. Here it must not, so resolution is a required dependency and every
 *      returned address is classified before a socket is opened.
 *
 *   4. REDIRECTS ARE REVALIDATED. Handled in `http.ts`, which calls back into
 *      `authoriseFetchTarget` for every hop. An allowlisted CDN that 302s to a
 *      cloud metadata endpoint bypasses a first-hop-only check completely.
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
 * KNOWN RESIDUAL RISK, stated rather than disguised: resolving and then fetching
 * by hostname leaves a rebinding window, because `fetch` re-resolves and nothing
 * pins the connection to the address we checked. Closing it needs a custom
 * dispatcher, which is why `fetchImpl` is also a port -- a pinning dispatcher is
 * injected at the same seam without this file changing. Tracked with PL-0701.
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

export type FetchTargetVerdict =
  | { readonly ok: true; readonly url: URL; readonly hostClass: HostClass; readonly addresses: readonly string[] }
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
  if (isIpLiteral(url.hostname)) {
    return { ok: true, url, hostClass, addresses: [url.hostname] };
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

  if (addresses.length === 0) {
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

  return { ok: true, url, hostClass, addresses: [...addresses] };
}
