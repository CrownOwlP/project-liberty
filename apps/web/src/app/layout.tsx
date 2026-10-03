import type { Metadata } from "next";
import type { ReactNode } from "react";

import { FocusOnRouteChange } from "../lib/a11y/focus-on-route-change";
import "./globals.css";

export const metadata: Metadata = {
  title: "Project Liberty",
  description: "A fast, rights-aware media platform foundation."
};

/*
 * THE ROOT LAYOUT STILL DOES NOT RENDER THE CHROME, AND THAT IS DELIBERATE
 * (PW-0301).
 *
 * The obvious move is to put `<AppShell>` here and delete it from every page.
 * It is refused for one concrete reason: the shell needs the CURRENT PATHNAME to
 * mark where the viewer is, a root layout in the App Router is not re-rendered
 * on navigation and is not given the path, and the only ways to get it are a
 * `usePathname()` hook -- which would make the entire application a client
 * boundary -- or reading `headers()`, which opts every route into dynamic
 * rendering whether it needed to or not.
 *
 * So the shell is a COMPONENT each page renders with its own path, and the
 * duplication that remains is one import and one prop rather than twenty lines
 * of copied markup with drifting contents. `shell-usage.test.ts` fails if a
 * route goes back to hand-rolling a header.
 */
export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        {/*
          THE ONE THING THE ROOT LAYOUT IS THE RIGHT PLACE FOR (PW-0310).

          The paragraph above refuses to put the SHELL here because the shell
          needs the pathname and a root layout is not given one. This component
          needs the pathname for the opposite reason: it must survive the
          navigation it is reacting to, and a root layout is the only thing in
          the tree that does -- everything below it is replaced by the
          navigation itself, so a listener mounted there would be unmounted
          before it could notice.

          It does not make the application a client boundary. It is a client
          LEAF that renders null; the layout around it stays a server
          component, and so does every page below it.
        */}
        <FocusOnRouteChange />
        {children}
      </body>
    </html>
  );
}
