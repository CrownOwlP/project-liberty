/**
 * Outbound URL policy (PL-0301).
 *
 * Every URL this package is about to hand to `fetch`, or about to publish as a
 * playable candidate, passes through here first -- the operator's configured
 * manifest URL, every redirect target, and every stream URL an addon returns.
 * The addon is a third party on the network; its response is attacker-shaped
 * input in exactly the same sense a request body is.
 *
 * The threat is SSRF. Project Liberty resolves playback SERVER-side, so an
 * addon that returns `http://169.254.169.254/latest/meta-data/iam/...` is asking
 * our server to fetch cloud instance credentials and hand the body back to a
 * client, and one that returns `http://10.0.0.5:9200/_search` is asking it to
 * read an internal service. Neither request is unusual-looking at the fetch
 * layer; the only place they can be stopped is a policy that runs before the
 * socket is opened.
 *
 * The rules, and why each one exists:
 *
 *   1. `https:` only, with `http:` allowed ONLY for a loopback host. Plaintext
 *      to a remote host is both a transport problem and the shape almost every
 *      internal-service pivot takes, since internal services rarely speak TLS.
 *      A local media server on `http://127.0.0.1:8096` is a legitimate,
 *      operator-chosen source and is not on any network, so it is exempt.
 *      Every other scheme -- `magnet:`, `file:`, `data:`, `ftp:`, `ws:` -- is
 *      rejected here as well as at the mapping layer.
 *
 *   2. Loopback is allowed only when the SOURCE opted in. "Explicit loopback"
 *      means both that the host is a literal loopback address (never a DNS name
 *      we hope resolves to one) and that the operator declared this source as a
 *      local one. A source configured against a public addon has no business
 *      reaching our own machine, and without the opt-in a compromised public
 *      addon could redirect us onto our own admin ports.
 *
 *   3. Private, link-local, CGNAT, multicast and reserved ranges are rejected
 *      unconditionally -- including when loopback is permitted. Allowing a local
 *      library addon is a statement about THIS machine, not about the operator's
 *      LAN or their cloud VPC.
 *
 *   4. Embedded credentials are rejected. `https://addon.example.com@evil.test/`
 *      is a host of `evil.test`, and userinfo is the oldest way to make a URL
 *      read as one origin to a human reviewer and resolve as another.
 *
 * KNOWN RESIDUAL RISK, deliberately not solved here: this validates the host
 * LITERAL, not the address the host resolves to. A public name with an A record
 * of 10.0.0.5, or a name that answers differently on the second lookup (DNS
 * rebinding), still passes. Closing that requires resolving the name ourselves
 * and pinning the connection to the resolved address, which the WHATWG `fetch`
 * API gives no hook for -- it needs a custom dispatcher/agent. That is a
 * follow-up for the security hardening pass (PL-0701), and it is recorded here
 * rather than left as an unstated assumption, because the check below looks
 * complete enough to be mistaken for one.
 */

export type HostClass = "public" | "loopback" | "private" | "unparseable";

/**
 * Rejection reasons carry the `url_` prefix so they can be surfaced verbatim in
 * a candidate's reason trail without translation. A reason that gets rewritten
 * on the way out is a reason that eventually stops matching what the code did.
 */
export type UrlRejectionReason =
  | "url_unparseable"
  | "url_scheme_not_http"
  | "url_credentials_present"
  | "url_host_missing"
  | "url_host_unparseable"
  | "url_plaintext_http_not_loopback"
  | "url_loopback_not_permitted"
  | "url_private_address";

export interface UrlPolicyOptions {
  /**
   * Whether this source is allowed to address the machine Liberty runs on.
   * Defaults to false everywhere it is derived from configuration: a source that
   * did not say it was local is not local.
   */
  readonly allowLoopback: boolean;
}

export type UrlCheckResult =
  | { readonly ok: true; readonly url: URL; readonly hostClass: HostClass }
  | { readonly ok: false; readonly reason: UrlRejectionReason; readonly detail: string };

/**
 * Suffixes that name something on the local network or the local machine.
 *
 * These are checked as suffixes rather than resolved, because resolution is what
 * we are trying to avoid depending on. `.local` is mDNS, `.internal` is the
 * conventional cloud-internal zone (and GCP's actual metadata zone), and
 * `.home.arpa` is the RFC 8375 residential equivalent.
 */
