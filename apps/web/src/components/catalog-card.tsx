import Link from "next/link";
import type { CatalogItem } from "@liberty/contracts/domains/catalog";
import { formatCatalogMeta } from "../lib/catalog";
import { resolveCatalogItemRoute } from "../lib/routes";

export interface CatalogCardProps {
  item: CatalogItem;
}

/**
 * One catalog item, on the home rails and in the search results.
 *
 * THE HEADING IS THE LINK, NOT THE CARD.
 *
 * Wrapping the whole `article` in an anchor was the alternative and it was
 * rejected on three counts. An anchor's accessible name is the text it
 * contains, so a card-sized link announces "Aurora Fall, Science fiction, 1h
 * 52m" -- in a screen reader's links list that is a paragraph where a title
 * belongs, and every card reads as a wall of metadata. It also makes the meta
 * line unselectable in practice, because a drag inside a link starts a link
 * drag rather than a selection. And it forecloses the surface: the moment a
 * card gains any second control -- a play affordance, a "my list" toggle --
 * that control is an interactive element nested inside an anchor, which is
 * invalid and behaves differently in every browser. Neither arrangement changes
 * the keyboard cost; both are exactly one tab stop.
 *
 * The large click target the card-wide link would have bought is still
 * available and costs no markup change: a `::after` stretched over a positioned
 * `.card` from the heading's anchor gets it. That is a `globals.css` edit, which
 * PL-0104 does not own, and it is a genuine trade rather than an oversight --
 * it reintroduces the text-selection problem. Noted so the option is a decision
 * later, not a rediscovery.
 *
 * THE ACCESSIBLE NAME IS THE TITLE, WITH NO `aria-label`.
 *
 * `episode-list.tsx` had to add one because every row's control said the literal
 * word "Play": N identical names pointing at N different episodes. That is not
 * this problem. Here the visible text IS the title, so the name already
 * identifies the target, is different on every card, and -- the property that
 * `aria-label` most often breaks -- matches what a speech-control user can see
 * to say. The principle is the same one that file applied; the remedy differs
 * because the defect it was fixing is absent.
 *
 * Two distinct works can share a title, and then two cards in one list do share
 * a link name. An `aria-label` carrying the year would fix the links list and
 * would also hand screen reader users a distinction the page does not show
 * anyone else, which is the sort of invented context this surface avoids
 * everywhere else. If it turns out to matter, the honest fix is
 * `aria-describedby` pointing at the meta line already rendered below -- it adds
 * a description without overwriting the name. Not done here: it needs a
 * per-card DOM id, and `item.id` is not constrained enough by the catalog
 * contract to be safe to interpolate into one.
 *
 * The poster stays `aria-hidden`: it is a decorative gradient, not an image, so
 * it carries nothing to name, and it is deliberately not part of the link.
 */
export function CatalogCard({ item }: CatalogCardProps) {
  const route = resolveCatalogItemRoute(item);

  return (
    <article className="card">
      <div className="poster" aria-hidden="true" />
      {/*
        An item with no resolvable route renders its title as plain text.

        Not a link to nowhere, and not a disabled-looking control either. A
        `<a>` without an `href` is not a link at all -- it is skipped by every
        links list and by tab order, so it would look clickable and do nothing.
        Styling something as unavailable would be worse still: it asserts the
        title is coming, which is a claim nothing here has checked. Unrouted is
        not a state the reader can act on, so it is not one the reader is shown
        -- the card still names the work and describes it, it just does not
        promise a page it cannot open. See `lib/routes.ts` for which items reach
        this branch and why (none from either surface today).
      */}
      <h3>
        {route.status === "routable" ? <Link href={route.href}>{item.title}</Link> : item.title}
      </h3>
      <p>{formatCatalogMeta(item)}</p>
    </article>
  );
}
