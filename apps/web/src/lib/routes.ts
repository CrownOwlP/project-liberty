import type { CatalogItem } from "@liberty/contracts/domains/catalog";
import { normalizedContentIdSchema } from "@liberty/contracts/shared/ids";
import { titleHref } from "../app/title/title-detail";

/* -------------------------------------------------------------------------
 * Where a catalog item goes when it is opened (PL-0104)
 *
 * `CatalogCard` is rendered by both the home rails and the search results, and
 * until now neither surface linked anywhere: `/title/:id` existed and nothing
 * pointed at it. Making the card link is not "wrap the heading in an anchor",
 * because a `CatalogItem` is not guaranteed to HAVE a detail page. The question
 * "does this item open, and where" is decided here, once, and answered as a
 * union so the card cannot forget the branch where the answer is no.
 *
 * WHY THIS FILE IMPORTS `titleHref` INSTEAD OF DECLARING IT
 *
 * The tidier arrangement is for this module to own `/title/:id` and for
 * `app/title/title-detail.ts` to read it from here. That is not possible under
 * PL-0104: `app/title/**` is outside this task's allowed paths, so the existing
 * definition cannot be deleted, and declaring a second one here would leave two
 * places that spell the same URL. Two spellings of one route is the drift this
 * repository has been bitten by before -- it fails silently, and it fails as a
 * 404 in front of a user rather than as a red build.
 *
 * So the definition stays where it already is and this module imports it. That
 * is also the precedent already set by `components/title/episode-list.tsx` and
 * `components/title/title-hero.tsx`, which import `titleHref` from the same
 * place.
 *
 * WHAT THAT COSTS, STATED RATHER THAN HIDDEN
 *
 * The import is not free and this file does not pretend otherwise. Importing
 * `app/title/title-detail` pulls `./demo-title-details` and
 * `@liberty/contracts/domains/title` into the module graph of every surface
 * that renders a card -- home and search -- for the sake of a one-line string
 * builder. Those modules are server-side only (no card component is a client
 * component, and nothing here is reachable from one), so this is server module
 * evaluation, not client bytes. But `demo-title-details.ts` says outright that
 * nothing downstream should assume it exists in production, and this edge makes
 * home a downstream of it.
 *
 * The edge is accepted because a duplicated URL is the worse defect, and it is
 * removable in one commit: a task whose allowed paths cover `app/title/**`,
 * `components/title/**` and this file should move `titleHref` and `watchHref`
 * down here and delete them there. At that point this import disappears and the
 * dependency points the way round it should. See the report on PL-0104.
 * ---------------------------------------------------------------------- */

/**
 * Why an item does not open.
 *
 * Named reasons rather than a bare `null`, for the same reason `CatalogLoadResult`
 * and `PlayAvailability` are unions: "we chose not to link this" and "we could
 * not work out where to link it" have different remedies, and a card that
 * silently renders unlinked text gives whoever is debugging it nothing to go on.
 */
export type CatalogItemUnroutedReason =
  | "kind_has_no_catalog_route"
  | "id_is_not_a_normalized_content_id";

export type CatalogItemRoute =
  | { status: "routable"; href: string }
  | { status: "unrouted"; reason: CatalogItemUnroutedReason };

/**
 * Whether a catalog item of this kind has a detail page reachable from a card.
 *
 * A total `Record` over the kind union rather than an array of the allowed
 * values: a fourth `CatalogItemKind` added to the contract is then a type error
 * in this file, which is the only place that would otherwise have to be
 * remembered. An `includes` list would compile unchanged and quietly answer "no
 * route" for the new kind, and the reason it reported would be a guess.
 *
 * Deliberately NOT derived from `HOME_RAIL_KINDS`. That list answers "what does
 * the home surface build a rail for", and it happens to hold the same two
 * values today. Reusing it would tie routability to merchandising: adding a
 * third rail would silently start linking a kind nobody had checked has a page,
 * and dropping a rail would stop search linking a kind that does.
 */
const HAS_CATALOG_DETAIL_PAGE: Readonly<Record<CatalogItem["kind"], boolean>> = {
  movie: true,
  series: true,
  episode: false
};

/**
 * The address a catalog item opens at, or a stated reason that it has none.
 *
 * Pure and total: same item in, same answer out, no clock, no lookup, no I/O.
 * It is in `lib/` and not inside the card precisely so the decision can be
 * exercised without rendering anything -- `apps/web/vitest.config.ts` sets
 * `environment: "node"`, so this app has no DOM test environment and a
 * component test is not an option here.
 *
 * TWO THINGS IT REFUSES, AND ONE IT CANNOT CHECK.
 *
 * 1. A bare `episode` catalog item. `/title/:id` resolves an episode fine when
 *    the episode belongs to a series -- that is exactly what the links in
 *    `episode-list.tsx` do, and `findDemoTitleDetail` looks inside each series
 *    to satisfy them. What does not resolve is an `episode` sitting in the
 *    catalog as a top-level item: it has no series to belong to, so
 *    `buildCatalogItemDetail` returns `null` and the route answers 404. Neither
 *    consumer can produce one today (`HOME_RAIL_KINDS` and `SEARCHABLE_KINDS`
 *    are both movie/series), but `CatalogCard` takes a `CatalogItem`, and the
 *    contract's discriminated union says `episode` is one. Refusing it here is
 *    what keeps that 404 unreachable if a future rail ever widens.
 *
 * 2. An id that cannot be a content id. `CatalogItem.id` is only
 *    `z.string().min(1)`; it is NOT `normalizedContentIdSchema`. So unlike every
 *    other caller of `titleHref` -- all of which receive ids the title loader
 *    has already validated -- this one is the first whose input is unchecked. An
 *    id carrying a slash, a space or upper case builds an address that
 *    `loadTitleDetail` rejects before it consults any source, so the link is
 *    known-broken at render time. A link we can prove will 404 is a broken link,
 *    and the acceptance for this task is that a result OPENS its details page.
 *    (`titleHref` still percent-encodes. That is defence in depth and stays: it
 *    is what stops such an id becoming path segments if this guard is ever
 *    bypassed.)
 *
 * What it cannot check is whether the title actually exists. A well-formed id
 * for a work no source knows about still 404s, and finding that out needs a
 * lookup this function deliberately does not do -- one per card, per render, to
 * decide whether to draw an anchor. The guarantee here is "this address is not
 * provably wrong", not "this address resolves".
 */
export function resolveCatalogItemRoute(item: CatalogItem): CatalogItemRoute {
  if (!HAS_CATALOG_DETAIL_PAGE[item.kind]) {
    return { status: "unrouted", reason: "kind_has_no_catalog_route" };
  }

  if (!normalizedContentIdSchema.safeParse(item.id).success) {
    return { status: "unrouted", reason: "id_is_not_a_normalized_content_id" };
  }

  return { status: "routable", href: titleHref(item.id) };
}
