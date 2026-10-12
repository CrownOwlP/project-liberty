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
import {
  loadProfileLibrary,
  noProfileSnapshot
} from "../../components/profiles/profile-library";
import { profileLibraryPort } from "../../components/profiles/profile-library-server";
import { AboutSection } from "../../components/settings/about-section";
import { DataResetSection } from "../../components/settings/data-reset-section";
import { DiagnosticsDisclosure } from "../../components/settings/diagnostics-disclosure";
import { LanguagePreferences } from "../../components/settings/language-preferences";
import { LibraryOnboarding } from "../../components/settings/library-onboarding";
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
  const requestHeaders = await headers();
  const account = await resolveAccountState(requestHeaders);

  /*
   * THE LIBRARY SNAPSHOT IS READ ONCE AND HANDED DOWN AS DATA (W132-F).
   *
   * Both new sections need it -- the first-run panel to decide whether to
   * appear, the reset section to enumerate exactly what it would remove -- and
   * reading it twice would be two queries that can disagree: a snapshot whose
   * watchlist is empty in the panel and holds three entries in the
   * confirmation. `loadProfileLibrary` never throws, so no boundary is needed
   * around it, and the port resolves the session ONCE so every facet is scoped
   * to one authorization decision.
   *
   * A SIGNED-OUT VIEWER IS NOT ASKED. There is no session to scope a read to
   * and the port would answer the no-profile snapshot anyway; short-circuiting
   * means a signed-out request never touches the repository at all, which is
   * the same arrangement `/profiles` chose for its picker.
   */
  const library =
    account.kind === "signed-out"
      ? noProfileSnapshot()
      : await loadProfileLibrary(profileLibraryPort(requestHeaders));

  return (
    <AppShell pathname="/settings">
      <section className="section">
        <h1>Settings</h1>
      </section>

      {account.kind === "signed-out" ? (
        <SignedOutPanel next="/settings" what="choose the languages you prefer" />
      ) : (
        <>
          {/*
            THE FIRST-RUN PANEL IS ABOVE THE FORM, and that order is the point:
            a new profile has nothing to configure a preference FOR, so the
            screen's first words explain what fills the product rather than
            asking for a ranked list of languages. It renders `null` the moment
            there is anything on this profile, so it cannot become a panel a
            household has to scroll past forever.
          */}
          <LibraryOnboarding snapshot={library} />
          <LanguagePreferences />
          {/*
            THE RESET SECTION IS BELOW EVERYTHING IT WOULD DELETE. A destructive
            control above the thing it destroys is a mis-tap; this one is last,
            takes two presses, and names what it keeps as well as what it
            removes.
          */}
          <DataResetSection snapshot={library} />
        </>
      )}

      <DiagnosticsDisclosure />
      <AboutSection />
    </AppShell>
  );
}
