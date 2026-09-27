import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  ARTWORK_EXTENSIONS,
  ARTWORK_MEDIA_TYPES,
  ARTWORK_ROUTE_PREFIX,
  ARTWORK_STORE_ENV_VAR,
  artworkCandidates,
  artworkPathFor,
  identifyArtworkBytes,
  resolveArtworkStore
} from "./store";

/**
 * The artwork boundary's policy (PW-0302).
 *
 * Every assertion here is reachable without a filesystem and without touching
 * `process.env`, which is the reason the policy is a separate module from the
 * route at all.
 */

describe("the store must be configured, and absolutely", () => {
  it("reports an unset variable as a distinct state from a bad one", () => {
    expect(resolveArtworkStore(undefined)).toEqual({ ok: false, reason: "not_configured" });
    expect(resolveArtworkStore("")).toEqual({ ok: false, reason: "not_configured" });
    expect(resolveArtworkStore("   ")).toEqual({ ok: false, reason: "not_configured" });
    expect(resolveArtworkStore("artwork")).toEqual({ ok: false, reason: "not_absolute" });
    expect(resolveArtworkStore("./artwork")).toEqual({ ok: false, reason: "not_absolute" });
    expect(resolveArtworkStore("../artwork")).toEqual({ ok: false, reason: "not_absolute" });
  });

  it("accepts the absolute spellings this product actually runs under", () => {
    /*
     * POSIX for the container and the hosted build, drive-absolute for the
     * commander's Windows PC, UNC for an operator serving artwork off a share.
     * A relative path is refused rather than resolved because `next dev`, a
     * standalone `next start` and the desktop sidecar each run from a different
     * working directory -- the same setting would name three different places.
     */
    expect(resolveArtworkStore("/srv/liberty/artwork")).toEqual({
      ok: true,
      directory: "/srv/liberty/artwork"
    });
    expect(resolveArtworkStore("D:\\project-liberty\\artwork")).toEqual({
      ok: true,
      directory: "D:\\project-liberty\\artwork"
    });
    expect(resolveArtworkStore("C:/liberty/artwork").ok).toBe(true);
    expect(resolveArtworkStore("\\\\assets\\liberty\\artwork").ok).toBe(true);
  });

  it("trims, because an environment variable set from a shell often has a newline", () => {
    expect(resolveArtworkStore(" /srv/artwork\n")).toEqual({ ok: true, directory: "/srv/artwork" });
  });
});

describe("a reference becomes a path inside the store and nowhere else", () => {
  it("builds one candidate per allowed extension", () => {
    const candidates = artworkCandidates("/srv/artwork", "aurora-fall-poster");
    expect(candidates?.map((candidate) => candidate.path)).toEqual(
      ARTWORK_EXTENSIONS.map((extension) => `/srv/artwork/aurora-fall-poster.${extension}`)
    );
  });

  it("does not double a separator the operator already typed", () => {
    expect(artworkCandidates("/srv/artwork/", "x")?.[0]?.path).toBe("/srv/artwork/x.avif");
    expect(artworkCandidates("D:\\art\\", "x")?.[0]?.path).toBe("D:\\art\\x.avif");
  });

  it("refuses to build any path at all for a reference that is not a reference", () => {
    /*
     * The traversal cases are the point. They do not escape because the
     * character class has no `/`, `\`, `.` or `%` in it -- so this is a property
     * of what a reference IS, not of a check performed on one. The assertion is
     * that the function refuses rather than sanitises: a sanitiser is a thing
     * that can be wrong, and there is nothing here to be wrong about.
     */
    for (const hostile of [
      "../../etc/passwd",
      "..",
      "a/b",
      "a\\b",
      "a%2fb",
      "a.png",
      "https://x.example/p.jpg",
      "",
      "A"
    ]) {
      expect(artworkCandidates("/srv/artwork", hostile), hostile).toBeNull();
      expect(artworkPathFor(hostile), hostile).toBeNull();
    }
  });

  it("emits a relative same-origin path for a valid reference", () => {
    const path = artworkPathFor("aurora-fall-poster");
    expect(path).toBe("/api/v1/artwork/aurora-fall-poster");
    expect(path?.startsWith(ARTWORK_ROUTE_PREFIX)).toBe(true);
    // No scheme and no authority: a relative path resolves against the
    // document's own origin, so the result cannot name a host.
    expect(path).not.toMatch(/^[a-zA-Z][a-zA-Z0-9+.-]*:/);
    expect(path?.startsWith("//")).toBe(false);
  });
});

