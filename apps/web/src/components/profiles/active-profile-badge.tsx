"use client";

/* -------------------------------------------------------------------------
 * Which profile this session is acting as, in the chrome, on every screen
 * (PW-0303).
 *
 * WHY IT IS IN THE SHELL AND NOT ON THE PICKER. Every progress and watchlist row
 * in this product is profile-scoped. A viewer looking at a continue-watching
 * rail that is missing the film they finished last night cannot tell whether the
 * product lost it or whether they are simply watching as somebody else -- and
 * those two have completely different remedies. The acceptance says "at all
 * times" for that reason, so this renders on every route the shell renders,
 * including the failures.
 *
 * IT ALWAYS RENDERS SOMETHING. There is no branch that returns `null` once the
 * first answer arrives: no profile chosen is "Choose profile", an unreachable
 * service is "Profile unavailable", and both are links to `/profiles`. A badge
 * that disappeared when the service was down would leave the topbar looking
 * correct while the scope underneath it was unknown.
 *
 * A CLIENT COMPONENT INSIDE A SERVER SHELL. `AppShell` stays a server component
 * and this is the only client boundary it opens -- the pages under it are not
 * pulled into the client bundle. The alternative, making the shell async and
 * reading the session from `headers()`, would put an identity read into a
 * component every route renders and would make the whole shell dynamic.
 * ---------------------------------------------------------------------- */
import { useEffect, useState } from "react";

import { avatarStyle, profileInitial } from "./avatar";
import { listProfiles } from "./profiles-client";

const PROFILES_HREF = "/profiles";

/**
 * What the badge shows. Three, and they are the three a viewer can act on.
 *
 * `checking` is the first paint and carries no claim: showing "Choose profile"
 * before the answer arrives would be a statement about the session that has not
 * been established, and it would flicker to a name a moment later.
 */
type BadgeState =
  | { readonly kind: "checking" }
  | { readonly kind: "none"; readonly label: string }
  | {
      readonly kind: "profile";
      readonly id: string;
      readonly displayName: string;
      readonly avatarKey: string | null;
    };

export function ActiveProfileBadge() {
  const [state, setState] = useState<BadgeState>({ kind: "checking" });

  useEffect(() => {
    let live = true;
    void (async () => {
      const result = await listProfiles();
      if (!live) return;

      if (result.kind !== "answered" || result.response.outcome !== "listed") {
        /*
         * ONE LABEL FOR EVERY WAY THIS CAN FAIL, and the reasons are deliberately
         * NOT shown here. The topbar is not a diagnostic surface -- a reason
         * trail in a 12px pill on every screen is noise, and some of these
         * details name the storage adapter. The picker shows the full trail; the
         * badge links to the picker.
         */
        setState({ kind: "none", label: "Profile unavailable" });
        return;
      }

      const { profiles, activeProfileId } = result.response;
      const active = profiles.find((profile) => profile.id === activeProfileId);
      /*
       * `find` rather than trusting `activeProfileId`, because the badge draws a
       * NAME and an id with no matching row is a profile this session cannot
       * describe. That combination should not occur -- the handler selects only
       * from the account's own live profiles -- and if it ever does, "Choose
       * profile" is the honest answer rather than a blank pill.
       */
      if (active === undefined) {
        setState({ kind: "none", label: "Choose profile" });
        return;
      }
      setState({
        kind: "profile",
        id: active.id,
        displayName: active.displayName,
        avatarKey: active.avatarKey
      });
    })();
    return () => {
      live = false;
    };
  }, []);

  if (state.kind === "checking") {
    /*
     * A placeholder with the same box as the resolved badge, so the topbar does
     * not reflow when the answer lands. `aria-hidden` because "…" is not
     * information; the link below it is what assistive technology reads once
     * there is something to say.
     */
    return <span className="profile-badge profile-badge-checking" aria-hidden="true" />;
  }

  if (state.kind === "none") {
    return (
      <a className="profile-badge" href={PROFILES_HREF}>
        <span className="profile-badge-avatar profile-badge-avatar-empty" aria-hidden="true" />
        <span className="profile-badge-name">{state.label}</span>
      </a>
    );
  }

  return (
    <a
      className="profile-badge"
      href={PROFILES_HREF}
      /*
       * The accessible name says WHAT THE LINK DOES as well as who is watching.
       * "Sam" alone tells a screen-reader user a name and not that activating it
       * switches profile.
       */
      aria-label={`Watching as ${state.displayName}. Switch profile.`}
    >
      <span className="profile-badge-avatar" style={avatarStyle(state)} aria-hidden="true">
        {profileInitial(state.displayName)}
      </span>
      <span className="profile-badge-name" aria-hidden="true">
        {state.displayName}
      </span>
    </a>
  );
}
