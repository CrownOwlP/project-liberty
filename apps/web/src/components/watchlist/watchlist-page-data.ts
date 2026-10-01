import type { CatalogItem } from "@liberty/contracts/domains/catalog";
import type { ListLimitRejection, WatchlistEntryRow } from "@liberty/persistence";

import { isSurfaceable } from "../../lib/catalog";
import { resolveCatalogMetadataSource } from "../../lib/catalog-source-registry";
import { resolveActiveProfileScope, resolveRequestContext } from "../../lib/db/request-context";

/* -------------------------------------------------------------------------
 * What /watchlist is given, and where it comes from (PW-0304)
 *
 * THE LIST IS READ ON THE SERVER AND THE CONTROLS ARE NOT, and the split is the
 * whole shape of this task. A control on a catalog card cannot be told its
 * state on the server -- `watchlist-source.ts` sets out why: reading a
 * profile's list inside `CatalogCard` would make every page that renders a card
 * dynamic, which is the cost `components/auth/account-region.tsx` already
 * declined to pay for the session. The LIST PAGE is the opposite case. It is
 * already `force-dynamic`, it already exists only for this profile, and what it
 * must render is not a boolean but a set of titles -- which the API cannot give
 * it, because `watchlistEntryViewSchema` publishes `contentId` and `addedAt` and
 * nothing else. A client that fetched `/api/v1/watchlist` would hold a page of
 * opaque ids and have no endpoint to turn them into names.
 *
 * SO THIS MODULE MIRRORS `lib/continue-watching.ts`, DELIBERATELY AND ALMOST
 * LINE FOR LINE, down to the synthesised `Request` and the comment explaining
 * it. That file is the established way a server component in this application
 * reads profile-scoped rows and names the titles behind them, and a second
 * arrangement for the same job would be a second place for the rights gate to
 * be forgotten.
 *
 * WHERE IT DELIBERATELY DIFFERS, AND WHY EACH DIFFERENCE IS NOT DRIFT:
 *
 *   1. A FAILURE IS RENDERED, NOT SWALLOWED. The rail answers `unavailable` and
 *      draws nothing, because it is supplementary and a viewer who has watched
 *      nothing legitimately has no rail. This page IS the feature. A /watchlist
 *      that silently rendered "nothing on your list" when the database was
 *      unreachable would be telling a household their list is empty on the
 *      strength of never having read it -- the same lie `loadHomeCatalog`
 *      refuses when it answers `catalog_source_not_configured` instead of
 *      `empty`.
 *
 *   2. `no_active_profile_selected` IS ITS OWN BRANCH. It is the one refusal on
 *      this path with a remedy the viewer can perform, and there is a screen to
 *      perform it on -- `/profiles`, which PW-0303 built. Folding it into the
 *      generic unavailable panel would hand somebody a dead end one click from
 *      the fix. The rail folds it in because the rail's answer to every refusal
 *      is the same: render nothing.
 *
 *   3. A TITLE THE CATALOG WILL NOT NAME STAYS ON THE PAGE. The rail drops it,
 *      which is right for a rail -- there is nothing to put in the slot. Here
 *      the row is the viewer's OWN stored entry, and dropping it would mean a
 *      list that is shorter than the list, with no way to remove the entry that
 *      is not being shown. `item: null` is carried through and the page renders
 *      it as an entry it cannot name. NOTHING ABOUT THE WITHHELD WORK IS
 *      PUBLISHED by doing so: the id is the one the viewer's own row holds and
 *      `/api/v1/watchlist` already returns to them, no metadata is read, and
 *      `/title/:id` applies its own gate to anyone who follows the link.
 * ---------------------------------------------------------------------- */

/**
 * How many rows the page asks the store for.
 *
 * `listWatchlist` requires a limit rather than defaulting one, for the reason it
 * states. `DEFAULT_WATCHLIST_PAGE_SIZE` is the API's answer to the same
 * requirement and this is the page's, stated separately rather than imported,
 * because they answer different questions: that one bounds an untrusted
 * caller's page, this one bounds a screen that renders every row it is given
 * and has no pagination control yet. They are equal today and the equality is a
 * coincidence rather than a constraint.
 *
 * WHAT THIS MEANS FOR A LONG LIST, STATED RATHER THAN HIDDEN: a profile with
 * more than fifty entries sees fifty, oldest ones absent, with nothing on the
 * page saying so. That is a real limitation of this task and it is named in the
 * report rather than discovered. The honest fix is a pagination control, which
 * needs a cursor the API does not publish -- `listedWatchlist` carries `limit`
 * and no continuation token. Inventing one here would be a second pagination
 * authority disagreeing with the wire contract.
 */
export const WATCHLIST_PAGE_QUERY_LIMIT = 50;

/** One row on the page: what the viewer stored, and the title if we may name it. */
export interface WatchlistPageEntry {
  readonly contentId: string;
  /** ISO 8601. When it went on the list, which is also the list's order. */
  readonly addedAt: string;
  /**
   * The catalog item, or `null` for a title this surface may not name.
   *
   * THREE DIFFERENT FACTS COLLAPSE INTO THIS `null` ON PURPOSE -- the catalog
   * does not know the id, the metadata source is not configured, or the work
   * exists and is withheld -- for the reason `selectContinueWatching` gives:
   * the reader cannot act differently on any of them, and distinguishing them
   * on this page would put the catalog's internal policy vocabulary in front of
   * a household.
   */
  readonly item: CatalogItem | null;
}

