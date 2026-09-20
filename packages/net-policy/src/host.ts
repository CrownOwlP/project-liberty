/**
 * HOW A HOST IS SPELLED. One implementation, for every gate in the repository.
 *
 * This module answers the question that comes BEFORE "is this address safe":
 * which string names which host. It is deliberately tiny and deliberately
 * boring, and it is a separate package because until PL-0710 it was three
 * functions in two packages that agreed by inspection rather than by
 * construction.
 *
 * THE THREE CANONICALISERS THIS FILE REPLACES, named so the merge is auditable:
 *
 *   1. `withoutRootLabel` in `@liberty/provider-sdk/src/stremio/url-policy.ts`
 *      -- PL-0702's F7 fix. `classifyHost` compares a hostname against literals
 *      (`=== "localhost"`, `.endsWith(".internal")`), and a trailing DNS root
 *      label defeats every one of those comparisons at once, so
 *      `metadata.google.internal.` classified `"public"`. F7 stripped the label
 *      before any comparison ran.
 *   2. `withoutRootLabel` in `@liberty/media-inspection/src/egress.ts` --
 *      PL-0709's F12 fix, a deliberate character-for-character copy of (1) with
 *      the duplication named in a comment and pinned by an agreement test,
 *      because there was no importable shared home for it at the time.
 *   3. `normaliseHost` in `@liberty/media-inspection/src/pin.ts`, which case
 *      folds and strips brackets and does NOT fold the root label. It was safe
 *      -- both sides of its one comparison come from the same `URL` object, so
 *      they carry or omit the dot together, and a mismatch refuses the
 *      connection -- but "safe because of where its inputs happen to come from"
 *      is the property that stops holding when somebody adds a caller. It was
 *      still a third answer to the same question.
 *
 * WHY A CANONICALISER DESERVES ITS OWN PACKAGE AT ALL. The argument the two
 * consumers already make about the address-range CLASSIFIER -- two copies drift,
 * the stale one becomes the hole, and nothing fails when they disagree -- is
 * exactly as true of four lines of string handling, and PL-0709 proved it
 * empirically: (1) and (2) were the same function and they still spent a
 * release disagreeing, because (2) did not exist yet. A shared implementation
 * cannot disagree with itself.
 *
 * WHAT THIS MODULE DOES NOT DO: it does not lower-case or trim on your behalf,
 * and that omission is load bearing. `hostOnAllowlist` trims its ALLOWLIST
 * ENTRIES (an operator writes those by hand, and a stray space in a config file
 * is a typo) and deliberately does NOT trim the HOSTNAME (that one comes from a
 * URL parser, and accepting `" cdn.example.test "` as a host would admit a
 * string no parser produces). Folding the two into one "canonicalise
 * everything" helper would have quietly widened one of them. `canonicalHost`
 * therefore case folds and folds the root label, and the caller composes any
 * trimming or bracket handling it actually wants.
 */

/**
 * A hostname with the DNS root label removed, or `null` when what is left is not
 * a name.
 *
 * `cdn.example.test.` and `cdn.example.test` are the same name to every
 * resolver: the trailing dot is the root label, and writing it is the ordinary
 * way to say "this is fully qualified, do not append a search domain". The
 * WHATWG URL parser agrees they are different STRINGS and keeps the dot on a
 * domain -- `new URL("https://metadata.google.internal./").hostname` is
 * `"metadata.google.internal."` -- while normalising it away on an IP literal
 * (`127.0.0.1.` comes back as `127.0.0.1`). That asymmetry is exactly why both
 * F7 and F12 went unnoticed: every numeric case in both suites was already
 * canonical.
 *
 * STRIPPING IS A NARROWING, NOT A WIDENING, and that is why it is safe to do it
 * before a classification. Removing the root label can only move a host from
 * `public` into `loopback` or `private`; there is no name it admits that the
 * parser did not already admit, and no spelling that becomes reachable because
 * of it.
 *
 * AN EMPTY LABEL IS REFUSED RATHER THAN COLLAPSED. `"."` is the root itself and
 * names no host; `"foo.local.."` has a zero-length label that no resolver will
 * accept. Folding either until something matched would be inventing a name on
 * the caller's behalf -- and an allowlist entry repaired down to `""` or `"."`
 * is the empty suffix, which is every host there is.
 */
export function withoutRootLabel(host: string): string | null {
  if (!host.endsWith(".")) return host;
  const stripped = host.slice(0, -1);
  return stripped === "" || stripped.endsWith(".") ? null : stripped;
}

/**
 * The one spelling two hosts are compared in: case folded, root label folded.
 *
 * `null` means the string names no host, and callers must treat that as a
 * REFUSAL rather than as a value to compare. Two `null`s are equal in
 * JavaScript, so a comparison written as `canonicalHost(a) === canonicalHost(b)`
 * without a null guard would make "names no host" match "names no host" -- which
 * is the fail-open reading of a fail-closed answer.
 *
 * The empty string is folded into `null` for the same reason: `""` is not a
 * host, and every caller that used to write `x === null || x === ""` was
 * spelling one condition as two.
 */
export function canonicalHost(hostname: string): string | null {
  const folded = withoutRootLabel(hostname.toLowerCase());
  return folded === "" ? null : folded;
}

/**
 * Strips the brackets a URL parser puts around an IPv6 literal.
 *
 * The brackets belong to the URL grammar, not to the address. A socket layer
 * given `[::1]` does not recognise it as an IP literal and tries to RESOLVE it,
 * which is both a failure and -- worse -- a name lookup the caller did not
 * intend to perform.
 *
 * Moved here from `@liberty/media-inspection/src/egress.ts`, which still
 * re-exports it so no consumer's import path changed. It lived there to keep the
 * dependency between `egress.ts` and `pin.ts` pointing one way; a leaf package
 * that neither of them can import back is a stronger version of the same
 * guarantee.
 */
export function bareAddress(address: string): string {
  return address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
}

/**
 * The bracketed spelling of an address, which is the spelling `classifyHost`
 * requires.
 *
 * THE BRACKETS ARE LOAD BEARING AND THIS IS THE INVERSE OF `bareAddress`, not a
 * formatting nicety. `classifyHost` is written for URL hostnames, where
 * `new URL()` has already wrapped every IPv6 literal in brackets, and it
 * dispatches on that leading `[`. A bare `fe80::1` handed to it falls through
 * every IPv4 branch and every name branch and comes back `"public"` -- so
 * link-local answers would pass a private-range check. A RESOLVER returns bare
 * addresses. Anything on the resolve-then-classify path therefore has to bracket
 * first, and `classifyResolvedAddress` is the function that does.
 *
 * A host that is already bracketed is left alone, and one with no colon in it
 * (every IPv4 spelling) is left alone, so this is safe to apply to a mixed
 * answer set.
 */
export function bracketedLiteral(address: string): string {
  return address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;
}
