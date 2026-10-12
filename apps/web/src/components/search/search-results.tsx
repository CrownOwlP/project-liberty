import type { CatalogItem } from "@liberty/contracts/domains/catalog";
import type { SearchMatchKind, SearchResponse } from "@liberty/contracts/domains/search";
import { CatalogCard } from "../catalog-card";
import { RovingGroup } from "../../lib/a11y/roving-group";
import {
  describeRelevance,
  foldSearchText,
  scoreCatalogItem
} from "../../app/search/relevance";
import { describeSurfacedRightsBasis } from "../../lib/catalog";
import styles from "./search.module.css";

/**
 * The reason trail, in words a viewer can act on.
 *
 * `matchedOn` is why the item is in the list and in what order; showing it means
 * a result that looks wrong is explainable on the page instead of only in a bug
 * report. Keyed by the contract enum, so a new match kind is a type error here
 * rather than a blank line in the UI.
 *
 * STILL HERE, AND NOW THE FALLBACK RATHER THAN THE ANSWER (Wave 132). The
 * published enum cannot express the word-boundary tier `relevance.ts` ranks by
 * -- `searchResultSchema` is a two-field object and `packages/contracts` is
 * read-only to this change -- so `title-contains` is the label for two
 * genuinely different positions in the list. `reasonFor` below recomputes the
 * real tier from the response's own normalised query and falls back to this
 * table when it cannot, which is the honest arrangement: the reader is told the
 * finer reason when it is derivable and the coarser one when it is not, and
 * never a reason that contradicts the order.
 */
const MATCH_LABEL: Readonly<Record<SearchMatchKind, string>> = {
  "title-exact": "Exact title match",
  "title-prefix": "Title starts with your search",
  "title-contains": "Title contains your search",
  "genre-contains": "Genre match"
};

/**
 * Why this result is here, at the finest resolution available.
 *
 * RECOMPUTED RATHER THAN TRANSPORTED, because it cannot be transported: a
 * `relevance` field added to a `SearchResult` would be silently STRIPPED by the
 * `searchResponseSchema` parse in `loadSearchResults`, and a field that
 * disappears at a validation boundary is worse than no field at all.
 *
 * It CANNOT DISAGREE with the order, because it is the same pure function over
 * the same two inputs the sort used -- `response.query` is the server's
 * normalised query (the contract publishes it for exactly this kind of
 * comparison) and the item is the one that was scored. `scoreCatalogItem`
 * memoises its case folding per item object, so this costs no folding work the
 * search itself did not already do.
 *
 * `null` IS REACHABLE AND HANDLED. The response is validated, not trusted: a
 * payload whose `query` no longer matches the item that was stored against it
 * -- the stale/misrouted case `loadSearchResults` already guards one level up --
 * scores nothing. The published `matchedOn` is then the only truthful thing left
 * to say, so it is what gets said, rather than an empty line or a guess.
 */
function reasonFor(item: CatalogItem, query: string, matchedOn: SearchMatchKind): string {
  const relevance = scoreCatalogItem(item, foldSearchText(query));
  return relevance === null ? MATCH_LABEL[matchedOn] : describeRelevance(relevance);
}

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
            <p className={styles.matchReason}>
              {reasonFor(result.item, response.query, result.matchedOn)}
            </p>
            {/*
              WHY THIS TITLE IS LISTED AT ALL, which is a different question
              from why it matched and was previously answered nowhere.

              `describeSurfacedRightsBasis` reports the rights basis the gate
              actually read off `item.rights` -- not a playability claim. A
              result being visible says the work exists and that its rights
              basis is on `PLAYABLE_CONTENT_RIGHTS`; it says nothing about
              whether a stream can be resolved, which is decided by authorized
              provider adapters at playback time and is the reason there is
              still no play affordance on these cards.
            */}
            <p className={styles.matchReason}>{describeSurfacedRightsBasis(result.item)}</p>
          </li>
        ))}
      </RovingGroup>
    </section>
  );
}
