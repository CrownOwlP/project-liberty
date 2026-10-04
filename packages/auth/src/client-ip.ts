/* -------------------------------------------------------------------------
 * Which hop may assert a client address (PL-0721)
 *
 * ==========================================================================
 * THE RULING THIS IMPLEMENTS
 * ==========================================================================
 *
 * PL-0719 found that the identity library keys each rate-limit bucket by
 * client IP and path, and reported -- rather than fixed -- that it cannot
 * always resolve one. gpt-architect's round-110 security review ruled on the
 * fix: DO NOT trust `X-Forwarded-For`, `Forwarded`, `X-Real-IP` or similar
 * headers by default, because "a shared fallback bucket when client IP cannot
 * be trusted is safer than accepting a spoofable header that gives an attacker
 * per-request rate-limit evasion".
 *
 * So this file is not "turn on forwarded headers". It is the deployment
 * statement of WHICH HOP MAY ASSERT A CLIENT ADDRESS, and it defaults to
 * nobody.
 *
 * ==========================================================================
 * THE LIVE SPOOF THIS CLOSES, MEASURED RATHER THAN FEARED
 * ==========================================================================
 *
 * `rate-limit.ts` describes the hazard as a shared bucket behind an
 * unconfigured proxy. That description is incomplete, and the part it misses
 * is worse. The library's default is not "resolve nothing": it is
 * `DEFAULT_IP_HEADERS = ["x-forwarded-for"]`, and with no `trustedProxies`
 * configured its header reader accepts a header carrying exactly one valid
 * address:
 *
 *     if (forwardedIps.length !== 1) return null;
 *     ... return normalizeIP(selectedIp, ...)
 *
 * (`@better-auth/core/dist/utils/ip.mjs`, `getIPFromHeader`.)
 *
 * `better-auth.ts` passed no `advanced.ipAddress` at all, so that default was
 * this product's behaviour. Driving the library's own `getIP` under
 * NODE_ENV=production, with no options, produced:
 *
 *     no headers                            -> null
 *     x-forwarded-for: "203.0.113.9"        -> "203.0.113.9"
 *     x-forwarded-for: "198.51.100.7"       -> "198.51.100.7"
 *     x-forwarded-for: "203.0.113.9, 10.0.0.1" -> null
 *     x-real-ip: "203.0.113.9"              -> null
 *
 * Lines two and three are the defect: ONE CALLER, TWO BUCKETS, chosen by the
 * caller. A direct client needs only to vary a header it writes itself to get
 * an unbounded number of credential attempts out of a three-per-ten-seconds
 * limit. That is the "per-request rate-limit evasion" the ruling names, and it
 * was live rather than hypothetical.
 *
 * ==========================================================================
 * THE TWO TOPOLOGIES, AND WHY THE DEFAULT IS THE SAFE ONE
 * ==========================================================================
 *
 * DIRECT (the default, and what every deployment gets until it says
 * otherwise): `ipAddressHeaders: []`. No header is read, by name or by
 * pattern, so nothing a caller writes can reach the bucket key. The library
 * resolves no address and falls back to its single shared `no-trusted-ip`
 * bucket.
 *
 * That fallback is a real cost and is not glossed: three sign-ins per ten
 * seconds for the whole deployment is a self-inflicted denial of service at
 * any scale. It is still the better side of the trade, for the reason the
 * ruling gives -- a shared bucket is a limit that is too TIGHT, which is
 * visible, annoying and survivable, while a spoofable header is a limit that
 * is absent, which is invisible. The remedy is to configure a topology, not
 * to trust a header.
 *
 * BEHIND PROXIES: `ipAddressHeaders: ["x-forwarded-for"]` with an explicit
 * `trustedProxies` list. The library then walks the chain FROM THE RIGHT and
 * returns the first hop that is not trusted, which is the correct algorithm:
 * the rightmost entry is the one appended by the hop that actually spoke to
 * the server, so entries a client prepended are discarded. Measured, with
 * `10.0.0.0/8` trusted:
 *
 *     "203.0.113.9, 10.0.0.1"             -> "203.0.113.9"
 *     "203.0.113.9, 10.0.0.1, 10.0.0.2"   -> "203.0.113.9"
 *     "9.9.9.9, 203.0.113.9, 10.0.0.1"    -> "203.0.113.9"
 *
 * The third line is the spoof attempt failing: the client prepended
 * `9.9.9.9`, the proxy appended its own address, and the derivation took the
 * entry the proxy vouched for.
 *
 * ==========================================================================
 * THE OBLIGATION THAT COMES WITH CONFIGURING A TOPOLOGY, STATED PLAINLY
 * ==========================================================================
 *
 * The same measurement shows the limit of this, and it is not hidden here
 * because somebody will otherwise discover it the hard way:
 *
 *     "203.0.113.9" alone                  -> "203.0.113.9"
 *     "203.0.113.9, 198.51.100.1"          -> "198.51.100.1"
 *
 * With `trustedProxies` set, a request that did NOT arrive through a trusted
 * hop still has its rightmost untrusted entry honoured. The algorithm is
 * right -- it cannot tell a forged chain from a real one without knowing who
 * spoke to the socket -- but it means configuring a topology is only sound
 * when THE ORIGIN IS UNREACHABLE EXCEPT THROUGH THAT PROXY. If an attacker
 * can reach the application directly, they are back to choosing their own
 * bucket.
 *
 * That is a network fact this repository cannot check, so it is written down
 * as a precondition in `docs/DEPLOYMENT_TRUST.md` and named here. Configuring
 * `LIBERTY_TRUSTED_PROXIES` on a deployment whose origin is publicly
 * reachable is WORSE than leaving it unset.
 *
 * ==========================================================================
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 * ==========================================================================
 *
 * It does not touch the limits. PL-0719 owns how many requests are allowed;
 * this owns who a request is attributed to, and nothing here can loosen,
 * widen or disable a rule.
 *
 * It does not use `disableIpTracking`. That option looks like the way to say
 * "read no header", and it is not: `resolveRateLimitConfig` returns `null`
 * when it is set and no address resolves, which switches rate limiting OFF
 * ENTIRELY. `ipAddressHeaders: []` reaches the same "no address" state
 * through the path that keeps the shared bucket.
 *
 * It introduces no way for a caller to nominate its own identity, for any
 * purpose, under any configuration, and there is no development carve-out.
 * ---------------------------------------------------------------------- */

