/* -------------------------------------------------------------------------
 * THE SHARED TABLE OF HOSTILE HOST SPELLINGS.
 *
 * NOTHING IN THIS FILE IS PRODUCTION CODE. It is published at
 * `@liberty/net-policy/testing/host-spellings` because two packages' suites
 * drive it, and three copies of a table are three tables that agree until
 * somebody edits one.
 *
 * WHERE IT CAME FROM, AND WHY IT MOVED. PL-0709 wrote this table into
 * `@liberty/media-inspection/src/testing/host-spellings.ts` to pin an AGREEMENT
 * between two functions that each decided what a host is:
 *
 *   - `classifyHost`, which answered "public / loopback / private /
 *     unparseable"; and
 *   - `hostOnAllowlist`, which answered "named by the operator or not".
 *
 * They disagreed. PL-0702's F7 taught `classifyHost` to fold the DNS root label
 * and `hostOnAllowlist` still compared the hostname as given, so
 * `cdn.example.test.` classified as one host and matched the allowlist as a
 * different one. The disagreement FAILED CLOSED -- the dotted spelling was
 * refused, never admitted -- which is why F12 is Informational, and it was worth
 * fixing anyway because two classifiers that disagree about what a host is get
 * reconciled eventually by somebody copying one of them, and the copy that goes
 * the other way is F7 again.
 *
 * PL-0710 REMOVED THE DISAGREEMENT RATHER THAN CONTINUING TO PIN IT. There is
 * now one root-label fold (`withoutRootLabel` in `../host.ts`) and one
 * classifier (`classifyHost` in `../classify.ts`), and both of the functions
 * above call them. An agreement test between two implementations is meaningless
 * once there is one implementation, so the table's job changed: it is no longer
 * a contract BETWEEN two functions, it is the hostile-spelling corpus that the
 * shared canonicaliser, the shared classifier and each consumer's own gate are
 * all driven from. It lives in the leaf package because that is the only place
 * both consumers can reach without reaching into each other.
 *
 * THE TABLE IS STILL THE POINT. Every entry below is a spelling that was, or
 * could plausibly be, answered wrongly by a comparison against a literal. Adding
 * a row here obliges the shared classifier, both consumers' gates and the pin
 * comparison to answer for it.
 * ---------------------------------------------------------------------- */

/**
 * One hostname spelling, and the name it denotes.
 *
 * `spelling` is written the way `new URL().hostname` produces it, because that
 * is the only way any of these functions is ever called in production:
 * bracketed IPv6, normalised IPv4, and a domain that KEEPS its trailing dot
 * (`new URL("https://metadata.google.internal./").hostname` is
 * `"metadata.google.internal."` -- an IP literal is normalised, a name is not,
 * which is exactly why F7 and F12 went unnoticed).
 *
 * `canonical` is the same name with the DNS root label folded away, or `null`
 * when the spelling names no host at all. `null` is the fail-closed half of the
 * contract and the reason this is a table of two columns rather than a list of
 * strings: every function must REFUSE those, and none of them may repair one
 * into something that matches.
 */
export interface HostSpelling {
  readonly spelling: string;
  readonly canonical: string | null;
  readonly why: string;
}

/**
 * Spellings every gate must agree about.
 *
 * Every entry whose `canonical` differs from its `spelling` is a case where the
 * canonicaliser has work to do. Every entry with `canonical: null` is a case
 * where the correct answer is a refusal, and where "repair it into a usable
 * name" is the tempting wrong fix -- inventing a name on a caller's behalf is
 * how a comparison against a spelling becomes a comparison against a spelling
 * the caller never wrote.
 */
export const HOSTILE_HOST_SPELLINGS: readonly HostSpelling[] = [
  {
    spelling: "cdn.example.test.",
    canonical: "cdn.example.test",
    why: "F12 itself: the fully qualified spelling of an allowlisted CDN."
  },
  {
    spelling: "CDN.Example.Test.",
    canonical: "cdn.example.test",
    why: "Case folding and root-label folding have to compose, not take turns."
  },
  {
    spelling: "edge.cdn.example.test.",
    canonical: "edge.cdn.example.test",
    why: "A subdomain reached through a leading-dot suffix entry, fully qualified."
  },
  {
    spelling: "localhost.",
    canonical: "localhost",
    why: "F7's sharp edge seen from the allowlist side: `localhost.` is loopback and must be gated by the two loopback keys, not waved through or refused for the wrong reason."
  },
  {
    spelling: "metadata.google.internal.",
    canonical: "metadata.google.internal",
    why: "The cloud metadata endpoint. Classified private and refused before the allowlist is consulted -- listed here so that a change which stopped folding the root label would fail loudly rather than quietly reclassify it as public."
  },
  {
    spelling: "vault.corp.local.",
    canonical: "vault.corp.local",
    why: "An mDNS/LAN name; the `.local` suffix only matches once the root label is gone."
  },
  {
    spelling: "127.0.0.1",
    canonical: "127.0.0.1",
    why: "An IPv4 literal, which the URL parser has ALREADY normalised -- `127.0.0.1.` never reaches any of these functions. Present so the fix is shown not to disturb the literals."
  },
  {
    spelling: "[::1]",
    canonical: "[::1]",
    why: "A bracketed IPv6 literal, likewise never dotted. Folding must not reach inside the brackets."
  },
  {
    spelling: ".",
    canonical: null,
    why: "The root itself. It names no host and must not fold to the empty string, which would match the empty suffix."
  },
  {
    spelling: "..",
    canonical: null,
    why: "Two root labels. Folding once leaves a trailing dot; folding until it stops is the repair this contract forbids."
  },
  {
    spelling: "cdn.example.test..",
    canonical: null,
    why: "A zero-length label no resolver accepts. Refusing is the only honest answer; folding it to `cdn.example.test` would admit a string the operator never named."
  },
  {
    spelling: "localhost..",
    canonical: null,
    why: "The same shape on the loopback name, where a repair would hand a caller a host that reaches this machine."
  }
];

