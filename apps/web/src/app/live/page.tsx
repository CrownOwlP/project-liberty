import { AppShell } from "../../components/shell/app-shell";
import { LIVE_PATH, LiveSurface } from "../../components/live/live-surface";
import { buildLivePageModel } from "../../components/live/live-page-data";
import { NO_FAVOURITES } from "../../lib/livetv/channels";
import { systemClock } from "../../lib/livetv/schedule";
import { UTC_ZONE, resolveViewerZone } from "../../lib/livetv/time";

/**
 * Rendered per request. The group filter and the query live in the URL, and the
 * now/next strip is a function of the clock, so a prerendered page would serve
 * one moment's schedule at every other moment's address. The same reason
 * `/browse` gives.
 */
export const revalidate = 0;

/*
 * `<AppShell>` STAYS IN THIS FILE. `shell-usage.test.ts` requires every
 * page-like file to contain it, and moving it behind `LiveSurface` would make
 * that guard pass by indirection on every future route — which is exactly the
 * check it was written to be. The same note `/browse/page.tsx` carries.
 *
 * THERE IS NO `error.tsx` IN THIS SEGMENT, on purpose: `buildLivePageModel`
 * converts every expected outcome — no licensed feed, a refused EPG document, a
 * feed that admitted nothing — into a handled state, and the root boundary from
 * PL-0101 covers anything genuinely unexpected.
 *
 * WHAT THIS PAGE SHOWS TODAY. Nothing registers a live feed in this repository
 * (see `lib/livetv/feed-configuration.ts`), so `buildLivePageModel` returns the
 * `unconfigured` state and this route states plainly that no licensed live feed
 * is configured. That is the correct output, not a placeholder: live acquisition
 * is PL-0602 and is blocked on licensed feed access.
 */
export default async function LivePage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const readOne = (key: string): string => {
    const value = params[key];
    if (typeof value === "string") return value;
    /* A repeated query parameter takes its FIRST value rather than its last, so
     * a hand-edited URL cannot make the filter depend on parameter order. */
    return Array.isArray(value) ? (value[0] ?? "") : "";
  };

  /*
   * THE VIEWER'S ZONE IS NOT KNOWN ON THE SERVER, AND THIS PAGE SAYS SO RATHER
   * THAN GUESSING. `?tz=` is honoured when it names a zone this runtime knows,
   * and the fallback is UTC — explicitly, not `Intl`'s resolved default, which
   * on a server render is the SERVER's zone and would make a viewer's grid a
   * function of where the process runs. `lib/livetv/time.ts` sets out the
   * argument; carrying the real zone from the browser needs a client boundary or
   * a stored viewer preference, and `lib/viewer-preferences.ts` is not this
   * task's write surface.
   */
  const requestedZone = readOne("tz");
  const resolvedZone = requestedZone === "" ? null : resolveViewerZone(requestedZone);
  const zone = resolvedZone !== null && resolvedZone.ok ? resolvedZone.zone : UTC_ZONE;

  const groupParameter = readOne("group");
  const model = buildLivePageModel({
    clock: systemClock(),
    zone,
    /* No favourites store is wired; see `lib/livetv/channels.ts` and `epg-cache.ts`. */
    favourites: NO_FAVOURITES,
    groupKey: groupParameter === "" ? null : groupParameter,
    query: readOne("q")
  });

  return (
    <AppShell badge="Live TV" pathname={LIVE_PATH}>
      <LiveSurface model={model} />
    </AppShell>
  );
}
