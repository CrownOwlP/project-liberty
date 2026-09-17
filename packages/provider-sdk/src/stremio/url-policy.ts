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
 *   2. Loopback requires TWO independent permissions, never either one alone:
 *      the SOURCE opted in, AND this Project Liberty instance is running as a
 *      local/development deployment. The host must also be a literal loopback
 *      address, never a DNS name we hope resolves to one. See the check itself
 *      for why the source's opt-in is not sufficient on its own.
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
 * of 10.0.0.5, or a name that answers differently between the check and the
 * connect (DNS rebinding), still passes. Closing that requires resolving the
 * name ourselves and pinning the connection to the resolved address, which the
 * WHATWG `fetch` API gives no hook for -- it needs a custom dispatcher/agent.
 *
 * Documenting the limitation rather than closing it is acceptable ONLY while
 * this is what it is today: a controlled adapter pointed at a small set of
 * operator-fixed endpoints, where the set of names ever passed to `fetch` is
 * known at configuration time and can be reviewed by a human. The moment this
 * becomes the general server-side client for arbitrary operator- or
 * user-configured addons, host-string checks are no longer a control at all --
 * an attacker chooses the name, so checking the name proves nothing -- and
 * resolve-and-pin has to land BEFORE that ships to production, not as a later
 * hardening pass. It is recorded here rather than left as an unstated
 * assumption, because the check below looks complete enough to be mistaken for
 * one.
 *
 * WHAT CHANGED SINCE THAT NOTE WAS WRITTEN, and what did not: resolve-and-pin
 * now EXISTS in this repository. `@liberty/media-inspection`'s
 * `authoriseFetchTarget` resolves the name, classifies every answer with the
 * function below, and refuses on any private result. This file does not use it,
 * so the limitation above is unchanged for the Stremio adapter -- but the
 * remedy is no longer hypothetical, which changes the deferral from "nobody has
 * built this" to "this adapter has not adopted it". The old note tracked the
 * work as PL-0701; PL-0701 is the end-to-end harness and never covered it, so
 * the reference is dropped rather than corrected to a task that does not exist.
 * Recorded under residual risks in docs/SECURITY.md by the PL-0702 review,
 * which is the surface where an unowned risk is visible.
 *
 * AND THE ARGUMENT FOR THAT ADOPTION IS NOW STRONGER THAN THE NOTE ABOVE MAKES
 * IT SOUND. Three defects of ONE SHAPE have now been found in this file: an
 * unbracketed IPv6 literal classified as public (F1), a trailing DNS root label
 * defeating every name comparison at once (F7), and an IPv4 address wearing a
 * translation prefix the zero-prefix test did not match (F8). Each was a host
 * SPELLING the comparisons below did not anticipate, each read as `"public"`,
 * and each was invisible to a reading pass -- all three were found by running a
 * differential probe over hostile spellings rather than by reviewing the code.
 * That is evidence about the technique, not about any one branch: a check that
 * compares a string against literals is only ever as complete as the list of
 * spellings whoever wrote it happened to think of. Resolve-and-pin classifies
 * the ADDRESS a resolver returned, which has one spelling. See
 * docs/SECURITY_REVIEW_PROVIDER_URL.md for the register and the method.
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
  | "url_loopback_not_local_deployment"
  | "url_private_address";

export interface UrlPolicyOptions {
  /**
   * Whether this SOURCE is allowed to address the machine Liberty runs on.
   * Defaults to false everywhere it is derived from configuration: a source that
   * did not say it was local is not local. Necessary for loopback; not
   * sufficient -- see `localDeployment`.
   */
  readonly allowLoopback: boolean;
  /**
   * Whether this INSTANCE of Project Liberty is a local or development
   * deployment rather than a hosted one.
   *
   * A property of the running deployment, not of a source, and deliberately not
   * readable from source configuration: if the config file could set it, it
   * would be the same switch as `allowLoopback` wearing a second name. It is
   * threaded in from the process boundary, and defaults to false everywhere it
   * is not stated, so an instance that never says it is local is treated as
   * hosted.
   */
  readonly localDeployment: boolean;
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

