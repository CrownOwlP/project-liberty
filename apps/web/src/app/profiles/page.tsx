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
 * ---------------------------------------------------------------------- */
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

export default function ProfilesPage() {
  return (
    <AppShell pathname="/profiles">
      <ProfilePicker />
    </AppShell>
  );
}
