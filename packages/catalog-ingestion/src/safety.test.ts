import { describe, expect, it } from "vitest";
import { FIXTURE_RIGHTS_REFERENCE, isOpaqueRightsReference } from "@liberty/provider-sdk";
import { checkRightsBasis, findMediaAddresses } from "./safety";
import type { IngestedWork } from "./record";

const work = (over: Partial<IngestedWork> = {}): IngestedWork => ({
  contentId: "example-source-a1",
  kind: "movie",
  titles: [{ locale: "en", value: "A Work" }],
  synopses: [],
  genres: [{ locale: "en", value: "Drama" }],
  releaseYear: 2024,
  runtimeMinutes: 100,
  episodeCount: null,
  availability: [],
  artwork: [],
  rights: { category: "public-domain", reference: null },
  ...over
});

describe("findMediaAddresses", () => {
  it("passes a payload with nothing address-shaped in it", () => {
    expect(
      findMediaAddresses({
        contentId: "example-source-a1",
        titles: [{ locale: "en", value: "Season 1: The Return" }],
        synopses: [{ locale: "en", value: "A crew returns home. Filmed in Reykjavik." }],
        releaseYear: 2024
      })
    ).toEqual([]);
  });

  /*
   * WHAT THIS CATCHES: the first and most direct way invariant 1 fails on this
   * path -- a provider handing back a playable address inside a catalog payload.
   * A catalog record says a work exists; the moment it can also say where to
   * fetch it, catalog metadata and playback resolution have stopped being
   * different boundaries.
   */
  it("finds an absolute media address by its value", () => {
    const findings = findMediaAddresses({
      title: "A Work",
      extra: "https://cdn.example.test/a/master.m3u8"
    });
    expect(findings).toEqual([{ path: "extra", kind: "address_value" }]);
  });

  /*
   * WHAT THIS CATCHES: a key-shaped hole. A provider that sends `{"streamUrl":
   * ""}` today sends a populated one tomorrow, and a scan that only looked at
   * values would pass the first -- after which somebody builds plumbing around a
   * field that is about to start carrying an address.
   */
  it("finds an address-shaped key even when its value is empty", () => {
    expect(findMediaAddresses({ streamUrl: "" })).toEqual([
      { path: "streamUrl", kind: "address_key" }
    ]);
    expect(findMediaAddresses({ stream_url: "" })).toEqual([
      { path: "stream_url", kind: "address_key" }
    ]);
    expect(findMediaAddresses({ playbackURL: "" })).toEqual([
      { path: "playbackURL", kind: "address_key" }
    ]);
  });

  /*
   * WHAT THIS CATCHES: the two address shapes a `new URL()`-based check misses
   * entirely. A protocol-relative reference has no scheme, and a bare
   * host-with-path is rejected by the URL parser -- and both are fetched
   * perfectly happily by a browser and by most HTTP clients.
   */
  it("finds protocol-relative and bare-host addresses, which have no scheme", () => {
    expect(findMediaAddresses({ a: "//cdn.example.test/x.m3u8" })).toEqual([
      { path: "a", kind: "address_value" }
    ]);
    expect(findMediaAddresses({ b: "cdn.example.test/x.m3u8" })).toEqual([
      { path: "b", kind: "address_value" }
    ]);
  });

  it("finds non-http schemes, which are the arbitrary-read primitives", () => {
    for (const value of ["file:///etc/passwd", "data:text/plain;base64,AA", "magnet:?xt=urn:btih:x"]) {
      expect(findMediaAddresses({ v: value }), value).toHaveLength(1);
    }
  });

  it("reports the path to a nested finding", () => {
    expect(
      findMediaAddresses({ images: [{ role: "poster", src: "https://img.example.test/1.jpg" }] })
    ).toEqual([
      { path: "images.0.src", kind: "address_key" },
      { path: "images.0.src", kind: "address_value" }
    ]);
  });

  /*
   * WHAT THIS CATCHES: an unbounded recursion reachable from a provider
   * response. `JSON.parse` cannot produce a cycle, but this function is exported
   * and takes `unknown`, and a stack overflow triggered by an input is the same
   * class of defect as an unbounded body.
   */
  it("terminates on a cyclic value", () => {
    const cyclic: Record<string, unknown> = { title: "A Work" };
    cyclic["self"] = cyclic;
    expect(() => findMediaAddresses(cyclic)).not.toThrow();
  });

  /*
   * WHAT THIS CATCHES: an over-broad scheme test. A colon followed by a space is
   * prose, and a great many real titles contain one. A check that refused every
   * string with a colon would refuse a large fraction of a real catalog, and the
   * remedy an operator would reach for is turning the check off.
   */
  it("does not mistake a title with a colon for a scheme", () => {
    expect(findMediaAddresses({ title: "Blade Runner: The Final Cut" })).toEqual([]);
    expect(findMediaAddresses({ title: "Chapter 4: Home" })).toEqual([]);
  });
});

