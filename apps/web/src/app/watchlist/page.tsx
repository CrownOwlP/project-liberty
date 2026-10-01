/* -------------------------------------------------------------------------
 * /watchlist -- the list (PW-0304).
 *
 * THE BACKEND FOR THIS SCREEN HAS BEEN COMPLETE AND REVIEWED SINCE PL-0404 AND
 * NOTHING RENDERED IT. `/api/v1/watchlist` and `/api/v1/watchlist/[contentId]`
 * have handlers, a four-outcome contract, a closed reason vocabulary, the
 * conflict semantics in `packages/persistence/src/watchlist-mutation.ts` and
 * tests -- and until this route there was no add control, no remove control and
 * no list anywhere in the application. `components/shell/navigation.ts` said so
 * in the product's own navigation: "the watchlist API is complete; its screen
 * is PW-0304". This is that screen, and that entry is now a link.
 *
 * A SERVER COMPONENT THAT DECIDES THE SIGNED-OUT STATE AND DELEGATES THE REST,
 * which is the arrangement `app/profiles/page.tsx` established and states the
 * reasons for. They are repeated only where this route differs.
 *
 * THE SIGNED-OUT PANEL IS DECIDED HERE, ON THE SERVER, and a panel rather than
 * a `redirect()` for the reason PW-0312 gives: a redirect makes a signed-out
 * viewer's address bar say `/signin` for a page they asked for by name, so the
 * back button returns them to the redirect and bounces them again.
 *
 * `unavailable` FALLS THROUGH TO THE LIST RATHER THAN TO THE PANEL, exactly as
 * `/profiles` does and for the same reason. A process with no identity
 * instance -- which is every `next dev` -- has an identity all the same,
 * supplied by the development headers, and the list works there. Showing "sign
 * in" to a developer who cannot sign in, on a screen that would have worked, is
 * the dead end this product has been removing.
 *
 * NO SUSPENSE BOUNDARY AND NO SKELETON, deliberately. `title/[titleId]/page.tsx`
 * records the rule this follows: a boundary is worth having where something is
 * genuinely waiting BELOW a decision that has already been made. Here the
 * decision and the content are one read -- whether there is a list, and what is
 * on it, come back together -- so a skeleton would be grey boxes standing in
 * for the only thing the route does. The read is one indexed query against the
 * viewer's own profile, not a provider round trip.
 * ---------------------------------------------------------------------- */
import { headers } from "next/headers";

import { resolveAccountState } from "../../components/auth/account-state";
import { SignedOutPanel } from "../../components/auth/signed-out-panel";
import { AppShell } from "../../components/shell/app-shell";
import { WatchlistList } from "../../components/watchlist/watchlist-list";

export const metadata = {
  title: "My List · Project Liberty"
};

/**
 * Rendered per request, and here the reason is sharper than it is on
 * `/profiles`.
 *
 * Everything on this page is one profile's own stored rows. A prerendered copy
 * served from a CDN would be one household's list in somebody else's cache --
 * which is the confidentiality boundary the whole profile model exists to
 * establish, and the same reason `/api/v1/watchlist` answers `no-store` on
 * every response.
 */
export const dynamic = "force-dynamic";

export default async function WatchlistPage() {
  const account = await resolveAccountState(await headers());

  return (
    <AppShell pathname="/watchlist">
      <section className="section">
        <h1>My List</h1>
      </section>
      {account.kind === "signed-out" ? (
        <SignedOutPanel next="/watchlist" what="keep a list of what you mean to watch" />
      ) : (
        <WatchlistList />
      )}
    </AppShell>
  );
}