  /*
   * The OTHER prefixes that carry an IPv4 address, and why they belong beside
   * the mapped/compatible case above rather than in a later hardening pass.
   *
   * `::ffff:a00:1` was already caught, because its first five groups are zero.
   * Three standard prefixes embed an IPv4 address WITHOUT that zero prefix, so
   * they fell through every mask below and came out `"public"` -- the one answer
   * that opens a socket -- even when the address they carry is 10.0.0.1:
   *
   *   - `64:ff9b::/96`, the NAT64 well-known prefix (RFC 6052 §2.1). On any
   *     network with a NAT64 gateway -- which is every IPv6-only network that
   *     still reaches IPv4 -- `[64:ff9b::a00:1]` IS 10.0.0.1, reached by one
   *     translation the sender does not have to arrange.
   *   - `2002::/16`, 6to4 (RFC 3056), which carries the IPv4 address in groups
   *     1 and 2 rather than 6 and 7. Deprecated (RFC 7526) and still forwarded
   *     by stacks that implemented it.
   *   - `::ffff:0:0/96`, IPv4-translated (RFC 2765 SIIT), which is the mapped
   *     spelling with a `0` group wedged in and therefore NOT zero-prefixed.
   *
   * Classifying each by the address it carries is strictly correct rather than
   * merely stricter: a 6to4 address wrapping 8.8.8.8 still classifies `public`,
   * because `classifyIPv4` is asked the same question about the same address.
   *
   * NOT COVERED, and named so nobody reads the list as exhaustive: RFC 8215's
   * local-use NAT64 prefixes (`64:ff9b:1::/48`), where the embedded address sits
   * at a different offset for each of the five legal prefix lengths, and any
   * network-specific prefix an operator chooses. Both are decidable only with
   * configuration this pure function does not have; the resolve-and-pin gate
   * recorded under R1 in docs/SECURITY.md is what actually closes that class,
   * because it classifies the address the resolver returns rather than a
   * spelling of one.
   */
  const embedded = embeddedIPv4(groups);
  if (embedded) return classifyIPv4(embedded);

  if ((first & 0xfe00) === 0xfc00) return "private"; // fc00::/7 unique local.
  if ((first & 0xffc0) === 0xfe80) return "private"; // fe80::/10 link local.
  if ((first & 0xff00) === 0xff00) return "private"; // ff00::/8 multicast.
  return "public";
}

/** The IPv4 address a translation prefix carries, or null if it carries none. */
function embeddedIPv4(groups: readonly number[]): readonly number[] | null {
  const at = (index: number): number => groups[index] ?? 0;
  const quad = (high: number, low: number): readonly number[] => [
    (high >> 8) & 0xff,
    high & 0xff,
    (low >> 8) & 0xff,
    low & 0xff
  ];

  // 64:ff9b::/96 -- NAT64 well-known prefix, address in the low 32 bits.
  if (at(0) === 0x0064 && at(1) === 0xff9b && at(2) === 0 && at(3) === 0 && at(4) === 0 && at(5) === 0) {
    return quad(at(6), at(7));
  }
  // ::ffff:0:0/96 -- IPv4-translated, address in the low 32 bits.
  if (at(0) === 0 && at(1) === 0 && at(2) === 0 && at(3) === 0 && at(4) === 0xffff && at(5) === 0) {
    return quad(at(6), at(7));
  }
  // 2002::/16 -- 6to4, address in groups 1 and 2.
  if (at(0) === 0x2002) return quad(at(1), at(2));

  return null;
}

/**
 * Classifies a hostname WITHOUT resolving it. See the residual-risk note in the
 * file header: a public name pointing at a private address is not caught here.
 *
 * PRECONDITION: the argument is a URL HOSTNAME, spelled the way `new URL()`
 * spells one -- which means every IPv6 literal arrives inside brackets. The
 * precondition is ENFORCED below rather than assumed, because a caller that
 * breaks it does not get a wrong-looking answer, it gets `"public"`, which is
 * the one answer that opens a socket.
 */
