import { readFile } from "node:fs/promises";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ArtworkReference } from "@liberty/contracts/shared/artwork";

import { nextConfigFor } from "../../../next.config";
import { ARTWORK_ROUTE_PREFIX } from "../../app/api/v1/artwork/store";
import { PosterArtwork } from "./poster-artwork";

/**
 * The only component in this product that renders an image (PW-0302).
 *
 * Rendered with `react-dom/server`, and rules asserted over source, for the
 * reasons `profile-ui.test.tsx` records: this workspace's vitest environment is
 * `node`, so there is no DOM and no effect runs. What a server render CAN see is
 * exactly what matters here -- the markup a reader's browser is handed.
 */

const POSTER: ArtworkReference = {
  role: "poster",
  assetRef: "aurora-fall-poster",
  width: 400,
  height: 600,
  rights: "owned"
};

async function componentSource(): Promise<string> {
  const raw = await readFile(new URL("./poster-artwork.tsx", import.meta.url), "utf8");
  /* This module's own prose names what it forbids; a rule its explanation fails
   * is not a rule. */
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("absent artwork is a designed state, not a broken one", () => {
  it("renders the gradient frame and no image at all", () => {
    /*
     * Byte-for-byte what every card rendered before PW-0302. A checkout with no
     * artwork store configured is therefore the previous design intact, rather
     * than a degraded version of this one.
     */
    const html = renderToStaticMarkup(<PosterArtwork artwork={undefined} />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("poster");
    expect(html).not.toContain("<img");
  });

  it("renders the same frame for an empty list and for a list with no poster", () => {
    const backdrop: ArtworkReference = { ...POSTER, role: "backdrop", assetRef: "a-backdrop" };
    expect(renderToStaticMarkup(<PosterArtwork artwork={[]} />)).not.toContain("<img");
    expect(renderToStaticMarkup(<PosterArtwork artwork={[backdrop]} />)).not.toContain("<img");
  });

  it("falls back rather than throwing for a reference that should not have parsed", () => {
    /*
     * Reachable only by casting an unvalidated object to the type -- a future
     * producer that constructs items without parsing. A malformed reference
     * costs a poster, never a page.
     */
    const smuggled = [{ ...POSTER, assetRef: "https://images.example.com/p.jpg" }];
    const html = renderToStaticMarkup(<PosterArtwork artwork={smuggled} />);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("images.example.com");
  });
});

describe("present artwork renders from this origin and nowhere else", () => {
  const html = renderToStaticMarkup(<PosterArtwork artwork={[POSTER]} />);

  it("points the image at the artwork boundary with a relative path", () => {
    expect(html).toContain(`src="${ARTWORK_ROUTE_PREFIX}aurora-fall-poster"`);
    // No scheme, no protocol-relative authority: nothing in this markup can
    // name a host.
    expect(html).not.toMatch(/src="[a-zA-Z][a-zA-Z0-9+.-]*:/);
    expect(html).not.toContain('src="//');
  });

  it("carries the asset's own dimensions so space is reserved before it arrives", () => {
    expect(html).toContain('width="400"');
    expect(html).toContain('height="600"');
  });

  it("stays decorative: empty alt, hidden frame, no repeated title", () => {
    expect(html).toContain('alt=""');
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain("Aurora");
  });

  it("defers the fetch and decode, because a rail is mostly off-screen", () => {
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
  });

  it("keeps the gradient behind the image rather than replacing it", () => {
    /*
     * This is what makes the failed-load state free. The global `.poster` class
     * -- with its gradient and its `:nth-child` hues -- is still on the wrapper,
     * so an image that 404s because the operator's store does not hold it leaves
     * the designed gradient showing. `alt=""` is what stops a broken-image icon
     * appearing over it.
     */
    expect(html).toMatch(/class="poster [^"]+"/);
  });
});

describe("the component cannot be pointed at another origin", () => {
  it("builds its src from the boundary's own function and never from a prop", async () => {
    const source = await componentSource();
    expect(source).toContain("artworkPathFor");
    expect(source).not.toMatch(/https?:\/\//);
    expect(source).not.toMatch(/\bnew URL\b/);
    // Non-vacuity: the stripped source is still the component.
    expect(source).toContain("PosterArtwork");
    expect(source).toContain("<img");
  });
});

describe("the framework image loader is narrowed even though this task does not use it", () => {
  /*
   * WHICH OF THE TWO THIS IS. The structural fact is above: no payload carries
   * an image address and the one src-building function returns a relative path.
   * This block is the STATED INVARIANT beside it, covering the component the
   * next person will reach for. Both targets are checked because
   * `next.config.ts` produces a different object per build target and a guard
   * that held only for the web build would be absent from the one that ships on
   * Windows.
   */
  for (const target of ["web", "desktop"] as const) {
    it(`permits no remote host under the ${target} target`, () => {
      expect(nextConfigFor(target).images?.remotePatterns).toEqual([]);
    });

    it(`permits only the artwork boundary's own paths under the ${target} target`, () => {
      const patterns = nextConfigFor(target).images?.localPatterns;
      expect(patterns).toEqual([{ pathname: `${ARTWORK_ROUTE_PREFIX}**`, search: "" }]);
      // Not the framework default, which is every path on this origin.
      expect(patterns?.[0]?.pathname).not.toBe("/**");
    });

    it(`refuses SVG under the ${target} target`, () => {
      expect(nextConfigFor(target).images?.dangerouslyAllowSVG).toBe(false);
    });
  }
});
