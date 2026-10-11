import { AppShell } from "../../components/shell/app-shell";
import { BrowseSurface } from "../../components/browse/browse-surface";
import { BROWSE_PATH } from "./browse";

/**
 * Rendered per request. The filters live in the URL, so a prerendered page
 * would serve one filter combination's titles at every other combination's
 * address.
 */
export const revalidate = 0;

/*
 * THE WHOLE SURFACE MOVED TO `components/browse/browse-surface.tsx` (Wave
 * 131B) so `/movies` and `/tv` could be the same thing with the kind decided
 * by the path, rather than two more copies of the loader, the empty-state
 * vocabulary and the unavailable panel.
 *
 * `<AppShell>` STAYS HERE. `shell-usage.test.ts` requires every page-like file
 * to contain it, and moving it behind the shared component would make that
 * guard pass by indirection on every future route -- which is exactly the
 * check it was written to be.
 *
 * There is no `error.tsx` in this segment on purpose: `loadBrowseCatalog`
 * converts every expected failure into a handled state, and the root boundary
 * from PL-0101 covers anything genuinely unexpected.
 */
export default async function BrowsePage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <AppShell badge="Browse" pathname={BROWSE_PATH}>
      <BrowseSurface heading="Browse" searchParams={await searchParams} />
    </AppShell>
  );
}
