import type { SearchMatchKind, SearchResponse } from "@liberty/contracts/domains/search";
import { CatalogCard } from "../catalog-card";
import { RovingGroup } from "../../lib/a11y/roving-group";
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

        `role="list"` is redundant markup that is not redundant in practice.
        WebKit drops the list role from a `ul` styled with `list-style: none`,
        which `.results` sets — so on Safari/VoiceOver this list would announce
        as a run of unrelated articles and the sentence above would be a claim
        the page does not actually keep. Stating the role restores it.

        Cards reuse `CatalogCard`, which renders title and metadata only. There
        is deliberately no play affordance here — search is discovery, and a
        stream is resolved through authorized provider adapters at playback
        time, never implied by a result being visible.
      */}
      {/*
        ARROW KEYS THROUGH THE RESULTS (PW-0310). A query that matches twenty
        titles is twenty cards, each with a heading link and usually a My List
        control, between the search box and anything below it. `RovingGroup`
        renders this same `ul` and changes nothing until it has hydrated.

        `role="list"` IS KEPT. The CSS resets the list style, and Safari then
        stops exposing an unstyled `ul` as a list at all; the attribute is what
        PL-0104 added to hold the semantics against that, and the keyboard
        arrangement has no reason to take it away.
      */}
      <RovingGroup as="ul" className={styles.results} itemNoun="search results">
        {response.results.map((result) => (
          <li className={styles.result} key={result.item.id}>
            <CatalogCard item={result.item} />
            <p className={styles.matchReason}>{MATCH_LABEL[result.matchedOn]}</p>
          </li>
        ))}
      </RovingGroup>
    </section>
  );
}
