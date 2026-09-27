/* -------------------------------------------------------------------------
 * /profiles -- the picker (PW-0303).
 *
 * A SERVER COMPONENT THAT RENDERS A CLIENT ONE AND FETCHES NOTHING ITSELF. The
 * list is read in the browser, for the reason `profiles-client.ts` states: a
 * profile picker is the one screen whose entire purpose is a write the viewer
 * performs, and rendering it from the server would mean a full round trip and a
 * fresh document for every tap on a tile.
 *
 * NOT IN THE PRIMARY NAVIGATION. `navigation.ts` is five entries chosen by
 * PW-0301 and is read-only to this task. The route is reached from the profile
 * badge in the topbar, which is on every screen -- a sixth nav item would push
 * the identity control in beside content destinations, where it is not one.
 *
 * THE SIGNED-OUT STATE IS DECIDED HERE, ON THE SERVER (PW-0312), and this is
 * the one place in the application where it is. This is the acceptance's own
 * example of a protected view: PW-0403 made a deployment answer 401
 * `not_authenticated` to `/api/v1/profiles`, and until now the only thing that
 * consumed it was the picker, which rendered it as an unreachable household
 * with nowhere to go.
 *
 * A PANEL RATHER THAN A `redirect()`, and the acceptance allows either. The
 * panel is chosen because a redirect makes a signed-out viewer's address bar
 * say `/signin` for a page they asked for by name, so the back button returns
 * them to the redirect and bounces them again -- and because the picker below
 * is a client component that would still mount, fetch, and render its own
 * refusal underneath an in-flight navigation. Deciding on the server means the
 * request that renders the panel never starts the picker at all.
 * ---------------------------------------------------------------------- */
import { headers } from "next/headers";

import { resolveAccountState } from "../../components/auth/account-state";
import { SignedOutPanel } from "../../components/auth/signed-out-panel";
import { ProfilePicker } from "../../components/profiles/profile-picker";
import { AppShell } from "../../components/shell/app-shell";

export const metadata = {
  title: "Profiles · Project Liberty"
};

/**
 * Rendered per request. Nothing on this page is cacheable across sessions --
 * everything it shows is scoped to who is asking -- and a prerendered
 * "Who's watching?" served from a CDN would be a household's picker in somebody
 * else's cache.
 */
export const dynamic = "force-dynamic";

export default async function ProfilesPage() {
  const account = await resolveAccountState(await headers());

  return (
    <AppShell pathname="/profiles">
      {/*
        `unavailable` FALLS THROUGH TO THE PICKER RATHER THAN TO THE PANEL, and
        the distinction is what keeps development working. A process with no
        identity instance -- which is every `next dev` -- has an identity all
        the same, supplied by the development headers, and the picker works
        there. Showing "sign in" to a developer who cannot sign in, on a screen
        that would have worked, is the dead end this task removes pointing the
        other way.
      */}
      {account.kind === "signed-out" ? (
        <SignedOutPanel next="/profiles" what="choose who is watching" />
      ) : (
        <ProfilePicker />
      )}
    </AppShell>
  );
}
