import {
  BROWSE_PATH,
  BROWSE_SORT_LABEL,
  DEFAULT_BROWSE_SORT,
  type BrowseFilters,
  type BrowseGenreFacet,
  type BrowseKindFilter,
  type BrowseSortKey
} from "../../app/browse/browse";
import styles from "./browse.module.css";

/* -------------------------------------------------------------------------
 * The browse filter bar (PL-0756).
 *
 * A PLAIN GET FORM AND A SERVER COMPONENT, which is the one place this surface
 * deliberately differs from search. Search types continuously, so it needs a
 * client reconciler to keep the input, the URL and the in-flight request from
 * disagreeing -- `components/search/search-sync.ts` exists for that and carries
 * the live region that announces it. A browse filter is a discrete submission
 * and a full navigation: the browser owns the URL, the new page announces
 * itself, and there is no in-flight state only the client could know about. So
 * there is no client component here, no hydration to wait for, and the surface
 * is complete with JavaScript disabled.
 *
 * `method="get"` AND NAMED CONTROLS ARE THE WHOLE MECHANISM. The browser builds
 * `?kind=…&genre=…` itself, which is why a filtered view is shareable and
 * bookmarkable without this file knowing how to build a URL. `buildBrowseHref`
 * exists for links made elsewhere, not for this.
 * ---------------------------------------------------------------------- */

const KIND_LABEL: Readonly<Record<BrowseKindFilter, string>> = {
  all: "Everything",
  movie: "Films",
  series: "Series"
};

/** The sentinel a `<select>` needs for "no genre filter", since it cannot submit null. */
const EVERY_GENRE = "";

export interface BrowseFilterBarProps {
  filters: BrowseFilters;
  genres: readonly BrowseGenreFacet[];
  /** The one sentence describing what is below, derived on the server. */
  summary: string;
  /**
   * Where the form submits. The route it is rendered on, so a filtered view
   * stays on the page the viewer is reading instead of bouncing to `/browse`.
   */
  action?: string;
  /**
   * Set on a route whose path fixes the kind (`/movies`, `/tv`). The kind
   * control is then NOT RENDERED AT ALL rather than rendered and disabled: a
   * disabled select is a control that says "you may not choose", and here
   * there is nothing to choose -- the viewer already chose by arriving. The
   * heading above says which kind, so nothing is hidden by leaving it out.
   */
  lockedKind?: Exclude<BrowseKindFilter, "all"> | null;
}

export function BrowseFilterBar({
  filters,
  genres,
  summary,
  action = BROWSE_PATH,
  lockedKind = null
}: BrowseFilterBarProps) {
  /*
   * A SELECTED GENRE THE FACETS DO NOT OFFER IS STILL SHOWN.
   *
   * It happens on exactly the page where it matters: a link to a genre nothing
   * carries any more renders the empty state, whose facet list cannot contain
   * it. Dropping it would leave the control reading "Every genre" while the
   * address bar and the heading both say otherwise -- a form that contradicts
   * the page it filters. It is marked rather than silently mixed in, so the
   * viewer can see why it matches nothing.
   */
  const selected = filters.genre;
  const offered = genres.some((facet) => facet.genre.toLowerCase() === selected?.toLowerCase());

  return (
    <form action={action} className={styles.filters} method="get">
      {lockedKind === null && (
        <div className={styles.field}>
          <label className={styles.label} htmlFor="browse-kind">
            Show
          </label>
          <select
            className={styles.select}
            defaultValue={filters.kind}
            id="browse-kind"
            name="kind"
          >
            {(Object.keys(KIND_LABEL) as BrowseKindFilter[]).map((kind) => (
              <option key={kind} value={kind}>
                {KIND_LABEL[kind]}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className={styles.field}>
        <label className={styles.label} htmlFor="browse-genre">
          Genre
        </label>
        <select
          className={styles.select}
          defaultValue={selected ?? EVERY_GENRE}
          id="browse-genre"
          name="genre"
        >
          <option value={EVERY_GENRE}>Every genre</option>
          {selected !== null && !offered && (
            <option value={selected}>{selected} — no titles</option>
          )}
          {genres.map((facet) => (
            <option key={facet.genre} value={facet.genre}>
              {facet.genre} ({facet.count})
            </option>
          ))}
        </select>
      </div>

      {/*
        THE SORT CONTROL (Wave 132).

        A THIRD NAMED CONTROL ON THE SAME GET FORM, which is the whole reason
        this stayed a server component: the browser builds `?kind=…&genre=…&
        sort=…` itself, so a sorted view is shareable and bookmarkable and this
        file still knows nothing about building a URL.

        RENDERED ON EVERY ROUTE, INCLUDING THE KIND-LOCKED ONES. The kind
        control is omitted on `/movies` and `/tv` because the path decided it;
        neither path says anything about an ORDER, so there is nothing for a
        locked value to be consistent with and a reader on `/movies` may sort
        films however they like. `readBrowseFilters` records the same boundary.

        `defaultValue` AND NOT `value`, so this is an uncontrolled native select
        in a server-rendered form with no client reconciler to keep in step --
        the same arrangement the other two controls use and the reason the
        surface is complete with JavaScript disabled. The label order matches
        `BROWSE_SORT_LABEL`'s declaration order, which is the comparator table's
        order, so the control cannot offer an order the module cannot apply.
      */}
      <div className={styles.field}>
        <label className={styles.label} htmlFor="browse-sort">
          Sort
        </label>
        <select
          className={styles.select}
          defaultValue={filters.sort ?? DEFAULT_BROWSE_SORT}
          id="browse-sort"
          name="sort"
        >
          {(Object.keys(BROWSE_SORT_LABEL) as BrowseSortKey[]).map((key) => (
            <option key={key} value={key}>
              {BROWSE_SORT_LABEL[key]}
            </option>
          ))}
        </select>
      </div>

      {/*
        A SUBMIT BUTTON RATHER THAN AN onChange HANDLER. Submitting on change is
        the thing a keyboard user cannot undo: arrowing through a native select
        changes its value on every key in several browsers, so each arrow press
        would navigate and the viewer would never reach the option they were
        heading for. An explicit submit costs one keystroke and is the only
        arrangement that works the same way for a mouse, a keyboard and a
        screen reader -- and it is what keeps this a server component.
      */}
      <button className={`button button-secondary ${styles.submit}`} type="submit">
        Apply
      </button>

      {/*
        The summary is VISIBLE and is not a live region. `describeBrowseState`
        explains why: this page arrives by navigation, so it announces itself,
        and a region whose content is already present when it is inserted is
        frequently not announced anyway. It is associated with the results by
        `aria-describedby` from the grid rather than shouted.
      */}
      <p className={styles.summary} id="browse-summary">
        {summary}
      </p>
    </form>
  );
}
