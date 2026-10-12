import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrowseFilterBar } from "./browse-filters";
import {
  BROWSE_PATH,
  BROWSE_SORT_LABEL,
  DEFAULT_BROWSE_SORT,
  MOVIES_PATH,
  UNFILTERED,
  type BrowseFilters
} from "../../app/browse/browse";

/** `UNFILTERED` plus the overrides a case cares about, so a new filter field does not have to be restated in every literal below. */
const filters = (over: Partial<BrowseFilters> = {}): BrowseFilters => ({ ...UNFILTERED, ...over });

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
        filters={filters({ kind: "movie" })}
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
        filters={filters({ kind: "movie" })}
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
        filters={filters({ genre: "Western" })}
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

describe("the sort control (Wave 132)", () => {
  it("offers every order the module can actually apply, and no other", () => {
    /*
     * Keyed off `BROWSE_SORT_LABEL`, which lives beside `SORT_COMPARATORS` in
     * `browse.ts` -- so the control cannot offer an order the module has no
     * comparator for, and a new comparator without a label is a type error
     * there rather than a missing option here.
     */
    const html = renderToStaticMarkup(
      <BrowseFilterBar filters={UNFILTERED} genres={genres} summary="4 titles." />
    );
    expect(html).toContain('id="browse-sort"');
    expect(html).toContain('name="sort"');
    for (const [key, label] of Object.entries(BROWSE_SORT_LABEL)) {
      expect(html, key).toContain(`value="${key}"`);
      expect(html, key).toContain(label);
    }
  });

  it("is rendered on a kind-locked route too, because no path states an order", () => {
    /*
     * The kind control is omitted on `/movies` and `/tv` because the path
     * decided it. Neither path says anything about an ORDER, so there is
     * nothing for a locked value to be consistent with and a reader on
     * `/movies` may sort films however they like.
     */
    const html = renderToStaticMarkup(
      <BrowseFilterBar
        action={MOVIES_PATH}
        filters={filters({ kind: "movie", sort: "title" })}
        genres={genres}
        lockedKind="movie"
        summary="3 films."
      />
    );
    expect(html).not.toContain('id="browse-kind"');
    expect(html).toContain('id="browse-sort"');
  });

  it("preselects the order the page is actually in", () => {
    /* A control that reads "Newest first" over a Z-A page is a form
     * contradicting the page it filters -- the same defect the genre control
     * carries its own case for. */
    const html = renderToStaticMarkup(
      <BrowseFilterBar
        filters={filters({ sort: "title-desc" })}
        genres={genres}
        summary="4 titles, Z–A by title."
      />
    );
    expect(html).toContain('value="title-desc" selected');
  });

  it("preselects the default when the filters carry no order at all", () => {
    /* `BrowseFilters` is a plain object: a caller that built one from parsed
     * JSON may have no `sort`, and the control must still render a selection
     * rather than an unselected native select. */
    const smuggled = { kind: "all", genre: null } as unknown as BrowseFilters;
    const html = renderToStaticMarkup(
      <BrowseFilterBar filters={smuggled} genres={genres} summary="4 titles." />
    );
    expect(html).toContain(`value="${DEFAULT_BROWSE_SORT}" selected`);
  });

  it("stays a plain GET form, so a sorted view is shareable without JavaScript", () => {
    const html = renderToStaticMarkup(
      <BrowseFilterBar filters={UNFILTERED} genres={genres} summary="4 titles." />
    );
    expect(html).toContain('method="get"');
    expect(html).toContain('type="submit"');
    /* No change handler, no hydration marker: three named controls and a
     * submit button are the whole mechanism. */
    expect(html).not.toContain("onchange");
  });
});