/** The environment variable a deployment states its topology in. */
export const TRUSTED_PROXIES_VARIABLE = "LIBERTY_TRUSTED_PROXIES";

/**
 * The one header read, and only when a topology is configured.
 *
 * ONE, NOT THREE. `X-Real-IP` and `Forwarded` are deliberately absent. Each
 * additional header is another string a caller might control, and the library
 * tries them IN ORDER and takes the first that yields an address -- so adding
 * a second header can only ever widen what is accepted, never narrow it. One
 * header, with a chain the trusted hop appends to, is sufficient for every
 * proxy this product is likely to sit behind.
 */
export const CLIENT_IP_HEADERS: readonly string[] = Object.freeze(["x-forwarded-for"]);

/**
 * Who, if anyone, may assert a client address on this deployment.
 *
 * `direct` carries no data, on purpose: there is no "almost direct". Either a
 * hop has been named or no header is read.
 */
export type TrustedProxyTopology =
  | { readonly kind: "direct" }
  | { readonly kind: "behind-proxies"; readonly hops: readonly string[] };

/** The default, named so a caller can compare against it rather than build one. */
export const DIRECT_TOPOLOGY: TrustedProxyTopology = Object.freeze({ kind: "direct" });

export type TopologyResolution =
  | { readonly ok: true; readonly topology: TrustedProxyTopology }
  | { readonly ok: false; readonly problems: readonly string[] };

/* -------------------------------------------------------------------------
 * Validating a hop
 *
 * WHY THIS IS STRICTER THAN THE LIBRARY'S PARSER, AND WHY STRICTER IS THE
 * SAFE DIRECTION. The library filters unparseable entries out of
 * `trustedProxies` SILENTLY (`.filter((proxy) => proxy !== null)`), and an
 * entry list that filters down to empty falls into the single-value branch --
 * which is the spoof at the top of this file. So a typo in one CIDR could
 * silently re-enable the exact defect this task exists to close.
 *
 * Two things stop that. This parser refuses anything it is not certain of, so
 * a rejected entry becomes a loud configuration error rather than a silent
 * downgrade; being narrower than the library can only produce a refusal to
 * start, never a quiet acceptance. And `better-auth.ts` re-checks the final
 * list at construction, so the authoritative opinion is taken at the point of
 * use. `client-ip.test.ts` then drives the library's own `getIP` with the
 * options produced here, so agreement is an executed property rather than a
 * claim.
 * ---------------------------------------------------------------------- */

const IPV4_OCTET = /^\d{1,3}$/;

function isIpv4(value: string): boolean {
  const octets = value.split(".");
  if (octets.length !== 4) return false;
  return octets.every((octet) => {
    if (!IPV4_OCTET.test(octet)) return false;
    /* Leading zeros rejected: "010.0.0.1" is read as octal by some parsers and
     * as decimal by others, and a trusted-hop list is not the place to find
     * out which. */
    if (octet.length > 1 && octet.startsWith("0")) return false;
    return Number(octet) <= 255;
  });
}

const IPV6_GROUP = /^[0-9a-fA-F]{1,4}$/;

function isIpv6(value: string): boolean {
  /* A zone index (`%eth0`) is a local scope identifier and can never describe
   * a remote hop, so it is refused rather than stripped. */
  if (value.includes("%")) return false;

  const halves = value.split("::");
  if (halves.length > 2) return false;

  const groupsOf = (part: string): string[] | null => {
    if (part === "") return [];
    const groups = part.split(":");
    return groups.every((group) => IPV6_GROUP.test(group)) ? groups : null;
  };

  if (halves.length === 2) {
    const left = groupsOf(halves[0] ?? "");
    const right = groupsOf(halves[1] ?? "");
    if (left === null || right === null) return false;
    /* `::` elides AT LEAST ONE group, so a compressed form with eight written
     * groups is not a valid address. */
    return left.length + right.length <= 7;
  }

  const groups = groupsOf(value);
  return groups !== null && groups.length === 8;
}

