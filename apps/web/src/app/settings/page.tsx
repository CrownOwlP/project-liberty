/* -------------------------------------------------------------------------
 * /settings -- the screen the navigation has been promising (PW-0308).
 *
 * `components/shell/navigation.ts` carried
 * `planned("settings", "Settings", "PW-0308")` -- a non-link naming this task
 * as the reason it was not one. This is that screen, and the entry is now a
 * link, which is the same one-field migration PW-0304 performed for the
 * watchlist and which that file's header promised.
 *
 * A SERVER COMPONENT THAT DECIDES THE SIGNED-OUT STATE AND DELEGATES THE REST,
 * the arrangement `/watchlist` and `/profiles` established. A panel rather
 * than a `redirect()` for the reason PW-0312 gives: a redirect makes a
 * signed-out viewer's address bar say `/signin` for a page they asked for by
 * name, so the back button bounces them.
 *
 * WHY THE SIGNED-OUT PANEL GUARDS ONLY THE LANGUAGES. Preferences are stored
 * on a profile, so a viewer with no account has nothing to read or write and
 * a form would be a dead end. Diagnostics and About are facts about THIS
 * BUILD -- what it would send, what version it is, what licences it owes --
 * and they are true whether or not anybody is signed in. Hiding them behind a
 * sign-in would withhold an attribution obligation from the person least able
 * to go looking for it.
 * ---------------------------------------------------------------------- */
import { headers } from "next/headers";

import { resolveAccountState } from "../../components/auth/account-state";
import { SignedOutPanel } from "../../components/auth/signed-out-panel";
import { AboutSection } from "../../components/settings/about-section";
import { DiagnosticsDisclosure } from "../../components/settings/diagnostics-disclosure";
import { LanguagePreferences } from "../../components/settings/language-preferences";
import { AppShell } from "../../components/shell/app-shell";

export const metadata = {
  title: "Settings · Project Liberty"
};

/**
 * Rendered per request, for the reason `/watchlist` gives about its own list:
 * what this page shows depends on who is asking, and a prerendered copy served
 * from a cache would be one household's settings in somebody else's.
 */
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const account = await resolveAccountState(await headers());

  return (
    <AppShell pathname="/settings">
      <section className="section">
        <h1>Settings</h1>
      </section>

      {account.kind === "signed-out" ? (
        <SignedOutPanel next="/settings" what="choose the languages you prefer" />
      ) : (
        <LanguagePreferences />
      )}

      <DiagnosticsDisclosure />
      <AboutSection />
    </AppShell>
  );
}
