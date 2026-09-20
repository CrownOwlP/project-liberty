import { canonicalHost } from "@liberty/net-policy/host";
import { classifyHost } from "@liberty/net-policy/classify";
import { HOSTILE_HOST_SPELLINGS } from "@liberty/net-policy/testing/host-spellings";
import { describe, expect, it } from "vitest";
import { checkUrlStatically, hostOnAllowlist, type EgressPolicy } from "./egress";

/* -------------------------------------------------------------------------
 * WHAT THIS FILE USED TO BE, AND WHY IT IS NOT THAT ANY MORE.
 *
 * PL-0709 wrote this suite as an AGREEMENT TEST between two implementations.
 * `classifyHost` lived in `@liberty/provider-sdk` and folded the DNS root label
 * (PL-0702, F7); `hostOnAllowlist` lived in `./egress.ts` and did not (F12). The
 * only way to observe a divergence between them was to hold both real functions
 * at once, and the only way to reach the real `classifyHost` from this package
 * was a DEEP RELATIVE IMPORT past a package boundary:
 *
 *     import { classifyHost } from "../../provider-sdk/src/stremio/url-policy";
 *
 * The reviewer accepted that import FOR THAT TEST ONLY AT THAT TREE and ruled it
 * was not an acceptable permanent boundary. It is gone. PL-0710 extracted the
 * canonicaliser and the classifier into `@liberty/net-policy`, a dependency leaf
 * that imports neither consumer, and both packages now call the same functions.
 *
 * AN AGREEMENT TEST BETWEEN TWO IMPLEMENTATIONS ASSERTS NOTHING ONCE THERE IS
 * ONE IMPLEMENTATION, so the half of this file that compared `classifyHost`
 * against the table is gone too -- it now lives in
 * `@liberty/net-policy/src/classify.test.ts`, driven from the same table, where
 * it tests the function rather than a coincidence. What is left here is the part
 * that was never about agreement:
 *
 *   1. `hostOnAllowlist` folds the root label. Still this package's function,
 *      still this package's behaviour to assert; it now folds by CALLING the
 *      shared canonicaliser, and this suite checks the outcome rather than the
 *      wiring. (`net-policy-boundary.test.ts` checks the wiring.)
 *   2. THE COMPOSITION. `checkUrlStatically` asks the classifier first and the
 *      allowlist second, and the two disagreeing produced a refusal with the
 *      WRONG REASON -- `metadata.google.internal.` is private, and being told it
 *      was "not on the allowlist" invites an operator to add it. The reason is
 *      this package's, so it is asserted here, against the real classifier.
 *   3. THE TWO WAYS AGREEMENT COULD HAVE BEEN BOUGHT TOO CHEAPLY: by repairing a
 *      name that names nothing, or by admitting a host nobody put on the list.
 *      PL-0709's acceptance called the second one out by name -- "making this
 *      path agree with the other one must not make it permissive" -- and it
 *      remains the thing to watch, because the merge PL-0710 performed is
 *      exactly the "somebody copies one of the two" event those assertions were
 *      written to survive.
 *
 * Every assertion below is a REFUSAL except where marked, so each group carries
 * a positive control: something that must still be ADMITTED. A permissiveness
 * suite that passes against a function returning `false` for everything is
 * worthless, and `hostOnAllowlist` returning `false` for everything is a
 * plausible way to break it.
 * ---------------------------------------------------------------------- */

/**
 * The policy every group below is driven against. `classifyHost` is the REAL
 * one, imported from the leaf package rather than approximated -- which is the
 * whole reason PL-0709 needed a deep import and the whole reason this file no
 * longer does.
 */
const REAL_CLASSIFIER_POLICY: EgressPolicy = {
  allowedHosts: ["cdn.example.test", ".cdn.example.test", "metadata.google.internal", "localhost"],
  allowLoopback: false,
  localDeployment: false
};

describe("this package's gate answers the shared table the same way", () => {
  /*
   * The defect PL-0709 exists to close, now asserted as this package's own
   * behaviour rather than as a comparison with another package's function.
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

    it("matches EXACTLY the spellings the shared canonicaliser calls a host", () => {
      /*
       * The replacement for the agreement test, and a stronger statement than
       * the one it replaces. The old version asserted that two functions gave
       * the same answer; this asserts that this package's allowlist admits a
       * spelling if and only if `@liberty/net-policy` says the spelling names a
       * host -- an iff, so it fails in BOTH directions. A `hostOnAllowlist` that
       * started refusing everything fails the first half; one that started
       * repairing `cdn.example.test..` fails the second.
       */
      for (const { spelling, canonical } of HOSTILE_HOST_SPELLINGS) {
        const namesAHost = canonicalHost(spelling) !== null;
        expect(namesAHost, spelling).toBe(canonical !== null);
        expect(hostOnAllowlist(spelling, [spelling]), spelling).toBe(namesAHost);
      }
    });

    it("still admits a plain listed host, which is the control for the iff above", () => {
      expect(hostOnAllowlist("cdn.example.test", ["cdn.example.test"])).toBe(true);
      expect(hostOnAllowlist("edge.cdn.example.test", [".cdn.example.test"])).toBe(true);
    });
  });

  /*
   * The composition, where the disagreement was actually consumed. `checkUrlStatically` asks the
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
