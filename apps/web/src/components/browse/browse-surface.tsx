import { BrowseFilterBar } from "./browse-filters";
import { BrowseGrid } from "./browse-grid";
import styles from "./browse.module.css";
import {
  BROWSE_PATH,
  CATALOG_SOURCE_NOT_CONFIGURED_REASON,
  UNFILTERED,
  buildBrowseHref,
  describeBrowseState,
  loadBrowseCatalog,
  readBrowseFilters,
  type BrowseEmptyCause,
  type BrowseKindFilter
} from "../../app/browse/browse";

/* -------------------------------------------------------------------------
 * The browse surface, once, for the three routes that are it (Wave 131B).
 *
 * `/browse` lets the viewer pick a kind. `/movies` and `/tv` are the same
 * surface with the kind decided by the path, because "Movies" and "TV Shows"
 * are what somebody looks for in a navigation bar: a dropdown on one page is a
 * filter, a named destination is a place.
 *
 * EXTRACTED RATHER THAN COPIED, which is the whole reason this file exists.
 * Three pages each loading the catalog, each deciding what an empty result
 * means, each writing its own unavailable panel, is three places for those
 * decisions to drift -- and this application already carries the scar of that
 * pattern: `shell-usage.test.ts` exists because eight routes grew eight
 * topbars. One loader, one empty-state vocabulary, one grid.
 *
 * THE SHELL IS NOT HERE, AND THAT IS DELIBERATE. Each page renders its own
 * `<AppShell>`, so `shell-usage.test.ts`'s rule -- every page-like file must
 * contain `<AppShell` -- keeps meaning what it says. Hiding the shell behind a
 * shared component would make that guard pass by indirection on every future
 * route, which is exactly the check it was written to be.
 * ---------------------------------------------------------------------- */

/**
 * The empty state, and it has to say WHICH empty it is.
 *
 * `browse.ts` explains why the two causes must not collapse: the remedies
 * differ and only one of them belongs to the viewer. When some other
 * combination would work, the way out is offered as a link to this same route
 * rather than described, because the viewer has just demonstrated that they are
 * using the filters.
 */
function BrowseEmpty({ cause, basePath }: { cause: BrowseEmptyCause; basePath: string }) {
  if (cause === "catalog_has_no_browsable_titles") {
    return (
      <section className="section">
        <div className="state-panel">
          <h2>There is nothing here yet</h2>
          <p>
            Nothing has been published to this installation for this part of the catalogue. Nothing
            is wrong with your account, and no combination of filters will find anything until the
            catalogue has something in it.
          </p>
        </div>
      </section>
    );
  }
  return (
    <section className="section">
      <div className="state-panel">
        <h2>No titles match these filters</h2>
        <p>
          The catalogue has titles, just not these ones. Widen the genre, or{" "}
          <a href={buildBrowseHref(UNFILTERED, basePath)}>see everything here</a>.
        </p>
      </div>
    </section>
  );
}

/**
 * The failure state, and NOT a live region -- the decision `SearchUnavailable`
 * records: this panel only ever appears as part of a server render, and an
 * alert whose content is present when the region is inserted is frequently not
 * announced anyway.
 *
 * TWO EXPLANATIONS FOR TWO FAILURES, because "try again in a moment" is FALSE
 * for one of them. `catalog_source_not_configured` means this process has no
 * catalogue metadata source at all: retrying produces the identical refusal
 * forever and the remedy belongs to an operator.
 */
function BrowseUnavailable({ reason }: { reason: string }) {
  return (
    <section className="section">
      <div className="state-panel">
        <h2>We couldn&apos;t load the catalogue</h2>
        {reason === CATALOG_SOURCE_NOT_CONFIGURED_REASON ? (
          <p>
            This installation has no catalogue to browse — no metadata source is configured for it.
            Nothing is wrong with your account, and retrying will not change the answer until an
            operator configures one.
          </p>
        ) : (
          <p>
            The catalogue didn&apos;t return a usable response. Nothing is wrong with your account —
            try again in a moment.
          </p>
        )}
        <p className="code state-detail">{reason}</p>
      </div>
    </section>
  );
}

export interface BrowseSurfaceProps {
  /** The route this is rendered on. The form submits here and links point here. */
  readonly basePath?: string;
  /** The `<h1>`. Named per route, because the heading is what says which kind. */
  readonly heading: string;
  /** Fixed on `/movies` and `/tv`; `null` on `/browse`, where the viewer picks. */
  readonly lockedKind?: Exclude<BrowseKindFilter, "all"> | null;
  readonly searchParams: Record<string, string | string[] | undefined>;
}

export async function BrowseSurface({
  basePath = BROWSE_PATH,
  heading,
  lockedKind = null,
  searchParams
}: BrowseSurfaceProps) {
  const filters = readBrowseFilters(searchParams, lockedKind);
  const result = await loadBrowseCatalog(filters);

  /*
   * THE FILTER BAR IS RENDERED IN EVERY STATE EXCEPT THE FAILURE ONE, where
   * there are no facets to offer. A surface whose only control disappears on
   * failure strands the viewer on an address they cannot change without editing
   * the URL -- and the filters-matched-nothing state is precisely where they
   * most need it. The facet list is whatever the loader managed to compute: a
   * full list in `ok`, the pre-filter list in `empty`, and nothing at all in
   * `error`, where no catalogue was read and offering a genre list would be
   * inventing one.
   */
  const genres =
    result.status === "error" ? [] : result.status === "ok" ? result.response.genres : result.genres;

  return (
    <>
      <section aria-labelledby="browse-heading" className="section">
        <div className="section-head">
          <h1 className={styles.heading} id="browse-heading">
            {heading}
          </h1>
        </div>
        {result.status === "error" ? (
          <p className={styles.summary} id="browse-summary">
            {describeBrowseState(result)}
          </p>
        ) : (
          <BrowseFilterBar
            action={basePath}
            filters={filters}
            genres={genres}
            lockedKind={lockedKind}
            summary={describeBrowseState(result)}
          />
        )}
      </section>

      {result.status === "error" && <BrowseUnavailable reason={result.reason} />}
      {result.status === "empty" && <BrowseEmpty basePath={basePath} cause={result.cause} />}
      {result.status === "ok" && <BrowseGrid items={result.response.items} />}
    </>
  );
}
