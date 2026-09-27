import { artworkForRole, type ArtworkList } from "@liberty/contracts/shared/artwork";
import { artworkPathFor } from "../../app/api/v1/artwork/store";
import styles from "./artwork.module.css";

/* -------------------------------------------------------------------------
 * The poster a browse card shows (PW-0302)
 *
 * THIS IS THE ONLY COMPONENT IN THE PRODUCT THAT RENDERS AN IMAGE, and it can
 * only ever render one from this application's own origin. Two independent
 * reasons, stated here because the acceptance asks which of them the
 * implementation achieves:
 *
 *   1. STRUCTURAL. The `src` is produced by `artworkPathFor`, which lives beside
 *      the route handler that serves it and returns a RELATIVE path -- a path
 *      with no scheme and no host, which resolves against the document's own
 *      origin. There is no parameter through which a caller could name another
 *      one, because this component never receives a URL: it receives an opaque
 *      reference, and `@liberty/contracts/shared/artwork` constrains that
 *      reference so it cannot contain `:`, `/` or `.`. An arbitrary upstream
 *      image URL is not something this component refuses. It is something no
 *      payload in this product has a field to carry.
 *   2. A STATED INVARIANT, belt to that brace. `next.config.ts` sets
 *      `images.remotePatterns` to the empty list and narrows
 *      `images.localPatterns` to this boundary's own path, so the framework's
 *      image component would refuse every remote host and every local path
 *      except this one. That guard covers a component this task does not use --
 *      see below -- and exists so the guard is already in place if somebody
 *      later reaches for it.
 *
 * WHY A PLAIN `img` AND NOT `next/image`. The optimizer is a server that refetches
 * the asset, re-encodes it with `sharp` and caches the result. Everything it buys
 * is already true here or not wanted: the size is known from the reference so
 * there is no layout shift to fix, `loading` and `decoding` are one attribute
 * each, and the assets are operator-curated rather than arbitrary uploads. What
 * it costs is a native dependency and a second fetch path inside the desktop
 * standalone build -- the build that has to run from an installer on the
 * commander's Windows PC. A boundary whose entire argument is that it does not
 * fetch things should not acquire a component that fetches things. The ESLint
 * rule that prefers `next/image` is disabled at the element below with that
 * reason rather than repo-wide, so the next `img` anybody writes still has to
 * argue for itself.
 *
 * THE POSTER STAYS DECORATIVE. `catalog-card.tsx` records why the gradient it
 * replaces was `aria-hidden` and deliberately outside the link, and an image
 * does not change that argument: the card's accessible name is its title, and an
 * `alt` here would either repeat that title -- a screen reader reading every
 * card twice -- or describe artwork nobody has described, which is invented
 * context. `alt=""` plus `aria-hidden` on the frame is the correct pair for
 * decoration, and it has the useful side effect that a failed load renders as
 * nothing at all rather than as a broken-image icon.
 * ---------------------------------------------------------------------- */

export interface PosterArtworkProps {
  /** Whatever the payload carried. Absent, empty and non-matching are one case. */
  readonly artwork: ArtworkList;
}

/**
 * The poster frame: the designed gradient, with an image over it when there is
 * one to show.
 *
 * RETURNS THE SAME ELEMENT IN BOTH STATES. The fallback is not a different
 * component and not a placeholder -- it is this element without a child, which
 * is byte-for-byte what every card rendered before PW-0302. So a product with no
 * artwork store configured is not a degraded version of this one; it is the
 * previous design, intact.
 *
 * `artworkPathFor` can still answer `null` for a reference that reached here
 * despite the schema -- an unvalidated object cast to the type, a future
 * producer that constructs items without parsing. That branch falls back rather
 * than throwing: a malformed reference should cost a poster, not a page.
 */
export function PosterArtwork({ artwork }: PosterArtworkProps) {
  const reference = artworkForRole(artwork, "poster");
  const source = reference === null ? null : artworkPathFor(reference.assetRef);

  if (reference === null || source === null) {
    return <div className="poster" aria-hidden="true" />;
  }

  return (
    <div className={`poster ${styles.frame}`} aria-hidden="true">
      {/*
        eslint-disable-next-line @next/next/no-img-element --
        Deliberate, and argued in this module's header: `next/image` would add
        the optimizer -- a refetch, a re-encode and a native `sharp` dependency
        -- inside the desktop standalone build, to buy layout stability the
        reference's own dimensions already provide.
      */}
      <img
        className={styles.image}
        src={source}
        alt=""
        /*
         * The asset's INTRINSIC size, carried by the reference rather than
         * measured here, because it is a property of the stored image and not of
         * this surface. On this card the CSS also fixes the box, so these
         * attributes change nothing about the layout -- they are what lets the
         * browser reserve the right space if the stylesheet has not applied yet,
         * and what a surface with no fixed frame, such as the title hero, will
         * need in order to reserve any space at all. That is why they are
         * required on the contract and not optional: a reference whose size only
         * one surface knows is a reference the next surface has to fetch before
         * it can lay anything out.
         */
        width={reference.width}
        height={reference.height}
        loading="lazy"
        decoding="async"
      />
    </div>
  );
}