/** One entry of the trusted list: an address, or an address with a prefix. */
function hopProblem(entry: string): string | null {
  if (entry !== entry.trim() || entry === "") {
    return `"${entry}" is not a trusted-proxy entry; entries are separated by commas and may not be empty`;
  }

  const slash = entry.lastIndexOf("/");
  const address = slash === -1 ? entry : entry.slice(0, slash);
  const prefix = slash === -1 ? null : entry.slice(slash + 1);

  const v4 = isIpv4(address);
  const v6 = !v4 && isIpv6(address);
  if (!v4 && !v6) {
    return `"${entry}" does not name an IPv4 or IPv6 address; a trusted hop is an address or a CIDR range, never a hostname`;
  }

  if (prefix === null) return null;
  if (!/^\d{1,3}$/.test(prefix)) {
    return `"${entry}" has a prefix that is not a number of bits`;
  }
  const bits = Number(prefix);
  const maximum = v4 ? 32 : 128;
  if (bits > maximum) {
    return `"${entry}" has a /${prefix} prefix, which is wider than the ${maximum} bits an ${v4 ? "IPv4" : "IPv6"} address has`;
  }
  return null;
}

/**
 * Read the deployment's topology out of the environment.
 *
 * ABSENT AND EMPTY BOTH MEAN DIRECT, and that is the whole safety property:
 * every way of not answering the question gives the answer that trusts
 * nobody. An unset variable, an empty string and a string of only whitespace
 * are the three ways a deployment ends up not having configured this, usually
 * by accident, and none of them may produce a trusting configuration.
 *
 * ANYTHING PRESENT BUT UNPARSEABLE IS A REFUSAL, not a fallback to direct.
 * Falling back would mean a deployment that INTENDED to trust its proxy, and
 * typed the list wrong, running with a silently different security posture
 * than the one its operator configured -- and finding out through a support
 * ticket about rate limits. A refusal is a start-up failure with a named
 * field, which is what `config.ts` already does for every other input.
 */
export function resolveTrustedProxyTopology(
  env: Readonly<Record<string, string | undefined>>
): TopologyResolution {
  const raw = env[TRUSTED_PROXIES_VARIABLE];
  if (raw === undefined || raw.trim() === "") {
    return { ok: true, topology: DIRECT_TOPOLOGY };
  }

  const entries = raw.split(",").map((entry) => entry.trim());
  const problems = entries
    .map((entry) => hopProblem(entry))
    .filter((problem): problem is string => problem !== null)
    .map((problem) => `${TRUSTED_PROXIES_VARIABLE}: ${problem}`);

  if (problems.length > 0) return { ok: false, problems };

  return { ok: true, topology: { kind: "behind-proxies", hops: Object.freeze(entries) } };
}

/**
 * What the identity library is told about client addresses.
 *
 * The shape is the library's `advanced.ipAddress`, built here so that the
 * decision lives beside its reasoning rather than inline in a 200-line
 * options object.
 */
export interface ClientIpDerivation {
  readonly ipAddressHeaders: readonly string[];
  readonly trustedProxies?: readonly string[];
}

export function clientIpDerivation(topology: TrustedProxyTopology): ClientIpDerivation {
  if (topology.kind === "direct") {
    /*
     * NO HEADERS, AND NO `trustedProxies` KEY EITHER. An empty list is not
     * "trust nothing in a chain" -- the library reads `trustedProxies.length
     * > 0` to decide which branch to take, so an empty one lands in the
     * single-value branch, which is the spoof. The header list is what makes
     * that unreachable: a header that is never read cannot carry anything.
     */
    return { ipAddressHeaders: [] };
  }
  return { ipAddressHeaders: CLIENT_IP_HEADERS, trustedProxies: topology.hops };
}

/**
 * One line a human can read, for the configured-surface report.
 *
 * It says what is TRUSTED and what the consequence is, because "no trusted
 * proxies" alone reads like an absence of configuration rather than like the
 * deliberate posture it is.
 */
export function describeClientIpDerivation(topology: TrustedProxyTopology): string {
  if (topology.kind === "direct") {
    return (
      "client IP: no forwarded header is read, so rate limiting uses one shared bucket per " +
      `path for every caller. Set ${TRUSTED_PROXIES_VARIABLE} to the proxy hops this ` +
      "deployment sits behind -- and only if the origin cannot be reached around them."
    );
  }
  return (
    `client IP: taken from ${CLIENT_IP_HEADERS.join(", ")}, trusting ` +
    `${topology.hops.join(", ")} and discarding anything a client prepended. Sound only ` +
    "while the origin is unreachable except through those hops."
  );
}
