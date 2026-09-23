/* -------------------------------------------------------------------------
 * The navigation model (PW-0301).
 *
 * ONE LIST, AND EVERY ENTRY GOES SOMEWHERE THAT EXISTS.
 *
 * What this replaces: four `<a href="#catalog">` fragment anchors, hand-copied
 * into eight route files, three of which pointed at the same anchor and one of
 * which ("Live") pointed at an anchor that has nothing to do with live TV. A
 * dead link is worse than an absent one, because it teaches a viewer the feature
 * is broken rather than absent -- and `/search`, which is the most finished
 * screen in this application, was reachable from no link anywhere.
 *
 * A DESTINATION THAT DOES NOT EXIST YET IS `planned`, NOT A LINK. It renders as
 * text with a stated reason, so the nav can honestly show where the product is
 * going without pretending it has arrived. The entry becomes a link by deleting
 * one field, which is the cheapest possible migration and the reason this is
 * data rather than JSX.
 *
 * DERIVED FROM `lib/routes.ts` WHERE A ROUTE ALREADY HAS A BUILDER, so the nav
 * and the rest of the application cannot disagree about a path.
 * ---------------------------------------------------------------------- */

export interface NavigationEntry {
  readonly id: string;
  readonly label: string;
  /** The path, when the destination exists. */
  readonly href: string | null;
  /**
   * Why there is no link yet. Present exactly when `href` is null, which the
   * type below enforces at the call site rather than by convention.
   */
  readonly plannedReason: string | null;
}

function live(id: string, label: string, href: string): NavigationEntry {
  return { id, label, href, plannedReason: null };
}

function planned(id: string, label: string, plannedReason: string): NavigationEntry {
  return { id, label, href: null, plannedReason };
}

/**
 * The primary navigation.
 *
 * Search is FIRST among the working entries because it is the one surface this
 * product finished and then hid.
 */
export const PRIMARY_NAVIGATION: readonly NavigationEntry[] = [
  live("home", "Home", "/"),
  live("search", "Search", "/search"),
  planned("watchlist", "Watchlist", "the watchlist API is complete; its screen is PW-0304"),
  planned("live", "Live TV", "live acquisition is PL-0602, blocked on licensed feed access"),
  planned("settings", "Settings", "PW-0308")
];

/** Whether an entry is currently reachable. Used by the renderer; here so the rule is one place. */
export function isReachable(entry: NavigationEntry): boolean {
  return entry.href !== null;
}

/**
 * Which entry a pathname is inside.
 *
 * Longest match wins so `/search` does not lose to `/`, and the root only
 * matches exactly. Returns `null` for a path no entry owns -- `/watch/x` is
 * deliberately not "Home", because highlighting a nav item for a full-screen
 * player would be a lie about where the viewer is.
 */
export function activeEntryId(pathname: string): string | null {
  let best: NavigationEntry | null = null;
  for (const entry of PRIMARY_NAVIGATION) {
    const href = entry.href;
    if (href === null) continue;
    const matches = href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
    if (matches && (best === null || href.length > (best.href ?? "").length)) best = entry;
  }
  return best?.id ?? null;
}
