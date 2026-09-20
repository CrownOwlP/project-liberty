/**
 * WHAT A HOST IS. The repository's one address-range classifier.
 *
 * Extracted by PL-0710 from `@liberty/provider-sdk/src/stremio/url-policy.ts`,
 * where it had been the single implementation and was reached by
 * `@liberty/media-inspection` through an injected port precisely so that it
 * would STAY single. That port worked, and it cost PL-0709 a deep relative
 * import across a package boundary to write a test that could observe both
 * sides at once -- an import the reviewer accepted for that one test at that one
 * tree and ruled was not an acceptable permanent boundary. A lower layer that
 * neither consumer can import back is the shape that works.
 *
 * THIS PACKAGE IS A DEPENDENCY LEAF AND THAT IS THE WHOLE DESIGN. It imports
 * nothing -- not `@liberty/contracts`, not `zod`, not a Node built-in -- so
 * there is no direction in which an edge from `@liberty/provider-sdk` or
 * `@liberty/media-inspection` could close a cycle. `module-boundary.test.ts`
 * asserts that mechanically rather than leaving it to review.
 *
 * NOTHING BELOW IS NEW BEHAVIOUR. Every branch arrived here unchanged from
 * url-policy.ts, including the three findings the register records against it,
 * which are approved behaviour and must survive byte for byte:
 *
 *   - F1, the unbracketed IPv6 literal that classified `"public"`. Closed by
 *     REFUSING a colon outside brackets rather than by auto-bracketing; see the
 *     block on that line for why absorbing the precondition relocates the bug.
 *   - F7, the trailing DNS root label that defeated every name comparison at
 *     once. Closed by folding the label before anything is compared, which is
 *     now `withoutRootLabel` in `./host` and is shared with the two allowlist
 *     and pin comparisons that used to carry their own copies.
 *   - F8, the three translation prefixes that carry an IPv4 address WITHOUT the
 *     zero prefix the mapped/compatible branch tests for: NAT64
 *     `64:ff9b::/96`, 6to4 `2002::/16`, and IPv4-translated `::ffff:0:0/96`.
 *
 * THE METHOD MATTERS MORE THAN ANY ONE BRANCH, and it is the reason this file
 * is worth a package. F1, F7 and F8 were three defects of ONE SHAPE in one
 * function: a host SPELLING the comparisons did not anticipate, each reading as
 * `"public"` -- the one answer that opens a socket -- and none of them findable
 * by reading the code. All three were found by running a differential probe
 * over hostile spellings. A check that compares a string against literals is
 * only ever as complete as the list of spellings whoever wrote it happened to
 * think of, which is why PL-0710's second half classifies the ADDRESS a
 * resolver returned, and that has one spelling. See
 * `docs/SECURITY_REVIEW_PROVIDER_URL.md` for the register and the method.
 */

import { bracketedLiteral, withoutRootLabel } from "./host";

/**
 * The four answers, and the vocabulary both consumers are typed against.
 *
 * `@liberty/provider-sdk` and `@liberty/media-inspection` both re-export this
 * type rather than restating it, so there is one declaration and a widening of
 * it cannot happen in one package without the other seeing it.
 *
 * `"private"` covers link-local, CGNAT, multicast, benchmarking, TEST-NET and
 * every other reserved range as well as RFC 1918 -- the distinction a caller
 * acts on is "may a socket be opened to this", and splitting the refusal into
 * finer classes would invite a caller to permit one of them.
 */
export type HostClass = "public" | "loopback" | "private" | "unparseable";

/**
 * Suffixes that name something on the local network or the local machine.
 *
 * These are checked as suffixes rather than resolved, because resolution is what
 * a pure classifier is trying to avoid depending on. `.local` is mDNS,
 * `.internal` is the conventional cloud-internal zone (and GCP's actual metadata
 * zone), and `.home.arpa` is the RFC 8375 residential equivalent.
 *
 * Exported so a consumer's test can assert the list rather than restate it. It
 * is `readonly` and frozen: a caller that could push onto it could name the
 * empty suffix, and the empty suffix is every host there is.
 */