describe("checkRightsBasis", () => {
  it("accepts a work whose source declared a basis with no register entry", () => {
    const checked = checkRightsBasis(work());
    expect(checked).toEqual({ ok: true, basis: { category: "public-domain", reference: null } });
  });

  it("accepts an opaque register reference", () => {
    expect(isOpaqueRightsReference(FIXTURE_RIGHTS_REFERENCE)).toBe(true);
    const checked = checkRightsBasis(
      work({ rights: { category: "licensed", reference: FIXTURE_RIGHTS_REFERENCE } })
    );
    expect(checked.ok).toBe(true);
  });

  /*
   * WHAT THIS CATCHES: "undeclared" being read as permission. `rights: null`
   * means nobody established a basis; the work's own category field is forced by
   * the contract to hold one of three values whether or not anybody checked, so
   * reading it as a fallback would convert every quiet record into a cleared one.
   */
  it("refuses a work whose source declared no basis", () => {
    expect(checkRightsBasis(work({ rights: null }))).toEqual({
      ok: false,
      reason: "rights_basis_not_declared"
    });
  });

  /*
   * WHAT THIS CATCHES: an agreement being smuggled into the reference field.
   * `docs/CONTENT_RIGHTS.md` keeps the agreements themselves out of this
   * repository, so no counterparty, term date, licence body or URL may appear in
   * one. The rule is `@liberty/provider-sdk`'s and is imported, never restated --
   * if a second spelling of it ever appears in this package, this test still
   * passes, so the guard against that is the import itself and the assertion
   * below that the SDK's own predicate agrees.
   */
  it("refuses a reference that is not opaque", () => {
    for (const reference of [
      "Warner Bros. master agreement 2026",
      "https://rights.example.test/contract/1",
      "expires 2027-01-01"
    ]) {
      expect(isOpaqueRightsReference(reference), reference).toBe(false);
      expect(checkRightsBasis(work({ rights: { category: "licensed", reference } })), reference).toEqual(
        { ok: false, reason: "rights_basis_reference_not_opaque" }
      );
    }
  });

  /*
   * WHAT THIS CATCHES: artwork licensing being checked less carefully than the
   * work's. An image is the one thing in a catalog record that is itself a copy
   * of somebody else's file, and its basis is a SEPARATE agreement from the
   * work's -- so the work being cleared says nothing about the poster.
   */
  it("checks artwork's own rights reference, separately from the work's", () => {
    const checked = checkRightsBasis(
      work({
        rights: { category: "licensed", reference: FIXTURE_RIGHTS_REFERENCE },
        artwork: [
          {
            role: "poster",
            assetRef: "poster-a1",
            rights: { category: "licensed", reference: "Getty invoice 12345" }
          }
        ]
      })
    );
    expect(checked).toEqual({ ok: false, reason: "artwork_rights_reference_not_opaque" });
  });
});
