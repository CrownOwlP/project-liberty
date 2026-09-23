/* -------------------------------------------------------------------------
 * The application chrome (PW-0301).
 *
 * WHAT THIS REPLACES. `layout.tsx` was sixteen lines -- html, body, children --
 * and every route rendered its own `<header className="topbar">`, hand-copied
 * into eight files, each with a slightly different status badge and a different
 * or absent nav. Changing the brand meant eight edits and the eight had already
 * drifted.
 *
 * A SERVER COMPONENT. It renders no client state; the active-entry highlight is
 * computed from the pathname the page passes in, rather than from a
 * `usePathname()` hook that would make the whole shell a client boundary and
 * pull every page under it into the client bundle.
 * ---------------------------------------------------------------------- */
import type { ReactNode } from "react";

import { ActiveProfileBadge } from "../profiles/active-profile-badge";
import { PRIMARY_NAVIGATION, activeEntryId } from "./navigation";

export interface AppShellProps {
  readonly children: ReactNode;
  /**
   * The current path, so the nav can mark where the viewer is. Passed rather
   * than hooked: see the header.
   */
  readonly pathname: string;
  /**
   * A short state word for the badge, or `null` for none. The eight copied
   * headers each invented their own; naming it a prop makes the variation
   * deliberate instead of accidental.
   */
  readonly badge?: string | null;
  /**
   * Extra classes for `<main>`, beyond `shell`.
   *
   * The watch route adds `player-shell`, which widens the frame for a full-bleed
   * player. Carried as a prop rather than by letting that route keep its own
   * `<main>`, because one route opting out of the shell is how eight of them
   * came to have eight different headers.
   */
  readonly mainClassName?: string | null;
  /** Passed through to `<main>`; the search skeleton sets it. */
  readonly busy?: boolean;
}

export function AppShell({
  children,
  pathname,
  badge = null,
  mainClassName = null,
  busy = false
}: AppShellProps) {
  const active = activeEntryId(pathname);
  return (
    <>
      {/*
        * THE SKIP LINK, first in the document and visible on focus.
        * There was none. On a screen whose main content sits behind a sticky
        * header and a five-item nav, a keyboard user paid that toll on every
        * navigation.
        */}
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <div className="brand">
          PROJECT <span>LIBERTY</span>
        </div>
        <nav className="nav" aria-label="Primary navigation">
          {PRIMARY_NAVIGATION.map((entry) =>
            entry.href === null ? (
              /*
               * Not a link, and not styled like one. `aria-disabled` rather than
               * omission so a screen-reader user hears the same five items a
               * sighted one sees, with the reason attached.
               */
              <span
                key={entry.id}
                className="nav-planned"
                aria-disabled="true"
                title={entry.plannedReason ?? undefined}
              >
                {entry.label}
              </span>
            ) : (
              <a
                key={entry.id}
                href={entry.href}
                aria-current={active === entry.id ? "page" : undefined}
              >
                {entry.label}
              </a>
            )
          )}
        </nav>
        {/*
          * THE IDENTITY CONTROL, ON EVERY SCREEN (PW-0303).
          *
          * Here rather than on `/profiles` alone, because every progress and
          * watchlist row in this product is profile-scoped: a viewer who cannot
          * see which profile is active cannot tell a missing row from somebody
          * else's list. It is the ONE client boundary this server shell opens --
          * it reads the session, and a server shell that did the same would make
          * every route dynamic.
          *
          * Before the status badge and after the nav: it belongs with the
          * viewer's own controls at the end of the bar, and it is not a sixth
          * navigation destination.
          */}
        <div className="topbar-end">
          <ActiveProfileBadge />
          {badge === null ? null : <div className="status">{badge}</div>}
        </div>
      </header>
      <main
        className={mainClassName === null ? "shell" : `shell ${mainClassName}`}
        id="main"
        aria-busy={busy ? "true" : undefined}
      >
        {children}
      </main>
    </>
  );
}
