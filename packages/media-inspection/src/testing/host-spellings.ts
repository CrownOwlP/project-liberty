/* -------------------------------------------------------------------------
 * THE SHARED TABLE OF HOSTILE HOST SPELLINGS (PL-0709, register entry F12).
 *
 * NOTHING IN THIS FILE IS PRODUCTION CODE. It sits under `src/testing/` for the
 * reason stated at the top of `fixtures.ts`: a description of a shape that two
 * suites both need is kept in ONE place, because three copies of a table are
 * three tables that agree until somebody edits one.
 *
 * WHY A TABLE AND NOT A LIST OF ASSERTIONS. Project Liberty has two functions
 * that decide what a host IS:
 *
 *   - `classifyHost` in `@liberty/provider-sdk/src/stremio/url-policy.ts`, which
 *     answers "public / loopback / private / unparseable"; and
 *   - `hostOnAllowlist` in `../egress.ts`, which answers "named by the operator
 *     or not".
 *
 * They are separate on purpose -- `egress.ts` takes the classifier as an
 * injected port precisely so there is only one address-range classifier in the
 * repository -- but BOTH have to agree on the prior question of which string
 * names which host, and until PL-0709 they did not. PL-0702's F7 taught
 * `classifyHost` to fold the DNS root label; `hostOnAllowlist` still compared
 * the hostname as given, so `cdn.example.test.` classified as one host and
 * matched the allowlist as a different one.
 *
 * That disagreement FAILED CLOSED -- the dotted spelling was refused, never
 * admitted -- which is why F12 is Informational and why the fix must not be
 * mistaken for closing a bypass. It is written down because two classifiers
 * disagreeing about what a host is will eventually be reconciled by somebody
 * copying the wrong one, and the copy that gets it wrong in the admitting
 * direction is F7 again.
 *
 * So the table is the contract, and `egress.root-label.test.ts` drives BOTH
 * functions from it. A future divergence is then a failing test rather than a
 * finding in the next review, which is the whole of what PL-0709 buys.
 *
 * MERGING THE TWO FUNCTIONS IS OUT OF SCOPE and belongs to PL-0710. This table
 * is deliberately the cheap half: it pins the agreement without deciding where
 * the single implementation should eventually live.
 * ---------------------------------------------------------------------- */

/**
 * One hostname spelling, and the name it denotes.
 *
 * `spelling` is written the way `new URL().hostname` produces it, because that
 * is the only way either function is ever called in production: bracketed IPv6,
 * normalised IPv4, and a domain that KEEPS its trailing dot (`new URL(
 * "https://metadata.google.internal./").hostname` is `"metadata.google.internal."`
 * -- an IP literal is normalised, a name is not, which is exactly why F7 and F12
 * went unnoticed).
 *
 * `canonical` is the same name with the DNS root label folded away, or `null`
 * when the spelling names no host at all. `null` is the fail-closed half of the
 * contract and the reason this is a table of two columns rather than a list of
 * strings: both functions must REFUSE those, and neither may repair them into
 * something that matches.
 */
export interface HostSpelling {
  readonly spelling: string;
  readonly canonical: string | null;
  readonly why: string;
}

/**
 * Spellings both classifiers must agree about.
 *
 * Every entry whose `canonical` differs from its `spelling` is a case where the
 * two functions used to disagree. Every entry with `canonical: null` is a case
 * where the correct answer is a refusal from both, and where "repair it into a
 * usable name" is the tempting wrong fix -- inventing a name on a caller's
 * behalf is how a comparison against a spelling becomes a comparison against a
 * spelling the caller never wrote.
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
    why: "An IPv4 literal, which the URL parser has ALREADY normalised -- `127.0.0.1.` never reaches either function. Present so the fix is shown not to disturb the literals."
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
