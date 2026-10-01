import Link from "next/link";
import type { CatalogItem } from "@liberty/contracts/domains/catalog";
import { PosterArtwork } from "./artwork/poster-artwork";
import { ProgressIndicator } from "./continue-watching/progress-indicator";
import { WatchlistControl } from "./watchlist/watchlist-control";
import styles from "./continue-watching/continue-watching.module.css";
import { formatCatalogMeta } from "../lib/catalog";
import { resolveCatalogItemRoute } from "../lib/routes";

/**
 * What a partially-watched card shows in addition to an unwatched one.
 *
 * ONE NAMED PROP RATHER THAN A GENERIC SLOT. A `ReactNode` footer would have
 * let any caller put anything below the meta line, and the next thing anybody
 * put there would not have had to argue for itself. This says exactly what the
 * card gains and nothing else, so the card still owns its own markup.
 */
export interface CatalogCardResume {
  /** How far through. `null` when the runtime is unknown; see `ProgressIndicator`. */
  readonly completedFraction: number | null;
  /** Where "start over" goes. Built by the caller, because the route is not this component's. */
  readonly startOverHref: string;
}

export interface CatalogCardProps {
  item: CatalogItem;
  /**
   * Present only on the continue-watching rail. ABSENT IS THE NORMAL CASE and
   * renders exactly the card every other rail renders, byte for byte -- so the
   * browse surface is unchanged by this task rather than being a version of a
   * card that happens to have its extras switched off.
   */
  resume?: CatalogCardResume;
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
 * THE POSTER STAYS `aria-hidden` AND STAYS OUT OF THE LINK, WHICH IS NOW A
 * DECISION RATHER THAN A DESCRIPTION.
 *
 * It used to be trivially true: the poster was a gradient, so it carried nothing
 * to name. PW-0302 put an image in it, and an image is the sort of thing people
 * reflexively give an `alt` and wrap in the anchor. Both were considered and
 * both are refused, on the arguments already made above rather than on new ones.
 * An `alt` here would repeat the title that is already the link's accessible
 * name -- every card announced twice -- or describe artwork nobody has
 * described, which is the invented context this surface avoids everywhere else.
 * And moving the poster inside the anchor would reintroduce exactly the
 * paragraph-sized link name this file rejected at the top.
 *
 * So the element is unchanged in kind: a decorative frame that is not part of
 * the link, now with a decorative image inside it. `artwork/poster-artwork.tsx`
 * renders the frame and owns both properties; see its header for why the image
 * is a plain `img` and why it can only ever come from this origin.
 *
 * THE SECOND CONTROL THIS FILE PREDICTED HAS ARRIVED (PW-0305), and the
 * prediction is why it costs nothing. The paragraph at the top rejected wrapping
 * the card in an anchor partly because "the moment a card gains any second
 * control -- a play affordance, a 'my list' toggle -- that control is an
 * interactive element nested inside an anchor, which is invalid and behaves
 * differently in every browser". The card is not an anchor, so "Start over" is
 * an ordinary sibling link and there was nothing to undo.
 *
 * It is rendered only when `resume` is supplied, which is only on the
 * continue-watching rail. Every other rail renders the same card it rendered
 * before, and the tab order of the browse surface is unchanged: one stop per
 * card, as the top of this file states.
 */
export function CatalogCard({ item, resume }: CatalogCardProps) {
  const route = resolveCatalogItemRoute(item);

  return (
    <article className="card">
      <PosterArtwork artwork={item.artwork} />
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
      {/*
        MY LIST, AND ONLY WHERE THE ID IS ONE THE LIST CAN HOLD (PW-0304).

        `CatalogItem.id` is `z.string().min(1)`, NOT a normalized content id --
        `resolveCatalogItemRoute` says so a few lines up and refuses to build a
        link from one that is not. The watchlist route applies the same schema
        and answers `not_a_normalized_content_id`, so a control rendered on such
        a card would be a button whose only possible outcome is a refusal. The
        route check has already been done here, so reusing it costs nothing and
        the control appears exactly where it can work.

        It is a sibling of the heading rather than a child of it, which is the
        arrangement the top of this file chose an anchor-free card for: "the
        moment a card gains any second control -- a play affordance, a 'my
        list' toggle -- that control is an interactive element nested inside an
        anchor, which is invalid". The prediction named this control by name.
      */}
      {route.status === "routable" && <WatchlistControl contentId={item.id} compact />}
      {resume !== undefined && (
        <>
          <ProgressIndicator completedFraction={resume.completedFraction} />
          {/*
            "Start over" is a LINK to the same title with a different request,
            not a control that mutates anything. Nothing is written when it is
            followed: the watch route reads the parameter and issues a session
            that starts at the engine default instead of the stored position,
            and the stored position is left alone until the viewer's next
            heartbeat overwrites it. So following it by accident costs a
            viewer nothing they cannot undo by going back.
          */}
          <a className={styles.startOver} href={resume.startOverHref}>
            Start over
          </a>
        </>
      )}
    </article>
  );
}