/**
 * Turn stored rows into page entries.
 *
 * PURE, AND THE ORDER IS THE STORE'S. `listWatchlist` orders by `added_at`
 * descending with `content_id` as a total-order tie-break, and that IS the
 * order the contract publishes. A second sort here could disagree with the one
 * that also decided which rows the `limit` returned, so it would silently be an
 * order over the wrong subset.
 */
export function selectWatchlistPage(
  rows: readonly WatchlistEntryRow[],
  resolveItem: (contentId: string) => CatalogItem | null
): readonly WatchlistPageEntry[] {
  return rows.map((row) => ({
    contentId: row.contentId,
    addedAt: row.addedAt.toISOString(),
    item: resolveItem(row.contentId)
  }));
}

/**
 * What the page gets.
 *
 * FOUR BRANCHES, AND EVERY ONE OF THEM IS RENDERED. See difference (1) and (2)
 * in the header for why this union is wider than `ContinueWatchingResult` and
 * why none of its failures is silent.
 *
 * `ok` WITH NO ENTRIES IS NOT A FAILURE. An empty list is the state every new
 * profile is in, and it is the one case where "nothing here yet" is the honest
 * sentence rather than an evasion.
 */
export type WatchlistPageResult =
  | { readonly status: "ok"; readonly entries: readonly WatchlistPageEntry[] }
  | { readonly status: "no-profile" }
  | { readonly status: "unavailable"; readonly reason: string };

export interface WatchlistPageLoadOptions {
  readonly limit?: number;
}

/**
 * The refusal that means "choose who is watching", spelled once.
 *
 * `authorizeProfileAccess` answers it when `session.activeProfileId` is null,
 * and it is the only reason on this path that is not a fault of any kind -- a
 * viewer who has not picked a profile has done nothing wrong.
 */
const NO_ACTIVE_PROFILE = "no_active_profile_selected";

/**
 * Load this profile's list.
 *
 * NEVER THROWS. This runs inside the page's render, and the failure mode of a
 * throw is a stack trace where a list should be -- on the one screen whose job
 * is to tell a household what it asked to keep.
 *
 * WHAT IT DOES NOT DO: it does not name a profile. `resolveActiveProfileScope`
 * reads `session.activeProfileId`, which is server-side state written by
 * `selectActiveProfile`, and there is no parameter on this path through which a
 * caller could supply one. That is the same absence every other profile-scoped
 * read in this application maintains, and it is why this page cannot be pointed
 * at a sibling's list by anything on the wire.
 */
export async function loadWatchlistPage(
  requestHeaders: Headers,
  options: WatchlistPageLoadOptions = {}
): Promise<WatchlistPageResult> {
  try {
    /*
     * HEADERS IN, NOT A `Request`, for the reason `loadContinueWatching` takes
     * the same: the session cookie and the two development headers are the only
     * inputs that decide anything on this path, and a caller in a server
     * component holds `headers()` rather than a request. The authority below is
     * a placeholder that nothing reads, and it is visibly one.
     */
    const context = await resolveRequestContext(
      new Request("http://watchlist-page.invalid/", { headers: requestHeaders })
    );
    if (!context.ok) {
      return { status: "unavailable", reason: context.reasons[0].code };
    }

    const decision = await resolveActiveProfileScope(context.context);
    if (!decision.allowed) {
      return decision.reason === NO_ACTIVE_PROFILE
        ? { status: "no-profile" }
        : { status: "unavailable", reason: decision.reason };
    }

    const rows = await context.context.repository.listWatchlist({
      scope: decision.scope,
      limit: options.limit ?? WATCHLIST_PAGE_QUERY_LIMIT
    });
    if (isLimitRefusal(rows)) {
      return { status: "unavailable", reason: rows.reason };
    }

    const resolve = await catalogResolver();
    return { status: "ok", entries: selectWatchlistPage(rows, resolve) };
  } catch {
    /*
     * The thrown value's text is NOT published, for the reason
     * `loadContinueWatching` gives: a repository exception can carry a
     * connection string, and this value reaches a server-rendered page.
     */
    return { status: "unavailable", reason: "watchlist_unavailable" };
  }
}

/**
 * The store answered with a refusal rather than rows.
 *
 * Narrowed by SHAPE rather than by `Array.isArray` alone, because
 * `Array.isArray` does not narrow a `readonly T[] | ListLimitRejection` union on
 * its false branch -- the member it leaves is still both.
 */
function isLimitRefusal(
  value: readonly WatchlistEntryRow[] | ListLimitRejection
): value is ListLimitRejection {
  return !Array.isArray(value);
}

/**
 * A lookup from content id to a title this surface may show.
 *
 * READS THE SAME SOURCE AND APPLIES THE SAME RIGHTS GATE AS THE RAILS. This is
 * the property that keeps a watchlist from becoming a second path into the
 * catalog: a work withheld from browse for want of a rights basis cannot
 * reappear here with its poster and its synopsis because somebody once put it
 * on a list. `isSurfaceable` is imported rather than restated for the reason
 * `rights.ts` gives about its own allowlist -- a second spelling of a rights
 * rule is the defect that predicate exists to prevent.
 *
 * Resolved ONCE per load and closed over rather than per row, for the reason
 * `catalogResolver` in `lib/continue-watching.ts` is: re-resolving the metadata
 * source per entry would multiply an operator's configuration read by the size
 * of a household's list.
 */
async function catalogResolver(): Promise<(contentId: string) => CatalogItem | null> {
  const resolution = resolveCatalogMetadataSource();
  if (resolution.status !== "configured") return () => null;

  const records = await resolution.source.listRecords();
  const byId = new Map<string, CatalogItem>();
  for (const record of records) {
    if (isSurfaceable(record.item)) byId.set(record.item.id, record.item);
  }
  return (contentId) => byId.get(contentId) ?? null;
}
