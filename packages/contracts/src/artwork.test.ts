import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  ARTWORK_ASSET_REF_PATTERN,
  artworkAssetRefSchema,
  artworkForRole,
  artworkListSchema,
  artworkReferenceSchema,
  artworkRoleSchema,
  type ArtworkReference
} from "./shared/artwork";
import { catalogItemSchema } from "./domains/catalog";
import { titleDetailSchema } from "./domains/title";

/**
 * The artwork vocabulary (PW-0302).
 *
 * THE CENTRAL PROPERTY THIS SUITE DEFENDS IS AN ABSENCE: there is no field
 * anywhere in this vocabulary through which an image address can travel, and no
 * string that matches `ARTWORK_ASSET_REF_PATTERN` is one. An absence is the kind
 * of property that a well-meaning later edit removes, so it is asserted as a
 * rule over the module's own source as well as over its behaviour -- the pattern
 * `module-boundary.test.ts` uses in this package.
 */

const POSTER: ArtworkReference = {
  role: "poster",
  assetRef: "aurora-fall-poster",
  width: 400,
  height: 600,
  rights: "owned"
};

describe("an asset reference cannot be an address", () => {
  /*
   * Each of these is a real way an image address gets into a payload, and every
   * one of them has to fail on SHAPE rather than on a blocklist of hosts. The
   * two data URLs and the protocol-relative form are the cases a naive
   * "must not start with http" check lets through.
   */
  const addresses = [
    "https://images.example.com/poster.jpg",
    "http://images.example.com/poster.jpg",
    "//images.example.com/poster.jpg",
    "data:image/png;base64,iVBORw0KGgo=",
    "DATA:image/svg+xml,<svg onload=alert(1)>",
    "file:///etc/passwd",
    "/etc/passwd",
    "../../etc/passwd",
    "..%2f..%2fetc%2fpasswd",
    "images.example.com/poster.jpg",
    "poster.png",
    "C:\\windows\\system32\\config\\sam"
  ];

  for (const address of addresses) {
    it(`refuses ${JSON.stringify(address)}`, () => {
      expect(artworkAssetRefSchema.safeParse(address).success).toBe(false);
      expect(ARTWORK_ASSET_REF_PATTERN.test(address)).toBe(false);
    });
  }

  it("accepts the opaque tokens an operator's store actually uses", () => {
    for (const reference of ["poster", "aurora-fall-poster", "a1", "9", "x-y-z-1-2"]) {
      expect(artworkAssetRefSchema.safeParse(reference).success).toBe(true);
    }
  });

  it("refuses the shapes that are neither an address nor a token", () => {
    /*
     * Leading, trailing and doubled hyphens, uppercase, whitespace and the empty
     * string. Uppercase matters beyond tidiness: two references differing only
     * by case would resolve to ONE file on a case-insensitive filesystem, which
     * is most Windows installations of this product.
     */
    for (const reference of ["-a", "a-", "a--b", "Aurora", "a b", "", "a_b", "a.b"]) {
      expect(artworkAssetRefSchema.safeParse(reference).success).toBe(false);
    }
  });

  it("says what a reference is when it refuses one", () => {
    const refusal = artworkAssetRefSchema.safeParse("https://example.com/a.jpg");
    expect(refusal.success).toBe(false);
    if (!refusal.success) {
      expect(refusal.error.issues[0]?.message).toContain("opaque");
    }
  });
});

describe("the module has nowhere to put an address", () => {
  it("declares no url, uri, src, href or origin field", () => {
    const source = readFileSync(new URL("./shared/artwork.ts", import.meta.url), "utf8")
      // The prose in that module names every one of these words in order to
      // forbid them. A rule its own explanation fails is not a rule.
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");

    expect(source).not.toMatch(/\b(url|uri|src|href|origin|endpoint|cdn|host)\s*:/i);
    // Non-vacuity: the stripped source still contains the fields that DO exist.
    expect(source).toMatch(/\bassetRef\s*:/);
    expect(source).toMatch(/\bwidth\s*:/);
  });
});