export function classifyHost(hostname: string): HostClass {
  const lowered = hostname.toLowerCase();
  if (lowered === "") return "unparseable";

  // `new URL()` hands back IPv6 literals still wrapped in their brackets.
  if (lowered.startsWith("[")) {
    if (!lowered.endsWith("]")) return "unparseable";
    const groups = expandIPv6(lowered.slice(1, -1));
    return groups ? classifyIPv6(groups) : "unparseable";
  }

  /*
   * THE ROOT LABEL IS REMOVED BEFORE ANYTHING IS COMPARED, and that ordering is
   * the whole of this fix.
   *
   * `metadata.google.internal.` and `metadata.google.internal` are the same name
   * to every resolver -- the trailing dot is the DNS root label, and writing it
   * is the ordinary way to say "this is fully qualified, do not append a search
   * domain". The WHATWG URL parser agrees they are different STRINGS and keeps
   * the dot on a domain: `new URL("https://metadata.google.internal./").hostname`
   * is `"metadata.google.internal."`. An IP literal is normalised instead
   * (`127.0.0.1.` comes back as `127.0.0.1`), which is exactly why this went
   * unnoticed -- every numeric case in the suite below was already canonical.
   *
   * So every check under this line is a comparison against a spelling, and the
   * dot defeats all of them at once: `.endsWith(".internal")` is false,
   * `=== "localhost"` is false, `.endsWith(".localhost")` is false. The result
   * was `"public"` for `metadata.google.internal.`, `foo.local.`, `vault.corp.`
   * and `localhost.` alike. The loopback case is the worse half, because
   * `"public"` does not merely weaken the two-permission gate below, it SKIPS
   * it: a host that never classifies `loopback` never reaches the branch that
   * demands a source opt-in and a local deployment, so both permissions go
   * unasked and the URL is accepted on a hosted instance.
   *
   * Stripping is a NARROWING, not a widening, which is why it is done here and
   * the unbracketed-IPv6 precondition three lines below is refused instead.
   * Removing the root label can only move a host from `public` into `loopback`
   * or `private`; there is no name it admits that the parser did not already
   * admit, and no spelling that becomes reachable because of it.
   *
   * An EMPTY label is refused rather than collapsed. `"."` is the root itself
   * and names no host, and `"foo.local.."` has a zero-length label that no
   * resolver will accept -- repairing either would be inventing a name on a
   * caller's behalf, which is the mistake the precondition below exists to
   * avoid.
   */
  const host = withoutRootLabel(lowered);
  if (host === null) return "unparseable";

  /*
   * A colon outside brackets is the precondition being broken, and it is
   * REFUSED rather than repaired.
   *
   * A bare `fd00::1`, `fe80::1` or `::1` reaches none of the branches below: it
   * is not a dotted quad, it is not all digits, it does not end in `.<digits>`,
   * it is not a loopback name and it matches no private suffix -- so it used to
   * fall out of the bottom as `"public"`. Nothing inside this package could
   * produce that string, since every caller passes a `URL.hostname`; the shape
   * that can is a RESOLVER ANSWER, which is bare, and a resolve-then-classify
   * egress gate is exactly the caller this classifier is being reused by
   * (`@liberty/media-inspection`'s `authoriseFetchTarget`). Link-local and
   * unique-local answers would have been classified public and connected to.
   *
   * Auto-bracketing here would also "work", and it is the wrong fix. It widens
   * what this function ACCEPTS, silently, for a consumer whose `HostClassifier`
   * port is typed against the four values below and whose own bracketing step
   * would then be dead code that nobody notices has stopped mattering. A
   * precondition that is enforced fails at the one call site that broke it; a
   * precondition that is quietly absorbed relocates the bug.
   */
  if (host.includes(":")) return "unparseable";

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
 * A hostname with the DNS root label removed, or null when what is left is not
 * a name. See the block in `classifyHost` for why this runs before every
 * comparison rather than after any of them.
 */
function withoutRootLabel(host: string): string | null {
  if (!host.endsWith(".")) return host;
  const stripped = host.slice(0, -1);
  return stripped === "" || stripped.endsWith(".") ? null : stripped;
}

/**
 * The scheme of a string that did NOT parse, or the fact that it has none.
 *
 * Everything after the scheme is discarded. A `detail` here reaches a candidate's
 * reason trail verbatim through `mapping.ts`, and unlike every other branch of
 * `checkUrl` this one has no parsed URL to reduce -- so echoing the input meant
 * echoing up to 120 characters of addon-authored string, query included. Both
 * strings this function is ever handed can be chosen by an addon: a stream URL,
 * where `//cdn.example.test/f.mp4?token=...` is protocol-relative and so is
 * refused outright by `new URL()`, and a `Location:` header, which resolves
 * against its base and therefore reaches this branch less often but reaches it
 * with `http.ts` waiting to re-report it as a rejected redirect target.
 *
 * The scheme is the one part that can be named safely: RFC 3986 bounds its
 * charset, and telling "the operator typed a relative path" apart from "the
 * addon offered `http://` with no host" is the whole diagnostic value of the
 * message. It is length-capped as well, because a bounded charset does not stop
 * anyone encoding a token in a very long scheme-shaped prefix. The character
 * count replaces the string itself: it distinguishes an empty config field from
 * a mangled URL without reproducing either.
 */
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*(?=:)/i;

function describeUnparseable(raw: string): string {
  const scheme = SCHEME_PATTERN.exec(raw)?.[0];
  const named = scheme === undefined ? "(no scheme)" : `scheme ${truncate(scheme, 16)}:`;
  return `${named}, ${raw.length} characters`;
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
    return {
      ok: false,
      reason: "url_unparseable",
      detail: `not an absolute URL: ${describeUnparseable(raw)}`
    };
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

  /*
   * The host is CAPPED everywhere it is named below.
   *
   * `detail` is copied verbatim into a candidate's reason trail by `mapping.ts`,
   * and on a stream URL the host is chosen by the addon. The WHATWG URL parser
   * enforces no length limit on a hostname -- the 253-byte DNS bound is a
   * resolver rule, not a parsing one -- so `https://<128KiB>.local/` parses,
   * fails the private-suffix check, and used to write all 128 KiB of it into
   * every log line and response that carries the trail. A host cannot hold a
   * signed query string, so this is a flooding problem rather than a secret
   * one, but 64 characters is enough to identify a host to a human and the
   * remainder was never diagnostic. Matches what `@liberty/media-inspection`
   * already does with the same five messages, so the two SSRF gates cannot
   * disagree about how much of a hostile host they repeat.
   */
  const host = truncate(url.hostname, 64);

  if (hostClass === "unparseable") {
    return {
      ok: false,
      reason: "url_host_unparseable",
      detail: `host ${host} is neither a valid name nor a valid address`
    };
  }

  if (hostClass === "private") {
    return {
      ok: false,
      reason: "url_private_address",
      detail: `host ${host} is in a private, link-local or reserved range`
    };
  }

  if (hostClass === "loopback") {
    /*
     * TWO conditions, both required, neither sufficient.
     *
     * `allowLoopback` alone used to open loopback, and that is wrong in the one
     * deployment that matters most. On a hosted Project Liberty instance,
     * 127.0.0.1 is the Liberty SERVER -- its admin endpoints, its metrics port,
     * its database bound to localhost, its sidecars. A source config saying "I
     * am a local addon" is a claim about the operator's laptop; honouring it in
     * a hosted process turns this package into a general request-forgery
     * capability aimed at ourselves, reachable by whoever can add or edit a
     * source (and, through redirects, by any addon that source talks to). The
     * private-address rules above deliberately do not save us here, because
     * loopback is exactly the class they exempt.
     *
     * So the deployment must ALSO say it is local. The two facts have different
     * owners -- a source config file and the process environment -- and
     * requiring both means neither owner can grant loopback by themselves.
     *
     * The source's opt-in is checked first so the reasons stay distinct and each
     * one names the thing to fix: "this source is not declared local" is a
     * config error, "this instance is not a local deployment" is a statement
     * that no config change can satisfy in production.
     */
    if (!options.allowLoopback) {
      return {
        ok: false,
        reason: "url_loopback_not_permitted",
        detail: `host ${host} is loopback and this source is not configured as local`
      };
    }
    if (!options.localDeployment) {
      return {
        ok: false,
        reason: "url_loopback_not_local_deployment",
        detail:
          `host ${host} is loopback and this instance is not a local deployment; ` +
          "a source opt-in alone never makes this machine reachable"
      };
    }
    return { ok: true, url, hostClass };
  }

  if (url.protocol === "http:") {
    return {
      ok: false,
      reason: "url_plaintext_http_not_loopback",
      detail: `plaintext http is only permitted for loopback, not ${host}`
    };
  }

  return { ok: true, url, hostClass };
}

/** Keeps a hostile URL from turning a log line or an error message into a wall. */
export function truncate(value: string, max = 120): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}