const PRIVATE_HOST_SUFFIXES: readonly string[] = [
  ".local",
  ".internal",
  ".intranet",
  ".lan",
  ".corp",
  ".private",
  ".home.arpa"
];

function isLoopbackName(hostname: string): boolean {
  // RFC 6761 reserves `localhost` and everything under it for the loopback
  // interface, so `.localhost` subdomains are treated the same rather than being
  // let through as ordinary public names.
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

/**
 * Dotted-quad only, and deliberately strict.
 *
 * The WHATWG URL parser already normalises the exotic spellings -- decimal
 * (`http://2130706433/`), octal (`http://0177.0.0.1/`) and hex
 * (`http://0x7f.0.0.1/`) all come out of `new URL()` as `127.0.0.1` -- so by the
 * time a hostname reaches this function it is either a canonical dotted quad or
 * it is not an IPv4 literal at all. Anything numeric-looking that fails this
 * test is therefore something the parser did not recognise as an address, and
 * `classifyHost` treats it as a name rather than silently accepting it as one.
 */
function parseIPv4(hostname: string): readonly number[] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;

  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

function classifyIPv4(octets: readonly number[]): HostClass {
  const [a = 0, b = 0] = octets;

  if (a === 127) return "loopback";
  if (a === 0) return "private"; // 0.0.0.0/8 "this network"; 0.0.0.0 often aliases loopback.
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 169 && b === 254) return "private"; // Link-local, and the EC2/Azure metadata address.
  if (a === 100 && b >= 64 && b <= 127) return "private"; // CGNAT, RFC 6598.
  if (a === 192 && b === 0) return "private"; // 192.0.0.0/24 protocol assignments, 192.0.2.0/24 TEST-NET-1.
  if (a === 198 && (b === 18 || b === 19)) return "private"; // Benchmarking, RFC 2544.
  if (a === 198 && b === 51) return "private"; // TEST-NET-2.
  if (a === 203 && b === 0) return "private"; // TEST-NET-3.
  if (a >= 224) return "private"; // Multicast (224/4) and reserved (240/4), incl. 255.255.255.255.
  return "public";
}

/**
 * Expands an IPv6 literal to its eight 16-bit groups, or null if it is not one.
 *
 * Written out rather than pattern-matched on the string, because the interesting
 * cases are the ones where two spellings of the same address look different:
 * `[::1]` and `[0:0:0:0:0:0:0:1]` are the same host, and `[::ffff:127.0.0.1]` --
 * which `new URL()` re-spells as `[::ffff:7f00:1]` -- is 127.0.0.1 wearing an
 * IPv6 hat. A prefix-string check would pass at least one of those through.
 */
function expandIPv6(hostname: string): readonly number[] | null {
  // A zone id (`fe80::1%25eth0`) never belongs in a URL we originate. Refuse to
  // interpret it rather than stripping it and guessing.
  if (hostname.includes("%")) return null;

  let text = hostname;
  const trailingIPv4 = text.includes(".");
  if (trailingIPv4) {
    const lastColon = text.lastIndexOf(":");
    if (lastColon === -1) return null;
    const quad = parseIPv4(text.slice(lastColon + 1));
    if (!quad) return null;
    const [a = 0, b = 0, c = 0, d = 0] = quad;
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;

  const toGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const groups: number[] = [];
    for (const chunk of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(chunk)) return null;
      groups.push(Number.parseInt(chunk, 16));
    }
    return groups;
  };

  const head = toGroups(halves[0] ?? "");
  const tail = halves.length === 2 ? toGroups(halves[1] ?? "") : [];
  if (!head || !tail) return null;

  if (halves.length === 1) return head.length === 8 ? head : null;

  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

