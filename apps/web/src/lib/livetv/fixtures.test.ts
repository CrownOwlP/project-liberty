/* -------------------------------------------------------------------------
 * The fixtures are obviously synthetic, and that is enforced rather than
 * promised (Wave 132, Worker E).
 *
 * `media/fixtures/livetv/README.md` claims every host is under `example.invalid`
 * and that nothing here is a real channel list. A claim in a README rots. This
 * file is the version that cannot.
 * ---------------------------------------------------------------------- */
import { describe, expect, it } from "vitest";

import { liveTvFixtureNames, readLiveTvFixture } from "./testing/fixtures";

const DOCUMENTS = ["authorized-synthetic.m3u", "hostile-synthetic.m3u", "unauthorized-origin.m3u", "synthetic-epg.xml", "hostile-doctype-epg.xml"];

describe("the fixture directory", () => {
  it("holds the documents the tests expect and a README that explains them", () => {
    const names = liveTvFixtureNames();
    expect(names).toContain("README.md");
    for (const document of DOCUMENTS) expect(names).toContain(document);
    /* Nothing undeclared: a file added here without a note is a file nobody
     * reviewed as a fixture. */
    expect([...names].sort()).toEqual([...DOCUMENTS, "README.md"].sort());
  });
});

describe("every host is unresolvable by construction", () => {
  it("uses only example.invalid and the RFC 5737 documentation addresses", () => {
    for (const name of DOCUMENTS) {
      const text = readLiveTvFixture(name);
      const hosts = [...text.matchAll(/[a-z][a-z0-9+.-]*:\/\/([^/\s"'<>]+)/gi)].map((match) =>
        (match[1] ?? "").toLowerCase()
      );
      for (const host of hosts) {
        /*
         * `.invalid` (RFC 6761) can never resolve, and the three TEST-NET blocks
         * (RFC 5737) are reserved for documentation and routed nowhere. One
         * fixture deliberately points at a literal address on an origin no
         * authorization declares, so that `playlist-validation.test.ts` can prove
         * it is refused; it is a documentation address rather than a private one,
         * because a private-range literal in a fixture is a thing somebody can
         * reach on their own network.
         */
        expect(host, `${name} names the host ${host}`).toMatch(
          /(?:(^|\.)example\.invalid|^192\.0\.2\.\d{1,3}|^198\.51\.100\.\d{1,3}|^203\.0\.113\.\d{1,3})(:\d+)?$/
        );
      }
    }
  });

  it("names no real broadcaster, CDN or public playlist index", () => {
    /*
     * A deny-list of the names a copied-from-the-internet playlist would carry.
     * `docs/LIVE_TV.md` is explicit that a third-party index is not permission
     * from anybody, so the fixtures must not even look like one.
     */
    for (const name of DOCUMENTS) {
      const text = readLiveTvFixture(name).toLowerCase();
      for (const forbidden of [
        "iptv-org",
        "github.io",
        "githubusercontent",
        ".m3u8?",
        "akamai",
        "cloudfront",
        "bbc",
        "cnn",
        "espn",
        "sky.",
        "rtmp://",
        "udp://"
      ]) {
        expect(text, `${name} must not mention ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("carries no token, key or credential-shaped value", () => {
    for (const name of DOCUMENTS) {
      const text = readLiveTvFixture(name);
      expect(text, name).not.toMatch(/\b(?:bearer|hdnts|hmac|apikey|api_key|password|secret)\b/i);
      /* An unbroken base64-looking RUN, which is what a signed-URL token looks
       * like. Path separators are not part of such a run, so `/` is deliberately
       * not in the class — with it in, every ordinary URL path matched. */
      expect(text, name).not.toMatch(/[A-Za-z0-9+]{32,}={0,2}/);
    }
  });
});

describe("the README states what they are", () => {
  it("says they are test input and not a channel list", () => {
    const readme = readLiveTvFixture("README.md");
    expect(readme).toContain("TEST INPUT ONLY");
    expect(readme).toContain("example.invalid");
    expect(readme).toContain("PL-0602");
  });
});
