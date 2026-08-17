import type { SearchMatchKind, SearchResponse } from "@liberty/contracts";
import { CatalogCard } from "../catalog-card";
import styles from "./search.module.css";

/**
 * The reason trail, in words a viewer can act on.
 *
 * `matchedOn` is why the item is in the list and in what order; showing it means
 * a result that looks wrong is explainable on the page instead of only in a bug
 * report. Keyed by the contract enum, so a new match kind is a type error here
 * rather than a blank line in the UI.
 */
const MATCH_LABEL: Readonly<Record<SearchMatchKind, string>> = {
  "title-exact": "Exact title match",
  "title-prefix": "Title starts with your search",
  "title-contains": "Title contains your search",
  "genre-contains": "Genre match"
};

export interface SearchResultListProps {
  response: SearchResponse;
}

export function SearchResultList({ response }: SearchResultListProps) {
  const count = response.results.length;

  return (
    <section aria-labelledby="search-results-heading" className="section">
      <div className="section-head">
        {/*
          The query is echoed as a React text node, which escapes it. It is
          never fed to `dangerouslySetInnerHTML`, and it is the server's
          normalised query rather than whatever is currently in the input, so
          the heading always describes the results actually below it.
        */}
        <h2 id="search-results-heading">Results for &ldquo;{response.query}&rdquo;</h2>
        <small>
          {count} {count === 1 ? "title" : "titles"}
        </small>
      </div>
      {/*
        A list, not a grid of divs: the count and the boundaries between results
        are then announced without the layout having to be described.

        Cards reuse `CatalogCard`, which renders title and metadata only. There
        is deliberately no play affordance here — search is discovery, and a
        stream is resolved through authorized provider adapters at playback
        time, never implied by a result being visible.
      */}
      <ul className={styles.results}>
        {response.results.map((result) => (
          <li className={styles.result} key={result.item.id}>
            <CatalogCard item={result.item} />
            <p className={styles.matchReason}>{MATCH_LABEL[result.matchedOn]}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
