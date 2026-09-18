import { describe, expect, it } from "vitest";
/*
 * THE REAL PROVIDER-SDK CLASSIFIER, IMPORTED HERE ON PURPOSE, AND ONLY HERE.
 *
 * This is the one file in `@liberty/media-inspection` that reaches outside the
 * package, and the reach is the point: PL-0709 asks for a test that FAILS when
 * the two classifiers diverge, and a test that compares `hostOnAllowlist`
 * against a local restatement of what `classifyHost` does would go green on the
 * day somebody edits the real one. Divergence is only observable by holding both
 * real implementations at once.
 *
 * It is a TEST-ONLY, TYPE-LEVEL-AND-RUNTIME import of a single self-contained
 * module (`url-policy.ts` imports nothing at all), and it deliberately does NOT
 * become a package dependency:
 *
 *   - No entry is added to `package.json`. `@liberty/provider-sdk` is not a
 *     dependency of this package and MUST NOT BECOME ONE: PL-0710 has provider-sdk
 *     adopting THIS package's `authoriseFetchTarget`, so a declared edge in this
 *     direction would be half of a workspace cycle the moment that lands.
 *   - Nothing under `src/` outside this file imports it, so the production graph
 *     is unchanged and the injected-`HostClassifier`-port design in `egress.ts`
 *     is untouched. `testing/fixtures.ts` keeps its crude `testClassifyHost` for
 *     every other suite, for the reason stated there.
 *
 * `url-policy.ts` is declared as PL-0709's `reviewDependency` in
 * `control/tasks.json` -- read, fingerprinted for review, never written.
 */
import { classifyHost, type HostClass } from "../../provider-sdk/src/stremio/url-policy";
import { checkUrlStatically, hostOnAllowlist, type EgressPolicy } from "./egress";
import { HOSTILE_HOST_SPELLINGS } from "./testing/host-spellings";

/**
 * PL-0709 / register entry F12 in `docs/SECURITY_REVIEW_PROVIDER_URL.md`.
 *
 * "packages/media-inspection/src/egress.ts classifies a fully qualified name the
 * same as its dotless spelling, matching the fix PL-0702 made in
 * packages/provider-sdk/src/stremio/url-policy.ts ... a test asserts the two
 * classifiers agree on a shared table of hostile spellings, so the next
 * divergence fails a test rather than waiting for a review; and the fail-closed
 * behaviour is preserved and asserted, because making this path agree with the
 * other one must not make it permissive."
 *
 * Three groups below, in that order: agreement, and then the two directions in
 * which agreement could have been bought too cheaply -- by repairing a name that
 * names nothing, or by admitting a host nobody put on the list.
 */

const REAL_CLASSIFIER_POLICY: EgressPolicy = {
  allowedHosts: ["cdn.example.test", ".cdn.example.test", "metadata.google.internal", "localhost"],
  allowLoopback: false,
  localDeployment: false
};

describe("the two classifiers agree on what a host is", () => {
  /*
   * The provider-sdk half. This is PL-0702's F7 fix restated against the SHARED
   * table rather than against a list private to that package's suite, so that
   * adding a spelling here obliges both functions to answer for it.
   */
  describe("classifyHost folds the root label", () => {
    it.each(HOSTILE_HOST_SPELLINGS.filter((entry) => entry.canonical !== null))(
      "classifies $spelling exactly as $canonical",
      ({ spelling, canonical }) => {
        const canonicalClass: HostClass = classifyHost(canonical as string);
        expect(classifyHost(spelling)).toBe(canonicalClass);
        expect(canonicalClass).not.toBe("unparseable");
      }
    );

    it.each(HOSTILE_HOST_SPELLINGS.filter((entry) => entry.canonical === null))(
      "refuses $spelling rather than repairing it",
      ({ spelling }) => {
        expect(classifyHost(spelling)).toBe("unparseable");
      }
    );
  });

  /*
   * The media-inspection half, and the defect PL-0709 exists to close.
   *
   * Each case is asserted from BOTH sides -- the hostile spelling against a
   * canonical entry, and the canonical spelling against a hostile entry -- because
   * an operator writes the allowlist by hand and a trailing dot is as easy to
   * type in a configuration file as it is in a URL. Before the fix the first
   * direction returned false for every dotted spelling.
   */
  describe("hostOnAllowlist folds the root label", () => {
    it.each(HOSTILE_HOST_SPELLINGS.filter((entry) => entry.canonical !== null))(
      "matches $spelling against $canonical in either position",
      ({ spelling, canonical }) => {
        expect(hostOnAllowlist(spelling, [canonical as string])).toBe(true);
        expect(hostOnAllowlist(canonical as string, [spelling])).toBe(true);
        expect(hostOnAllowlist(spelling, [spelling])).toBe(true);
      }
    );
  });

  /*
   * Agreement where it is actually consumed. `checkUrlStatically` asks the
   * classifier first and the allowlist second, so a host the two disagreed about
   * got a refusal whose REASON was wrong -- `metadata.google.internal.` is
   * private, not "unlisted", and an operator reading the second reason would add
   * it to the allowlist and still be refused.
   */
  it("gives the fully qualified and the dotless URL the same verdict and the same reason", () => {
    const outcome = (raw: string): string => {
      const verdict = checkUrlStatically(raw, REAL_CLASSIFIER_POLICY, classifyHost);
      return verdict.ok ? `ok:${verdict.hostClass}` : verdict.reason;
    };

    expect(outcome("https://cdn.example.test./master.m3u8")).toBe(outcome("https://cdn.example.test/master.m3u8"));
    expect(outcome("https://cdn.example.test./master.m3u8")).toBe("ok:public");

    expect(outcome("https://edge.cdn.example.test./master.m3u8")).toBe(
      outcome("https://edge.cdn.example.test/master.m3u8")
    );

    // Private and loopback are decided BEFORE the allowlist, so these two agree
    // for a different reason -- and the point of asserting them is that they
    // must keep agreeing for that reason and not start agreeing on "unlisted".
    expect(outcome("https://metadata.google.internal./computeMetadata/v1/")).toBe("url_host_private_literal");
    expect(outcome("http://localhost./library/master.m3u8")).toBe("url_loopback_not_permitted");
  });
});