describe("the served format is read from the bytes, not from the name", () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  const ascii = (text: string): number[] => [...text].map((character) => character.charCodeAt(0));
  const webp = Uint8Array.from([...ascii("RIFF"), 1, 2, 3, 4, ...ascii("WEBP")]);
  const avif = Uint8Array.from([0, 0, 0, 0x20, ...ascii("ftyp"), ...ascii("avif")]);
  const avis = Uint8Array.from([0, 0, 0, 0x20, ...ascii("ftyp"), ...ascii("avis")]);

  it("identifies the four formats the boundary serves", () => {
    expect(identifyArtworkBytes(png)).toBe("image/png");
    expect(identifyArtworkBytes(jpeg)).toBe("image/jpeg");
    expect(identifyArtworkBytes(webp)).toBe("image/webp");
    expect(identifyArtworkBytes(avif)).toBe("image/avif");
    expect(identifyArtworkBytes(avis)).toBe("image/avif");
  });

  it("refuses an SVG, which is a document and not a raster image", () => {
    /*
     * The single most important negative case in this file. An SVG can carry
     * script and external references; serving one from this origin would be a
     * stored-XSS surface on the product's own domain. It is excluded by the
     * media-type allowlist AND by this identification, so naming a file
     * `poster.png` does not get it served.
     */
    expect(identifyArtworkBytes(Uint8Array.from(ascii('<svg onload="alert(1)">')))).toBeNull();
    expect(identifyArtworkBytes(Uint8Array.from(ascii("<?xml version=\"1.0\"?><svg/>")))).toBeNull();
  });

  it("refuses HTML, a PDF, an ELF binary and empty bytes", () => {
    expect(identifyArtworkBytes(Uint8Array.from(ascii("<!DOCTYPE html>")))).toBeNull();
    expect(identifyArtworkBytes(Uint8Array.from(ascii("%PDF-1.7")))).toBeNull();
    expect(identifyArtworkBytes(Uint8Array.from([0x7f, ...ascii("ELF")]))).toBeNull();
    expect(identifyArtworkBytes(new Uint8Array())).toBeNull();
  });

  it("does not read past the end of a truncated header", () => {
    // A one-byte file must answer null rather than throw: a truncated asset is
    // an operator's problem, not a 500 from an index out of range.
    for (let length = 0; length < 12; length += 1) {
      expect(() => identifyArtworkBytes(png.slice(0, length))).not.toThrow();
    }
  });

  it("maps both jpeg spellings to one media type, and names no vector format", () => {
    expect(ARTWORK_MEDIA_TYPES.jpg).toBe(ARTWORK_MEDIA_TYPES.jpeg);
    expect(Object.keys(ARTWORK_MEDIA_TYPES)).not.toContain("svg");
    expect(Object.values(ARTWORK_MEDIA_TYPES)).not.toContain("image/svg+xml");
  });
});

describe("this module decides the origin, and it is the only one that does", () => {
  it("contains no HTTP client, no URL construction and no host", () => {
    /*
     * "No arbitrary URL proxy" is satisfied by ABSENCE here rather than by a
     * check: there is nothing in this boundary that fetches an address, so there
     * is no address for a caller to influence. That is the property this rule
     * defends against a future edit that adds "just a small upstream fetch".
     */
    const source = readFileSync(new URL("./store.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");

    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/\bnew URL\b/);
    expect(source).not.toMatch(/\bhttps?:\/\//);
    expect(source).not.toMatch(/node:https?\b/);
    // Non-vacuity: the stripped source is still the module it claims to be.
    expect(source).toMatch(/artworkCandidates/);
    expect(source).toMatch(/ARTWORK_STORE_ENV_VAR/);
  });

  it("names exactly one environment variable", () => {
    expect(ARTWORK_STORE_ENV_VAR).toBe("LIBERTY_ARTWORK_STORE");
  });
});
