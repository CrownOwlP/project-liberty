import { AppShell } from "../../components/shell/app-shell";
import { BrowseSurface } from "../../components/browse/browse-surface";
import { TV_PATH } from "../browse/browse";

/** Rendered per request: the genre filter lives in the URL. */
export const revalidate = 0;

/*
 * Series, as a destination rather than a filter (Wave 131B). See
 * `app/movies/page.tsx` for the reasoning; this is the same surface with the
 * other kind.
 *
 * "TV Shows" IN THE NAVIGATION AND "Series" IN THE HEADING, deliberately. The
 * nav label is what a viewer scans for; the heading matches the word the rest
 * of this application uses for the kind -- `RAIL_DEFINITIONS` titles the home
 * rail "Series" and `describeBrowseState` counts "2 series". A heading that
 * said "TV Shows" over a summary that says "series" would be two names for one
 * thing on one screen.
 */
export default async function TelevisionPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <AppShell badge="Series" pathname={TV_PATH}>
      <BrowseSurface
        basePath={TV_PATH}
        heading="Series"
        lockedKind="series"
        searchParams={await searchParams}
      />
    </AppShell>
  );
}