/**
 * Translation-prefix and bare-literal spellings of an address, for the suites
 * that exercise `classifyHost` rather than a name comparison.
 *
 * SEPARATE FROM THE TABLE ABOVE ON PURPOSE. That one is about NAMES and the
 * root label; this one is about ADDRESSES wearing a spelling the range masks did
 * not anticipate -- F1 and F8 rather than F7 and F12. Merging them would give
 * every consumer's root-label suite a pile of rows with nothing to say about the
 * root label.
 */
export interface AddressSpelling {
  readonly spelling: string;
  readonly expected: "public" | "loopback" | "private" | "unparseable";
  readonly why: string;
}

/** Address spellings the classifier must not read as `"public"` by accident. */
export const HOSTILE_ADDRESS_SPELLINGS: readonly AddressSpelling[] = [
  {
    spelling: "[64:ff9b::a00:1]",
    expected: "private",
    why: "F8: the NAT64 well-known prefix carrying 10.0.0.1. On any network with a NAT64 gateway this IS 10.0.0.1."
  },
  {
    spelling: "[64:ff9b::7f00:1]",
    expected: "loopback",
    why: "F8: NAT64 carrying 127.0.0.1, which must classify as the loopback it reaches, not as a public IPv6 address."
  },
  {
    spelling: "[64:ff9b::808:808]",
    expected: "public",
    why: "F8 is strictly correct rather than merely stricter: NAT64 carrying 8.8.8.8 is still public."
  },
  {
    spelling: "[2002:a00:1::]",
    expected: "private",
    why: "F8: 6to4 carries the IPv4 address in groups 1 and 2, not 6 and 7, so it fell through every mask."
  },
  {
    spelling: "[2002:a9fe:a9fe::]",
    expected: "private",
    why: "F8: 6to4 wrapping 169.254.169.254, the cloud metadata address."
  },
  {
    spelling: "[2002:808:808::]",
    expected: "public",
    why: "F8: 6to4 wrapping 8.8.8.8 is public, for the same reason the NAT64 case above is."
  },
  {
    spelling: "[::ffff:0:a00:1]",
    expected: "private",
    why: "F8: IPv4-translated (RFC 2765 SIIT) is the mapped spelling with a `0` group wedged in, so it is NOT zero-prefixed and the mapped branch missed it."
  },
  {
    spelling: "[::ffff:a00:1]",
    expected: "private",
    why: "IPv4-mapped, which the zero-prefix branch already caught. Present so a change to the F8 branch cannot silently break the case that worked."
  },
  {
    spelling: "[::ffff:7f00:1]",
    expected: "loopback",
    why: "How `new URL()` re-spells `[::ffff:127.0.0.1]`."
  },
  {
    spelling: "fe80::1",
    expected: "unparseable",
    why: "F1: an UNBRACKETED IPv6 literal, the shape a resolver answer has. It used to fall out of the bottom as `public`. Refused rather than auto-bracketed -- see `classifyHost`."
  },
  {
    spelling: "::1",
    expected: "unparseable",
    why: "F1 on the loopback address. `classifyResolvedAddress` is the named step that brackets a resolver answer; the classifier itself refuses."
  },
  {
    spelling: "[fe80::1%25eth0]",
    expected: "unparseable",
    why: "A zone id never belongs in a URL we originate, and guessing what it meant is worse than refusing it."
  },
  {
    spelling: "[fd00::1]",
    expected: "private",
    why: "fc00::/7 unique local."
  },
  {
    spelling: "169.254.169.254",
    expected: "private",
    why: "The EC2/Azure instance metadata address, the single most-targeted SSRF destination there is."
  },
  {
    spelling: "100.64.0.1",
    expected: "private",
    why: "CGNAT, RFC 6598 -- a range that is neither RFC 1918 nor routable."
  },
  {
    spelling: "0.0.0.0",
    expected: "private",
    why: "`0.0.0.0/8` is `this network`, and 0.0.0.0 frequently aliases loopback on a socket layer."
  },
  {
    spelling: "255.255.255.255",
    expected: "private",
    why: "Broadcast, caught by the 224/4-and-above rule."
  },
  {
    spelling: "93.184.216.34",
    expected: "public",
    why: "A control. A classifier that refuses everything is not a classifier."
  }
];