describe("a reference states a basis, and a size", () => {
  it("accepts a complete reference", () => {
    expect(artworkReferenceSchema.parse(POSTER)).toEqual(POSTER);
  });

  it("refuses an artwork entry with no rights basis", () => {
    /*
     * The one field in this vocabulary that may not be absent and may not be
     * null. `titleRightsBasisSchema` is nullable because a detail surface must
     * be able to say "nobody has declared a basis for this work"; an IMAGE with
     * no declared basis that reached a page would be somebody else's file served
     * from our origin, so the undeclared case is not expressible here.
     */
    const { rights: _dropped, ...withoutRights } = POSTER;
    expect(artworkReferenceSchema.safeParse(withoutRights).success).toBe(false);
    expect(artworkReferenceSchema.safeParse({ ...POSTER, rights: null }).success).toBe(false);
  });

  it("refuses a reference that cannot state its own size", () => {
    const { width: _w, ...withoutWidth } = POSTER;
    expect(artworkReferenceSchema.safeParse(withoutWidth).success).toBe(false);
    for (const bad of [0, -1, 1.5, Number.NaN, "400"]) {
      expect(artworkReferenceSchema.safeParse({ ...POSTER, width: bad }).success).toBe(false);
      expect(artworkReferenceSchema.safeParse({ ...POSTER, height: bad }).success).toBe(false);
    }
  });

  it("refuses a role nothing renders", () => {
    expect(artworkRoleSchema.safeParse("logo").success).toBe(false);
    expect(artworkReferenceSchema.safeParse({ ...POSTER, role: "thumbnail" }).success).toBe(false);
  });

  it("refuses a rights value outside the shared vocabulary", () => {
    expect(artworkReferenceSchema.safeParse({ ...POSTER, rights: "fair-use" }).success).toBe(false);
  });
});

describe("the three states of an artwork list", () => {
  it("distinguishes absent from empty", () => {
    expect(artworkListSchema.parse(undefined)).toBeUndefined();
    expect(artworkListSchema.parse([])).toEqual([]);
  });

  it("refuses null, which would be a fourth state meaning the same as two others", () => {
    expect(artworkListSchema.safeParse(null).success).toBe(false);
  });

  it("answers null for a role nothing carries, on every state", () => {
    expect(artworkForRole(undefined, "poster")).toBeNull();
    expect(artworkForRole([], "poster")).toBeNull();
    expect(artworkForRole([POSTER], "backdrop")).toBeNull();
  });

  it("takes the FIRST reference of a role, because order is the producer's preference", () => {
    const second: ArtworkReference = { ...POSTER, assetRef: "second-poster" };
    expect(artworkForRole([POSTER, second], "poster")).toBe(POSTER);
    expect(artworkForRole([second, POSTER], "poster")).toBe(second);
  });

  it("skips roles it was not asked for rather than taking the first entry", () => {
    const backdrop: ArtworkReference = { ...POSTER, role: "backdrop", assetRef: "a-backdrop" };
    expect(artworkForRole([backdrop, POSTER], "poster")).toBe(POSTER);
  });
});

describe("both published shapes carry it, and neither requires it", () => {
  const item = {
    id: "aurora-fall",
    title: "Aurora Fall",
    kind: "movie" as const,
    rights: "owned" as const,
    genre: "Sci-fi",
    releaseYear: 2024,
    runtimeMinutes: 128,
    episodeCount: null
  };

  const detail = {
    id: "aurora-fall",
    title: "Aurora Fall",
    kind: "movie" as const,
    rights: "owned" as const,
    genre: "Sci-fi",
    releaseYear: 2024,
    synopsis: null,
    technical: { maxHeight: null, audioLanguages: null, subtitleLanguages: null },
    runtimeMinutes: 128
  };

  it("parses a catalog item that says nothing about artwork", () => {
    /*
     * The compatibility property the optional key exists for. Ten producers of
     * this type predate PW-0302 and none has an artwork concept; a required key
     * would have forced each of them to assert "this source looked and found
     * none", which is a claim none of them can support.
     */
    const parsed = catalogItemSchema.parse(item);
    expect(parsed.artwork).toBeUndefined();
  });

  it("parses a catalog item that carries artwork", () => {
    expect(catalogItemSchema.parse({ ...item, artwork: [POSTER] }).artwork).toEqual([POSTER]);
  });

  it("refuses a catalog item whose artwork is an address", () => {
    const smuggled = { ...item, artwork: [{ ...POSTER, assetRef: "https://x.example/p.jpg" }] };
    expect(catalogItemSchema.safeParse(smuggled).success).toBe(false);
  });

  it("parses a title detail with and without artwork", () => {
    expect(titleDetailSchema.parse(detail).artwork).toBeUndefined();
    expect(titleDetailSchema.parse({ ...detail, artwork: [POSTER] }).artwork).toEqual([POSTER]);
  });

  it("refuses a title detail whose artwork is an address", () => {
    const smuggled = { ...detail, artwork: [{ ...POSTER, assetRef: "//x.example/p.jpg" }] };
    expect(titleDetailSchema.safeParse(smuggled).success).toBe(false);
  });

  it("strips an unknown key rather than carrying it, so posterUrl cannot ride along", () => {
    /*
     * Zod's default is to strip. That is relied on rather than assumed here: the
     * assertion is that a `posterUrl` a provider invents does NOT survive
     * parsing into the published item, which is the property that made the
     * round-83 audit's objection ("this would put a URL in the one contract
     * whose header promises there is none") answerable at all.
     */
    const parsed = catalogItemSchema.parse({ ...item, posterUrl: "https://x.example/p.jpg" });
    expect(parsed).not.toHaveProperty("posterUrl");
  });
});