function classifyIPv6(groups: readonly number[]): HostClass {
  const first = groups[0] ?? 0;
  const isZeroPrefix = groups.slice(0, 5).every((group) => group === 0);

  // ::ffff:0:0/96 (IPv4-mapped) and ::/96 (IPv4-compatible) are IPv4 addresses.
  // Classify them as the IPv4 address they carry, so `[::ffff:a00:1]` is caught
  // by the same 10/8 rule that catches `10.0.0.1`.
  if (isZeroPrefix && (groups[5] === 0xffff || groups[5] === 0)) {
    const high = groups[6] ?? 0;
    const low = groups[7] ?? 0;
    const asIPv4 = [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff];
    // ::0 and ::1 are the unspecified and loopback addresses, not 0.0.0.0/0.0.0.1.
    if (groups[5] === 0 && high === 0 && low <= 1) return low === 1 ? "loopback" : "private";
    return classifyIPv4(asIPv4);
  }

  if ((first & 0xfe00) === 0xfc00) return "private"; // fc00::/7 unique local.
  if ((first & 0xffc0) === 0xfe80) return "private"; // fe80::/10 link local.
  if ((first & 0xff00) === 0xff00) return "private"; // ff00::/8 multicast.
  return "public";
}

/**
 * Classifies a hostname WITHOUT resolving it. See the residual-risk note in the
 * file header: a public name pointing at a private address is not caught here.
 */
export function classifyHost(hostname: string): HostClass {
  const host = hostname.toLowerCase();
  if (host === "") return "unparseable";

  // `new URL()` hands back IPv6 literals still wrapped in their brackets.
  if (host.startsWith("[")) {
    if (!host.endsWith("]")) return "unparseable";
    const groups = expandIPv6(host.slice(1, -1));
    return groups ? classifyIPv6(groups) : "unparseable";
  }

  const octets = parseIPv4(host);
  if (octets) return classifyIPv4(octets);

  // A bare number, or a dotted form with a numeric last label, that the URL
  // parser did NOT normalise into a dotted quad. `new URL()` rejects the ones
  // that are genuinely addresses, so reaching here means the string is neither a
  // valid address nor a valid name -- which is not something to resolve and see.
  if (/^\d+$/.test(host) || /\.\d+$/.test(host)) return "unparseable";

  if (isLoopbackName(host)) return "loopback";
  if (PRIVATE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return "private";
  return "public";
}

/**
 * The single gate. Pure: no DNS, no sockets, no clock.
 *
 * `base` lets a relative `Location:` header be resolved against the URL that
 * produced it, so redirect targets go through exactly the same checks as the
 * original -- validating only the first URL of a redirect chain is the classic
 * way an SSRF filter is bypassed.
 */
export function checkUrl(raw: string, options: UrlPolicyOptions, base?: string): UrlCheckResult {
  let url: URL;
  try {
    url = base === undefined ? new URL(raw) : new URL(raw, base);
  } catch {
    return { ok: false, reason: "url_unparseable", detail: `not an absolute URL: ${truncate(raw)}` };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return {
      ok: false,
      reason: "url_scheme_not_http",
      detail: `scheme ${url.protocol} is not fetchable by this adapter`
    };
  }

  if (url.username !== "" || url.password !== "") {
    return {
      ok: false,
      reason: "url_credentials_present",
      detail: "URL carries embedded credentials"
    };
  }

  if (url.hostname === "") {
    return { ok: false, reason: "url_host_missing", detail: "URL has no host" };
  }

  const hostClass = classifyHost(url.hostname);

  if (hostClass === "unparseable") {
    return {
      ok: false,
      reason: "url_host_unparseable",
      detail: `host ${url.hostname} is neither a valid name nor a valid address`
    };
  }

  if (hostClass === "private") {
    return {
      ok: false,
      reason: "url_private_address",
      detail: `host ${url.hostname} is in a private, link-local or reserved range`
    };
  }

  if (hostClass === "loopback") {
    if (!options.allowLoopback) {
      return {
        ok: false,
        reason: "url_loopback_not_permitted",
        detail: `host ${url.hostname} is loopback and this source is not configured as local`
      };
    }
    return { ok: true, url, hostClass };
  }

  if (url.protocol === "http:") {
    return {
      ok: false,
      reason: "url_plaintext_http_not_loopback",
      detail: `plaintext http is only permitted for loopback, not ${url.hostname}`
    };
  }

  return { ok: true, url, hostClass };
}

/** Keeps a hostile URL from turning a log line or an error message into a wall. */
export function truncate(value: string, max = 120): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}