describe("the agreement is not bought by repairing a name", () => {
  /*
   * THE FAIL-CLOSED HALF, first direction. A spelling with an empty label names
   * no host. `classifyHost` answers "unparseable" and `checkUrlStatically`
   * refuses it before the allowlist is reached; `hostOnAllowlist` must not
   * disagree by folding until the string becomes something that matches.
   */
  it.each(HOSTILE_HOST_SPELLINGS.filter((entry) => entry.canonical === null))(
    "refuses $spelling as a hostname whatever is on the list",
    ({ spelling }) => {
      expect(hostOnAllowlist(spelling, [spelling])).toBe(false);
      expect(hostOnAllowlist(spelling, ["cdn.example.test", ".cdn.example.test", "localhost"])).toBe(false);
    }
  );

  it.each(HOSTILE_HOST_SPELLINGS.filter((entry) => entry.canonical === null))(
    "skips $spelling as an allowlist ENTRY rather than letting it match anything",
    ({ spelling }) => {
      expect(hostOnAllowlist("anything.test", [spelling])).toBe(false);
      expect(hostOnAllowlist("cdn.example.test", [spelling])).toBe(false);
      expect(hostOnAllowlist("cdn.example.test.", [spelling])).toBe(false);
      // The one that would hurt: an entry that folded to "" or to "." would be
      // the empty suffix, and the empty suffix is every host on the internet.
      expect(hostOnAllowlist("evil.test", [spelling])).toBe(false);
    }
  );

  it("refuses an unparseable spelling at the gate, never at the allowlist", () => {
    const verdict = checkUrlStatically(
      "https://cdn.example.test../master.m3u8",
      REAL_CLASSIFIER_POLICY,
      classifyHost
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("url_host_unparseable");
  });
});

describe("the agreement is not bought by widening the allowlist", () => {
  /*
   * THE FAIL-CLOSED HALF, second direction, and the one PL-0709's acceptance
   * calls out by name: "making this path agree with the other one must not make
   * it permissive". Folding the root label admits exactly one thing that was
   * refused before -- ANOTHER SPELLING OF A NAME THE OPERATOR ALREADY WROTE
   * DOWN. Everything below was refused before the fix and must still be.
   */
  it("still fetches nothing at all when the allowlist is empty", () => {
    for (const { spelling } of HOSTILE_HOST_SPELLINGS) {
      expect(hostOnAllowlist(spelling, [])).toBe(false);
      expect(hostOnAllowlist(spelling, ["", "   ", "."])).toBe(false);
    }
  });

  it("still refuses a host that is not on the list, in either spelling", () => {
    expect(hostOnAllowlist("evil.test.", ["cdn.example.test"])).toBe(false);
    expect(hostOnAllowlist("evil.test", ["cdn.example.test."])).toBe(false);
  });

  it("still requires the leading dot for a subdomain, and still refuses the prefix trick", () => {
    // A suffix entry matches a strict subdomain and not the parent -- unchanged,
    // and now unchanged for the dotted spelling too.
    expect(hostOnAllowlist("edge.cdn.example.test.", [".cdn.example.test"])).toBe(true);
    expect(hostOnAllowlist("cdn.example.test.", [".cdn.example.test"])).toBe(false);
    // The bypass the leading dot exists to close, wearing a root label.
    expect(hostOnAllowlist("evilcdn.example.test.", [".cdn.example.test"])).toBe(false);
    expect(hostOnAllowlist("evil-cdn.example.test.", ["cdn.example.test"])).toBe(false);
  });

  it("still refuses an attacker-controlled name that merely CONTAINS a listed one", () => {
    expect(hostOnAllowlist("cdn.example.test.evil.test", ["cdn.example.test"])).toBe(false);
    expect(hostOnAllowlist("cdn.example.test.evil.test.", ["cdn.example.test"])).toBe(false);
    expect(hostOnAllowlist("cdn.example.test.evil.test.", [".cdn.example.test"])).toBe(false);
  });

  it("still leaves every other control in front of and behind the allowlist", () => {
    // Being on the allowlist has never been sufficient. A fully qualified
    // loopback name reaches the two-key rule instead of skipping it, and a
    // fully qualified private name never reaches the allowlist at all.
    const loopbackListed: EgressPolicy = { ...REAL_CLASSIFIER_POLICY, allowedHosts: ["localhost"] };
    const refused = checkUrlStatically("http://localhost./library/x.m3u8", loopbackListed, classifyHost);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("url_loopback_not_permitted");

    const metadataListed: EgressPolicy = {
      ...REAL_CLASSIFIER_POLICY,
      allowedHosts: ["metadata.google.internal"]
    };
    const stillPrivate = checkUrlStatically(
      "https://metadata.google.internal./computeMetadata/v1/",
      metadataListed,
      classifyHost
    );
    expect(stillPrivate.ok).toBe(false);
    if (!stillPrivate.ok) expect(stillPrivate.reason).toBe("url_host_private_literal");

    // And plaintext to a remote host is still refused with the host on the list.
    const plaintext = checkUrlStatically("http://cdn.example.test./x.m3u8", REAL_CLASSIFIER_POLICY, classifyHost);
    expect(plaintext.ok).toBe(false);
    if (!plaintext.ok) expect(plaintext.reason).toBe("url_plaintext_http_not_loopback");
  });
});