export const PRIVATE_HOST_SUFFIXES: readonly string[] = Object.freeze([
  ".local",
  ".internal",
  ".intranet",
  ".lan",
  ".corp",
  ".private",
  ".home.arpa"
]);

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
   *   - `64:ff9b::/96`, the NAT64 well-known prefix (RFC 6052 section 2.1). On
   *     any network with a NAT64 gateway -- which is every IPv6-only network
   *     that still reaches IPv4 -- `[64:ff9b::a00:1]` IS 10.0.0.1, reached by
   *     one translation the sender does not have to arrange.
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
 * Classifies a hostname WITHOUT resolving it.
 *
 * A public name pointing at a private address is not caught here and cannot be:
 * that is the resolve-and-pin control's job, and this function is the thing it
 * asks about each address a resolver returned.
 *
 * PRECONDITION: the argument is a URL HOSTNAME, spelled the way `new URL()`
 * spells one -- which means every IPv6 literal arrives inside brackets. The
 * precondition is ENFORCED below rather than assumed, because a caller that
 * breaks it does not get a wrong-looking answer, it gets `"public"`, which is
 * the one answer that opens a socket. Callers holding a bare resolver answer
 * want `classifyResolvedAddress`, which brackets first.
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
   * the whole of PL-0702's F7 fix. `withoutRootLabel` now lives in `./host` and
   * is the same function the allowlist and the pin comparison call; see that
   * file for why the three copies became one.
   *
   * Every check under this line is a comparison against a spelling, and the dot
   * defeats all of them at once: `.endsWith(".internal")` is false,
   * `=== "localhost"` is false, `.endsWith(".localhost")` is false. The result
   * was `"public"` for `metadata.google.internal.`, `foo.local.`, `vault.corp.`
   * and `localhost.` alike. The loopback case is the worse half, because
   * `"public"` does not merely weaken a two-permission gate downstream, it SKIPS
   * it: a host that never classifies `loopback` never reaches the branch that
   * demands a source opt-in and a local deployment, so both permissions go
   * unasked and the URL is accepted on a hosted instance.
   */
  const host = withoutRootLabel(lowered);
  if (host === null) return "unparseable";

  /*
   * A colon outside brackets is the precondition being broken, and it is
   * REFUSED rather than repaired. This is F1.
   *
   * A bare `fd00::1`, `fe80::1` or `::1` reaches none of the branches below: it
   * is not a dotted quad, it is not all digits, it does not end in `.<digits>`,
   * it is not a loopback name and it matches no private suffix -- so it used to
   * fall out of the bottom as `"public"`. Nothing that passes a `URL.hostname`
   * can produce that string; the shape that can is a RESOLVER ANSWER, which is
   * bare, and a resolve-then-classify egress gate is exactly the caller this
   * classifier is reused by. Link-local and unique-local answers would have been
   * classified public and connected to.
   *
   * Auto-bracketing here would also "work", and it is the wrong fix. It widens
   * what this function ACCEPTS, silently, for a consumer whose own bracketing
   * step would then be dead code that nobody notices has stopped mattering. A
   * precondition that is enforced fails at the one call site that broke it; a
   * precondition that is quietly absorbed relocates the bug. `bracketedLiteral`
   * in `./host` is the explicit, named step a resolver path takes instead.
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
 * Classifies an address a RESOLVER returned.
 *
 * Moved here from `@liberty/media-inspection/src/egress.ts`, where it was a
 * private helper that took the classifier as a parameter because the classifier
 * lived in another package. It is the same two lines, and it belongs beside the
 * precondition it satisfies: `classifyHost` dispatches on a leading `[`, a
 * resolver answer has none, and every resolve-then-classify caller in the
 * repository therefore needs this exact adaptation. Leaving each of them to
 * write it is how one of them eventually does not.
 *
 * A zone id (`fe80::1%eth0`) is refused by `classifyHost` itself rather than
 * stripped here, which is the correct failure direction.
 */
export function classifyResolvedAddress(address: string): HostClass {
  return classifyHost(bracketedLiteral(address));
}
