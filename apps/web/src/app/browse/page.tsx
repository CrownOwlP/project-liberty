import { AppShell } from "../../components/shell/app-shell";
import { BrowseFilterBar } from "../../components/browse/browse-filters";
import { BrowseGrid } from "../../components/browse/browse-grid";
import styles from "../../components/browse/browse.module.css";
import {
  CATALOG_SOURCE_NOT_CONFIGURED_REASON,
  UNFILTERED,
  buildBrowseHref,
  describeBrowseState,
  loadBrowseCatalog,
  readBrowseFilters
} from "./browse";

/**
 * Rendered per request. The filters live in the URL, so a prerendered page
 * would serve one filter combination's titles at every other combination's
 * address.
 */
export const revalidate = 0;

/**
 * The empty state, and it has to say WHICH empty it is.
 *
 * `browse.ts` explains why the two causes must not collapse. The remedies are
 * different and only one of them belongs to the viewer: a catalog with nothing
 * in it is not something they can filter their way out of, and telling them to
 * try other filters would send them round a loop. When some other combination
 * WOULD work, the way out is offered as a link rather than described, because
 * the viewer has just demonstrated that they are using the filters.
 */
function BrowseEmpty({ cause }: { cause: "catalog_has_no_browsable_titles" | "filters_match_nothing" }) {
  if (cause === "catalog_has_no_browsable_titles") {
    return (
      <section className="section">
        <div className="state-panel">
          <h2>There is nothing in the catalog yet</h2>
          <p>
            No films or series have been published to this installation. Nothing is wrong with
            your account, and no combination of filters will find anything until the catalog has
            something in it.
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
          The catalog has titles, just not these ones. Widen the genre, change what you are
          showing, or <a href={buildBrowseHref(UNFILTERED)}>see everything</a>.
        </p>
      </div>
    </section>
  );
}

/**
 * The failure state, and NOT a live region -- the same decision
 * `SearchUnavailable` records: this panel only ever appears as part of a server
 * render, and an alert whose content is present when the region is inserted is
 * frequently not announced anyway.
 *
 * TWO EXPLANATIONS FOR TWO FAILURES, because "try again in a moment" is FALSE
 * for one of them. `catalog_source_not_configured` means this process has no
 * catalog metadata source at all: retrying produces the identical refusal
 * forever and the remedy belongs to an operator. Telling a viewer to retry
 * something that cannot succeed is the same class of defect as telling them
 * nothing matched filters that were never applied to anything.
 */
function BrowseUnavailable({ reason }: { reason: string }) {
  return (
    <section className="section">
      <div className="state-panel">
        <h2>We couldn&apos;t load the catalog</h2>
        {reason === CATALOG_SOURCE_NOT_CONFIGURED_REASON ? (
          <p>
            This deployment has no catalog to browse — no metadata source is configured for it.
            Nothing is wrong with your account, and retrying will not change the answer until an
            operator configures one.
          </p>
        ) : (
          <p>
            The catalog didn&apos;t return a usable response. Nothing is wrong with your account —
            try again in a moment.
          </p>
        )}
        <p className="code state-detail">{reason}</p>
      </div>
    </section>
  );
}

/**
 * There is no `error.tsx` in this segment on purpose: `loadBrowseCatalog`
 * converts every expected failure into the handled `error` state above, and the
 * root boundary from PL-0101 already covers anything genuinely unexpected.
 */
export default async function BrowsePage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const filters = readBrowseFilters(await searchParams);
  const result = await loadBrowseCatalog(filters);

  /*
   * THE FILTER BAR IS RENDERED IN EVERY STATE, INCLUDING THE FAILURE ONE,
   * EXCEPT WHEN THERE ARE NO FACETS TO OFFER. A surface whose only control
   * disappears on failure strands the viewer on an address they cannot change
   * without editing the URL -- and the empty-filters state is precisely where
   * they most need the control. The facet list is whatever the loader managed
   * to compute, which is a full list in `ok`, the pre-filter list in `empty`,
   * and nothing at all in `error`, where no catalog was read and offering a
   * genre list would be inventing one.
   */
  const genres = result.status === "error" ? [] : result.status === "ok" ? result.response.genres : result.genres;

  return (
    <AppShell badge="Browse" pathname="/browse">
      <section aria-labelledby="browse-heading" className="section">
        <div className="section-head">
          <h1 className={styles.heading} id="browse-heading">
            Browse
          </h1>
        </div>
        {result.status === "error" ? (
          <p className={styles.summary} id="browse-summary">
            {describeBrowseState(result)}
          </p>
        ) : (
          <BrowseFilterBar
            filters={filters}
            genres={genres}
            summary={describeBrowseState(result)}
          />
        )}
      </section>

      {result.status === "error" && <BrowseUnavailable reason={result.reason} />}
      {result.status === "empty" && <BrowseEmpty cause={result.cause} />}
      {result.status === "ok" && <BrowseGrid items={result.response.items} />}
    </AppShell>
  );
}
