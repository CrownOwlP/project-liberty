import type { CatalogItem } from "@liberty/contracts/domains/catalog";
import { CatalogCard } from "../catalog-card";
import { RovingGroup } from "../../lib/a11y/roving-group";
import styles from "./browse.module.css";

/* -------------------------------------------------------------------------
 * The browse grid (PL-0756).
 *
 * `CatalogCard` UNCHANGED, AND DELIBERATELY WITHOUT A PLAY AFFORDANCE. Browse
 * is discovery. A stream is resolved through authorized provider adapters at
 * playback time, and a play button on a browse card would imply this
 * application already knows there is one -- the same argument `search-results`
 * makes for its own list, and the reason both surfaces render the identical
 * card.
 * ---------------------------------------------------------------------- */

export interface BrowseGridProps {
  items: readonly CatalogItem[];
}

export function BrowseGrid({ items }: BrowseGridProps) {
  return (
    <section
      aria-describedby="browse-summary"
      aria-labelledby="browse-results-heading"
      className="section"
    >
      <div className="section-head">
        <h2 className="visually-hidden" id="browse-results-heading">
          Titles
        </h2>
      </div>
      {/*
        A list, not a grid of divs, so the count and the boundaries between
        cards are announced without the layout having to be described.

        `role="list"` is redundant markup that is not redundant in practice:
        WebKit drops the list role from a `ul` styled with `list-style: none`,
        which `.grid` sets, so on Safari/VoiceOver this would announce as a run
        of unrelated articles. `RovingGroup` states it, and arrow keys move
        between cards once it has hydrated -- a genre with forty titles is forty
        headings and forty My List controls between the filter bar and the end
        of the page.

        The `aria-describedby` that points at the summary the filter bar
        renders is on the SECTION rather than on this list, because
        `RovingGroupProps` takes four named props and no attribute passthrough
        -- deliberately, by its own header. The region is the right host for it
        anyway: a reader entering the section is told what it contains before
        reaching the first card, rather than hearing the sentence once it is
        already inside the list.
      */}
      <RovingGroup as="ul" className={styles.grid} itemNoun="titles">
        {items.map((item) => (
          <li className={styles.cell} key={item.id}>
            <CatalogCard item={item} />
          </li>
        ))}
      </RovingGroup>
    </section>
  );
}
