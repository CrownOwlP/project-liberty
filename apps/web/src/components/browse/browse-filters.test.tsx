import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrowseFilterBar } from "./browse-filters";
import { BROWSE_PATH, MOVIES_PATH, UNFILTERED } from "../../app/browse/browse";

const genres = [
  { genre: "Drama", count: 3 },
  { genre: "Science fiction", count: 1 }
];

describe("the browse filter bar", () => {
  it("offers the kind control on /browse", () => {
    const html = renderToStaticMarkup(
      <BrowseFilterBar filters={UNFILTERED} genres={genres} summary="4 titles." />
    );
    expect(html).toContain('id="browse-kind"');
    expect(html).toContain(`action="${BROWSE_PATH}"`);
  });

  it("omits the kind control entirely on a route whose path fixes it", () => {
    /*
     * NOT RENDERED, not rendered-and-disabled. A disabled select says "you may
     * not choose"; here there is nothing to choose, because the viewer chose by
     * arriving. The heading says which kind.
     */
    const html = renderToStaticMarkup(
      <BrowseFilterBar
        action={MOVIES_PATH}
        filters={{ kind: "movie", genre: null }}
        genres={genres}
        lockedKind="movie"
        summary="3 films."
      />
    );
    expect(html).not.toContain('id="browse-kind"');
    expect(html).not.toContain('name="kind"');
    expect(html).toContain('id="browse-genre"');
  });

  it("submits to the route it is rendered on, so filtering does not bounce to /browse", () => {
    const html = renderToStaticMarkup(
      <BrowseFilterBar
        action={MOVIES_PATH}
        filters={{ kind: "movie", genre: null }}
        genres={genres}
        lockedKind="movie"
        summary="3 films."
      />
    );
    expect(html).toContain(`action="${MOVIES_PATH}"`);
  });

  it("still shows a selected genre the facets no longer offer, and marks it", () => {
    /* It happens on exactly the page where it matters: the empty state, whose
     * facet list cannot contain the genre that matched nothing. */
    const html = renderToStaticMarkup(
      <BrowseFilterBar
        filters={{ kind: "all", genre: "Western" }}
        genres={genres}
        summary="No titles match these filters."
      />
    );
    expect(html).toContain("Western");
    expect(html).toContain("no titles");
  });

  it("carries the summary in the element the grid points at", () => {
    const html = renderToStaticMarkup(
      <BrowseFilterBar filters={UNFILTERED} genres={genres} summary="4 titles." />
    );
    expect(html).toContain('id="browse-summary"');
    expect(html).toContain("4 titles.");
  });
});
