import { AppShell } from "../../components/shell/app-shell";
import { BrowseSurface } from "../../components/browse/browse-surface";
import { MOVIES_PATH } from "../browse/browse";

/** Rendered per request: the genre filter lives in the URL. */
export const revalidate = 0;

/*
 * Films, as a destination rather than a filter (Wave 131B).
 *
 * The kind is fixed by the PATH and not by a query parameter, which is what
 * makes this a place a viewer can be sent to and bookmark. `readBrowseFilters`
 * lets the locked kind win over `?kind=`, so `/movies?kind=series` serves films
 * -- a stale link cannot make a page contradict its own heading.
 *
 * Everything else -- the loader, the rights gates, the genre facets, the three
 * states and their copy -- is `BrowseSurface`'s, unchanged.
 */
export default async function MoviesPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <AppShell badge="Films" pathname={MOVIES_PATH}>
      <BrowseSurface
        basePath={MOVIES_PATH}
        heading="Films"
        lockedKind="movie"
        searchParams={await searchParams}
      />
    </AppShell>
  );
}
