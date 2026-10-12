import { cache } from "react";

import { loadHomeCatalog, type CatalogLoadOutcome } from "../../lib/catalog";

/* -------------------------------------------------------------------------
 * ONE CATALOG READ FOR TWO SUSPENSE BOUNDARIES (W132-B)
 *
 * ==========================================================================
 * THE SHAPE THIS SOLVES
 * ==========================================================================
 *
 * The home surface is three slots in a fixed order: the hero, then continue
 * watching, then the catalog rails. The hero and the rails are both the
 * catalog; continue watching, between them, is the identity store and the
 * progress table, and `app/page.tsx` has kept it in a SEPARATE boundary since
 * PW-0305 on the stated grounds that sharing one "would make an unreachable
 * database into a slow catalog".
 *
 * Document order is JSX order, so a single boundary cannot produce that
 * sequence: anything wrapping the hero and the rails together also wraps what
 * is between them. Which leaves two boundaries over the same data, and two
 * boundaries mean two `await`s.
 *
 * ==========================================================================
 * WHY `cache` AND NOT THE THREE ALTERNATIVES
 * ==========================================================================
 *
 * REJECTED: NESTING THE CONTINUE-WATCHING BOUNDARY INSIDE THE CATALOG'S, which
 * needs no new primitive and inverts PW-0305's property instead of sharing it.
 * Browse would still not wait on the database, but the rail would wait on the
 * catalog -- it could not even begin until the catalog resolved, because its
 * parent had not rendered -- so a slow metadata source would delay the one slot
 * on this page that is about the reader rather than about the catalog.
 *
 * REJECTED: PASSING THE OUTCOME DOWN FROM ONE AWAITED LOAD, which is the same
 * arrangement with the nesting made explicit and has the same defect.
 *
 * REJECTED: TWO PLAIN CALLS TO `loadHomeCatalog`. It is idempotent, so this
 * works, and it is wrong in a way that is invisible until it bites: two reads of
 * a source that is being written to can disagree, and the way a reader would
 * find out is a hero saying there is nothing in the catalog above rails full of
 * titles. The two slots are one statement about one read and they have to come
 * from one read.
 *
 * `cache` MEMOISES PER SERVER REQUEST, which is exactly the scope of one render
 * of this page: both boundaries get the same promise, the source is asked once,
 * and the hero and the rails cannot disagree. It is React's own primitive for
 * this -- not a module-level variable, which would be a cache shared between
 * every reader of the server and is how one household's view of a catalog ends
 * up in front of another.
 *
 * NOTHING ELSE SHOULD IMPORT THIS. `loadHomeCatalog` remains the entry point for
 * everything outside the home surface, including
 * `app/api/v1/catalog/home/route.ts`, which answers one request per read and has
 * nothing to deduplicate.
 * ---------------------------------------------------------------------- */

/**
 * The home catalog, read at most once per server request.
 *
 * TAKES NO ARGUMENT, deliberately, and not only because `loadHomeCatalog`'s
 * default source is the production wiring. A `cache`d function keys on its
 * arguments, so a parameter here would be a way for one of the two call sites to
 * silently miss the other's entry and reintroduce the second read this module
 * exists to prevent. The loader's injectable source stays injectable for its own
 * tests, which call it directly.
 */
export const loadHomeCatalogOnce: () => Promise<CatalogLoadOutcome> = cache(() =>
  loadHomeCatalog()
);
